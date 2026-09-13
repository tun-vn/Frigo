import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AIRouter,
  DeepSeekProvider,
  GLMProvider,
  GroqProvider,
  GROQ_DEFAULT_VISION_MODEL,
  normalizeOcrNumber,
  QwenProvider,
} from '../../packages/ai/src/index';

const visionPayload = {
  items: [
    {
      raw_name: 'Cà chua',
      estimated_quantity: 2,
      unit: 'piece',
      confidence: 0.92,
      category: 'vegetable',
      storage: 'fridge',
    },
  ],
};

function okResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function providerResponse(content: unknown): Response {
  return okResponse({ choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] });
}

afterEach(() => vi.restoreAllMocks());

describe('vision provider recovery contract', () => {
  it.each([
    ['42.000', 42000],
    ['42,000', 42000],
    ['0,91', 0.91],
    ['1.234,56', 1234.56],
    ['12.5', 12.5],
  ])('normalizes locale-formatted OCR number %s', (input, expected) => {
    expect(normalizeOcrNumber(input)).toBe(expected);
  });

  it('uses the production-safe Qwen model by default', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(providerResponse(visionPayload));

    await new GroqProvider('groq-key').vision({ imageBase64OrUrl: 'AQI=' });

    const request = fetchMock.mock.calls[0]?.[1];
    expect(request).toBeDefined();
    expect(JSON.parse(String(request?.body)).model).toBe(GROQ_DEFAULT_VISION_MODEL);
    expect(GROQ_DEFAULT_VISION_MODEL).toBe('qwen/qwen3.6-27b');
  });

  it('marks a missing Groq model as permanent and preserves the typed error through the router', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ error: { message: 'The model `meta-llama/llama-4-scout-17b-16e-instruct` does not exist' } }),
      { status: 404, headers: { 'Content-Type': 'application/json' } },
    ));

    const router = new AIRouter({ aiMockMode: false, groqApiKey: 'groq-key', groqFallbackEnabled: true });
    await expect(router.vision({ imageBase64OrUrl: 'AQI=' })).rejects.toMatchObject({
      code: 'MODEL_NOT_FOUND',
      retryable: false,
      status: 404,
    });
  });

  it.each([
    [429, 'RATE_LIMITED'],
    [503, 'UPSTREAM_ERROR'],
  ] as const)('keeps %i provider failures retryable', async (status, code) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('upstream failure', { status }));

    await expect(new GroqProvider('groq-key').vision({ imageBase64OrUrl: 'AQI=' })).rejects.toMatchObject({
      code,
      retryable: true,
      status,
    });
  });

  it('reads Qwen reasoning_content when the compatible API omits message.content', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse({
      choices: [{ message: { reasoning_content: JSON.stringify(visionPayload) } }],
    }));

    const result = await new QwenProvider('qwen-key').vision({ imageBase64OrUrl: 'AQI=' });
    expect(result.items[0]?.raw_name).toBe('Cà chua');
  });

  it('reads Groq reasoning_content when the provider puts structured output there', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse({
      choices: [{ message: { reasoning_content: JSON.stringify(visionPayload) } }],
    }));

    const result = await new GroqProvider('groq-key').vision({ imageBase64OrUrl: 'AQI=' });
    expect(result.items[0]?.raw_name).toBe('Cà chua');
  });

  it.each([
    ['qwen', () => new QwenProvider('qwen-key')],
    ['groq', () => new GroqProvider('groq-key')],
  ] as const)('retains a valid provider canonical_id when the OCR name is unknown (%s)', async (_name, createProvider) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(providerResponse({
      items: [{
        raw_name: 'SKU-ABCD-001',
        canonical_id: 'TOMATO',
        estimated_quantity: 1,
        unit: 'piece',
        confidence: 0.9,
      }],
    }));

    const result = await createProvider().vision({ imageBase64OrUrl: 'AQI=' });
    expect(result.items[0]?.canonical_id).toBe('TOMATO');
  });

  it('normalizes common OCR numeric strings and unit aliases from Qwen receipts', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(providerResponse({
      merchant_name: 'WinMart',
      total_amount_vnd: '42,000',
      items: [{
        raw_name: 'Sữa tươi',
        estimated_quantity: '2',
        unit: 'hộp',
        unit_price_vnd: '21,000',
        total_price_vnd: '42,000',
        confidence: '0.91',
      }],
    }));

    await expect(new QwenProvider('qwen-key').receiptScan({ imageBase64OrUrl: 'AQI=' })).resolves.toMatchObject({
      total_amount_vnd: 42000,
      items: [{ estimated_quantity: 2, unit: 'pack', unit_price_vnd: 21000, total_price_vnd: 42000, confidence: 0.91 }],
    });
  });

  it('does not treat Vietnamese dotted thousands separators as decimal values', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(providerResponse({
      merchant_name: 'Co.opmart',
      total_amount_vnd: '42.000',
      items: [{ raw_name: 'Cà chua', estimated_quantity: '2', unit: 'piece', total_price_vnd: '42.000', confidence: '0,91' }],
    }));

    await expect(new QwenProvider('qwen-key').receiptScan({ imageBase64OrUrl: 'AQI=' })).resolves.toMatchObject({
      total_amount_vnd: 42000,
      items: [{ total_price_vnd: 42000, confidence: 0.91 }],
    });
  });

  it('normalizes dotted thousands and comma decimals in Groq receipts too', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(providerResponse({
      merchant_name: 'Co.opmart',
      total_amount_vnd: '42.000',
      items: [{ raw_name: 'Cà chua', estimated_quantity: '2', unit: 'piece', total_price_vnd: '42.000', confidence: '0,91' }],
    }));

    await expect(new GroqProvider('groq-key').receiptScan({ imageBase64OrUrl: 'AQI=' })).resolves.toMatchObject({
      total_amount_vnd: 42000,
      items: [{ total_price_vnd: 42000, confidence: 0.91 }],
    });
  });

  it('preserves and normalizes Qwen vision storage, category, and unit aliases', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(providerResponse({
      items: [{ raw_name: 'Cá hồi', estimated_quantity: 1, unit: 'lát', confidence: 0.84, storage: 'ngăn đông', category: 'hải sản' }],
    }));

    await expect(new QwenProvider('qwen-key').vision({ imageBase64OrUrl: 'AQI=' })).resolves.toMatchObject({
      items: [{ unit: 'slice', storage: 'freezer', category: 'seafood' }],
    });
  });

  it('classifies an aborted provider request as a retryable timeout', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(abortError);

    await expect(new GroqProvider('groq-key').vision({ imageBase64OrUrl: 'AQI=' })).rejects.toMatchObject({
      code: 'REQUEST_TIMEOUT',
      retryable: true,
    });
  });

  it('does not enable Cloudflare vision when the fallback flag is explicitly disabled', async () => {
    const run = vi.fn();
    const router = new AIRouter({
      aiMockMode: false,
      aiBinding: { run },
      cloudflareVisionFallback: false,
      silentFallback: true,
    });

    await expect(router.vision({ imageBase64OrUrl: 'AQI=' })).rejects.toMatchObject({
      code: 'AI_SCAN_UNAVAILABLE',
      retryable: false,
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('does not activate legacy or future providers from stored keys alone', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const router = new AIRouter({
      aiMockMode: false,
      qwenApiKey: 'qwen-key',
      groqApiKey: 'groq-key',
      deepseekApiKey: 'deepseek-key',
      zaiApiKey: 'glm-key',
      silentFallback: true,
    });

    await expect(router.vision({ imageBase64OrUrl: 'AQI=' })).rejects.toMatchObject({
      code: 'AUTHENTICATION_FAILED',
      provider: 'Qwen',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('dashscope');
  });

  it('falls through from a failed Qwen ranking request to the explicitly enabled DeepSeek fallback', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('temporary upstream failure', { status: 503 }))
      .mockResolvedValueOnce(providerResponse(['Bún bò']));

    const router = new AIRouter({
      aiMockMode: false,
      qwenApiKey: 'qwen-key',
      deepseekApiKey: 'deepseek-key',
      deepseekFallbackEnabled: true,
      silentFallback: true,
    });

    await expect(router.rankRecipes(['Canh rau', 'Bún bò'], ['thịt bò']))
      .resolves.toEqual(['Bún bò', 'Canh rau']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('api.deepseek.com');
  });

  it('does not treat an empty DeepSeek chat response as a successful fallback', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse({ choices: [{ message: { content: '' } }] }));

    await expect(new DeepSeekProvider('deepseek-key').chat('Xin chào')).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      retryable: false,
    });
  });

  it('does not treat a failed GLM chat response as a successful fallback', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('upstream failure', { status: 503 }));

    await expect(new GLMProvider('glm-key').chat('Xin chào')).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR',
      retryable: true,
    });
  });
});
