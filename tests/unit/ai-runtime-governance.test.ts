import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  AIEscalationExhaustedError,
  AIRouter,
  QwenTaskRuntime,
  AIUsageLedger,
  createGovernanceConfig,
  calculateEstimatedCost,
} from '../../packages/ai/src';

function response(content: unknown, usage?: Record<string, unknown>): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }],
    ...(usage ? { usage } : {}),
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

const receipt = {
  merchant_name: 'WinMart',
  items: [{ raw_name: 'Cà chua', estimated_quantity: 2, unit: 'piece', total_price_vnd: 20_000, confidence: 0.95 }],
};

afterEach(() => vi.restoreAllMocks());

describe('Qwen task runtime governance', () => {
  it('resolves task roles to pinned Qwen physical models', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(receipt, {
      prompt_tokens: 50, completion_tokens: 20,
    }));
    const router = new AIRouter({ qwenApiKey: 'test-key', qwenOnly: true });

    await router.receiptScan({ imageBase64OrUrl: 'AQI=' });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.model).toBe('qwen-vl-ocr');
    expect(body.max_tokens).toBe(2_048);
  });

  it('does not construct or call non-Qwen fallbacks in Qwen-only mode', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(receipt));
    const router = new AIRouter({
      qwenApiKey: 'qwen-key', qwenOnly: true,
      groqApiKey: 'groq-key', groqFallbackEnabled: true,
      deepseekApiKey: 'deepseek-key', deepseekFallbackEnabled: true,
      zaiApiKey: 'glm-key', glmFallbackEnabled: true,
      aiBinding: { run: vi.fn() }, cloudflareVisionFallback: true,
    });

    await router.receiptScan({ imageBase64OrUrl: 'AQI=' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('dashscope');
  });

  it('repairs malformed structured output on the same cheap role', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response('{not-json'))
      .mockResolvedValueOnce(response(receipt));
    const runtime = new QwenTaskRuntime({ qwenApiKey: 'qwen-key', qwenOnly: true });

    const result = await runtime.generate({ task: 'receipt_ocr', input: { imageBase64OrUrl: 'AQI=' } });
    expect(result.value).toMatchObject({ items: [{ raw_name: 'Cà chua' }] });
    expect(result.attempts).toBe(2);
    expect(fetchMock.mock.calls).toHaveLength(2);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).model)
      .toBe(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)).model);
  });

  it('escalates exactly once after bounded repair attempts', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response('{not-json'))
      .mockResolvedValueOnce(response('{still-not-json'))
      .mockResolvedValueOnce(response(receipt));
    const runtime = new QwenTaskRuntime({ qwenApiKey: 'qwen-key', qwenOnly: true });

    const result = await runtime.generate({ task: 'receipt_ocr', input: { imageBase64OrUrl: 'AQI=' } });
    expect(result.attempts).toBe(3);
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).model))
      .toEqual(['qwen-vl-ocr', 'qwen-vl-ocr', 'qwen3.8-flash']);
  });

  it('uses the Qwen multimodal fallback when the OCR model is unavailable', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('model not found', { status: 404 }))
      .mockResolvedValueOnce(response(receipt));
    const runtime = new QwenTaskRuntime({ qwenApiKey: 'qwen-key', qwenOnly: true });

    const result = await runtime.generate({ task: 'receipt_ocr', input: { imageBase64OrUrl: 'AQI=' } });
    expect(result.attempts).toBe(2);
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).model))
      .toEqual(['qwen-vl-ocr', 'qwen3.8-flash']);
  });

  it('uses the Qwen multimodal fallback for generic Qwen model 404/unsupported responses', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('resource not found', { status: 404 }))
      .mockResolvedValueOnce(response(receipt));
    const runtime = new QwenTaskRuntime({ qwenApiKey: 'qwen-key', qwenOnly: true });

    await expect(runtime.generate({ task: 'receipt_ocr', input: { imageBase64OrUrl: 'AQI=' } }))
      .resolves.toMatchObject({ attempts: 2, physicalModel: 'qwen3.8-flash' });
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).model))
      .toEqual(['qwen-vl-ocr', 'qwen3.8-flash']);
  });

  it('rejects unparsed structured chat output and omits broad context from repair', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response('not-json'))
      .mockResolvedValueOnce(response({ plan: [] }));
    const runtime = new QwenTaskRuntime({ qwenApiKey: 'qwen-key', qwenOnly: true });

    await expect(runtime.generate({
      task: 'weekly_plan',
      input: { candidate: [{ day: 1 }] },
      context: { rawHistory: 'should-not-be-repeated-on-repair' },
    })).resolves.toMatchObject({ value: { plan: [] }, attempts: 2 });

    const firstPrompt = JSON.stringify(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)));
    const repairPrompt = JSON.stringify(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)));
    expect(firstPrompt).toContain('should-not-be-repeated-on-repair');
    expect(repairPrompt).not.toContain('should-not-be-repeated-on-repair');
    expect(repairPrompt).toContain('VALIDATION FAILURES');
  });

  it('does not enter the reasoning tier unless explicitly enabled', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response('{not-json'));
    const runtime = new QwenTaskRuntime({ qwenApiKey: 'qwen-key', qwenOnly: true });

    await expect(runtime.generate({
      task: 'weekly_plan_complex',
      input: { inventory: [] },
      schema: z.object({ plan: z.array(z.string()) }),
    })).rejects.toBeInstanceOf(AIEscalationExhaustedError);
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(2);
  });

  it('enforces task input budgets before any provider call', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const governance = createGovernanceConfig({ AI_MAX_INPUT_TOKENS: '1024' }, { qwenOnly: true });
    const runtime = new QwenTaskRuntime({ qwenApiKey: 'qwen-key', qwenOnly: true, governance });

    await expect(runtime.generate({ task: 'fridge_chat', input: 'x'.repeat(10_000) }))
      .rejects.toMatchObject({ code: 'AI_BUDGET_EXCEEDED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('records provider usage and centralized estimated cost', async () => {
    const logs: Array<{ inputTokens: number; outputTokens: number; estimatedCostUsd?: number; task: string }> = [];
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response('hello', {
      prompt_tokens: 100, completion_tokens: 25, prompt_tokens_details: { cached_tokens: 40 },
    }));
    const governance = createGovernanceConfig({}, { qwenOnly: true });
    const runtime = new QwenTaskRuntime({ qwenApiKey: 'qwen-key', qwenOnly: true, governance }, (log) => logs.push(log));

    await runtime.generate({ task: 'fridge_chat', input: 'hello' });
    expect(logs[0]).toMatchObject({ task: 'fridge_chat', inputTokens: 100, outputTokens: 25 });
    expect(logs[0]?.estimatedCostUsd).toBe(calculateEstimatedCost(
      governance, 'qwen3.7-flash-2026-07-15', 100, 25, 40,
    ));
  });

  it('uses Qwen Fast for unknown ingredient normalization and rejects unknown IDs', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ canonicalId: 'CHICKEN_BREAST', confidence: 0.88 }));
    const router = new AIRouter({ qwenApiKey: 'qwen-key', qwenOnly: true });

    await expect(router.normalizeIngredient('鶏むね肉')).resolves.toEqual({
      canonicalId: 'CHICKEN_BREAST', confidence: 0.88,
    });
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(request.model).toBe('qwen3.7-flash-2026-07-15');
    expect(JSON.stringify(request.messages)).toContain('鶏むね肉');

    fetchMock.mockResolvedValueOnce(response({ canonicalId: 'NOT_IN_CATALOG', confidence: 0.99 }));
    await expect(router.normalizeIngredient('unknown-name')).resolves.toEqual({ canonicalId: null, confidence: 0 });
  });

  it('aggregates task and physical-model usage without retaining content', () => {
    const ledger = new AIUsageLedger();
    ledger.record({
      task: 'receipt_ocr', provider: 'qwen', model: 'qwen-vl-ocr', physicalModel: 'qwen-vl-ocr',
      inputTokens: 100, outputTokens: 20, estimatedCost: 0.01, estimatedCostUsd: 0.01,
      latencyMs: 15, attempt: 2, escalationReason: 'bounded_repair', status: 'error',
      failureCode: 'SCHEMA_VALIDATION', createdAt: new Date().toISOString(),
    });
    const snapshot = ledger.snapshot();
    expect(snapshot.callsByTask.receipt_ocr).toBe(1);
    expect(snapshot.callsByModel['qwen-vl-ocr']).toBe(1);
    expect(snapshot.inputTokensByModel['qwen-vl-ocr']).toBe(100);
    expect(snapshot.schemaFailures).toBe(1);
    expect(snapshot.retries).toBe(1);
    expect(snapshot.ocrFailures).toBe(1);
  });

  it('counts only controlled model escalations separately from repair retries', () => {
    const ledger = new AIUsageLedger();
    const base = {
      provider: 'qwen', model: 'qwen3.7-flash-2026-07-15', physicalModel: 'qwen3.7-flash-2026-07-15',
      inputTokens: 10, outputTokens: 5, estimatedCost: 0, estimatedCostUsd: 0, latencyMs: 1,
      status: 'error' as const, createdAt: new Date().toISOString(),
    };
    ledger.record({ ...base, task: 'receipt_ocr', attempt: 2, escalationReason: 'bounded_repair' });
    ledger.record({ ...base, task: 'receipt_ocr', attempt: 3, escalationReason: 'controlled_escalation' });
    expect(ledger.snapshot()).toMatchObject({ retries: 2, escalations: 1 });
  });

  it('reserves the operation budget before launching an optional shadow call', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response('hello', {
      prompt_tokens: 10, completion_tokens: 5,
    }));
    const governance = createGovernanceConfig({
      AI_SHADOW_CANARY_PERCENT: '100',
      AI_MAX_CALLS_PER_OPERATION: '2',
      AI_MAX_TOTAL_TOKENS: '1024',
    }, { qwenOnly: true });
    const logs: Array<{ physicalModel?: string; escalationReason?: string }> = [];
    const runtime = new QwenTaskRuntime(
      { qwenApiKey: 'qwen-key', qwenOnly: true, governance },
      (log) => logs.push(log),
    );

    await runtime.generate({ task: 'fridge_chat', input: 'hello' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(logs.filter((log) => log.escalationReason === 'shadow_canary')).toHaveLength(1);
    expect(logs.find((log) => log.escalationReason === 'shadow_canary')?.physicalModel)
      .toBe('qwen3.7-flash');
  });
});
