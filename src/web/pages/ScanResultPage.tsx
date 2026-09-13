import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useScanStore } from '../stores/useScanStore';
import { api } from '../services/api';
import { TopBar } from '../components/common/TopBar';
import { QuantityStepper } from '../components/common/QuantityStepper';
import { Button } from '../components/common/Button';
import { getIngredientImage } from '../lib/ingredient-images';
import { Plus, Trash2, CheckCircle2, AlertCircle, X } from 'lucide-react';
import { StandardUnit } from '@frigo/domain';
import { capturePrivateSession } from '../lib/private-session';
import { invalidateInventoryDependents } from '../lib/query-invalidation';

function scanErrorText(code?: string, _detail?: string): string {
  if (code === 'AI_SCAN_NO_USABLE_ITEMS') {
    return 'Ảnh chưa đủ rõ để nhận diện món ăn. Hãy chụp gần hơn, đủ sáng và không bị lóa.';
  }
  if (code === 'AI_SCAN_TIMEOUT' || code === 'REQUEST_TIMEOUT') {
    return 'Dịch vụ nhận diện phản hồi quá lâu. Hãy thử lại với ảnh nhỏ và rõ hơn.';
  }
  if (code === 'AI_SCAN_UNAVAILABLE' || code === 'MODEL_NOT_FOUND' || code === 'AUTHENTICATION_FAILED' ||
    code === 'PERMISSION_DENIED' || code === 'LICENSE_REQUIRED') {
    return 'Dịch vụ nhận diện đang tạm thời không khả dụng. Hãy thử lại hoặc nhập thủ công.';
  }
  if (code === 'NETWORK_ERROR' || code === 'RATE_LIMITED' || code === 'UPSTREAM_ERROR') {
    return 'Dịch vụ nhận diện đang bận hoặc mất kết nối. Vui lòng thử lại sau ít phút.';
  }
  if (code === 'INVALID_RESPONSE' || code === 'SCHEMA_VALIDATION') {
    return 'Ảnh chưa đủ rõ để nhận diện món ăn. Hãy chụp gần hơn, đủ sáng và không bị lóa.';
  }
  if (code === 'IMAGE_NOT_FOUND' || code === 'IMAGE_UNAVAILABLE') {
    return 'Ảnh quét không còn khả dụng. Hãy chọn và tải lên ảnh mới.';
  }
  return 'Không thể xử lý bản quét. Hãy thử lại với ảnh rõ hơn.';
}

