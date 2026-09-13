import { afterEach, describe, expect, it, vi } from 'vitest';
import { AIRouter, GroqProvider, GROQ_DEFAULT_VISION_MODEL } from '../../packages/ai/src';

describe('GroqProvider', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sends OpenAI-compatible vision payload and validates/normalizes items', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ items: [{ raw_name: 'Trứng gà', estimated_quantity: 6, unit: 'piece', confidence: 0.96 }] }) } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const provider = new GroqProvider('secret');
    const result = await provider.vision({ imageBase64OrUrl: 'AQI=', mimeType: 'image/jpeg' });
    expect(result.items[0].canonical_id).toBe('CHICKEN_EGG');
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/chat/completions'), expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer secret' }),
      body: expect.stringContaining(GROQ_DEFAULT_VISION_MODEL),
    }));
  });

  it('parses fenced JSON receipt and preserves prices', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '```json\n{"merchant_name":"WinMart","total_amount_vnd":42000,"items":[{"raw_name":"Cà chua","estimated_quantity":2,"unit":"piece","unit_price_vnd":21000,"total_price_vnd":42000}]}\n```' } }],
    }), { status: 200 }));
    const result = await new GroqProvider('secret').receiptScan({ imageBase64OrUrl: 'https://example.test/receipt.jpg' });
    expect(result.total_amount_vnd).toBe(42000);
    expect(result.items[0].total_price_vnd).toBe(42000);
  });

  it('coerces OCR-formatted numeric strings before schema validation', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        merchant_name: 'Frigo',
        total_amount_vnd: '313,200',
        items: [{ raw_name: 'Sữa tươi', estimated_quantity: '2', unit: 'hộp', unit_price_vnd: '32,000', total_price_vnd: '64,000', confidence: '0.93' }],
      }) } }],
    }), { status: 200 }));
    const result = await new GroqProvider('secret').receiptScan({ imageBase64OrUrl: 'AQI=' });
    expect(result.total_amount_vnd).toBe(313200);
    expect(result.items[0]).toMatchObject({ estimated_quantity: 2, unit: 'pack', unit_price_vnd: 32000, total_price_vnd: 64000, confidence: 0.93 });
  });

  it('normalizes Vietnamese unit and storage aliases', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ items: [{ raw_name: 'Cá hồi', estimated_quantity: 1, unit: 'lát', confidence: 0.8, storage: 'ngăn đông', category: 'hải sản' }] }) } }],
    }), { status: 200 }));
    const result = await new GroqProvider('secret').vision({ imageBase64OrUrl: 'AQI=' });
    expect(result.items[0]).toMatchObject({ unit: 'slice', storage: 'freezer', category: 'seafood' });
  });

  it('fails closed on invalid provider JSON and HTTP errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('not-json', { status: 200 }));
    await expect(new GroqProvider('secret').vision({ imageBase64OrUrl: 'AQI=' })).rejects.toThrow();
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('unauthorized', { status: 401 }));
    await expect(new GroqProvider('secret').vision({ imageBase64OrUrl: 'AQI=' })).rejects.toThrow('Groq API error: 401');
  });

  it('uses Groq before Workers AI and falls back when Groq fails', async () => {
    const calls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      calls.push('groq');
      return new Response('upstream unavailable', { status: 503 });
    });
    const router = new AIRouter({
      aiMockMode: false,
      groqApiKey: 'secret',
      groqFallbackEnabled: true,
      aiBinding: {
        run: async () => ({ response: JSON.stringify({ items: [{ raw_name: 'Trứng gà', estimated_quantity: 1, unit: 'piece', confidence: 0.9 }] }) }),
      },
      cloudflareVisionFallback: true,
      silentFallback: true,
    });
    const result = await router.vision({ imageBase64OrUrl: 'AQI=' });
    expect(calls).toEqual(['groq']);
    expect(result.items[0].canonical_id).toBe('CHICKEN_EGG');
  });

  it('uses the configured vision model in the request', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ items: [{ raw_name: 'Cà chua', estimated_quantity: 1, unit: 'piece', confidence: 0.9 }] }) } }],
    }), { status: 200 }));
    await new GroqProvider('secret').vision({ imageBase64OrUrl: 'AQI=' });
    expect(fetchMock.mock.calls[0]?.[1]?.body).toContain(GROQ_DEFAULT_VISION_MODEL);
  });

  it('reports Groq as the usage provider when it succeeds', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ items: [{ raw_name: 'Cà chua', estimated_quantity: 2, unit: 'piece', confidence: 0.9 }] }) } }],
    }), { status: 200 }));
    const usage: Array<{ provider: string; model: string; status: string }> = [];
    const router = new AIRouter({ aiMockMode: false, groqApiKey: 'secret', groqFallbackEnabled: true }, (entry) => usage.push(entry));
    await router.vision({ imageBase64OrUrl: 'AQI=' });
    expect(usage[0]).toMatchObject({ provider: 'groq', model: GROQ_DEFAULT_VISION_MODEL, status: 'success' });
  });
});
