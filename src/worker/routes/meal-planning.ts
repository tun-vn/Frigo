import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { AuthContext, Env } from '../types';
import { tenancyGuard } from '../middleware/tenancy';
import { rateLimiter } from '../middleware/rate-limit';
import {
  MealPlanningIntentSchema, PlanIdSchema, PlanningRequestKeySchema, RegenerateMealPlanSchema,
  SwapMealSchema, OptimizePlanShoppingSchema, PlanFeedbackSchema,
} from '../../../packages/domain/src/meal-planning-api';
import { GeneratedMealPlanPersistenceError } from '../../../packages/db/src/meal-planning';
import { MealPlanningSnapshotAuthorizationError } from '../../../packages/db/src/meal-planning-snapshot';
import { MealPlanningApplicationService, type MealPlanningServiceOptions } from '../services/meal-planning';
import { MealPlanningError } from '../services/meal-planning-error';
import { PlanAlternativesQuerySchema, PlanExplanationRequestSchema } from '../../../packages/domain/src/meal-planning-presentation';
import { createExplanationTransport } from '../services/meal-planning-explanation';

type App = { Bindings: Env; Variables: { auth: AuthContext } };
type Ctx = Context<App>;

async function body<T extends z.ZodTypeAny>(c: Ctx, schema: T): Promise<z.output<T>> {
  let json: unknown;
  try { json = await c.req.json(); }
  catch { throw new MealPlanningError('INVALID_JSON', 400, 'Expected a JSON request body'); }
  const result = schema.safeParse(json);
  if (!result.success) throw new MealPlanningError('INVALID_REQUEST', 422, 'Request fields do not match the meal-planning contract');
  return result.data;
}

function key(c: Ctx) {
  const result = PlanningRequestKeySchema.safeParse(c.req.header('Idempotency-Key'));
  if (!result.success) throw new MealPlanningError('IDEMPOTENCY_KEY_REQUIRED', 400, 'A valid Idempotency-Key header is required');
  return result.data;
}

async function respond(c: Ctx, operation: () => Promise<unknown>) {
  try { return c.json(await operation()); }
  catch (error) {
    if (error instanceof MealPlanningError) return c.json({ code: error.code, error: error.message }, error.status);
    if (error instanceof MealPlanningSnapshotAuthorizationError) return c.json({ code: 'TENANCY_VIOLATION', error: 'Household access denied' }, 403);
    if (error instanceof GeneratedMealPlanPersistenceError) {
      const status = error.code === 'NOT_FOUND' ? 404 : error.code === 'FORBIDDEN' ? 403 : 409;
      const code = error.code === 'REVISION_CONFLICT' ? 'PLAN_REVISION_CONFLICT' : error.code;
      return c.json({ code, error: status === 404 ? 'Plan not found' : status === 403 ? 'Household access denied' : 'Request conflicts with current plan state' }, status);
    }
    console.error(JSON.stringify({ level: 'error', event: 'meal_planning_failure', code: 'MEAL_PLANNING_UNAVAILABLE' }));
    return c.json({ code: 'MEAL_PLANNING_UNAVAILABLE', error: 'Meal planning could not be completed' }, 500);
  }
}

/** Options are installed by server composition, never HTTP JSON or environment request fields. */
export function createMealPlanningRoutes(options: MealPlanningServiceOptions = {}) {
  const routes = new Hono<App>();
  routes.use('/meal-planning/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    const auth = c.get('auth');
    if (!auth?.userId) return c.json({ code: 'UNAUTHORIZED', error: 'Authentication required' }, 401);
    if (auth.isGuest) return c.json({ code: 'REGISTERED_ACCOUNT_REQUIRED', error: 'Registered household membership required' }, 403);
    if (c.env.MEAL_PLANNER_ENABLED !== 'true') return c.json({ code: 'MEAL_PLANNER_DISABLED', error: 'Meal planner is not enabled' }, 404);
    await next();
  });
  routes.use('/meal-planning/*', tenancyGuard);
  routes.use('/meal-planning/*', bodyLimit({ maxSize: 65_536, onError: (c) => c.json({ code: 'REQUEST_TOO_LARGE', error: 'Request exceeds 64 KiB' }, 413) }));
  const expensive = rateLimiter({ maxRequests: 10, windowSeconds: 60, prefix: 'meal-planning-expensive' });
  const compute = rateLimiter({ maxRequests: 10, windowSeconds: 60, prefix: 'planner-compute', scope: 'account' });
  const feedbackLimit = rateLimiter({ maxRequests: 60, windowSeconds: 60, prefix: 'meal-planning-feedback' });
  const reads = rateLimiter({ maxRequests: 60, windowSeconds: 60, prefix: 'meal-planning-read' });
  const service = (c: Ctx) => new MealPlanningApplicationService(c.env.DB, {
    ...options,
    explanationTransport: options.explanationTransport ?? createExplanationTransport(
      c.env,
      (promise) => c.executionCtx.waitUntil(promise),
    ),
  });
  const scope = (c: Ctx) => ({ householdId: c.get('auth').householdId, userId: c.get('auth').userId });
  const planId = (c: Ctx) => {
    const parsed = PlanIdSchema.safeParse(c.req.param('id'));
    if (!parsed.success) throw new MealPlanningError('INVALID_PLAN_ID', 422, 'Invalid plan ID');
    return parsed.data;
  };

  routes.post('/meal-planning/plans', compute, expensive, (c) => respond(c, async () =>
    service(c).generate(scope(c), await body(c, MealPlanningIntentSchema), key(c))));
  routes.get('/meal-planning/plans/current', reads, (c) => respond(c, () => service(c).current(scope(c))));
  routes.get('/meal-planning/plans/:id', reads, (c) => respond(c, () => service(c).get(scope(c), planId(c))));
  routes.get('/meal-planning/plans/:id/alternatives', reads, (c) => respond(c, () => {
    const parsed = PlanAlternativesQuerySchema.safeParse(c.req.query());
    if (!parsed.success || Object.values(c.req.queries()).some((values) => values.length !== 1)) {
      throw new MealPlanningError('INVALID_REQUEST', 422, 'A single positive plan revision is required');
    }
    return service(c).alternatives(scope(c), planId(c), parsed.data.revision);
  }));
  routes.post('/meal-planning/plans/:id/explanation', compute, expensive, (c) => respond(c, async () =>
    service(c).explanation(scope(c), planId(c), await body(c, PlanExplanationRequestSchema), c.env.MEAL_PLANNER_AI_ENABLED === 'true')));
  routes.post('/meal-planning/plans/:id/regenerate', compute, expensive, (c) => respond(c, async () =>
    service(c).regenerate(scope(c), planId(c), await body(c, RegenerateMealPlanSchema))));
  routes.post('/meal-planning/plans/:id/swap', compute, expensive, (c) => respond(c, async () =>
    service(c).swap(scope(c), planId(c), await body(c, SwapMealSchema))));
  routes.post('/meal-planning/plans/:id/shopping', compute, expensive, (c) => respond(c, async () =>
    service(c).shopping(scope(c), planId(c), await body(c, OptimizePlanShoppingSchema))));
  routes.post('/meal-planning/plans/:id/feedback', feedbackLimit, (c) => respond(c, async () =>
    service(c).feedback(scope(c), planId(c), await body(c, PlanFeedbackSchema), key(c))));
  return routes;
}

export const mealPlanningRoutes = createMealPlanningRoutes();
