import { expect, it, vi } from 'vitest';
import { hasTrustedOrigin } from '../../src/worker/middleware/csrf';
import worker from '../../src/worker/index';

// Keep the Worker entrypoint out of the DOM typecheck; tsconfig.worker.json checks it separately.
vi.mock('../../src/worker/services/email', () => ({ sendEmail: vi.fn(), buildOtpEmail: vi.fn() }));

it('allows both request-owner headers through the Worker CORS preflight', async () => {
  const response = await worker.fetch(new Request('http://127.0.0.1:8787/api/v1/inventory', {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://localhost:5173',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type,x-frigo-expected-user-id,x-frigo-expected-household-id',
    },
  }), { ENVIRONMENT: 'development' });
  expect(response.status).toBe(204);
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
  const allowed = response.headers.get('Access-Control-Allow-Headers')?.toLowerCase().split(',');
  expect(allowed).toEqual(expect.arrayContaining(['x-frigo-expected-user-id', 'x-frigo-expected-household-id']));
});

const production = {
  ENVIRONMENT: 'production', APP_URL: 'https://app.example.com/frigo',
  DB: {}, CACHE: {}, AI: {}, SCAN_QUEUE: {},
  QWEN_API_KEY: 'qwen-test-key',
  JWT_SECRET: 'test-only-jwt-secret'.repeat(3), OTP_HASH_SECRET: 'test-only-otp-secret',
  TURNSTILE_SITE_KEY: 'test-site', TURNSTILE_SECRET_KEY: 'test-secret',
};

it.each([
  ['production', 'https://app.example.com', true],
  ['production', 'https://app.example.com.evil.test', false],
  ['production', 'https://evil-app.example.com', false],
  ['production', 'https://app.example.com@evil.test', false],
  ['production', 'https://app.example.com/path', false],
  ['production', 'http://localhost:5173', false],
  ['production', 'https://random.example.com', false],
  ['production', 'https://frigo.tungjpstore.net', false],
  ['production', 'null', false],
  ['development', 'http://localhost:5173', true],
  ['development', 'http://127.0.0.1:8787', true],
  ['development', 'https://random.example.com', false],
  ['staging', 'http://localhost:5173', false],
])('CORS and CSRF agree: %s / %s => %s', async (ENVIRONMENT, origin, allowed) => {
  const env = { ...production, ENVIRONMENT };
  const response = await worker.fetch(new Request('https://api.example.com/api/v1/inventory', {
    method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' },
  }), env);
  expect(response.status).toBe(204);
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe(allowed ? origin : null);
  expect(response.headers.get('Access-Control-Allow-Origin')).not.toBe('*');
  expect(hasTrustedOrigin({ env, req: { header: (name) => name === 'origin' ? origin : undefined } })).toBe(allowed);
});

it('does not emit a wildcard when the request has no Origin', async () => {
  const response = await worker.fetch(new Request('https://app.example.com/api/v1/health'), production);
  expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
});
