import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteD1, createBarrier } from '../helpers/sqlite-d1';
import { reserveScanQuota, finalizeScanQuota } from '../../src/worker/services/scan-quota';
import { SCAN_QUOTA_POLICY } from '../../src/worker/config/scan-quota-policy';
import { authMiddleware } from '../../src/worker/middleware/auth';
import { scanRoutes } from '../../src/worker/routes/scans';
import { sha256Hex, SESSION_COOKIE } from '../../src/worker/utils/session';
import type { AuthContext, Env } from '../../src/worker/types';

const vision = vi.fn(async () => ({ items: [] }));
vi.mock('@frigo/ai', () => ({ AIRouter: class {
  vision = vision;
  receiptScan = vision;
} }));

describe('D1 scan quota and request idempotency', () => {
  let db: SqliteD1;
  const input = (scanId: string) => ({ userId: 'user-a', householdId: 'house-a', scanId, idempotencyKey: `command:${scanId}` });
  const usage = () => Number(db.query('SELECT used_count FROM scan_quota_periods')[0]?.used_count || 0);
  beforeEach(() => {
    db = new SqliteD1();
    db.seed(`INSERT INTO users (id,email) VALUES ('user-a','a@example.com'),('user-b','b@example.com');
      INSERT INTO households (id,name,created_by) VALUES ('house-a','A','user-a'),('house-b','B','user-b');
      INSERT INTO household_members (id,user_id,household_id,role) VALUES ('ma','user-a','house-a','owner'),('mb','user-b','house-b','owner');`);
    vision.mockClear();
  });
  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  it('serializes concurrent contenders for the final quota slot', async () => {
    for (let i = 0; i < SCAN_QUOTA_POLICY.free - 1; i++) expect((await reserveScanQuota(db, input(`seed-${i}`))).ok).toBe(true);
    const barrier = createBarrier(2);
    db.hooks.beforeBatch = () => barrier.wait();
    const results = await Promise.all(['last-a', 'last-b'].map((id) => reserveScanQuota(db, input(id))));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results).toContainEqual({ ok: false, reason: 'exceeded' });
    expect(usage()).toBe(SCAN_QUOTA_POLICY.free);
  });

  it('uses one ledger entry and one owner for concurrent duplicate commands', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => reserveScanQuota(db, input('same'))));
    expect(results.every((result) => result.ok)).toBe(true);
    expect(results.filter((result) => result.ok && result.acquired)).toHaveLength(1);
    expect(usage()).toBe(1);
    expect(db.query('SELECT * FROM scan_quota_ledger')).toHaveLength(1);
  });

  it('reclaims a released reservation once even when both callers read released', async () => {
    const first = await reserveScanQuota(db, input('released'));
    if (!first.ok) throw new Error('reservation failed');
    await finalizeScanQuota(db, first.reservation.reservationId, 'released');
    const barrier = createBarrier(2);
    db.hooks.afterStatement = (event) => event.method === 'first' && event.sql.includes('WHERE idempotency_key = ? OR scan_id = ?') ? barrier.wait() : undefined;
    const results = await Promise.all([reserveScanQuota(db, input('released')), reserveScanQuota(db, input('released'))]);
    expect(results.filter((result) => result.ok && result.acquired)).toHaveLength(1);
    expect(usage()).toBe(1);
  });

  it('cannot reclaim a historical released command against an exhausted current month', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-15T12:00:00Z'));
    const first = await reserveScanQuota(db, input('historical'));
    if (!first.ok) throw new Error('reservation failed');
    await finalizeScanQuota(db, first.reservation.reservationId, 'released');

    vi.setSystemTime(new Date('2026-09-15T12:00:00Z'));
    for (let i = 0; i < SCAN_QUOTA_POLICY.free; i++) expect((await reserveScanQuota(db, input(`current-${i}`))).ok).toBe(true);
    expect(await reserveScanQuota(db, input('historical'))).toEqual({ ok: false, reason: 'exceeded' });
    expect(db.query('SELECT id, period_start, status FROM scan_quota_ledger WHERE scan_id = ?', 'historical'))
      .toEqual([{ id: first.reservation.reservationId, period_start: '2026-08-01', status: 'released' }]);
    expect(db.query('SELECT period_start, used_count FROM scan_quota_periods ORDER BY period_start'))
      .toEqual([{ period_start: '2026-08-01', used_count: 0 }, { period_start: '2026-09-01', used_count: SCAN_QUOTA_POLICY.free }]);
  });

  it('atomically moves historical released quota to the current last slot with one new owner', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-15T12:00:00Z'));
    const first = await reserveScanQuota(db, input('historical'));
    if (!first.ok) throw new Error('reservation failed');
    await finalizeScanQuota(db, first.reservation.reservationId, 'released');

    vi.setSystemTime(new Date('2026-09-15T12:00:00Z'));
    for (let i = 0; i < SCAN_QUOTA_POLICY.free - 1; i++) expect((await reserveScanQuota(db, input(`current-${i}`))).ok).toBe(true);
    const barrier = createBarrier(2);
    db.hooks.afterStatement = (event) => event.method === 'first' && event.sql.includes('WHERE idempotency_key = ? OR scan_id = ?') ? barrier.wait() : undefined;
    const results = await Promise.all([reserveScanQuota(db, input('historical')), reserveScanQuota(db, input('historical'))]);
    expect(results.filter((result) => result.ok && result.acquired)).toHaveLength(1);
    const reclaimed = results.find((result) => result.ok && result.acquired);
    if (!reclaimed?.ok) throw new Error('reclaim failed');
    expect(reclaimed.reservation.reservationId).not.toBe(first.reservation.reservationId);
    expect(reclaimed.reservation.periodStart).toBe('2026-09-01');
    expect(results.every((result) => result.ok && result.reservation.reservationId === reclaimed.reservation.reservationId)).toBe(true);
    await finalizeScanQuota(db, first.reservation.reservationId, 'released');
    await finalizeScanQuota(db, first.reservation.reservationId, 'consumed');
    expect(db.query('SELECT id, period_start, status FROM scan_quota_ledger WHERE scan_id = ?', 'historical'))
      .toEqual([{ id: reclaimed.reservation.reservationId, period_start: '2026-09-01', status: 'reserved' }]);
    expect(await reserveScanQuota(db, input('historical'))).toMatchObject({ ok: true, acquired: false, reservation: reclaimed.reservation });
    expect(await reserveScanQuota(db, input('extra'))).toEqual({ ok: false, reason: 'exceeded' });
    expect(db.query('SELECT period_start, used_count FROM scan_quota_periods ORDER BY period_start'))
      .toEqual([{ period_start: '2026-08-01', used_count: 0 }, { period_start: '2026-09-01', used_count: SCAN_QUOTA_POLICY.free }]);
    expect(db.query('SELECT * FROM scan_quota_ledger WHERE scan_id = ?', 'historical')).toHaveLength(1);
  });

  it.each(['reserved', 'consumed'] as const)('keeps historical %s retries in their original month without a new charge', async (status) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-15T12:00:00Z'));
    const first = await reserveScanQuota(db, input('historical'));
    if (!first.ok) throw new Error('reservation failed');
    if (status === 'consumed') await finalizeScanQuota(db, first.reservation.reservationId, 'consumed');

    vi.setSystemTime(new Date('2026-09-15T12:00:00Z'));
    for (let i = 0; i < SCAN_QUOTA_POLICY.free; i++) expect((await reserveScanQuota(db, input(`current-${i}`))).ok).toBe(true);
    expect(await reserveScanQuota(db, input('historical'))).toEqual({ ok: true, acquired: false, reservation: first.reservation });
    expect(db.query('SELECT period_start, used_count FROM scan_quota_periods ORDER BY period_start'))
      .toEqual([{ period_start: '2026-08-01', used_count: 1 }, { period_start: '2026-09-01', used_count: SCAN_QUOTA_POLICY.free }]);
    expect(db.query('SELECT status FROM scan_quota_ledger WHERE scan_id = ?', 'historical')).toEqual([{ status }]);
  });

  it('checks current-month allowance when a historical reservation is released after the initial read', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-15T12:00:00Z'));
    const first = await reserveScanQuota(db, input('historical'));
    if (!first.ok) throw new Error('reservation failed');

    vi.setSystemTime(new Date('2026-09-15T12:00:00Z'));
    for (let i = 0; i < SCAN_QUOTA_POLICY.free; i++) expect((await reserveScanQuota(db, input(`current-${i}`))).ok).toBe(true);
    db.hooks.beforeBatch = async () => {
      db.hooks.beforeBatch = undefined;
      await finalizeScanQuota(db, first.reservation.reservationId, 'released');
    };
    expect(await reserveScanQuota(db, input('historical'))).toEqual({ ok: false, reason: 'exceeded' });
    expect(db.query('SELECT period_start, used_count FROM scan_quota_periods ORDER BY period_start'))
      .toEqual([{ period_start: '2026-08-01', used_count: 0 }, { period_start: '2026-09-01', used_count: SCAN_QUOTA_POLICY.free }]);
  });

  it('duplicate and late releases cannot decrement another reservation or its reclaim', async () => {
    const a = await reserveScanQuota(db, input('a'));
    const b = await reserveScanQuota(db, input('b'));
    if (!a.ok || !b.ok) throw new Error('reservation failed');
    await Promise.all([finalizeScanQuota(db, a.reservation.reservationId, 'released'), finalizeScanQuota(db, a.reservation.reservationId, 'released')]);
    expect(usage()).toBe(1);
    const reclaimed = await reserveScanQuota(db, input('a'));
    if (!reclaimed.ok) throw new Error('reclaim failed');
    expect(reclaimed.reservation.reservationId).not.toBe(a.reservation.reservationId);
    await finalizeScanQuota(db, a.reservation.reservationId, 'released');
    expect(usage()).toBe(2);
  });

  it('consumed retries cost nothing and cannot be released', async () => {
    const first = await reserveScanQuota(db, input('used'));
    if (!first.ok) throw new Error('reservation failed');
    await finalizeScanQuota(db, first.reservation.reservationId, 'consumed');
    await finalizeScanQuota(db, first.reservation.reservationId, 'released');
    expect(await reserveScanQuota(db, input('used'))).toMatchObject({ ok: true, acquired: false });
    expect(usage()).toBe(1);
  });

  it('rejects mismatched tenant, scan ID, or command reuse without consuming quota', async () => {
    await reserveScanQuota(db, input('a'));
    for (const changed of [{ scanId: 'other' }, { idempotencyKey: 'other' }, { userId: 'user-b', householdId: 'house-b' }]) {
      expect(await reserveScanQuota(db, { ...input('a'), ...changed })).toEqual({ ok: false, reason: 'conflict' });
    }
    expect(usage()).toBe(1);
  });

  it('rolls back ledger and usage if any reservation batch statement fails', async () => {
    db.seed(`CREATE TRIGGER fail_usage BEFORE UPDATE ON scan_quota_periods BEGIN SELECT RAISE(ABORT, 'test failure'); END;`);
    expect(await reserveScanQuota(db, input('a'))).toEqual({ ok: false, reason: 'unavailable' });
    expect(db.query('SELECT * FROM scan_quota_ledger')).toHaveLength(0);
    expect(usage()).toBe(0);
  });

  const app = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>();
  app.use('*', authMiddleware);
  app.route('/', scanRoutes);

  async function request(key: string, queue?: { send: (message: unknown) => Promise<void> }, extra = {}, user = 'a', type = 'fridge') {
    await db.prepare(`INSERT OR IGNORE INTO sessions_v2 (id,user_id,household_id,token_hash,expires_at)
      VALUES (?, ?, ?, ?, datetime('now','+1 day'))`)
      .bind(`session-${user}`, `user-${user}`, `house-${user}`, await sha256Hex(`token-${user}`)).run();
    return app.request(`/scans/${type}`, {
      method: 'POST', headers: { Cookie: `${SESSION_COOKIE}=token-${user}`, Origin: 'https://frigo.example.com',
        'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify({ imageBase64: 'aGVsbG8=', ...extra }),
    }, { DB: db, CACHE: { get: async () => null, put: async () => undefined },
      APP_URL: 'https://frigo.example.com', ENVIRONMENT: 'production',
      SCAN_QUEUE_MODE: queue ? 'async' : 'sync', SCAN_QUEUE: queue,
      IMAGES: undefined } as unknown as Env);
  }

  it('recovers the same synchronous operation and results after a lost response', async () => {
    const first = await request('stable-command');
    const firstBody = await first.json() as any;
    expect(first.status).toBe(200);
    const retry = await request('stable-command');
    expect(await retry.json()).toMatchObject({ idempotentReplay: true, scan: { id: firstBody.scan.id, status: 'ready', items: [] } });
    expect(vision).toHaveBeenCalledTimes(1);
    expect(usage()).toBe(1);
    expect(db.query('SELECT * FROM scans')).toHaveLength(1);
  });

  it('binds an idempotency key to the original image bytes and MIME type', async () => {
    const first = await request('fingerprint-command', undefined, {
      imageBase64: 'aGVsbG8=',
    });
    expect(first.status).toBe(200);
    const changedBytes = await request('fingerprint-command', undefined, {
      imageBase64: 'd29ybGQ=',
    });
    expect(changedBytes.status).toBe(409);
    expect(await changedBytes.json()).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    const changedMime = await request('mime-command', undefined, {
      imageBase64: 'data:image/jpeg;base64,aGVsbG8=',
    });
    expect(changedMime.status).toBe(200);
    const mimeReplay = await request('mime-command', undefined, {
      imageBase64: 'data:image/png;base64,aGVsbG8=',
    });
    expect(mimeReplay.status).toBe(409);
    expect(await mimeReplay.json()).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(vision).toHaveBeenCalledTimes(2);
    expect(usage()).toBe(2);
  });

  it('rejects an empty image before reserving quota or creating a scan row', async () => {
    const response = await request('empty-image', undefined, { imageBase64: '' });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'IMAGE_REQUIRED' });
    expect(usage()).toBe(0);
    expect(db.query('SELECT * FROM scans')).toHaveLength(0);
    expect(vision).not.toHaveBeenCalled();
  });

  it.each([
    ['MODEL_NOT_FOUND', false, 503, 'tạm thời không khả dụng'],
    ['AI_SCAN_NO_USABLE_ITEMS', false, 422, 'Không nhận diện được dữ liệu đủ rõ'],
    ['REQUEST_TIMEOUT', true, 504, 'phản hồi quá lâu'],
  ] as const)('returns a sanitized synchronous scan failure for %s', async (code, retryable, status, message) => {
    vision.mockRejectedValueOnce({
      code,
      retryable,
      message: `PRIVATE_PROVIDER_DETAIL_${code}`,
    });

    const response = await request(`sync-failure-${code}`);
    expect(response.status).toBe(status);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ code, retryable });
    expect(String(body.error)).toContain(message);
    expect(JSON.stringify(body)).not.toContain('PRIVATE_PROVIDER_DETAIL');
    expect(usage()).toBe(0);
  });

  it('returns the same sanitized failure contract for synchronous receipt OCR', async () => {
    vision.mockRejectedValueOnce({
      code: 'INVALID_RESPONSE',
      retryable: false,
      message: 'PRIVATE_RECEIPT_PROVIDER_DETAIL',
    });

    const response = await request('sync-receipt-failure', undefined, {}, 'a', 'receipt');
    expect(response.status).toBe(422);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ code: 'INVALID_RESPONSE', retryable: false });
    expect(JSON.stringify(body)).not.toContain('PRIVATE_RECEIPT_PROVIDER_DETAIL');
    expect(usage()).toBe(0);
  });

  it('returns one logical operation for concurrent uploads, not duplicate AI work', async () => {
    const responses = await Promise.all([request('race-command'), request('race-command')]);
    const bodies = await Promise.all(responses.map((response) => response.json())) as any[];
    expect(responses.every((response) => [200, 202].includes(response.status))).toBe(true);
    expect(bodies[0].scan.id).toBe(bodies[1].scan.id);
    expect(vision).toHaveBeenCalledTimes(1);
    expect(usage()).toBe(1);
  });

  it('recovers an ambiguous queue send with the same job and no quota refund or new charge', async () => {
    const messages: any[] = [];
    const queue = { send: vi.fn(async (message) => { messages.push(message); if (messages.length === 1) throw new Error('accepted but response lost'); }) };
    expect((await request('queue-command', queue)).status).toBe(503);
    expect(usage()).toBe(1);
    expect(db.query('SELECT status, error_code FROM scan_queue_jobs')).toEqual([{ status: 'pending', error_code: null }]);
    const retry = await request('queue-command', queue);
    expect(retry.status).toBe(202);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual(messages[1]);
    expect(usage()).toBe(1);
    expect(db.query('SELECT status FROM scan_quota_ledger')).toEqual([{ status: 'consumed' }]);
  });

  it('does not turn a failed synchronous replay into a success response', async () => {
    vision.mockRejectedValueOnce({
      code: 'MODEL_NOT_FOUND',
      retryable: false,
      message: 'PRIVATE_MODEL_DETAIL',
    }).mockRejectedValueOnce({
      code: 'MODEL_NOT_FOUND',
      retryable: false,
      message: 'PRIVATE_MODEL_DETAIL',
    });
    const first = await request('failed-replay');
    expect(first.status).toBe(503);
    expect(db.query('SELECT status FROM scans')).toEqual([{ status: 'failed' }]);

    const replay = await request('failed-replay');
    expect(replay.status).toBe(503);
    const body = await replay.json() as Record<string, unknown>;
    expect(body).toMatchObject({ code: 'MODEL_NOT_FOUND', retryable: false });
    expect(body.success).not.toBe(true);
    expect(JSON.stringify(body)).not.toContain('PRIVATE_MODEL_DETAIL');
  });

  it('ignores client Plus/quota hints and expired server Plus entitlements', async () => {
    db.seed(`INSERT INTO subscriptions (id,user_id,plan,status,max_scans_per_month,expires_at)
      VALUES ('expired','user-a','plus','active',${SCAN_QUOTA_POLICY.plus},datetime('now','-1 day'));`);
    for (let i = 0; i < SCAN_QUOTA_POLICY.free; i++) await reserveScanQuota(db, input(`full-${i}`));
    const response = await request('bypass', undefined, { isPlus: true, plan: 'plus', maxScans: SCAN_QUOTA_POLICY.plus });
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ code: 'SCAN_QUOTA_EXCEEDED' });
    expect(vision).not.toHaveBeenCalled();
    expect(usage()).toBe(SCAN_QUOTA_POLICY.free);
  });

  it('scopes client command IDs to their user and household', async () => {
    const a = await (await request('shared-command')).json() as any;
    const b = await (await request('shared-command', undefined, {}, 'b')).json() as any;
    expect(a.scan.id).not.toBe(b.scan.id);
    expect(db.query('SELECT used_count FROM scan_quota_periods ORDER BY user_id')).toEqual([{ used_count: 1 }, { used_count: 1 }]);
  });
});
