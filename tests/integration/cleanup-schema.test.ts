import { describe, expect, it } from 'vitest';
import { SqliteD1 } from '../helpers/sqlite-d1';
import { cleanupTerminalScanJobs, runScheduledCleanup } from '../../src/worker/services/cleanup';
import type { Env } from '../../src/worker/types';

describe('scheduled cleanup against migrated hardening schema', () => {
  it.each([
    ['ready', 'pending', false],
    ['ready', 'processing', false],
    ['ready', 'failed', false],
    ['failed', 'processing', false],
    ['failed', 'ready', false],
    ['ready', 'confirmed', true],
    ['ready', 'ready', true],
    ['failed', 'failed', true],
  ])('retains a %s tombstone unless its scan (%s) is consistently terminal', async (jobStatus, scanStatus, removable) => {
    const db = new SqliteD1();
    try {
      db.seed(`INSERT INTO users (id,email) VALUES ('u','cleanup@example.com');
        INSERT INTO households (id,name,created_by) VALUES ('h','Cleanup','u');
        INSERT INTO scans (id,user_id,household_id,status,scan_type) VALUES ('s','u','h','${scanStatus}','fridge');
        INSERT INTO scan_queue_jobs (id,scan_id,user_id,household_id,idempotency_key,status,updated_at,completed_at)
          VALUES ('j','s','u','h','key','${jobStatus}',datetime('now','-120 days'),datetime('now','-120 days'));`);
      const result = await cleanupTerminalScanJobs(db, { readyJobDays: 30, failedJobDays: 90 });
      expect(result.readyDeleted + result.failedDeleted).toBe(removable ? 1 : 0);
      expect(db.query('SELECT id FROM scan_queue_jobs')).toHaveLength(removable ? 0 : 1);
    } finally { db.close(); }
  });

  it('keeps terminal tombstones for reserved quota, recent updates, or mismatched tenancy', async () => {
    const db = new SqliteD1();
    try {
      db.seed(`INSERT INTO users (id,email) VALUES ('u','cleanup@example.com');
        INSERT INTO households (id,name,created_by) VALUES ('h','Cleanup','u'),('other','Other','u');`);
      for (const id of ['reserved', 'recent', 'tenant']) {
        db.seed(`INSERT INTO scans (id,user_id,household_id,status,scan_type) VALUES ('${id}','u','h','ready','fridge');
          INSERT INTO scan_queue_jobs (id,scan_id,user_id,household_id,idempotency_key,status,updated_at,completed_at)
            VALUES ('${id}','${id}','u','${id === 'tenant' ? 'other' : 'h'}','${id}','ready',
              datetime('now','${id === 'recent' ? '-1 day' : '-120 days'}'),datetime('now','-120 days'));`);
      }
      db.seed(`INSERT INTO scan_quota_ledger (id,user_id,household_id,scan_id,idempotency_key,period_start,status,created_at)
        VALUES ('quota','u','h','reserved','key','2020-01-01','reserved',datetime('now'));`);
      const env = { DB: db, ENVIRONMENT: 'test' } as Env;
      for (let run = 0; run < 2; run += 1) {
        expect((await runScheduledCleanup(env)).tasks.every((task) => task.status === 'ok' && task.deleted === 0)).toBe(true);
        expect(db.query('SELECT id FROM scan_queue_jobs')).toHaveLength(3);
        expect(db.query('SELECT status FROM scan_quota_ledger')).toEqual([{ status: 'reserved' }]);
      }
    } finally { db.close(); }
  });

  it('keeps live or indeterminate expiries even at minimum retention with mixed timestamp formats', async () => {
    const db = new SqliteD1();
    try {
      db.seed(`INSERT INTO users (id,email) VALUES ('u','cleanup@example.com');
        INSERT INTO households (id,name,created_by) VALUES ('h','Cleanup','u');`);
      for (const [id, expires] of [
        ['live', new Date(Date.now() + 60_000).toISOString()],
        ['recent', new Date(Date.now() - 60_000).toISOString()],
        ['invalid', 'not-a-date'],
        ['old', new Date(Date.now() - 3 * 86_400_000).toISOString()],
      ]) {
        db.seed(`INSERT INTO sessions_v2 (id,user_id,household_id,token_hash,expires_at)
          VALUES ('${id}','u','h','${id}','${expires}');
          INSERT INTO auth_otps (id,email,code_digest,purpose,expires_at)
            VALUES ('${id}','cleanup@example.com','digest','register','${expires}');`);
      }
      const report = await runScheduledCleanup({
        DB: db, ENVIRONMENT: 'test', CLEANUP_SESSION_RETENTION_DAYS: '1', CLEANUP_OTP_RETENTION_DAYS: '1',
      } as Env);
      expect(report.tasks.every((task) => task.status === 'ok')).toBe(true);
      for (const table of ['auth_otps', 'sessions_v2']) {
        expect(db.query(`SELECT id FROM ${table} ORDER BY id`)).toEqual([{ id: 'invalid' }, { id: 'live' }, { id: 'recent' }]);
      }
    } finally { db.close(); }
  });

  it('expires sessions/OTPs and terminal jobs without deleting active claims or quota history', async () => {
    const db = new SqliteD1();
    try {
      db.seed(`INSERT INTO users (id,email) VALUES ('cleanup-user','cleanup@example.com');
        INSERT INTO households (id,name,created_by) VALUES ('cleanup-house','Cleanup','cleanup-user');
        INSERT INTO sessions_v2 (id,user_id,household_id,token_hash,expires_at,revoked_at) VALUES
          ('expired','cleanup-user','cleanup-house','expired-hash',datetime('now','-90 days'),NULL),
          ('active','cleanup-user','cleanup-house','active-hash',datetime('now','+1 day'),NULL),
          ('revoked-recent','cleanup-user','cleanup-house','revoked-hash',datetime('now','+1 day'),datetime('now'));
        INSERT INTO auth_otps (id,email,code_digest,purpose,expires_at,used,attempt_count,used_at) VALUES
          ('expired','cleanup@example.com','digest','register',datetime('now','-90 days'),0,5,NULL),
          ('used-old','cleanup@example.com','digest','register',datetime('now','-90 days'),1,0,datetime('now','-90 days')),
          ('active','cleanup@example.com','digest','register',datetime('now','+10 minutes'),0,0,NULL),
          ('used-recent','cleanup@example.com','digest','register',datetime('now','+10 minutes'),1,0,datetime('now'));
        INSERT INTO scan_quota_periods (user_id,household_id,period_start,used_count,max_scans)
          VALUES ('cleanup-user','cleanup-house','2020-01-01',2,5);`);
      for (const status of ['pending', 'processing', 'ready', 'failed']) {
        db.seed(`INSERT INTO scans (id,user_id,household_id,status,scan_type)
          VALUES ('scan-${status}','cleanup-user','cleanup-house','${status}','fridge');
          INSERT INTO scan_queue_jobs (id,scan_id,user_id,household_id,idempotency_key,status,claim_token,claim_attempt,locked_at,updated_at,completed_at)
          VALUES ('job-${status}','scan-${status}','cleanup-user','cleanup-house','key-${status}','${status}','claim-${status}',1,
            datetime('now','-120 days'),datetime('now','-120 days'),datetime('now','-120 days'));`);
      }
      for (const status of ['reserved', 'consumed', 'released']) {
        db.seed(`INSERT INTO scan_quota_ledger (id,user_id,household_id,scan_id,idempotency_key,period_start,status,created_at)
          VALUES ('quota-${status}','cleanup-user','cleanup-house','quota-scan-${status}','quota-key-${status}','2020-01-01','${status}',
            CASE WHEN '${status}' = 'reserved' THEN datetime('now') ELSE datetime('now','-90 days') END);`);
      }
      const env = { DB: db, ENVIRONMENT: 'test' } as Env;
      const report = await runScheduledCleanup(env);
      expect(report.tasks.every((task) => task.status === 'ok')).toBe(true);
      expect(db.query('SELECT id FROM sessions_v2 ORDER BY id')).toEqual([{ id: 'active' }, { id: 'revoked-recent' }]);
      expect(db.query('SELECT id FROM auth_otps ORDER BY id')).toEqual([{ id: 'active' }, { id: 'used-recent' }]);
      expect(db.query('SELECT id,claim_token FROM scan_queue_jobs ORDER BY id')).toEqual([
        { id: 'job-pending', claim_token: 'claim-pending' }, { id: 'job-processing', claim_token: 'claim-processing' },
      ]);
      expect(db.query('SELECT status FROM scan_quota_ledger ORDER BY status')).toEqual([
        { status: 'consumed' }, { status: 'released' }, { status: 'reserved' },
      ]);
      expect(db.query('SELECT used_count FROM scan_quota_periods')).toEqual([{ used_count: 2 }]);
      expect((await runScheduledCleanup(env)).tasks.every((task) => task.deleted === 0)).toBe(true);
      expect(db.query('PRAGMA foreign_key_check')).toEqual([]);
    } finally { db.close(); }
  });
});
