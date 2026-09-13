import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MealPlanningIntentSchema } from '../../packages/domain/src/meal-planning-api';
import { MealPlanningApplicationService } from '../../src/worker/services/meal-planning';
import { createMealPlanningRoutes } from '../../src/worker/routes/meal-planning';
import {
  createExplanationTransport, EXPLANATION_TIMEOUT_MS, explainMealReasons,
} from '../../src/worker/services/meal-planning-explanation';
import type { AuthContext, Env } from '../../src/worker/types';
import { SqliteD1 } from '../helpers/sqlite-d1';

const input = {
  planId: '10000000-0000-4000-8000-000000000007', planRevision: 7,
  slotId: '2030-01-02:dinner:0', locale: 'en' as const,
  reasonCodes: ['REQUIRES_SHOPPING', 'NUTRITION_DATA_UNKNOWN', 'USES_EXPIRING_INGREDIENTS'], enabled: true,
};

function flagApp(explanationTransport?: (facts: { locale: 'vi' | 'en'; reasonCodes: readonly string[] }) => Promise<unknown>) {
  const db = new SqliteD1();
  const auth: AuthContext = { userId: 'flag-user', householdId: 'flag-household', isGuest: false };
  db.seed(`INSERT INTO users (id) VALUES ('${auth.userId}');
    INSERT INTO households (id, name, created_by) VALUES ('${auth.householdId}', 'Flag household', '${auth.userId}');
    INSERT INTO household_members (id, household_id, user_id, role)
      VALUES ('flag-member', '${auth.householdId}', '${auth.userId}', 'owner');`);
  const app = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>();
  app.use('*', async (c, next) => { c.set('auth', auth); await next(); });
  app.route('/api/v1', createMealPlanningRoutes({
    now: () => new Date('2030-01-01T00:00:00.000Z'), explanationTransport,
  }));
  return { app, auth, db };
}

async function flagPlan(db: SqliteD1, auth: AuthContext) {
  db.seed(`DELETE FROM recipes;
    INSERT INTO recipes (id, slug, title, cuisine, servings, prep_time_minutes, cook_time_minutes, difficulty)
      VALUES ('flag-meal', 'flag-meal', 'Flag meal', 'viet', 2, 0, 10, 'easy');
    INSERT INTO recipe_ingredients (id, recipe_id, ingredient_id, name, required_quantity, unit, is_optional)
      VALUES ('flag-line', 'flag-meal', 'CHICKEN_BREAST', 'Chicken', 100, 'g', 0);`);
  const intent = MealPlanningIntentSchema.parse({
    startDate: '2030-01-02', horizonDays: 1, defaultServings: 2, mode: 'shopping_allowed',
    slots: [{ date: '2030-01-02', mealType: 'dinner' }],
  });
  return new MealPlanningApplicationService(db, { now: () => new Date('2030-01-01T00:00:00.000Z') })
    .generate({ userId: auth.userId, householdId: auth.householdId }, intent, 'flag-explanation-plan');
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('T07 grounded explanation audit', () => {
  it('accepts a complete reordered permutation and refuses missing, extra, or duplicate grounded IDs', async () => {
    const ordered = [...input.reasonCodes].reverse();
    const success = await explainMealReasons({ ...input, transport: async () => JSON.stringify({ reasonCodes: ordered }) });
    expect(success).toMatchObject({ source: 'ai', reasonCodes: ordered, fallbackReason: null });

    for (const [output, fallbackReason] of [
      [JSON.stringify({ reasonCodes: ordered.slice(1) }), 'ungrounded_output'],
      [JSON.stringify({ reasonCodes: [...ordered, 'FABRICATED_FACT'] }), 'ungrounded_output'],
      [JSON.stringify({ reasonCodes: [ordered[0], ordered[0], ordered[2]] }), 'invalid_output'],
    ] as const) {
      const fallback = await explainMealReasons({ ...input, transport: async () => output });
      expect(fallback).toMatchObject({ source: 'deterministic', reasonCodes: input.reasonCodes, fallbackReason });
    }
  });

  it.each([
    ['HTTP 429', new Error('429 private provider detail')],
    ['network failure', new TypeError('network unavailable')],
    ['malformed provider output', undefined],
  ] as const)('makes one bounded provider attempt and exposes no provider detail for %s', async (_name, failure) => {
    const transport = vi.fn(async () => {
      if (failure) throw failure;
      return '{not-json';
    });
    const result = await explainMealReasons({ ...input, transport });
    expect(result).toMatchObject({
      source: 'deterministic', reasonCodes: input.reasonCodes,
      fallbackReason: failure ? 'provider_unavailable' : 'invalid_output',
    });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain('private provider detail');
  });

  it('uses no external provider fallback and returns at the native response deadline without claiming cancellation', async () => {
    vi.useFakeTimers();
    const run = vi.fn(() => new Promise<never>(() => {}));
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('external transport forbidden'));
    const transport = createExplanationTransport({ AI: { run }, AI_QWEN_ONLY: 'false' });
    expect(transport).toBeDefined();

    const pending = explainMealReasons({ ...input, transport });
    await vi.advanceTimersByTimeAsync(EXPLANATION_TIMEOUT_MS);
    await expect(pending).resolves.toMatchObject({ source: 'deterministic', fallbackReason: 'timeout' });
    expect(run).toHaveBeenCalledTimes(1);
    expect(network).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('T07 planner rollout flags', () => {
  it.each([
    ['missing', undefined, 404],
    ['empty', '', 404],
    ['false', 'false', 404],
    ['invalid', 'enabled', 404],
    ['true', 'true', 200],
  ] as const)('requires the literal true backend flag (%s)', async (_name, value, expectedStatus) => {
    const { app, db } = flagApp();
    try {
      const env: Env = { DB: db, MEAL_PLANNER_ENABLED: value };
      const response = await app.request('https://frigo.example.test/api/v1/meal-planning/plans/current', undefined, env);
      expect(response.status).toBe(expectedStatus);
      if (expectedStatus === 404) expect(await response.json()).toMatchObject({ code: 'MEAL_PLANNER_DISABLED' });
      else expect(await response.json()).toEqual({ plan: null });
    } finally {
      db.close();
    }
  });

  it.each([
    ['missing', undefined, 'deterministic'],
    ['empty', '', 'deterministic'],
    ['false', 'false', 'deterministic'],
    ['invalid', 'enabled', 'deterministic'],
    ['true', 'true', 'ai'],
  ] as const)('enables AI explanation ordering only for the literal true flag (%s)', async (_name, value, source) => {
    const transport = vi.fn(async ({ reasonCodes }: { reasonCodes: readonly string[] }) => JSON.stringify({ reasonCodes }));
    const { app, auth, db } = flagApp(transport);
    try {
      const plan = await flagPlan(db, auth);
      const response = await app.fetch(new Request(`https://frigo.example.test/api/v1/meal-planning/plans/${plan.id}/explanation`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: plan.revision, slotId: plan.result.meals[0].slotId, locale: 'en' }),
      }), { DB: db, MEAL_PLANNER_ENABLED: 'true', MEAL_PLANNER_AI_ENABLED: value });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ source, fallbackReason: source === 'ai' ? null : 'disabled' });
      expect(transport).toHaveBeenCalledTimes(source === 'ai' ? 1 : 0);
    } finally {
      db.close();
    }
  });
});