export const ScanResultPage: React.FC = () => {
  const navigate = useNavigate();
  const { id: paramScanId } = useParams<{ id: string }>();
  const { scanId, items, updateItem, addItem, removeItem, reset } = useScanStore();
  const effectiveScanId = scanId || paramScanId || `scan_${Date.now()}`;

  const [isConfirming, setIsConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [isManualAddOpen, setIsManualAddOpen] = useState(false);
  const [addName, setAddName] = useState('');
  const [addQty, setAddQty] = useState(1);
  const [addUnit, setAddUnit] = useState<StandardUnit>('piece');
  const [pollError, setPollError] = useState<string | null>(null);
  const [pollRefresh, setPollRefresh] = useState(0);
  const [scanStatus, setScanStatus] = useState<'pending' | 'ready' | 'failed'>(
    items.length > 0 || effectiveScanId.startsWith('scan_offline_') ? 'ready' : 'pending'
  );

  // Async queue canary returns a pending scan. Poll only while the result is
  // pending so the existing review flow remains unchanged for sync scans.
  useEffect(() => {
    if (items.length > 0 || !effectiveScanId || effectiveScanId.startsWith('scan_offline_')) return;
    let cancelled = false;
    let attempts = 0;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const scan = await api.getScan(effectiveScanId);
        if (cancelled) return;
        setPollError(null);
        if (scan.status === 'ready' || scan.status === 'confirmed') {
          setScanStatus('ready');
          useScanStore.getState().setScanResults(effectiveScanId, scan.items || []);
          return;
        }
        if (scan.status === 'failed') {
          setScanStatus('failed');
          setPollError(scanErrorText(scan.errorCode, scan.errorMessage));
          return;
        }
      } catch {
        setPollError('Không thể cập nhật trạng thái bản quét. Kiểm tra kết nối rồi thử lại.');
      }
      attempts += 1;
      if (!cancelled && attempts < 45) {
        timer = window.setTimeout(poll, 2000);
      } else if (!cancelled) {
        setPollError('Bản quét đang xử lý lâu hơn dự kiến. Bạn có thể kiểm tra lại hoặc chọn ảnh mới.');
      }
    };
    timer = window.setTimeout(poll, 500);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [effectiveScanId, items.length, pollRefresh]);

  const handleUpdateQty = (id: string, delta: number) => {
    const item = items.find((i) => i.id === id);
    if (!item) return;
    updateItem(id, { estimatedQuantity: Math.max(1, item.estimatedQuantity + delta) });
  };

  const handleConfirm = async () => {
    if (items.length === 0 || scanStatus !== 'ready') return;
    const isCurrent = capturePrivateSession();
    setConfirmError(null);
    setIsConfirming(true);
    try {
      await api.confirmScan(effectiveScanId, items);
      if (!isCurrent()) return;
      void invalidateInventoryDependents();
      reset();
      navigate('/fridge');
    } catch {
      if (!isCurrent()) return;
      setConfirmError('Chưa lưu được nguyên liệu. Vui lòng thử lại.');
      setIsConfirming(false);
    }
  };

  const handleAddManualItem = (e: React.FormEvent) => {
    e.preventDefault();
    if (!addName.trim()) return;
    addItem({
      rawName: addName.trim(),
      estimatedQuantity: Number(addQty),
      unit: addUnit,
      storage: 'fridge',
    });
    setAddName('');
    setAddQty(1);
    setIsManualAddOpen(false);
  };

  return (
    <div className="min-h-screen bg-[#F8FAF9] pb-28">
      <TopBar showBack title="Kết quả nhận diện AI" subtitle="Kiểm tra & chỉnh sửa trước khi xác nhận" />

      <div className="px-4 pt-3 space-y-4">
        {confirmError && <p role="alert" className="text-sm text-red-700">{confirmError}</p>}
        {/* Banner Alert */}
        <div className={scanStatus === 'failed'
          ? 'bg-rose-50 border border-rose-200 rounded-xl p-3.5 flex items-start gap-3'
          : 'bg-emerald-50/80 border border-emerald-200/70 rounded-xl p-3.5 flex items-start gap-3'}>
          {scanStatus === 'failed'
            ? <AlertCircle className="w-5 h-5 text-rose-600 shrink-0 mt-0.5" />
            : <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />}
          <div className="text-xs">
            <p className="font-heading font-bold text-sm text-slate-900">
              {items.length > 0
                ? `AI đã phát hiện ${items.length} nguyên liệu`
                : scanStatus === 'failed'
                  ? 'Bản quét không thể xử lý'
                  : 'Đang chờ AI hoàn tất bản quét'}
            </p>
            <p className="text-slate-600 mt-0.5">
              {items.length > 0
                ? 'Bạn có thể sửa số lượng, tên hoặc xóa trước khi bấm lưu.'
                : scanStatus === 'failed'
                  ? 'Vui lòng quay lại và thử lại với ảnh khác.'
                  : 'Kết quả sẽ tự động xuất hiện khi queue xử lý xong.'}
            </p>
          </div>
        </div>
        {pollError && (
          <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 flex items-center justify-between gap-3">
            <span>{pollError}</span>
            <div className="flex items-center gap-2 shrink-0">
              {scanStatus === 'pending' && (
                <button className="underline font-semibold" onClick={() => { setPollError(null); setPollRefresh((value) => value + 1); }}>
                  Kiểm tra lại
                </button>
              )}
              {scanStatus === 'failed' && (
                <button className="underline font-semibold" onClick={() => { reset(); navigate('/scan'); }}>
                  Quét ảnh mới
                </button>
              )}
            </div>
          </div>
        )}

        {/* Detected Items List */}
        <div className="space-y-2.5">
          {items.map((item) => (
            <div
              key={item.id}
              className="bg-white rounded-xl p-3 flex items-center justify-between border border-slate-200/80 shadow-xs"
            >
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-12 h-12 rounded-lg bg-slate-50 border border-slate-100 flex items-center justify-center shrink-0 p-1.5 overflow-hidden">
                  <img
                    src={getIngredientImage(item.canonicalId, item.rawName)}
                    alt={item.rawName}
                    className="w-full h-full object-contain"
                  />
                </div>

                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <h4 className="font-heading font-semibold text-sm text-slate-900 truncate">
                      {item.rawName}
                    </h4>
                    <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200/60">
                      {Math.round((item.confidence || 0.9) * 100)}%
                    </span>
                  </div>
                  <p className="text-xs text-slate-500">
                    Bảo quản: Ngăn mát
                  </p>
                </div>
              </div>

              {/* Edit Controls */}
              <div className="flex items-center gap-1.5 shrink-0 ml-2">
                <QuantityStepper
                  quantity={item.estimatedQuantity}
                  unit={item.unit}
                  onIncrement={() => handleUpdateQty(item.id, item.unit === 'g' ? 50 : 1)}
                  onDecrement={() => handleUpdateQty(item.id, item.unit === 'g' ? -50 : -1)}
                />

                <button
                  onClick={() => removeItem(item.id)}
                  className="p-2 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 active:scale-95 transition-colors tap-target flex items-center justify-center"
                  aria-label="Xóa món này"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* Add Missing Item Button */}
        <Button
          variant="outline"
          fullWidth
          size="md"
          onClick={() => setIsManualAddOpen(true)}
          className="flex items-center justify-center gap-1.5 text-xs text-slate-700"
        >
          <Plus className="w-4 h-4 text-emerald-700" />
          <span>Thêm nguyên liệu AI còn thiếu</span>
        </Button>
      </div>

      {/* Fixed Confirm CTA Bar */}
      <div className="fixed bottom-0 left-0 right-0 p-4 pb-[calc(1rem+env(safe-area-inset-bottom,0px))] bg-white/95 backdrop-blur-md border-t border-slate-200/80 max-w-md mx-auto z-40 shadow-lg">
        <Button
          fullWidth
          size="lg"
          onClick={handleConfirm}
          isLoading={isConfirming}
          disabled={items.length === 0 || scanStatus !== 'ready'}
          className="flex items-center justify-center gap-2"
        >
          <CheckCircle2 className="w-5 h-5" />
          <span>Xác nhận nguyên liệu ({items.length} món)</span>
        </Button>
      </div>

      {/* Manual Add Sheet */}
      {isManualAddOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/40 backdrop-blur-sm flex items-end justify-center p-0 animate-in fade-in duration-200">
          <div className="bg-white rounded-t-2xl w-full max-w-md p-5 shadow-2xl border-t border-slate-200/80 animate-in slide-in-from-bottom-5 duration-200">
            {/* Grab bar */}
            <div className="w-10 h-1 bg-slate-200 rounded-full mx-auto mb-4 shrink-0" />

            <div className="flex items-center justify-between mb-4">
              <h3 className="font-heading font-bold text-base text-slate-900">
                Thêm nguyên liệu thủ công
              </h3>
              <button
                onClick={() => setIsManualAddOpen(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors tap-target flex items-center justify-center"
                aria-label="Đóng"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleAddManualItem} className="space-y-3.5">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">Tên nguyên liệu</label>
                <input
                  type="text"
                  required
                  value={addName}
                  onChange={(e) => setAddName(e.target.value)}
                  placeholder="Ví dụ: Nấm hương, Hành lá..."
                  className="w-full h-11 px-3 rounded-lg border border-slate-200/80 text-sm font-medium text-slate-900 bg-white focus:border-emerald-600 focus:outline-none transition-colors"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1.5">Số lượng</label>
                  <input
                    type="number"
                    min="1"
                    required
                    value={addQty}
                    onChange={(e) => setAddQty(Number(e.target.value))}
                    className="w-full h-11 px-3 rounded-lg border border-slate-200/80 text-sm font-medium text-slate-900 bg-white focus:border-emerald-600 focus:outline-none transition-colors"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1.5">Đơn vị</label>
                  <select
                    value={addUnit}
                    onChange={(e) => setAddUnit(e.target.value as StandardUnit)}
                    className="w-full h-11 px-2.5 rounded-lg border border-slate-200/80 text-xs font-semibold text-slate-800 bg-white focus:border-emerald-600 focus:outline-none transition-colors"
                  >
                    <option value="piece">quả / củ / bìa</option>
                    <option value="g">gam (g)</option>
                    <option value="kg">kg</option>
                    <option value="bunch">bó</option>
                    <option value="pack">gói / hộp</option>
                    <option value="ml">ml</option>
                  </select>
                </div>
              </div>

              <div className="pt-2">
                <Button fullWidth size="md" type="submit">
                  Thêm vào danh sách
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
