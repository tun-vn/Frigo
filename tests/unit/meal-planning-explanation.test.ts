import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlanExplanationDtoSchema, PlanExplanationRequestSchema } from '../../packages/domain/src/meal-planning-presentation';
import {
  createExplanationTransport, explainMealReasons, EXPLANATION_MAX_TOKENS, EXPLANATION_TIMEOUT_MS,
} from '../../src/worker/services/meal-planning-explanation';

const input = {
  planId: '10000000-0000-4000-8000-000000000001', planRevision: 2,
  slotId: '2030-01-02:dinner:0', locale: 'vi' as const,
  reasonCodes: ['REQUIRES_SHOPPING', 'NUTRITION_DATA_UNKNOWN'], enabled: true,
};
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('grounded meal explanation selection', () => {
  it('is deterministic and does not call AI when disabled', async () => {
    const transport = vi.fn();
    const output = await explainMealReasons({ ...input, enabled: false, transport });
    expect(output).toEqual({
      planId: input.planId, planRevision: 2, slotId: input.slotId,
      source: 'deterministic', reasonCodes: input.reasonCodes, fallbackReason: 'disabled',
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it('accepts only a permutation of all grounded IDs, preserving uncertainty', async () => {
    const transport = vi.fn(async () => JSON.stringify({ reasonCodes: [...input.reasonCodes].reverse() }));
    const output = await explainMealReasons({ ...input, transport });
    expect(PlanExplanationDtoSchema.parse(output)).toMatchObject({
      source: 'ai', reasonCodes: ['NUTRITION_DATA_UNKNOWN', 'REQUIRES_SHOPPING'], fallbackReason: null,
    });
    expect(transport).toHaveBeenCalledExactlyOnceWith({ locale: 'vi', reasonCodes: input.reasonCodes });
  });

  it.each([
    ['non-JSON', 'AI knows the cost is zero', 'invalid_output'],
    ['HTML', '<script>alert(1)</script>', 'invalid_output'],
    ['markdown JSON', '```json\n{"reasonCodes":[]}\n```', 'invalid_output'],
    ['extra prose', JSON.stringify({ reasonCodes: input.reasonCodes, text: 'Allergy safe' }), 'invalid_output'],
    ['wrong type', { reasonCodes: input.reasonCodes }, 'invalid_output'],
    ['duplicate IDs', JSON.stringify({ reasonCodes: ['REQUIRES_SHOPPING', 'REQUIRES_SHOPPING'] }), 'invalid_output'],
    ['invented ID', JSON.stringify({ reasonCodes: ['ALLERGEN_SAFE', 'NUTRITION_DATA_UNKNOWN'] }), 'ungrounded_output'],
    ['omitted uncertainty', JSON.stringify({ reasonCodes: ['REQUIRES_SHOPPING'] }), 'ungrounded_output'],
    ['empty selection', JSON.stringify({ reasonCodes: [] }), 'ungrounded_output'],
    ['oversized response', 'x'.repeat(16_385), 'invalid_output'],
  ])('falls back for %s without forwarding the rejected output', async (_name, response, fallbackReason) => {
    const output = await explainMealReasons({ ...input, transport: async () => response });
    expect(output).toMatchObject({ source: 'deterministic', reasonCodes: input.reasonCodes, fallbackReason });
    expect(Object.keys(output).sort()).toEqual(['fallbackReason', 'planId', 'planRevision', 'reasonCodes', 'slotId', 'source']);
  });

  it('falls back for missing provider, outage and no facts without inventing a reason', async () => {
    expect((await explainMealReasons(input)).fallbackReason).toBe('provider_unavailable');
    expect((await explainMealReasons({ ...input, transport: async () => { throw new Error('private provider detail'); } })).fallbackReason)
      .toBe('provider_unavailable');
    const transport = vi.fn();
    expect((await explainMealReasons({ ...input, reasonCodes: [], transport })).fallbackReason).toBe('no_facts');
    expect(transport).not.toHaveBeenCalled();
  });

  it('bounds response wait and never retries after timeout', async () => {
    vi.useFakeTimers();
    const transport = vi.fn(() => new Promise<never>(() => {}));
    const pending = explainMealReasons({ ...input, transport });
    await vi.advanceTimersByTimeAsync(EXPLANATION_TIMEOUT_MS);
    expect(await pending).toMatchObject({ source: 'deterministic', reasonCodes: input.reasonCodes, fallbackReason: 'timeout' });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('validates strict intent and response provenance combinations', () => {
    const request = { revision: 2, slotId: input.slotId, locale: 'en' };
    expect(PlanExplanationRequestSchema.safeParse(request).success).toBe(true);
    for (const invalid of [{ ...request, locale: 'ja' }, { ...request, revision: '2' },
      { ...request, facts: input.reasonCodes }, { ...request, householdId: 'other' }]) {
      expect(PlanExplanationRequestSchema.safeParse(invalid).success).toBe(false);
    }
    const response = { planId: input.planId, planRevision: input.planRevision, slotId: input.slotId,
      reasonCodes: input.reasonCodes, source: 'ai', fallbackReason: null };
    expect(PlanExplanationDtoSchema.safeParse(response).success).toBe(true);
    expect(PlanExplanationDtoSchema.safeParse({ ...response, fallbackReason: 'timeout' }).success).toBe(false);
    expect(PlanExplanationDtoSchema.safeParse({ ...response, source: 'deterministic' }).success).toBe(false);
  });
});

describe('existing AI router/native transport', () => {
  it('uses one bounded native request with structured IDs only, no tools or provider fallback', async () => {
    const run = vi.fn(async () => ({ response: JSON.stringify({ reasonCodes: input.reasonCodes }) }));
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('External transport forbidden'));
    const output = await explainMealReasons({ ...input, locale: 'en', transport: createExplanationTransport({ AI: { run }, AI_QWEN_ONLY: 'false' }) });
    expect(output.source).toBe('ai');
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith('@cf/meta/llama-3.1-8b-instruct', {
      messages: [
        { role: 'system', content: expect.stringContaining('no tools or mutation authority') },
        { role: 'user', content: JSON.stringify({ locale: 'en', reasonCodes: input.reasonCodes }) },
      ],
      max_tokens: EXPLANATION_MAX_TOKENS, temperature: 0,
    });
    expect(network).not.toHaveBeenCalled();
  });

  it('does not mistake friendly legacy-provider outage text for AI success', async () => {
    const run = vi.fn(async () => { throw new Error('private failure'); });
    const output = await explainMealReasons({ ...input, transport: createExplanationTransport({ AI: { run }, AI_QWEN_ONLY: 'false' }) });
    expect(output).toMatchObject({ source: 'deterministic', fallbackReason: 'provider_unavailable' });
    expect(JSON.stringify(output)).not.toContain('private failure');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not fabricate a provider when absent or mock mode is enabled', () => {
    expect(createExplanationTransport({})).toBeUndefined();
    expect(createExplanationTransport({ AI: { run: vi.fn() }, AI_MOCK_MODE: 'true' })).toBeUndefined();
  });
});
