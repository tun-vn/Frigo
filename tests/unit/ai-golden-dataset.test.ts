import { describe, expect, it } from 'vitest';
import dataset from '../fixtures/ai-golden.json';
import { AI_TASKS, getTaskPolicy, defaultGovernanceConfig, buildPrompt, type AITask } from '../../packages/ai/src';

describe('offline AI golden dataset', () => {
  it('covers multilingual and failure-contract cases without live credentials', () => {
    expect(dataset.version).toMatch(/^\d{4}-\d{2}-\d{2}\.v\d+$/);
    expect(dataset.cases).toHaveLength(6);
    expect(new Set(dataset.cases.map((item) => item.locale))).toEqual(new Set(['vi', 'ja', 'en']));
    for (const item of dataset.cases) {
      expect((AI_TASKS as readonly string[])).toContain(item.task);
      expect(getTaskPolicy(defaultGovernanceConfig(), item.task as AITask).promptId).toBeTruthy();
    }
  });

  it('keeps fixtures free of real image bytes and credentials', () => {
    const serialized = JSON.stringify(dataset);
    expect(serialized).not.toMatch(/data:image|sk-[A-Za-z0-9]|Bearer\s+/i);
    expect(serialized).toContain('fixture://');
  });

  it('keeps representative planner prompts within the normal context target', () => {
    const inventory = Array.from({ length: 40 }, (_, index) => ({
      canonicalId: `ingredient_${index}`, quantity: 100 + index, unit: 'g', expiresInDays: index % 7,
    }));
    const prompt = buildPrompt('weekly_plan', JSON.stringify({ inventory, days: 7 }), 'householdSize=2');
    expect(Math.ceil(prompt.length / 4)).toBeLessThanOrEqual(8_000);
  });
});
