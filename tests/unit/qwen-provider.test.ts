import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  QwenProvider,
  QWEN_DEFAULT_BASE_URL,
  QWEN_DEFAULT_MODEL,
} from '../../packages/ai/src';

function response(content: unknown): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => vi.restoreAllMocks());

describe('QwenProvider', () => {
  it('uses the DashScope international endpoint, qwen3.7-flash, and disables thinking by default', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({
      items: [{ name: 'Cà chua', quantity: 2, measurementUnit: 'piece', confidenceScore: 92 }],
    }));

    const result = await new QwenProvider('secret').vision({ imageBase64OrUrl: 'AQI=' });
    const [url, init] = fetchMock.mock.calls[0] || [];
    const body = JSON.parse(String(init?.body));

    expect(url).toBe(`${QWEN_DEFAULT_BASE_URL}/chat/completions`);
    expect(body).toMatchObject({ model: QWEN_DEFAULT_MODEL, enable_thinking: false });
    expect(result.items[0]).toMatchObject({ raw_name: 'Cà chua', estimated_quantity: 2, confidence: 0.92 });
  });

  it('accepts a custom model while retaining the historical timeout constructor form', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({
      items: [{ raw_name: 'Trứng gà', estimated_quantity: 1, unit: 'piece', confidence: 0.9 }],
    }));

    await new QwenProvider('secret', undefined, 'qwen3.7-flash-preview').vision({ imageBase64OrUrl: 'AQI=' });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).model).toBe('qwen3.7-flash-preview');
  });

  it('does not send provider structured-output options to qwen-vl-ocr', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({
      items: [{ raw_name: 'Cà chua', estimated_quantity: 1, unit: 'piece', confidence: 0.95 }],
    }));

    await new QwenProvider('secret', undefined, 'qwen-vl-ocr').receiptScan({ imageBase64OrUrl: 'AQI=' });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).not.toHaveProperty('response_format');
    expect(body).not.toHaveProperty('enable_thinking');
  });

  it('keeps provider structured output enabled for supported multimodal models', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({
      items: [{ raw_name: 'Cà chua', estimated_quantity: 1, unit: 'piece', confidence: 0.95 }],
    }));

    await new QwenProvider('secret', undefined, 'qwen3.8-flash').vision({ imageBase64OrUrl: 'AQI=' });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('parses OCR JSON text at the application layer without provider structured output', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(
      '```json\n{"items":[{"raw_name":"Cà chua","estimated_quantity":1,"unit":"piece","confidence":0.95}]}\n```',
    ));

    await expect(new QwenProvider('secret', undefined, 'qwen-vl-ocr').receiptScan({ imageBase64OrUrl: 'AQI=' }))
      .resolves.toMatchObject({ items: [{ raw_name: 'Cà chua', confidence: 0.95 }] });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).not.toHaveProperty('response_format');
  });

  it('fails closed when OCR returns malformed JSON text', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response('{not-json'));

    await expect(new QwenProvider('secret', undefined, 'qwen-vl-ocr').receiptScan({ imageBase64OrUrl: 'AQI=' }))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE', retryable: false });
  });

  it('normalizes Qwen-style receipt aliases and numeric confidence percentages', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({
      storeName: 'WinMart',
      receiptNumber: 'HD-42',
      transactionDate: '2026-09-12',
      grandTotal: '42.000',
      lineItems: [{
        productName: 'Sữa tươi',
        qty: '2',
        quantityUnit: 'hộp',
        unitPrice: '21.000',
        lineTotal: '42.000',
        confidenceScore: 91,
      }],
    }));

    await expect(new QwenProvider('secret').receiptScan({ imageBase64OrUrl: 'AQI=' })).resolves.toMatchObject({
      merchant_name: 'WinMart',
      invoice_number: 'HD-42',
      total_amount_vnd: 42000,
      items: [{ raw_name: 'Sữa tươi', estimated_quantity: 2, unit: 'pack', unit_price_vnd: 21000, total_price_vnd: 42000, confidence: 0.91 }],
    });
  });

  it('uses the configured model for ranking and chat', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response({ ranked_titles: ['Bún bò', 'Canh rau'] }))
      .mockResolvedValueOnce(response('Xin chào từ Frigo'));
    const provider = new QwenProvider('secret', undefined, 'qwen3.7-flash-custom');

    await expect(provider.rankRecipes(['Canh rau', 'Bún bò'], ['thịt bò'])).resolves.toEqual(['Bún bò', 'Canh rau']);
    await expect(provider.chat('Xin chào')).resolves.toBe('Xin chào từ Frigo');
    expect(fetchMock.mock.calls).toHaveLength(2);
    for (const [, init] of fetchMock.mock.calls) {
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'qwen3.7-flash-custom', enable_thinking: false });
    }
  });

  it.each([
    [404, 'resource not found'],
    [400, 'unsupported model qwen-vl-ocr'],
  ])('classifies Qwen model capability failures (%i) as MODEL_NOT_FOUND', async (status, detail) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(detail, { status }));

    await expect(new QwenProvider('secret').receiptScan({ imageBase64OrUrl: 'AQI=' })).rejects.toMatchObject({
      code: 'MODEL_NOT_FOUND', retryable: false,
    });
  });

  it.each([
    [401, 'invalid api key', 'AUTHENTICATION_FAILED', false],
    [403, 'permission denied', 'PERMISSION_DENIED', false],
    [429, 'rate limit exceeded', 'RATE_LIMITED', true],
  ] as const)('keeps Qwen auth, permission, and rate-limit errors distinct (%i)', async (status, detail, code, retryable) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(detail, { status }));

    await expect(new QwenProvider('secret').receiptScan({ imageBase64OrUrl: 'AQI=' })).rejects.toMatchObject({
      code, retryable,
    });
  });

  it('does not classify an unrelated bad request as a missing model', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('unsupported parameter response_format', { status: 400 }));

    await expect(new QwenProvider('secret').receiptScan({ imageBase64OrUrl: 'AQI=' })).rejects.toMatchObject({
      code: 'PROVIDER_REQUEST_REJECTED', retryable: false,
    });
  });
});
