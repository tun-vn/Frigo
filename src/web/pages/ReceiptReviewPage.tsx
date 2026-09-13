import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { TopBar } from '../components/common/TopBar';
import { QuantityStepper } from '../components/common/QuantityStepper';
import { Button } from '../components/common/Button';
import { api } from '../services/api';
import { useWeekStore } from '../stores/useWeekStore';
import { getIngredientImage } from '../lib/ingredient-images';
import { CheckCircle2, ShoppingBag, Trash2, Store, Calendar, CalendarCheck, AlertCircle } from 'lucide-react';
import { StandardUnit } from '@frigo/domain';
import { capturePrivateSession } from '../lib/private-session';
import { invalidateInventoryDependents } from '../lib/query-invalidation';

function receiptErrorText(code?: string, _detail?: string): string {
  if (code === 'AI_SCAN_NO_USABLE_ITEMS') {
    return 'Không đọc được dòng hàng đủ rõ. Hãy chụp toàn bộ hóa đơn, thẳng và đủ sáng.';
  }
  if (code === 'AI_SCAN_TIMEOUT' || code === 'REQUEST_TIMEOUT') {
    return 'Dịch vụ đọc hóa đơn phản hồi quá lâu. Hãy thử lại với ảnh gọn và rõ hơn.';
  }
  if (code === 'AI_SCAN_UNAVAILABLE' || code === 'MODEL_NOT_FOUND' || code === 'AUTHENTICATION_FAILED' ||
    code === 'PERMISSION_DENIED' || code === 'LICENSE_REQUIRED') {
    return 'Dịch vụ đọc hóa đơn đang tạm thời không khả dụng. Bạn có thể nhập thủ công.';
  }
  if (code === 'NETWORK_ERROR' || code === 'RATE_LIMITED' || code === 'UPSTREAM_ERROR') {
    return 'Dịch vụ đọc hóa đơn đang bận hoặc mất kết nối. Vui lòng thử lại sau ít phút.';
  }
  if (code === 'INVALID_RESPONSE' || code === 'SCHEMA_VALIDATION') {
    return 'Không đọc được dòng hàng đủ rõ. Hãy chụp toàn bộ hóa đơn, thẳng và đủ sáng.';
  }
  if (code === 'IMAGE_NOT_FOUND' || code === 'IMAGE_UNAVAILABLE') {
    return 'Ảnh hóa đơn không còn khả dụng. Hãy chọn và tải lên ảnh mới.';
  }
  return 'Không thể đọc hóa đơn. Hãy thử lại với ảnh rõ hơn.';
}

interface ReceiptItemState {
  id: string;
  rawName: string;
  canonicalId?: string;
  estimatedQuantity: number;
  unit: StandardUnit;
  unitPriceVnd?: number;
  totalPriceVnd?: number;
  category?: string;
  storage: 'fridge' | 'freezer' | 'pantry';
}

export const ReceiptReviewPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const receiptScanId = searchParams.get('scanId');
  return <ReceiptReview key={receiptScanId || ''} receiptScanId={receiptScanId} />;
};

