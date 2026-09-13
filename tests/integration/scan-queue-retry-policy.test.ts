import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteD1 } from '../helpers/sqlite-d1';
import { processScanJob, SCAN_AI_TIMEOUT_MS, type ScanQueueMessage } from '../../src/worker/services/scan-queue';
import type { Env } from '../../src/worker/types';

const vision = vi.hoisted(() => vi.fn());
vi.mock('@frigo/ai', () => ({
  AIRouter: class {
    vision = vision;
    receiptScan = vision;
  },
}));

const message: ScanQueueMessage = {
  type: 'scan.process.v1',
  jobId: 'retry-policy-job',
  scanId: 'retry-policy-scan',
  userId: 'retry-policy-user',
  householdId: 'hh_retry-policy-user',
  scanType: 'fridge',
  imageBase64: 'aGVsbG8=',
  idempotencyKey: 'retry-policy-command',
};

describe('scan queue provider retry policy', () => {
  let db: SqliteD1;
  let env: Env;

  beforeEach(() => {
    db = new SqliteD1();
    db.seed(`
      INSERT INTO users (id, email) VALUES ('${message.userId}', 'retry-policy@example.test');
      INSERT INTO households (id, name, created_by) VALUES ('${message.householdId}', 'Retry policy', '${message.userId}');
      INSERT INTO household_members (id, household_id, user_id, role)
        VALUES ('hm_retry_policy', '${message.householdId}', '${message.userId}', 'owner');
      INSERT INTO scans (id, user_id, household_id, status, scan_type)
        VALUES ('${message.scanId}', '${message.userId}', '${message.householdId}', 'pending', 'fridge');
    `);
    env = { DB: db, ENVIRONMENT: 'test' } as unknown as Env;
    vision.mockReset();
  });

  afterEach(() => db.close());

  it('fails a model-access error immediately instead of burning all queue attempts', async () => {
    vision.mockRejectedValueOnce({
      name: 'AIRequestError',
      code: 'MODEL_NOT_FOUND',
      retryable: false,
      message: 'model unavailable',
    });

    await expect(processScanJob(env, message)).rejects.toMatchObject({
      code: 'MODEL_NOT_FOUND',
      retryable: false,
    });
    expect(db.query('SELECT status, attempts, error_code, error_message FROM scan_queue_jobs')).toEqual([{
      status: 'failed',
      attempts: 1,
      error_code: 'MODEL_NOT_FOUND',
      error_message: 'Dịch vụ nhận diện đang tạm thời không khả dụng.',
    }]);
    expect(db.query('SELECT status FROM scans')).toEqual([{ status: 'failed' }]);
    expect(vision).toHaveBeenCalledOnce();
  });

  it('returns a retryable pending job for a transient timeout', async () => {
    vision.mockRejectedValueOnce({
      name: 'AIRequestError',
      code: 'REQUEST_TIMEOUT',
      retryable: true,
      message: 'provider timed out',
    });

    await expect(processScanJob(env, message)).rejects.toMatchObject({
      code: 'REQUEST_TIMEOUT',
      retryable: true,
    });
    expect(db.query('SELECT status, attempts, error_code FROM scan_queue_jobs')).toEqual([{
      status: 'pending',
      attempts: 1,
      error_code: 'REQUEST_TIMEOUT',
    }]);
    expect(db.query('SELECT status FROM scans')).toEqual([{ status: 'pending' }]);
  });

  it('bounds a hung AI operation and records a retryable timeout', async () => {
    vi.useFakeTimers();
    try {
      vision.mockImplementationOnce(() => new Promise(() => {}));
      const pending = processScanJob(env, message).catch((error) => error);

      await vi.advanceTimersByTimeAsync(SCAN_AI_TIMEOUT_MS);
      await expect(pending).resolves.toMatchObject({ code: 'REQUEST_TIMEOUT', retryable: true });
      expect(db.query('SELECT status, error_code FROM scan_queue_jobs')).toEqual([{
        status: 'pending',
        error_code: 'REQUEST_TIMEOUT',
      }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not write an untrusted provider canonical id into the ingredient FK', async () => {
    vision.mockResolvedValueOnce({
      items: [{
        raw_name: 'Branded seafood label',
        canonical_id: 'NOT_IN_CATALOG',
        estimated_quantity: 1,
        unit: 'piece',
        confidence: 0.9,
        category: 'other',
        storage: 'fridge',
      }],
    });

    await expect(processScanJob(env, message)).resolves.toBeUndefined();
    expect(db.query('SELECT status FROM scans')).toEqual([{ status: 'ready' }]);
    expect(db.query('SELECT canonical_id FROM scan_items')).toEqual([{ canonical_id: null }]);
  });

  it('keeps a catalog-valid provider canonical id when the raw label is unknown', async () => {
    vision.mockResolvedValueOnce({
      items: [{
        raw_name: 'SKU-ABCD-001',
        canonical_id: 'TOMATO',
        estimated_quantity: 1,
        unit: 'piece',
        confidence: 0.9,
        category: 'other',
        storage: 'fridge',
      }],
    });

    await expect(processScanJob(env, message)).resolves.toBeUndefined();
    expect(db.query('SELECT status FROM scans')).toEqual([{ status: 'ready' }]);
    expect(db.query('SELECT canonical_id, category FROM scan_items')).toEqual([{
      canonical_id: 'TOMATO',
      category: 'vegetable',
    }]);
  });
});
