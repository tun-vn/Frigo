// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getScan = vi.hoisted(() => vi.fn());
const navigate = vi.hoisted(() => vi.fn());

vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
  useSearchParams: () => [new URLSearchParams('scanId=receipt-poll-test')],
}));
vi.mock('../../src/web/services/api', () => ({ api: { getScan, confirmScan: vi.fn() } }));
vi.mock('../../src/web/components/common/TopBar', () => ({ TopBar: () => <div /> }));
vi.mock('../../src/web/components/common/QuantityStepper', () => ({ QuantityStepper: () => <div /> }));
vi.mock('../../src/web/components/common/Button', () => ({ Button: ({ children, fullWidth: _fullWidth, size: _size, variant: _variant, isLoading: _isLoading, className: _className, ...props }: any) => <button {...props}>{children}</button> }));
vi.mock('../../src/web/stores/useWeekStore', () => ({
  useWeekStore: (selector: (state: { currentPlan: null }) => unknown) => selector({ currentPlan: null }),
}));
vi.mock('../../src/web/lib/ingredient-images', () => ({ getIngredientImage: () => '/ingredient.png' }));
vi.mock('../../src/web/lib/private-session', () => ({ capturePrivateSession: () => () => true }));
vi.mock('../../src/web/lib/query-invalidation', () => ({ invalidateInventoryDependents: vi.fn() }));

function flushEffects(): Promise<void> {
  return act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('receipt review polling', () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    getScan.mockReset();
    navigate.mockReset();
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(() => {
    act(() => root?.unmount());
    host.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function renderPage() {
    const { ReceiptReviewPage } = await import('../../src/web/pages/ReceiptReviewPage');
    await act(async () => {
      root = createRoot(host);
      root.render(<ReceiptReviewPage />);
    });
    await flushEffects();
  }

  it('continues polling after a transient getScan network error', async () => {
    getScan
      .mockRejectedValueOnce(new Error('temporary network error'))
      .mockResolvedValue({ id: 'receipt-poll-test', status: 'pending', items: [] });
    await renderPage();

    await act(async () => { vi.advanceTimersByTime(500); });
    await flushEffects();
    expect(getScan).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('Không thể cập nhật trạng thái hóa đơn');

    await act(async () => { vi.advanceTimersByTime(1000); });
    await flushEffects();
    expect(getScan).toHaveBeenCalledTimes(2);
  });

  it('shows the timeout-specific message returned by the failed scan DTO', async () => {
    getScan.mockResolvedValueOnce({
      id: 'receipt-poll-test',
      status: 'failed',
      errorCode: 'REQUEST_TIMEOUT',
      errorMessage: 'PRIVATE_PROVIDER_DETAIL_SHOULD_NOT_LEAK',
      items: [],
    });
    await renderPage();

    await act(async () => { vi.advanceTimersByTime(500); });
    await flushEffects();
    expect(host.textContent).toContain('Dịch vụ đọc hóa đơn phản hồi quá lâu');
    expect(host.textContent).not.toContain('PRIVATE_PROVIDER_DETAIL');
  });

  it('stops retrying repeated network failures and shows a bounded timeout', async () => {
    getScan.mockRejectedValue(new Error('temporary network error'));
    await renderPage();

    await act(async () => { await vi.advanceTimersByTimeAsync(90_000); });
    await flushEffects();

    expect(getScan).toHaveBeenCalledTimes(90);
    expect(host.textContent).toContain('Không thể cập nhật hóa đơn trong thời gian cho phép');
    expect(vi.getTimerCount()).toBe(0);
  });
});
