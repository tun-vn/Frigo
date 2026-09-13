import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteD1 } from '../helpers/sqlite-d1';
import { fetchWorker } from '../helpers/worker-fetch.mjs';
import { MealPlanDtoSchema, PlanShoppingDtoSchema } from '../../packages/domain/src/meal-planning-api';
import { CurrentMealPlanDtoSchema, PlanAlternativesDtoSchema, PlanExplanationDtoSchema } from '../../packages/domain/src/meal-planning-presentation';
import { createPreviewCache, createPreviewControls, issuePreviewSession, PREVIEW_USER_ID, previewFixtureState, seedPlannerPreview } from '../../scripts/planner-preview-fixtures.mjs';

vi.mock('../../src/worker/services/email', () => ({ sendEmail: vi.fn(), buildOtpEmail: vi.fn() }));

const ORIGIN = 'https://planner-preview.example.test';
const PREFIX = '/api/v1/meal-planning/plans';
const tomorrow = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
const dates = Array.from({ length: 7 }, (_, index) => new Date(`${tomorrow}T00:00:00Z`).getTime() + index * 86400_000)
  .map((instant) => new Date(instant).toISOString().slice(0, 10));
const intent = { startDate: tomorrow, horizonDays: 7, utcOffsetMinutes: 0, defaultServings: 2, mode: 'shopping_allowed',
  slots: dates.map((date) => ({ date, mealType: 'dinner' })) };
let db;
let env;
let controls;
let cookie;

beforeEach(() => {
  db = new SqliteD1();
  seedPlannerPreview(db);
  env = { DB: db, CACHE: createPreviewCache(), APP_URL: ORIGIN, ENVIRONMENT: 'development', MEAL_PLANNER_ENABLED: 'true', AI_MOCK_MODE: 'true' };
  controls = createPreviewControls({ getDatabase: () => db, resetDatabase: () => {
    db.close();
    db = new SqliteD1();
    seedPlannerPreview(db);
    env.DB = db;
    env.CACHE = createPreviewCache();
  } });
  cookie = issuePreviewSession(db).split(';')[0];
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('External network disabled in isolated preview'));
});
afterEach(() => { db.close(); vi.restoreAllMocks(); });

