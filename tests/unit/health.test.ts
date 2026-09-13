import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { productionConfigGate } from '../../src/worker/middleware/config-gate';
import { healthRoutes } from '../../src/worker/routes/health';
import type { Env } from '../../src/worker/types';

function healthyDb(): Env['DB'] {
  return {
    prepare() {
      return {
        bind() {
          return this;
        },
        first: async () => ({ ok: 1 }),
        run: async () => ({ success: true, meta: { changes: 0 } }),
        all: async () => ({ results: [], success: true, meta: {} }),
      };
    },
    batch: async () => [],
    exec: async () => ({ count: 0, duration: 0 }),
  } as unknown as Env['DB'];
}

function schemaMismatchDb(): Env['DB'] {
  return {
    prepare(sql: string) {
      if (sql.includes('request_fingerprint')) throw new Error('missing migration 0023');
      return {
        bind() {
          return this;
        },
        first: async () => ({ ok: 1 }),
        run: async () => ({ success: true, meta: { changes: 0 } }),
        all: async () => ({ results: [], success: true, meta: {} }),
      };
    },
    batch: async () => [],
    exec: async () => ({ count: 0, duration: 0 }),
  } as unknown as Env['DB'];
}

const SECRETS_IN_ENV: Partial<Env> = {
  RESEND_API_KEY: 're_sk_do_not_leak_1234567890',
  TURNSTILE_SECRET_KEY: '0xturnstile_secret_do_not_leak',
  JWT_SECRET: 'jwt_secret_do_not_leak_0123456789abcdef',
  OTP_HASH_SECRET: 'otp_secret_do_not_leak_0123456789abcdef',
  PLUS_GRANT_SECRET: 'plus_grant_do_not_leak',
};

// Mirrors the production wiring: config gate first, then the public
// observability router mounted under /api/v1.
function createApp() {
  const app = new Hono<{ Bindings: Env; Variables: { requestId: string } }>();
  app.use('*', productionConfigGate);
  app.route('/api/v1', healthRoutes);
  return app;
}

async function fetchReady(app: ReturnType<typeof createApp>, env: Partial<Env>): Promise<Response> {
  return app.request('/api/v1/health/ready', { method: 'GET' }, { IMAGES: {} as Env['IMAGES'], ...env } as Env);
}

async function fetchHealth(app: ReturnType<typeof createApp>, env: Partial<Env>): Promise<Response> {
  return app.request('/api/v1/health', { method: 'GET' }, { IMAGES: {} as Env['IMAGES'], ...env } as Env);
}

