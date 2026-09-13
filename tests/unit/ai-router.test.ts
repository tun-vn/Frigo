import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  VisionScanResultSchema,
  AIRouter,
  MockAIProvider,
  applyReceiptScanQualityGate,
  applyVisionScanQualityGate,
  AI_SCAN_MIN_CONFIDENCE,
  AI_SCAN_NO_USABLE_ITEMS,
} from '../../packages/ai/src/index';

afterEach(() => vi.restoreAllMocks());

describe('AI Router & Schema Verification', () => {
  it('should validate structured vision scan schema', () => {
    const validData = {
      items: [
        { raw_name: 'Thịt ba chỉ', estimated_quantity: 400, unit: 'g', confidence: 0.95 },
        { raw_name: 'Trứng gà', estimated_quantity: 6, unit: 'piece', confidence: 0.99 },
      ],
    };

    const parsed = VisionScanResultSchema.safeParse(validData);
    expect(parsed.success).toBe(true);
  });

  it('should reject invalid vision items', () => {
    const invalidData = {
      items: [
        { raw_name: '', estimated_quantity: -10, unit: 'unknown_unit', confidence: 2.5 },
      ],
    };

    const parsed = VisionScanResultSchema.safeParse(invalidData);
    expect(parsed.success).toBe(false);
  });

  it('rejects a vision result containing only generic model labels', () => {
    expect(() => applyVisionScanQualityGate({
      items: [{ raw_name: 'Tủ lạnh', estimated_quantity: 1, unit: 'piece', confidence: 0.99, storage: 'fridge' }],
    })).toThrow(`${AI_SCAN_NO_USABLE_ITEMS}`);
  });

  it('keeps usable vision items and removes generic/low-confidence items', () => {
    const result = applyVisionScanQualityGate({
      items: [
        { raw_name: '  Cà chua  ', estimated_quantity: 2, unit: 'piece', confidence: AI_SCAN_MIN_CONFIDENCE, storage: 'fridge' },
        { raw_name: 'Sản phẩm', estimated_quantity: 1, unit: 'piece', confidence: 0.99, storage: 'fridge' },
        { raw_name: 'Trứng gà', estimated_quantity: 1, unit: 'piece', confidence: AI_SCAN_MIN_CONFIDENCE - 0.01, storage: 'fridge' },
      ],
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].raw_name).toBe('Cà chua');
  });

  it('rejects a vision result containing only low-confidence items', () => {
    expect(() => applyVisionScanQualityGate({
      items: [
        {
          raw_name: 'Trứng gà',
          estimated_quantity: 6,
          unit: 'piece',
          confidence: AI_SCAN_MIN_CONFIDENCE - 0.01,
          storage: 'fridge',
        },
      ],
    })).toThrow(`${AI_SCAN_NO_USABLE_ITEMS}`);
  });

  it('rejects receipt results containing only placeholder lines', () => {
    expect(() => applyReceiptScanQualityGate({
      merchant_name: 'Siêu thị',
      items: [
        {
          raw_name: 'Tên sản phẩm tiếng Việt',
          estimated_quantity: 1,
          unit: 'piece',
          confidence: 0.95,
          storage: 'fridge',
        },
      ],
    })).toThrow(`${AI_SCAN_NO_USABLE_ITEMS}`);
  });

  it('applies the quality gate before accepting provider output', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        items: [{ raw_name: 'Tủ lạnh', estimated_quantity: 1, unit: 'piece', confidence: 0.95, storage: 'fridge' }],
      }) } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    await expect(new AIRouter({ aiMockMode: false, groqApiKey: 'secret', groqFallbackEnabled: true })
      .vision({ imageBase64OrUrl: 'AQI=' })).rejects.toThrow(AI_SCAN_NO_USABLE_ITEMS);
  });

  it('applies the quality gate before accepting receipt provider output', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        merchant_name: 'Siêu thị',
        items: [{ raw_name: 'Sản phẩm', estimated_quantity: 1, unit: 'piece', confidence: 0.95, storage: 'fridge' }],
      }) } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    await expect(new AIRouter({ aiMockMode: false, groqApiKey: 'secret', groqFallbackEnabled: true })
      .receiptScan({ imageBase64OrUrl: 'AQI=' })).rejects.toThrow(AI_SCAN_NO_USABLE_ITEMS);
  });

  it('MockAIProvider should return structured items matching required demo fixture', async () => {
    const mock = new MockAIProvider();
    const result = await mock.vision({ imageBase64OrUrl: 'mock-url' });
    expect(result.items.length).toBeGreaterThanOrEqual(5);

    const names = result.items.map(i => i.raw_name);
    expect(names).toContain('Thịt ba chỉ');
    expect(names).toContain('Trứng gà');
    expect(names).toContain('Cà chua');
    expect(names).toContain('Rau muống');
    expect(names).toContain('Đậu phụ');
  });

  it('AIRouter should fallback seamlessly in mock mode', async () => {
    const router = new AIRouter({ aiMockMode: true });
    const result = await router.vision({ imageBase64OrUrl: 'mock-image' });
    expect(result.items.length).toBe(5);
  });

  it('AIRouter should fail closed when production has no vision provider', async () => {
    const router = new AIRouter({ aiMockMode: false, silentFallback: true });
    await expect(router.vision({ imageBase64OrUrl: 'real-image' })).rejects.toThrow(
      'AI_SCAN_UNAVAILABLE'
    );
    await expect(router.receiptScan({ imageBase64OrUrl: 'real-receipt' })).rejects.toThrow(
      'AI_SCAN_UNAVAILABLE'
    );
    await expect(router.normalizeIngredient('Nguyên liệu không có trong danh mục')).rejects.toThrow(
      'AI_NORMALIZATION_UNAVAILABLE'
    );
    await expect(router.chat('Xin chào')).rejects.toThrow('AI_CHAT_UNAVAILABLE');
  });

  it('does not emit the invalid OTHER foreign-key sentinel for unknown ingredients', async () => {
    const mock = new MockAIProvider();
    await expect(mock.normalizeIngredient('Tên nguyên liệu lạ')).resolves.toEqual({
      canonicalId: null,
      confidence: 0,
    });
  });

  it('CloudflareAIProvider should parse real vision model JSON output', async () => {
    const { CloudflareAIProvider } = await import('../../packages/ai/src/providers/cloudflare');

    const fakeAiBinding = {
      run: async (model: string, _input: any) => {
        if (model.includes('vision')) {
          return {
            response: JSON.stringify({
              items: [
                { raw_name: 'Trứng gà', estimated_quantity: 10, unit: 'piece', confidence: 0.98, category: 'egg', storage: 'fridge' },
                { raw_name: 'Cá hồi Na Uy', estimated_quantity: 300, unit: 'g', confidence: 0.92, category: 'seafood', storage: 'freezer' },
              ]
            })
          };
        }
        return { response: 'Frigo tư vấn món ăn ngon' };
      }
    };

    const provider = new CloudflareAIProvider(fakeAiBinding);
    // 1x1 transparent GIF base64
    const testBase64 = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

    const scan = await provider.vision({ imageBase64OrUrl: testBase64 });
    expect(scan.items).toHaveLength(2);
    expect(scan.items[0].raw_name).toBe('Trứng gà');
    expect(scan.items[0].canonical_id).toBe('CHICKEN_EGG');
    expect(scan.items[1].raw_name).toBe('Cá hồi Na Uy');
    expect(scan.items[1].storage).toBe('freezer');
  });

  it('CloudflareAIProvider should parse real receipt model JSON output', async () => {
    const { CloudflareAIProvider } = await import('../../packages/ai/src/providers/cloudflare');

    const fakeAiBinding = {
      run: async (_model: string, _input: any) => ({
        response: JSON.stringify({
          merchant_name: 'Co.opmart Cống Quỳnh',
          invoice_number: 'COOP-88992',
          purchase_date: '2026-09-05',
          total_amount_vnd: 250000,
          items: [
            { raw_name: 'Thịt bò phi lê', estimated_quantity: 500, unit: 'g', unit_price_vnd: 180000, total_price_vnd: 180000, category: 'meat', storage: 'fridge' },
            { raw_name: 'Sữa tươi Dalat Milk', estimated_quantity: 1, unit: 'l', unit_price_vnd: 70000, total_price_vnd: 70000, category: 'dairy', storage: 'fridge' },
          ]
        })
      })
    };

    const provider = new CloudflareAIProvider(fakeAiBinding);
    const testBase64 = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

    const receipt = await provider.receiptScan({ imageBase64OrUrl: testBase64 });
    expect(receipt.merchant_name).toBe('Co.opmart Cống Quỳnh');
    expect(receipt.total_amount_vnd).toBe(250000);
    expect(receipt.items).toHaveLength(2);
    expect(receipt.items[0].raw_name).toBe('Thịt bò phi lê');
    expect(receipt.items[0].canonical_id).toBe('BEEF_SIRLOIN');
  });
});
