import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { SqliteD1 } from '../helpers/sqlite-d1';
import { authMiddleware } from '../../src/worker/middleware/auth';
import { scanRoutes } from '../../src/worker/routes/scans';
import { signJwt } from '../../src/worker/utils/jwt';
import type { AuthContext, Env } from '../../src/worker/types';

const app = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>();
app.use('*', authMiddleware);
app.route('/', scanRoutes);

const USER_ID = 'scan_error_user';
const HOUSEHOLD_ID = `hh_${USER_ID}`;
const SCAN_ID = 'scan_error_case';
const JWT_SECRET = 'scan-error-test-secret-longer-than-32';

async function authHeader(): Promise<string> {
  const token = await signJwt(
    {
      sub: USER_ID,
      hid: HOUSEHOLD_ID,
      typ: 'access',
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    JWT_SECRET,
  );
  return `Bearer ${token}`;
}

describe('GET scan failure DTO', () => {
  let db: SqliteD1;

  beforeEach(() => {
    db = new SqliteD1();
    db.seed(`
      INSERT INTO users (id, email, is_guest) VALUES ('${USER_ID}', 'scan-error@example.test', 0);
      INSERT INTO households (id, name, created_by) VALUES ('${HOUSEHOLD_ID}', 'Error tests', '${USER_ID}');
      INSERT INTO household_members (id, household_id, user_id, role)
        VALUES ('hm_${USER_ID}', '${HOUSEHOLD_ID}', '${USER_ID}', 'owner');
      INSERT INTO scans (id, user_id, household_id, status, scan_type)
        VALUES ('${SCAN_ID}', '${USER_ID}', '${HOUSEHOLD_ID}', 'failed', 'fridge');
    `);
  });

  afterEach(() => db.close());

  it.each([
    ['REQUEST_TIMEOUT', 'Dịch vụ nhận diện phản hồi quá lâu'],
    ['MODEL_NOT_FOUND', 'Dịch vụ nhận diện đang tạm thời không khả dụng'],
    ['AUTHENTICATION_FAILED', 'Dịch vụ nhận diện đang tạm thời không khả dụng'],
  ] as const)('maps %s to a safe user-facing message and preserves retry metadata', async (errorCode, expectedText) => {
    db.seed(`INSERT INTO scan_queue_jobs
      (id, scan_id, household_id, user_id, status, attempts, max_attempts, idempotency_key, error_code, error_message)
      VALUES ('job_${errorCode}', '${SCAN_ID}', '${HOUSEHOLD_ID}', '${USER_ID}', 'failed', 3, 3,
        'key_${errorCode}', '${errorCode}', 'PRIVATE_PROVIDER_DETAIL_SHOULD_NOT_LEAK');`);

    const response = await app.fetch(
      new Request(`https://itest.local/scans/${SCAN_ID}`, {
        headers: { Authorization: await authHeader() },
      }),
      { DB: db, JWT_SECRET, ENVIRONMENT: 'test' } as unknown as Env,
    );

    expect(response.status).toBe(200);
    const payload = await response.json<{ scan: Record<string, unknown> }>();
    expect(payload.scan).toMatchObject({
      status: 'failed',
      errorCode,
      attempts: 3,
      maxAttempts: 3,
    });
    expect(String(payload.scan.errorMessage)).toContain(expectedText);
    expect(String(payload.scan.errorMessage)).not.toContain('PRIVATE_PROVIDER_DETAIL');
  });
});