describe('health endpoints', () => {
  it('public liveness returns a minimal ok payload', async () => {
    const app = createApp();
    const response = await fetchHealth(app, { ENVIRONMENT: 'development' });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ status: 'ok', app: 'Frigo' });
    expect(Object.keys(body as object).sort()).toEqual(['app', 'status', 'timestamp']);
  });

  it('readiness reports ok with healthy database and exposes deployment traceability', async () => {
    const app = createApp();
    const response = await fetchReady(app, {
      ENVIRONMENT: 'production',
      DB: healthyDb(),
      GIT_COMMIT: 'abc1234def5678',
      AI_MOCK_MODE: 'false',
      AI: undefined,
      QWEN_API_KEY: 'qwen-test-key',
      SCAN_QUEUE: {} as unknown as Env['SCAN_QUEUE'],
      SCAN_QUEUE_MODE: 'async',
      WEEK_SCHEMA_MODE: 'dual',
      CACHE: {} as unknown as Env['CACHE'],
      JWT_SECRET: 's'.repeat(40),
      OTP_HASH_SECRET: 'otp'.repeat(16),
      APP_URL: 'https://frigo.example.com',
      TURNSTILE_SITE_KEY: '0xpublic_site_key_not_secret',
      ...SECRETS_IN_ENV,
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect((body.services as Record<string, unknown>).database).toBe('ok');
    expect(body.commit).toBe('abc1234def5678');
  });

  it('readiness reports degraded when optional dependencies are missing, without failing liveness', async () => {
    const app = createApp();
    const response = await fetchReady(app, {
      ENVIRONMENT: 'production',
      DB: healthyDb(),
      AI_MOCK_MODE: 'false',
      AI: undefined,
      QWEN_API_KEY: 'qwen-test-key',
      SCAN_QUEUE: {} as unknown as Env['SCAN_QUEUE'],
      SCAN_QUEUE_MODE: 'async',
      WEEK_SCHEMA_MODE: 'dual',
      CACHE: {} as unknown as Env['CACHE'],
      JWT_SECRET: 's'.repeat(40),
      OTP_HASH_SECRET: 'otp'.repeat(16),
      APP_URL: 'https://frigo.example.com',
      // No email provider and no Plus grant secret: warnings only, not fatal.
      TURNSTILE_SITE_KEY: 'test-site-key',
      TURNSTILE_SECRET_KEY: 'test-secret-key',
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.status).toBe('degraded');
  });

  it('readiness reports unhealthy when the database is unreachable', async () => {
    const app = createApp();
    const response = await fetchReady(app, {
      ENVIRONMENT: 'development',
      DB: {
        prepare: () => {
          throw new Error('D1 down');
        },
      } as unknown as Env['DB'],
    });
    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.status).toBe('unhealthy');
    expect((body.services as Record<string, unknown>).database).toBe('error');
  });

  it('readiness reports unhealthy when scan fingerprint migration is missing', async () => {
    const app = createApp();
    const response = await fetchReady(app, {
      ENVIRONMENT: 'development',
      DB: schemaMismatchDb(),
    });
    expect(response.status).toBe(503);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      status: 'unhealthy',
      services: { database: 'error' },
    });
  });

  it('readiness never leaks secret values', async () => {
    const app = createApp();
    const response = await fetchReady(app, {
      ENVIRONMENT: 'production',
      DB: healthyDb(),
      AI_MOCK_MODE: 'false',
      AI: undefined,
      QWEN_API_KEY: 'qwen-test-key',
      SCAN_QUEUE: {} as unknown as Env['SCAN_QUEUE'],
      SCAN_QUEUE_MODE: 'async',
      WEEK_SCHEMA_MODE: 'dual',
      CACHE: {} as unknown as Env['CACHE'],
      JWT_SECRET: 's'.repeat(40),
      OTP_HASH_SECRET: 'otp'.repeat(16),
      APP_URL: 'https://frigo.example.com',
      ...SECRETS_IN_ENV,
    });
    const text = await response.text();
    for (const secret of Object.values(SECRETS_IN_ENV)) {
      expect(text).not.toContain(secret as string);
    }
  });

  it('production gate fails closed with sanitized diagnostics on dangerous configuration', async () => {
    const app = createApp();
    const response = await fetchHealth(app, { ENVIRONMENT: 'production', AI_MOCK_MODE: 'true' });
    expect(response.status).toBe(503);
    const body = (await response.json()) as { code: string; issues: string[] };
    expect(body.code).toBe('CONFIG_INVALID');
    expect(body.issues).toContain('CONFIG_MOCK_MODE_IN_PRODUCTION');
    expect(body.issues).toContain('CONFIG_BINDING_DB_MISSING');
  });

  it('production gate passes valid configuration through to liveness', async () => {
    const app = createApp();
    const response = await fetchHealth(app, {
      ENVIRONMENT: 'production',
      AI_MOCK_MODE: 'false',
      AI: undefined,
      QWEN_API_KEY: 'qwen-test-key',
      SCAN_QUEUE: {} as unknown as Env['SCAN_QUEUE'],
      SCAN_QUEUE_MODE: 'async',
      WEEK_SCHEMA_MODE: 'dual',
      CACHE: {} as unknown as Env['CACHE'],
      DB: healthyDb(),
      JWT_SECRET: 's'.repeat(40),
      OTP_HASH_SECRET: 'otp'.repeat(16),
      APP_URL: 'https://frigo.example.com',
      TURNSTILE_SITE_KEY: 'test-site-key',
      TURNSTILE_SECRET_KEY: 'test-secret-key',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok' });
  });

  it.each([
    [{ OTP_HASH_SECRET: undefined }, 'CONFIG_OTP_HASH_SECRET_MISSING'],
    [{ APP_URL: undefined }, 'CONFIG_PRODUCTION_APP_URL'],
    [{ APP_URL: 'https://' }, 'CONFIG_PRODUCTION_APP_URL'],
  ] as const)('readiness fails closed for unusable auth configuration %j', async (overrides, code) => {
    const response = await fetchReady(createApp(), {
      ENVIRONMENT: 'production', APP_URL: 'https://frigo.example.com',
      DB: healthyDb(), CACHE: {} as Env['CACHE'], AI: undefined,
      QWEN_API_KEY: 'qwen-test-key',
      SCAN_QUEUE: {} as Env['SCAN_QUEUE'], SCAN_QUEUE_MODE: 'async',
      WEEK_SCHEMA_MODE: 'dual', AI_MOCK_MODE: 'false',
      JWT_SECRET: 's'.repeat(40), OTP_HASH_SECRET: 'otp'.repeat(16),
      ...overrides,
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'CONFIG_INVALID', issues: expect.arrayContaining([code]) });
  });

  it('reports AI as disabled when only the native binding exists without an enabled fallback', async () => {
    const response = await fetchReady(createApp(), {
      ENVIRONMENT: 'development',
      DB: healthyDb(),
      AI: {},
      AI_MOCK_MODE: 'false',
      CLOUDFLARE_VISION_FALLBACK: 'false',
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { services: { ai: string } };
    expect(body.services.ai).toBe('disabled');
  });

  it('reports Qwen as the configured production AI capability', async () => {
    const response = await fetchReady(createApp(), {
      ENVIRONMENT: 'production',
      DB: healthyDb(),
      CACHE: {} as Env['CACHE'],
      AI_MOCK_MODE: 'false',
      QWEN_API_KEY: 'qwen-test-key',
      SCAN_QUEUE: {} as Env['SCAN_QUEUE'],
      SCAN_QUEUE_MODE: 'async',
      WEEK_SCHEMA_MODE: 'dual',
      JWT_SECRET: 's'.repeat(40),
      OTP_HASH_SECRET: 'otp'.repeat(16),
      APP_URL: 'https://frigo.example.com',
      TURNSTILE_SITE_KEY: 'test-site-key',
      TURNSTILE_SECRET_KEY: 'test-secret-key',
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect((body.services as Record<string, unknown>).ai).toBe('configured');
  });

  it('fails production readiness when Qwen is missing even if a native AI binding exists', async () => {
    const response = await fetchReady(createApp(), {
      ENVIRONMENT: 'production',
      DB: healthyDb(),
      CACHE: {} as Env['CACHE'],
      AI: {},
      AI_MOCK_MODE: 'false',
      SCAN_QUEUE: {} as Env['SCAN_QUEUE'],
      SCAN_QUEUE_MODE: 'async',
      WEEK_SCHEMA_MODE: 'dual',
      JWT_SECRET: 's'.repeat(40),
      OTP_HASH_SECRET: 'otp'.repeat(16),
      APP_URL: 'https://frigo.example.com',
      TURNSTILE_SITE_KEY: 'test-site-key',
      TURNSTILE_SECRET_KEY: 'test-secret-key',
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: 'CONFIG_INVALID',
      issues: expect.arrayContaining(['CONFIG_QWEN_API_KEY_MISSING']),
    });
  });

  it('fails production readiness when async scan image storage is missing', async () => {
    const response = await fetchReady(createApp(), {
      ENVIRONMENT: 'production',
      DB: healthyDb(),
      CACHE: {} as Env['CACHE'],
      AI_MOCK_MODE: 'false',
      QWEN_API_KEY: 'qwen-test-key',
      SCAN_QUEUE: {} as Env['SCAN_QUEUE'],
      SCAN_QUEUE_MODE: 'async',
      IMAGES: undefined,
      WEEK_SCHEMA_MODE: 'dual',
      JWT_SECRET: 's'.repeat(40),
      OTP_HASH_SECRET: 'otp'.repeat(16),
      APP_URL: 'https://frigo.example.com',
      TURNSTILE_SITE_KEY: 'test-site-key',
      TURNSTILE_SECRET_KEY: 'test-secret-key',
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: 'CONFIG_INVALID',
      issues: expect.arrayContaining(['CONFIG_SCAN_IMAGE_STORAGE_MISSING']),
    });
  });
});