function request(path, body, extraHeaders = {}) {
  return new Request(`${ORIGIN}${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { Origin: ORIGIN, Cookie: cookie, 'Content-Type': 'application/json',
      'Idempotency-Key': 'preview-e2e-default', ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body) });
}
async function api(suffix, body, headers) {
  return fetchWorker(request(`${PREFIX}${suffix}`, body, headers), env);
}
async function generated() {
  const response = await api('', intent);
  expect(response.status, await response.clone().text()).toBe(200);
  return MealPlanDtoSchema.parse(await response.json());
}

describe('isolated planner preview using real registered Worker sessions and T02–T05', () => {
  it('expires and deletes preview cache entries without mutating stored JSON on read', async () => {
    let now = 100_000;
    const cache = createPreviewCache(() => now);
    await cache.put('temporary', JSON.stringify({ count: 1 }), { expirationTtl: 60 });
    const read = await cache.get('temporary', 'json');
    read.count = 2;
    expect(await cache.get('temporary', 'json')).toEqual({ count: 1 });
    now += 60_000;
    expect(await cache.get('temporary')).toBeNull();
    await cache.put('absolute', 'value', { expiration: 170 });
    expect(await cache.get('absolute')).toBe('value');
    now = 170_000;
    expect(await cache.get('absolute')).toBeNull();
    await cache.put('deleted', 'value');
    await cache.delete('deleted');
    expect(await cache.get('deleted')).toBeNull();
  });

  it('replays all migrations and seeds idempotently without retaining a plaintext session', async () => {
    const before = previewFixtureState(db);
    seedPlannerPreview(db);
    expect(previewFixtureState(db)).toEqual(before);
    expect(db.migrations.at(-1)).toBe('0023_scan_request_fingerprint.sql');
    const token = cookie.split('=')[1];
    expect(db.query('SELECT token_hash FROM sessions_v2')[0].token_hash).not.toBe(token);
    expect(db.query('PRAGMA foreign_key_check')).toEqual([]);
    const response = await fetchWorker(request('/api/v1/me'), env);
    expect(response.status).toBe(200);
    expect((await response.json()).user).toMatchObject({ id: PREVIEW_USER_ID, isGuest: false });
  });

  it('generates a real seven-meal plan, restores it, shops with unknown prices, swaps and records cooked without consuming inventory', async () => {
    const before = previewFixtureState(db);
    expect(CurrentMealPlanDtoSchema.parse(await (await api('/current')).json())).toEqual({ plan: null });
    const plan = await generated();
    expect(plan.result.status).toBe('feasible');
    expect(plan.result.meals).toHaveLength(7);
    expect(new Set(plan.result.meals.map((meal) => meal.source.id)).size).toBeGreaterThan(1);
    expect(plan.result.meals.every((meal) => meal.instructions.length > 0)).toBe(true);
    const restored = await api(`/${plan.id}`);
    expect(restored.status).toBe(200);
    expect((await restored.json()).result.meals).toEqual(plan.result.meals);
    const shoppingResponse = await api(`/${plan.id}/shopping`, {
      revision: 1, currency: 'VND', budget: { mode: 'soft', money: { currency: 'VND', minorAmount: '500000' } },
    });
    expect(shoppingResponse.status, await shoppingResponse.clone().text()).toBe(200);
    const shopping = PlanShoppingDtoSchema.parse(await shoppingResponse.json());
    expect(shopping.result.cost.totalCost).toBeNull();
    expect(shopping.result.cost.unknownCostItemCount).toBeGreaterThan(0);
    expect(shopping.result.budget.status).toBe('unknown');
    const meal = plan.result.meals[0];
    const alternativesResponse = await api(`/${plan.id}/alternatives?revision=1`);
    expect(alternativesResponse.status).toBe(200);
    const alternatives = PlanAlternativesDtoSchema.parse(await alternativesResponse.json());
    const replacement = alternatives.alternatives.find(({ id }) => id !== meal.source.id).id;
    const swapped = await api(`/${plan.id}/swap`, { revision: 1, slotId: meal.slotId, replacement: { kind: 'recipe', id: replacement } });
    expect(swapped.status, await swapped.clone().text()).toBe(200);
    const revised = MealPlanDtoSchema.parse(await swapped.json());
    expect(revised.revision).toBe(2);
    expect(revised.result.meals[0].source.id).toBe(replacement);
    expect(revised.result.meals).toHaveLength(7);
    const explanationResponse = await api(`/${plan.id}/explanation`, { revision: 2, slotId: meal.slotId, locale: 'vi' });
    expect(explanationResponse.status).toBe(200);
    const explanation = PlanExplanationDtoSchema.parse(await explanationResponse.json());
    expect(explanation.source).toBe('deterministic');
    expect(explanation.fallbackReason).toBe('disabled');
    expect(new Set(explanation.reasonCodes)).toEqual(new Set(revised.result.meals[0].reasons));
    const swappedFeedback = await api(`/${plan.id}/feedback`, { revision: 2, slotId: meal.slotId, type: 'swapped' },
      { 'Idempotency-Key': 'preview-e2e-swapped-feedback' });
    expect(swappedFeedback.status).toBe(200);
    const cooked = await api(`/${plan.id}/feedback`, { revision: 2, slotId: meal.slotId, type: 'cooked' });
    expect(cooked.status, await cooked.clone().text()).toBe(200);
    expect(await cooked.json()).toMatchObject({ inventoryMutated: false });
    const after = previewFixtureState(db);
    expect(after.inventory).toEqual(before.inventory);
    expect(after.inventoryEventCount).toBe(before.inventoryEventCount);
    expect(after.cookedMealCount).toBe(before.cookedMealCount);
    const login = await controls(request('/__preview/login', {}, { Accept: 'application/json' }));
    cookie = login.headers.get('Set-Cookie').split(';')[0];
    const currentResponse = await api('/current');
    expect(currentResponse.status).toBe(200);
    const current = CurrentMealPlanDtoSchema.parse(await currentResponse.json());
    expect(current.plan).toMatchObject({ id: plan.id, revision: 2 });
    expect(current.plan.result.meals).toEqual(revised.result.meals);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  }, 30_000);

  it('does not hide stale source state and recovers through regeneration', async () => {
    const plan = await generated();
    expect((await controls(request('/__preview/stale-inventory', {}))).status).toBe(200);
    const stale = await api(`/${plan.id}/shopping`, { revision: 1, currency: 'VND' });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: 'PLAN_REVALIDATION_REQUIRED' });
    const regenerated = await api(`/${plan.id}/regenerate`, { revision: 1 });
    expect(regenerated.status, await regenerated.clone().text()).toBe(200);
    expect((await regenerated.json()).revision).toBe(2);
    const obsolete = await api(`/${plan.id}/shopping`, { revision: 1, currency: 'VND' });
    expect(obsolete.status).toBe(409);
    expect(await obsolete.json()).toMatchObject({ code: 'PLAN_REVISION_CONFLICT' });
    const updated = await api(`/${plan.id}/shopping`, { revision: 2, currency: 'VND' });
    expect(updated.status).toBe(200);
    expect(PlanShoppingDtoSchema.parse(await updated.json())).toMatchObject({ planId: plan.id, planRevision: 2 });
  }, 30_000);

  it.each(['liked', 'disliked', 'skipped'])('persists %s feedback once without inventory or cooking side effects', async (type) => {
    const plan = await generated();
    const before = previewFixtureState(db);
    const payload = { revision: 1, slotId: plan.result.meals[0].slotId, type };
    const response = await api(`/${plan.id}/feedback`, payload);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ inventoryMutated: false });
    const replay = await api(`/${plan.id}/feedback`, payload);
    expect(replay.status).toBe(200);
    expect(db.query('SELECT event_type, target_recipe_id FROM recipe_feedback_events WHERE user_id = ?', PREVIEW_USER_ID))
      .toEqual([{ event_type: type, target_recipe_id: plan.result.meals[0].source.id }]);
    expect(previewFixtureState(db)).toEqual(before);
  });

  it('reports an infeasible cook-now plan instead of manufacturing missing stock', async () => {
    const response = await api('', { ...intent, mode: 'cook_now' });
    expect(response.status, await response.clone().text()).toBe(200);
    const plan = MealPlanDtoSchema.parse(await response.json());
    expect(plan.result.meals).toHaveLength(0);
    expect(plan.result.conclusion).toBe('proven_infeasible');
    expect(plan.result.unplannedSlots).toHaveLength(7);
  });

  it('keeps actual Worker authorization, CSRF and feature-off gates intact', async () => {
    expect((await api('', intent, { Cookie: '' })).status).toBe(401);
    expect((await api('', intent, { Origin: 'https://attacker.example.test' })).status).toBe(403);
    expect((await api('', intent, { 'X-Frigo-Expected-User-Id': 'other-user' })).status).toBe(403);
    env.MEAL_PLANNER_ENABLED = 'false';
    expect((await api('', intent)).status).toBe(404);
  });

  it('provides same-origin POST-only login with the actual secure HttpOnly session cookie', async () => {
    const response = await controls(request('/__preview/login', {}, { Accept: 'application/json' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('Set-Cookie')).toMatch(/^__Host-frigo_session=[0-9a-f]{64}; Path=\/; HttpOnly; Secure; SameSite=Lax;/);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(JSON.stringify(await response.json())).not.toContain('__Host-frigo_session');
    const form = await controls(request('/__preview/login', {}));
    expect(form.status).toBe(303);
    expect(form.headers.get('Location')).toBe('/__preview/ready');
    const bootstrap = await controls(request('/__preview/session.js'));
    const source = await bootstrap.text();
    expect(source).toContain("fetch('/api/v1/me'");
    expect(source).toContain('setAuthSession');
    expect(source).not.toContain(PREVIEW_USER_ID);
  });

  it.each(['/__preview/login', '/__preview/reset', '/__preview/state', '/__preview/stale-inventory'])
  ('blocks GET, absent origin, cross-site and same-site sibling-origin access to %s', async (path) => {
    const before = previewFixtureState(db);
    const sessionCount = db.query('SELECT COUNT(*) AS count FROM sessions_v2')[0].count;
    expect((await controls(request(path))).status).toBe(405);
    expect((await controls(request(path, {}, { Origin: '' }))).status).toBe(403);
    expect((await controls(request(path, {}, { Origin: 'https://attacker.example.test' }))).status).toBe(403);
    expect((await controls(request(path, {}, { 'Sec-Fetch-Site': 'cross-site' }))).status).toBe(403);
    expect((await controls(request(path, {}, { 'Sec-Fetch-Site': 'same-site' }))).status).toBe(403);
    expect(previewFixtureState(db)).toEqual(before);
    expect(db.query('SELECT COUNT(*) AS count FROM sessions_v2')[0].count).toBe(sessionCount);
  });

  it('resets the entire in-memory namespace repeatably and revokes prior sessions', async () => {
    const before = previewFixtureState(db);
    await generated();
    const reset = await controls(request('/__preview/reset', {}, { Accept: 'application/json' }));
    expect(reset.status).toBe(200);
    expect(previewFixtureState(db)).toEqual(before);
    expect((await fetchWorker(request('/api/v1/me'), env)).status).toBe(401);
    cookie = reset.headers.get('Set-Cookie').split(';')[0];
    expect((await fetchWorker(request('/api/v1/me'), env)).status).toBe(200);
    expect((await controls(request('/__preview/reset', {}, { Accept: 'application/json' }))).status).toBe(200);
    expect(previewFixtureState(db)).toEqual(before);
  }, 30_000);

  it('resets preview rate-limit state without bypassing the real Worker limiter', async () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      await api('', { invalid: true });
    }
    expect((await api('', { invalid: true })).status).toBe(429);
    const reset = await controls(request('/__preview/reset', {}, { Accept: 'application/json' }));
    cookie = reset.headers.get('Set-Cookie').split(';')[0];
    expect((await api('', { invalid: true })).status).toBe(422);
  });

  it('does not register local controls on the production Worker', async () => {
    const localPage = await controls(request('/__preview'));
    expect(localPage.status).toBe(200);
    expect(await controls(request('/api/v1/me'))).toBeNull();
    const direct = await fetchWorker(request('/__preview/login', {}), env);
    expect(direct.status).toBe(404);
    expect(direct.headers.get('Set-Cookie')).toBeNull();
  });
});
