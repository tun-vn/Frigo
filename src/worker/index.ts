import { Hono } from 'hono';
import { isTrustedOrigin } from './config/origins';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { HTTPException } from 'hono/http-exception';
import { Env, AuthContext } from './types';
import { apiCsp, spaCsp } from './config/csp';
import { runScheduledCleanup } from './services/cleanup';
import { authMiddleware } from './middleware/auth';
import { productionConfigGate } from './middleware/config-gate';
import { healthRoutes } from './routes/health';
import { authRoutes } from './routes/auth';
import { inventoryRoutes } from './routes/inventory';
import { scanRoutes } from './routes/scans';
import { recipeRoutes } from './routes/recipes';
import { shoppingRoutes } from './routes/shopping';
import { preferencesRoutes } from './routes/preferences';
import { notificationRoutes } from './routes/notifications';
import { weekRoutes } from './routes/week';
import { mealPlanningRoutes } from './routes/meal-planning';
import { processScanJob, ScanQueueError } from './services/scan-queue';
import { billingRoutes } from './routes/billing';

const SCAN_RETRY_DELAY_SECONDS = 5;

type WorkerVariables = { auth: AuthContext; requestId: string };
type WorkerApp = { Bindings: Env; Variables: WorkerVariables };

const app = new Hono<WorkerApp>();

// 1. Structured request logging with correlation + traceability. Sensitive
// headers (Cookie, Authorization, tokens) are never logged.
app.use('*', async (c, next) => {
  const requestId = c.req.header('X-Request-Id') || crypto.randomUUID();
  c.set('requestId', requestId);
  const startedAt = Date.now();
  let status = 500;
  try {
    await next();
    status = c.res.status;
  } finally {
    const durationMs = Date.now() - startedAt;
    c.header('X-Request-Id', requestId);
    const environment = c.env.ENVIRONMENT || 'development';
    const record = {
      requestId,
      method: c.req.method,
      path: c.req.path,
      status,
      durationMs,
      environment,
    };
    if (environment === 'production') {
      console.log(JSON.stringify({ level: 'info', ...record }));
    } else {
      console.log(`[req] ${record.method} ${record.path} ${status} ${durationMs}ms ${requestId}`);
    }
  }
});

// 2. Global Security Middlewares
app.use('*', secureHeaders({
  xFrameOptions: 'DENY',
  xContentTypeOptions: 'nosniff',
  referrerPolicy: 'strict-origin-when-cross-origin',
}));

// SEC-7: additional security headers hono's secureHeaders doesn't cover
app.use('*', async (c, next) => {
  await next();
  c.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  c.header('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(), payment=()');
  c.header('Cross-Origin-Opener-Policy', 'same-origin');
  c.header('X-DNS-Prefetch-Control', 'off');
  // CSP: API responses get a locked-down policy; the SPA is served from the
  // same worker so it needs the full script/style/img connect allowances.
  const isApi = c.req.path.startsWith('/api/');
  c.header('Content-Security-Policy', isApi ? apiCsp() : spaCsp());
});

// 3. Production configuration gate: fail closed with a sanitized diagnostic
// when the deployment is dangerous. Development/staging are not gated.
app.use('*', productionConfigGate);

app.use('*', cors({
  origin: (origin, c) => isTrustedOrigin(origin, c.env) ? origin : undefined,
  allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  // The SPA sends tenant context headers on every request and idempotency
  // keys on durable commands. Include them in preflight responses for a
  // separately-hosted frontend as well as same-origin deployments.
  allowHeaders: ['Content-Type', 'Authorization', 'x-user-id', 'x-household-id',
    'X-Frigo-Expected-User-Id', 'X-Frigo-Expected-Household-Id', 'Idempotency-Key', 'If-Match'],
  credentials: true,
  maxAge: 86400,
}));

// 4. Global Error Handler (Sanitize internal errors in production)
app.onError((err, c) => {
  // Preserve intentional Hono errors (401/403/404/409/503, etc.). Turning
  // every exception into a 500 makes clients retry the wrong class of error
  // and hides the actual auth/tenancy contract.
  if (err instanceof HTTPException) {
    return err.getResponse();
  }

  console.error(
    JSON.stringify({
      level: 'error',
      requestId: c.get('requestId'),
      code: 'INTERNAL_SERVER_ERROR',
    })
  );
  const isProd = c.env.ENVIRONMENT === 'production';
  return c.json(
    {
      error: isProd ? 'Đã xảy ra lỗi máy chủ nội bộ' : (err.message || 'Internal Server Error'),
      code: 'INTERNAL_SERVER_ERROR',
      ...(isProd ? {} : { stack: err.stack }),
    },
    500
  );
});

// 5. Public observability (no auth): liveness, readiness, public config.
app.route('/api/v1', healthRoutes);

// 6. API v1 Router (auth-protected)
const api = new Hono<WorkerApp>();

api.use('*', authMiddleware);
api.route('/', authRoutes);
api.route('/', billingRoutes);
api.route('/', inventoryRoutes);
api.route('/', scanRoutes);
api.route('/', recipeRoutes);
api.route('/', shoppingRoutes);
api.route('/', preferencesRoutes);
api.route('/', notificationRoutes);
api.route('/', weekRoutes);
api.route('/', mealPlanningRoutes);

// Mount API under /api/v1
app.route('/api/v1', api);

// 7. Static assets fallback (SPA)
app.get('*', async (c) => {
  if (c.env.ASSETS) {
    return await c.env.ASSETS.fetch(c.req.raw);
  }
  return c.text('Frigo API Worker Running. Static assets not attached in this environment.', 200);
});

// 8. Cloudflare Worker export with queue consumer and scheduled cleanup
export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<any>, env: Env): Promise<void> {
    console.log(`[Queue] Received batch with ${batch.messages.length} messages`);
    for (const msg of batch.messages) {
      try {
        await processScanJob(env, msg.body);
        msg.ack();
      } catch (error) {
        const retryable = error instanceof ScanQueueError ? error.retryable : true;
        if (retryable) {
          console.warn('[Queue] Retryable scan job failure', error);
          msg.retry({ delaySeconds: SCAN_RETRY_DELAY_SECONDS });
        } else {
          // Permanent failures are acknowledged after being persisted as
          // failed; this prevents poison messages from blocking the queue.
          console.error('[Queue] Permanent scan job failure', error);
          msg.ack();
        }
      }
    }
  },
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    const report = await runScheduledCleanup(env);
    console.log(`[Cleanup] ${JSON.stringify(report)}`);
  },
};
