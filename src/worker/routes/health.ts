import { Hono } from 'hono';
import { Env } from '../types';
import { getAIServiceStatus, validateEnvironment } from '../config/validation';

/**
 * Public observability endpoints, mounted OUTSIDE the auth-protected API
 * router so load balancers and operators can reach them without a JWT.
 * Everything here is sanitized: statuses and feature flags only — never
 * secret values, token material, or binding identifiers.
 */

export const healthRoutes = new Hono<{ Bindings: Env }>();

// Public liveness: disclose as little as possible.
healthRoutes.get('/health', (c) => {
  return c.json({
    status: 'ok',
    app: 'Frigo',
    timestamp: new Date().toISOString(),
  });
});

// Public readiness: sanitized service states + configuration issue codes.
// `unhealthy` means an essential dependency or production configuration is
// broken; `degraded` keeps serving but reports warnings.
healthRoutes.get('/health/ready', async (c) => {
  const env = c.env;

  let database: 'ok' | 'error' = 'ok';
  if (env.DB) {
    try {
      await env.DB.prepare('SELECT 1 AS ok').first();
      // Candidate scan paths read these additive columns before any provider
      // call; fail readiness instead of accepting traffic against schema 0022.
      await env.DB.prepare(
        'SELECT request_fingerprint, image_mime_type FROM scans LIMIT 0',
      ).all();
    } catch {
      database = 'error';
    }
  } else {
    database = 'error';
  }

  const config = validateEnvironment(env);
  const unhealthy = config.fatal.length > 0 || database === 'error';

  return c.json(
    {
      status: unhealthy ? 'unhealthy' : config.warnings.length > 0 ? 'degraded' : 'ok',
      app: 'Frigo',
      version: '0.1.0',
      commit: env.GIT_COMMIT || null,
      timestamp: new Date().toISOString(),
      environment: env.ENVIRONMENT || 'development',
      services: {
        database,
        queue: env.SCAN_QUEUE ? 'ok' : env.SCAN_QUEUE_MODE === 'async' ? 'error' : 'disabled',
        // Reflect the providers AIRouter can actually construct. In
        // particular, a native AI binding alone is not an OCR capability when
        // its explicit fallback flag is disabled.
        ai: getAIServiceStatus(env),
        email: env.SEND_EMAIL || env.RESEND_API_KEY ? 'configured' : 'disabled',
        rateLimiting: env.CACHE
          ? env.RATE_LIMIT_ENFORCEMENT === 'fail-closed'
            ? 'kv-fail-closed'
            : 'kv-best-effort'
          : 'isolate-local',
      },
      config: {
        ok: config.ok,
        issues: [...config.fatal, ...config.warnings].map((issue) => ({
          code: issue.code,
          severity: issue.severity,
        })),
      },
    },
    unhealthy ? 503 : 200
  );
});

// SEC-6: public config for client-side Turnstile widget. siteKey is null when
// Turnstile is not configured, and the client skips the widget entirely.
healthRoutes.get('/config', (c) => {
  return c.json({
    turnstileSiteKey: c.env.TURNSTILE_SITE_KEY || null,
  });
});