const ReceiptReview: React.FC<{ receiptScanId: string | null }> = ({ receiptScanId }) => {
  const navigate = useNavigate();
  const currentPlan = useWeekStore((s) => s.currentPlan);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // History survives logout. Only the authorized scan endpoint may supply receipt data.
  const [liveReceipt, setLiveReceipt] = useState<any>({
    id: receiptScanId || '', status: receiptScanId ? 'pending' : 'failed', items: [],
  });
  const [pollError, setPollError] = useState<string | null>(
    receiptScanId ? null : 'Không tìm thấy bản quét hóa đơn. Vui lòng quay lại và quét ảnh mới.'
  );
  const [pollRefresh, setPollRefresh] = useState(0);
  const isPending = liveReceipt.status === 'pending' || liveReceipt.status === 'processing';
  const isReady = liveReceipt.status === 'ready' || liveReceipt.status === 'confirmed';

  // Async receipt scans arrive as a pending DTO. Poll the tenant-scoped scan
  // endpoint until the queue processor publishes ready/failed state.
  useEffect(() => {
    if (!liveReceipt.id || !isPending) return;
    let cancelled = false;
    let attempts = 0;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const next = await api.getScan(liveReceipt.id);
        if (cancelled) return;
        setPollError(null);
        setLiveReceipt(next);
        if (next.status === 'pending' || next.status === 'processing') {
          attempts += 1;
          if (attempts < 90) timer = window.setTimeout(poll, 1000);
          else setPollError('Hóa đơn đang xử lý lâu hơn dự kiến. Bạn có thể kiểm tra lại hoặc chọn ảnh mới.');
        } else if (next.status === 'failed') {
          setPollError(receiptErrorText(next.errorCode, next.errorMessage));
        }
      } catch {
        if (cancelled) return;
        setPollError('Không thể cập nhật trạng thái hóa đơn. Kiểm tra kết nối rồi thử lại.');
        attempts += 1;
        if (attempts < 90) {
          timer = window.setTimeout(poll, 1000);
        } else {
          setPollError('Không thể cập nhật hóa đơn trong thời gian cho phép. Bạn có thể kiểm tra lại hoặc chọn ảnh mới.');
        }
      }
    };
    timer = window.setTimeout(poll, 500);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [liveReceipt.id, isPending, pollRefresh]);

  const [items, setItems] = useState<ReceiptItemState[]>([]);
  useEffect(() => {
    if (Array.isArray(liveReceipt.items) && liveReceipt.items.length > 0) {
      setItems(liveReceipt.items);
    }
  }, [liveReceipt.items]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [successToast, setSuccessToast] = useState<string | null>(null);

  const handleUpdateQty = (id: string, delta: number) => {
    setItems((prev) =>
      prev.map((it) => {
        if (it.id === id) {
          const newQty = Math.max(1, it.estimatedQuantity + delta);
          const newTotal = it.unitPriceVnd ? it.unitPriceVnd * (it.unit === 'g' ? newQty / 1000 : newQty) : undefined;
          return { ...it, estimatedQuantity: newQty, totalPriceVnd: newTotal };
        }
        return it;
      })
    );
  };

  const handleRemove = (id: string) => {
    setItems((prev) => prev.filter((it) => it.id !== id));
  };

  const handleImportToFridge = async () => {
    if (items.length === 0 || !isReady) return;
    const isCurrent = capturePrivateSession();
    setIsSubmitting(true);
    try {
      await api.confirmScan(liveReceipt.id, items);
      if (!mounted.current || !isCurrent()) return;
      void invalidateInventoryDependents();
      setSuccessToast('Đã nhập nguyên liệu hóa đơn vào tủ lạnh thành công!');
      setTimeout(() => {
        if (mounted.current && isCurrent()) navigate('/fridge');
      }, 1200);
    } catch {
      if (!mounted.current || !isCurrent()) return;
      setPollError('Chưa nhập được nguyên liệu. Vui lòng thử lại.');
      setIsSubmitting(false);
    }
  };

  const handleReconcileWeeklyPlan = async () => {
    if (items.length === 0 || !isReady) return;
    const isCurrent = capturePrivateSession();
    setIsSubmitting(true);
    try {
      await api.confirmScan(liveReceipt.id, items);
      if (!mounted.current || !isCurrent()) return;
      setSuccessToast('Đã đối chiếu hóa đơn & cập nhật tủ lạnh!');
      setTimeout(() => {
        if (!mounted.current || !isCurrent()) return;
        if (currentPlan) {
          navigate(`/week/${currentPlan.id}/shopping`);
        } else {
          navigate('/week');
        }
      }, 1200);
    } catch (err) {
      console.error('Failed to reconcile with week plan:', err);
      setIsSubmitting(false);
    }
  };

  const calculatedTotal = items.reduce((sum, it) => sum + (it.totalPriceVnd || 0), 0);

  return (
    <div className="min-h-screen bg-[#F8FAF9] pb-32 max-w-md mx-auto">
      <TopBar showBack title="Chi tiết Hóa đơn" subtitle="Bóc tách tự động bởi AI Vision" />

      {/* Success Toast */}
      {successToast && (
        <div className="fixed top-16 left-4 right-4 z-50 bg-slate-900 text-white px-4 py-3 rounded-xl shadow-lg flex items-center gap-3 animate-in fade-in slide-in-from-top-4 duration-200 max-w-md mx-auto border border-white/10">
          <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
          <p className="text-xs font-semibold leading-tight">{successToast}</p>
        </div>
      )}

      <div className="px-4 pt-3 space-y-4">
        {isPending && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Hóa đơn đang được AI xử lý nền. Trang sẽ tự cập nhật khi hoàn tất...
          </div>
        )}
        {pollError && (
          <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{pollError}</span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {isPending && (
                <button className="underline font-semibold" onClick={() => { setPollError(null); setPollRefresh((value) => value + 1); }}>
                  Kiểm tra lại
                </button>
              )}
              {!isPending && !isReady && (
                <button className="underline font-semibold" onClick={() => navigate('/scan')}>
                  Quét ảnh mới
                </button>
              )}
            </div>
          </div>
        )}
        {/* Receipt Header Card */}
        <div className="bg-white rounded-xl p-4 border border-slate-200/80 shadow-xs space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="w-10 h-10 rounded-xl bg-emerald-50 border border-emerald-100 flex items-center justify-center text-emerald-700 shrink-0">
                <Store className="w-5 h-5" />
              </div>
              <div>
                <h3 className="font-heading font-bold text-sm text-slate-900">
                  {liveReceipt.merchantName}
                </h3>
                <p className="text-xs text-slate-500 flex items-center gap-1 mt-0.5">
                  <Calendar className="w-3 h-3 text-slate-400" />
                  <span>{liveReceipt.purchaseDate}</span>
                  {liveReceipt.invoiceNumber && <span>• {liveReceipt.invoiceNumber}</span>}
                </p>
              </div>
            </div>
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-emerald-50 text-emerald-800 border border-emerald-200/60">
              AI OCR
            </span>
          </div>

          <div className="flex items-center justify-between pt-2 border-t border-slate-100">
            <span className="text-xs text-slate-500">Tổng thanh toán:</span>
            <span className="font-heading font-bold text-lg text-slate-900">
              {(calculatedTotal || liveReceipt.totalAmountVnd || 0).toLocaleString('vi-VN')}đ
            </span>
          </div>
        </div>

        {/* Extracted Items Count */}
        <div className="flex items-center justify-between px-1">
          <h4 className="font-heading font-semibold text-sm text-slate-900">
            Hàng hóa nhận diện ({items.length} món)
          </h4>
          <span className="text-xs text-slate-500">Chạm để chỉnh số lượng</span>
        </div>

        {/* Items List */}
        <div className="space-y-2.5">
          {items.map((item) => (
            <div
              key={item.id}
              className="bg-white rounded-xl p-3 border border-slate-200/80 shadow-xs flex items-center justify-between gap-3"
            >
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-12 h-12 rounded-lg bg-slate-50 border border-slate-100 p-1.5 shrink-0 flex items-center justify-center">
                  <img
                    src={getIngredientImage(item.canonicalId || item.rawName)}
                    alt={item.rawName}
                    className="w-full h-full object-contain"
                  />
                </div>
                <div className="min-w-0">
                  <p className="font-heading font-semibold text-sm text-slate-900 truncate">
                    {item.rawName}
                  </p>
                  <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                    {item.totalPriceVnd && (
                      <span className="text-xs font-semibold text-emerald-700">
                        {item.totalPriceVnd.toLocaleString('vi-VN')}đ
                      </span>
                    )}
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 font-medium">
                      {item.storage === 'fridge' ? 'Tủ mát' : item.storage === 'freezer' ? 'Tủ đông' : 'Tủ khô'}
                    </span>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                <QuantityStepper
                  quantity={item.estimatedQuantity}
                  unit={item.unit}
                  onIncrement={() => handleUpdateQty(item.id, item.unit === 'g' ? 100 : 1)}
                  onDecrement={() => handleUpdateQty(item.id, item.unit === 'g' ? -100 : -1)}
                />
                <button
                  onClick={() => handleRemove(item.id)}
                  className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors tap-target"
                  title="Xóa"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}

          {items.length === 0 && (
            <div className="text-center py-10 bg-white rounded-xl p-6 border border-slate-200/80">
              <p className="text-xs text-slate-400">Không còn món nào trong hóa đơn</p>
            </div>
          )}
        </div>
      </div>

      {/* Floating Action Bottom */}
      <div className="fixed bottom-0 left-0 right-0 p-4 bg-white/95 backdrop-blur-md border-t border-slate-200/80 z-40 max-w-md mx-auto space-y-2 shadow-lg">
        <Button
          fullWidth
          size="lg"
            disabled={items.length === 0 || isSubmitting || !isReady}
          onClick={handleImportToFridge}
          className="flex items-center justify-center gap-2"
        >
          <ShoppingBag className="w-4 h-4" />
          <span>Nhập {items.length} món vào Tủ lạnh</span>
        </Button>

        {currentPlan && (
          <Button
            fullWidth
            variant="outline"
            size="md"
          disabled={items.length === 0 || isSubmitting || !isReady}
            onClick={handleReconcileWeeklyPlan}
            className="flex items-center justify-center gap-2 text-slate-800"
          >
            <CalendarCheck className="w-4 h-4 text-emerald-600" />
            <span>Đối chiếu & Đánh dấu đi chợ tuần</span>
          </Button>
        )}
      </div>
    </div>
  );
};
