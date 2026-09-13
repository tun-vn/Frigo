import { Env } from '../types';
import { getRetentionConfig } from '../config/retention';
import { validateEnvironment } from '../config/validation';
import { reconcileStaleScanReservations } from './scan-quota';

/**
 * Scheduled cleanup for expired OTPs, expired sessions, and terminal scan
 * queue ledger rows. All statements DELETE rows whose natural expiry or
 * terminal timestamp is older than the retention window, so re-running the
 * cron is always safe (replay-safe/idempotent) and active rows are retained.
 *
 * `datetime(column)` normalization matters: application code writes
 * `expires_at`/`completed_at` as JS ISO strings while D1 defaults write
 * `YYYY-MM-DD HH:MM:SS`; comparing raw text across both formats is wrong.
 */

export type CleanupTaskStatus = 'ok' | 'skipped' | 'error';

export interface CleanupTaskResult {
  task: string;
  status: CleanupTaskStatus;
  deleted: number;
  error?: string;
}

export interface CleanupReport {
  ranAt: string;
  environment: string;
  tasks: CleanupTaskResult[];
}

const MAX_ERROR_LENGTH = 300;

function changesOf(result: { success: boolean; meta: Record<string, unknown> }): number {
  return typeof result.meta?.changes === 'number' ? result.meta.changes : 0;
}

async function deleteExpired(
  db: NonNullable<Env['DB']>,
  table: string,
  timeColumn: string,
  days: number,
  extraCondition = ''
): Promise<number> {
  const result = await db
    .prepare(
      `DELETE FROM ${table} WHERE datetime(${timeColumn}) IS NOT NULL
         AND datetime(${timeColumn}) < datetime('now', ?)${extraCondition}`
    )
    .bind(`-${days} days`)
    .run();
  return changesOf(result);
}

export async function cleanupExpiredOtps(db: NonNullable<Env['DB']>, days: number): Promise<number> {
  return deleteExpired(db, 'auth_otps', 'expires_at', days);
}

/** Legacy sessions are not an authentication or cleanup source after cutover. */
export async function cleanupExpiredSessions(db: NonNullable<Env['DB']>, days: number): Promise<number> {
  return deleteExpired(db, 'sessions_v2', 'expires_at', days);
}

/** Keep tombstones while the scan or its quota reservation may still need replay. */
export async function cleanupTerminalScanJobs(
  db: NonNullable<Env['DB']>,
  cfg: { readyJobDays: number; failedJobDays: number }
): Promise<{ readyDeleted: number; failedDeleted: number }> {
  const replaySafe = ` AND EXISTS (
    SELECT 1 FROM scans s WHERE s.id = scan_queue_jobs.scan_id
      AND s.user_id = scan_queue_jobs.user_id AND s.household_id = scan_queue_jobs.household_id
      AND ((scan_queue_jobs.status = 'ready' AND s.status IN ('ready', 'confirmed'))
        OR (scan_queue_jobs.status = 'failed' AND s.status = 'failed'))
    ) AND NOT EXISTS (
      SELECT 1 FROM scan_quota_ledger q WHERE q.scan_id = scan_queue_jobs.scan_id
        AND q.status = 'reserved'
    )`;
  const readyDeleted = await deleteExpired(
    db,
    'scan_queue_jobs',
    'MAX(COALESCE(datetime(completed_at), datetime(updated_at)), datetime(updated_at))',
    cfg.readyJobDays,
    " AND status = 'ready'" + replaySafe
  );
  const failedDeleted = await deleteExpired(
    db,
    'scan_queue_jobs',
    'updated_at',
    cfg.failedJobDays,
    " AND status = 'failed'" + replaySafe
  );
  return { readyDeleted, failedDeleted };
}

/** Release quota held by an async enqueue that never reached a live worker. */
export async function cleanupStaleScanReservations(
  db: NonNullable<Env['DB']>,
  staleMinutes: number,
): Promise<{ consumed: number; released: number; expiredJobs: number; expiredScans: number }> {
  return reconcileStaleScanReservations(db, staleMinutes);
}

function sanitizeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, MAX_ERROR_LENGTH);
}

export async function runScheduledCleanup(env: Env): Promise<CleanupReport> {
  const environment = env.ENVIRONMENT || 'development';
  const tasks: CleanupTaskResult[] = [];

  if (!env.DB) {
    tasks.push({
      task: 'database',
      status: 'error',
      deleted: 0,
      error: 'D1 binding DB is absent; cleanup skipped.',
    });
    return { ranAt: new Date().toISOString(), environment, tasks };
  }

  // Production fail-closed: do not mutate data while the deployment is
  // misconfigured (a fatal config means the worker may be pointed at the
  // wrong infrastructure).
  if (environment === 'production') {
    const config = validateEnvironment(env);
    if (config.fatal.length > 0) {
      tasks.push({
        task: 'config-gate',
        status: 'skipped',
        deleted: 0,
        error: `cleanup skipped: ${config.fatal.map((issue) => issue.code).join(', ')}`,
      });
      return { ranAt: new Date().toISOString(), environment, tasks };
    }
  }

  const retention = getRetentionConfig(env);
  const db = env.DB;

  try {
    const deleted = await cleanupExpiredOtps(db, retention.otpDays);
    tasks.push({ task: 'expired-otps', status: 'ok', deleted });
  } catch (err) {
    tasks.push({ task: 'expired-otps', status: 'error', deleted: 0, error: sanitizeError(err) });
  }

  try {
    const deleted = await cleanupExpiredSessions(db, retention.sessionDays);
    tasks.push({ task: 'expired-sessions', status: 'ok', deleted });
  } catch (err) {
    tasks.push({ task: 'expired-sessions', status: 'error', deleted: 0, error: sanitizeError(err) });
  }

  try {
    const result = await cleanupStaleScanReservations(db, retention.reservedScanMinutes);
    tasks.push({
      task: 'stale-scan-reservations',
      status: 'ok',
      deleted: result.released,
    });
  } catch (err) {
    tasks.push({ task: 'stale-scan-reservations', status: 'error', deleted: 0, error: sanitizeError(err) });
  }

  try {
    const { readyDeleted, failedDeleted } = await cleanupTerminalScanJobs(db, retention);
    tasks.push({ task: 'terminal-ready-jobs', status: 'ok', deleted: readyDeleted });
    tasks.push({ task: 'terminal-failed-jobs', status: 'ok', deleted: failedDeleted });
  } catch (err) {
    tasks.push({ task: 'terminal-scan-jobs', status: 'error', deleted: 0, error: sanitizeError(err) });
  }

  return { ranAt: new Date().toISOString(), environment, tasks };
}
