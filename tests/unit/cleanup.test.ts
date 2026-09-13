import { describe, expect, it } from 'vitest';
import {
  cleanupExpiredOtps,
  cleanupExpiredSessions,
  cleanupTerminalScanJobs,
  runScheduledCleanup,
} from '../../src/worker/services/cleanup';
import { getRetentionConfig, DEFAULT_RETENTION_DAYS } from '../../src/worker/config/retention';
import type { D1DatabaseBinding } from '@frigo/db';
import type { Env } from '../../src/worker/types';

interface RecordedStatement {
  sql: string;
  params: unknown[];
}

class FakeCleanupDb implements D1DatabaseBinding {
  readonly statements: RecordedStatement[] = [];
  changes = 1;

  prepare(sql: string) {
    const db = this;
    return {
      bind(...params: unknown[]) {
        db.statements.push({ sql, params });
        return this;
      },
      async run() {
        return { success: true, meta: { changes: db.changes } };
      },
      async first<T>(): Promise<T | null> {
        return null;
      },
      async all<T>(): Promise<{ results: T[]; success: boolean; meta: Record<string, unknown> }> {
        return { results: [], success: true, meta: {} };
      },
    };
  }

  async batch<T = unknown>(): Promise<{ results: T[]; success: boolean; meta: Record<string, unknown> }[]> {
    return [];
  }

  async exec(): Promise<{ count: number; duration: number }> {
    return { count: 0, duration: 0 };
  }
}

describe('scheduled cleanup', () => {
  it('deletes only OTPs whose expiry predates the retention window, with datetime normalization', async () => {
    const db = new FakeCleanupDb();
    const deleted = await cleanupExpiredOtps(db, 7);

    expect(deleted).toBe(1);
    expect(db.statements).toHaveLength(1);
    const { sql, params } = db.statements[0];
    expect(sql).toContain('DELETE FROM auth_otps');
    expect(sql).toContain('datetime(expires_at) < datetime(\'now\', ?)');
    expect(params).toEqual(['-7 days']);
    // Active rows can never match: the predicate only selects expiries in the past.
    expect(sql).not.toContain('> datetime');
  });

  it('deletes expired sessions without touching active rows (predicate-only expiry)', async () => {
    const db = new FakeCleanupDb();
    db.changes = 3;
    const deleted = await cleanupExpiredSessions(db, 30);

    expect(deleted).toBe(3);
    const { sql, params } = db.statements[0];
    expect(sql).toContain('DELETE FROM sessions_v2');
    expect(sql).toContain('datetime(expires_at) < datetime(\'now\', ?)');
    expect(params).toEqual(['-30 days']);
  });

  it('cleans terminal queue jobs with distinct ready/failed retention and never pending/processing', async () => {
    const db = new FakeCleanupDb();
    const { readyDeleted, failedDeleted } = await cleanupTerminalScanJobs(db, {
      readyJobDays: 30,
      failedJobDays: 90,
    });

    expect(readyDeleted).toBe(1);
    expect(failedDeleted).toBe(1);
    expect(db.statements).toHaveLength(2);

    const [ready, failed] = db.statements;
    expect(ready.sql).toContain('status = \'ready\'');
    expect(ready.sql).toContain('MAX(COALESCE(datetime(completed_at), datetime(updated_at)), datetime(updated_at))');
    expect(ready.params).toEqual(['-30 days']);
    expect(failed.sql).toContain('status = \'failed\'');
    expect(failed.params).toEqual(['-90 days']);
    for (const { sql } of db.statements) {
      expect(sql).toContain('s.id = scan_queue_jobs.scan_id');
      expect(sql).toContain('s.user_id = scan_queue_jobs.user_id');
      expect(sql).toContain('s.household_id = scan_queue_jobs.household_id');
      expect(sql).toContain("q.status = 'reserved'");
      expect(sql).not.toContain('pending');
      expect(sql).not.toContain('processing');
    }
  });

  it('is replay-safe: a second run deletes nothing and reports zero', async () => {
    const db = new FakeCleanupDb();
    db.changes = 0; // nothing left to delete on the replay
    const report = await runScheduledCleanup({ DB: db, ENVIRONMENT: 'development' } as Env);

    const deleted = report.tasks
      .filter((task) => task.status === 'ok')
      .reduce((sum, task) => sum + task.deleted, 0);
    expect(deleted).toBe(0);
    expect(report.tasks.every((task) => task.status === 'ok')).toBe(true);
    expect(report.tasks.map((task) => task.task)).toEqual([
      'expired-otps',
      'expired-sessions',
      'stale-scan-reservations',
      'terminal-ready-jobs',
      'terminal-failed-jobs',
    ]);
  });

  it('fails closed: skips cleanup in production when configuration is fatal', async () => {
    const db = new FakeCleanupDb();
    const report = await runScheduledCleanup({ DB: db, ENVIRONMENT: 'production' } as Env);

    expect(report.tasks).toHaveLength(1);
    expect(report.tasks[0]).toMatchObject({ task: 'config-gate', status: 'skipped' });
    expect(db.statements).toHaveLength(0);
  });

  it('reports a sanitized error when a task fails instead of throwing', async () => {
    const db = new FakeCleanupDb();
    const poisoned = {
      prepare(sql: string) {
        if (sql.includes('auth_otps')) return db.prepare(sql);
        const failing = db.prepare(sql);
        return {
          ...failing,
          async run() {
            throw new Error('D1 exploded: some technical detail');
          },
        };
      },
      batch: db.batch.bind(db),
      exec: db.exec.bind(db),
    };
    const report = await runScheduledCleanup({ DB: poisoned, ENVIRONMENT: 'staging' } as Env);

    const failedTask = report.tasks.find((task) => task.task === 'expired-sessions');
    expect(failedTask?.status).toBe('error');
    expect(failedTask?.deleted).toBe(0);
    expect(failedTask?.error).toContain('D1 exploded');
  });
});

describe('retention configuration', () => {
  it('applies defaults when no overrides are present', () => {
    const config = getRetentionConfig({} as Env);
    expect(config).toEqual({
      otpDays: DEFAULT_RETENTION_DAYS.otp,
      sessionDays: DEFAULT_RETENTION_DAYS.sessions,
      readyJobDays: DEFAULT_RETENTION_DAYS.readyJobs,
      failedJobDays: DEFAULT_RETENTION_DAYS.failedJobs,
      reservedScanMinutes: 60,
    });
  });

  it('honors per-var overrides and rejects nonsense values', () => {
    const config = getRetentionConfig({
      CLEANUP_OTP_RETENTION_DAYS: '14',
      CLEANUP_SESSION_RETENTION_DAYS: 'not-a-number',
      CLEANUP_READY_JOB_RETENTION_DAYS: '-5',
      CLEANUP_FAILED_JOB_RETENTION_DAYS: '120',
      CLEANUP_RESERVED_SCAN_RETENTION_MINUTES: '15',
    } as Env);
    expect(config.otpDays).toBe(14);
    expect(config.sessionDays).toBe(DEFAULT_RETENTION_DAYS.sessions);
    expect(config.readyJobDays).toBe(DEFAULT_RETENTION_DAYS.readyJobs);
    expect(config.failedJobDays).toBe(120);
    expect(config.reservedScanMinutes).toBe(15);
  });
});
