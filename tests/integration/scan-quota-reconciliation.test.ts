import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteD1 } from '../helpers/sqlite-d1';
import { reconcileStaleScanReservations } from '../../src/worker/services/scan-quota';

describe('stale async scan quota reconciliation', () => {
  let db: SqliteD1;

  beforeEach(() => {
    db = new SqliteD1();
    db.seed(`
      INSERT INTO users (id, email) VALUES ('reconcile-user', 'reconcile@example.test');
      INSERT INTO households (id, name, created_by)
        VALUES ('reconcile-house', 'Reconcile', 'reconcile-user');
      INSERT INTO scan_quota_periods (user_id, household_id, period_start, used_count, max_scans)
        VALUES ('reconcile-user', 'reconcile-house', '2026-09-01', 1, 5);
    `);
  });

  afterEach(() => db.close());

  function seedScan(scanId: string, status: string, withJob = false, jobStatus = 'pending', old = true) {
    const timestamp = old ? "datetime('now', '-2 hours')" : "datetime('now')";
    db.seed(`
      INSERT INTO scans (id, user_id, household_id, status, scan_type, updated_at)
        VALUES ('${scanId}', 'reconcile-user', 'reconcile-house', '${status}', 'fridge', ${timestamp});
      INSERT INTO scan_quota_ledger
        (id, user_id, household_id, scan_id, idempotency_key, period_start, status, created_at)
        VALUES ('quota-${scanId}', 'reconcile-user', 'reconcile-house', '${scanId}', 'key-${scanId}', '2026-09-01', 'reserved', ${timestamp});
      ${withJob ? `INSERT INTO scan_queue_jobs
        (id, scan_id, user_id, household_id, idempotency_key, status, updated_at, created_at)
        VALUES ('job-${scanId}', '${scanId}', 'reconcile-user', 'reconcile-house', 'key-${scanId}', '${jobStatus}', ${timestamp}, ${timestamp});` : ''}
    `);
  }

  it('releases an orphaned reservation and marks its pending scan failed', async () => {
    seedScan('orphan', 'pending');

    await expect(reconcileStaleScanReservations(db, 60)).resolves.toMatchObject({
      released: 1,
      expiredScans: 1,
      expiredJobs: 0,
      consumed: 0,
    });
    expect(db.query('SELECT status FROM scans WHERE id = ?', 'orphan')).toEqual([{ status: 'failed' }]);
    expect(db.query('SELECT status FROM scan_quota_ledger WHERE scan_id = ?', 'orphan'))
      .toEqual([{ status: 'released' }]);
    expect(db.query('SELECT used_count FROM scan_quota_periods')).toEqual([{ used_count: 0 }]);

    await expect(reconcileStaleScanReservations(db, 60)).resolves.toEqual({
      released: 0,
      expiredScans: 0,
      expiredJobs: 0,
      consumed: 0,
    });
  });

  it('expires a stale pending queue intent before releasing its reservation', async () => {
    seedScan('stale-job', 'pending', true);

    await expect(reconcileStaleScanReservations(db, 60)).resolves.toMatchObject({
      released: 1,
      expiredScans: 1,
      expiredJobs: 1,
    });
    expect(db.query('SELECT status, error_code FROM scan_queue_jobs WHERE id = ?', 'job-stale-job'))
      .toEqual([{ status: 'failed', error_code: 'RESERVATION_EXPIRED' }]);
  });

  it('preserves a fresh queue intent even when the reservation was created earlier', async () => {
    seedScan('fresh-job', 'pending', true, 'pending', false);
    db.seed("UPDATE scan_quota_ledger SET created_at = datetime('now', '-2 hours') WHERE scan_id = 'fresh-job'");

    await expect(reconcileStaleScanReservations(db, 60)).resolves.toEqual({
      released: 0,
      expiredScans: 0,
      expiredJobs: 0,
      consumed: 0,
    });
    expect(db.query('SELECT status FROM scans WHERE id = ?', 'fresh-job')).toEqual([{ status: 'pending' }]);
    expect(db.query('SELECT status FROM scan_quota_ledger WHERE scan_id = ?', 'fresh-job'))
      .toEqual([{ status: 'reserved' }]);
  });

  it('converts an old reservation to consumed when the scan already completed', async () => {
    seedScan('completed', 'ready');

    await expect(reconcileStaleScanReservations(db, 60)).resolves.toMatchObject({
      released: 0,
      expiredScans: 0,
      expiredJobs: 0,
      consumed: 1,
    });
    expect(db.query('SELECT status FROM scan_quota_ledger WHERE scan_id = ?', 'completed'))
      .toEqual([{ status: 'consumed' }]);
    expect(db.query('SELECT used_count FROM scan_quota_periods')).toEqual([{ used_count: 1 }]);
  });
});
