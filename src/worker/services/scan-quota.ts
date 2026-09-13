import { D1DatabaseBinding } from '@frigo/db';
import { getScanQuotaEntitlement, getScanQuotaPeriod, type ScanSubscription } from '../config/scan-quota-policy';

export type QuotaReservation = { reservationId: string; periodStart: string; scanId: string };

export type ScanReservationSpec = {
  imageKey: string | null;
  scanType: 'fridge' | 'food' | 'receipt';
  requestFingerprint: string;
  imageMimeType: string;
};

/** Read one snapshot without creating subscriptions, periods, or reservations. */
export async function getScanQuota(db: D1DatabaseBinding, userId: string, now = new Date()) {
  const period = getScanQuotaPeriod(now);
  const row = await db.prepare(`SELECT sub.plan, sub.status, sub.expires_at,
      (SELECT COUNT(*) FROM scan_quota_ledger
        WHERE user_id = principal.user_id AND period_start = ? AND status != 'released') AS used
    FROM (SELECT ? AS user_id) AS principal
    LEFT JOIN subscriptions AS sub ON sub.user_id = principal.user_id`)
    .bind(period.start, userId).first<ScanSubscription & { used: number }>();
  if (!row || !Number.isSafeInteger(row.used) || row.used < 0) throw new Error('SCAN_QUOTA_UNAVAILABLE');
  const entitlement = getScanQuotaEntitlement(row, now);
  return {
    ...entitlement,
    used: row.used,
    remaining: Math.max(0, entitlement.limit - row.used),
    resetAt: period.resetAt,
  };
}

function changes(result: any): number {
  return Number(result?.meta?.changes || 0);
}

/** Atomically reserves one scan for the current user/month. */
export async function reserveScanQuota(
  db: D1DatabaseBinding,
  input: {
    userId: string;
    householdId: string;
    scanId: string;
    idempotencyKey: string;
    scan?: ScanReservationSpec;
  },
): Promise<{ ok: true; reservation: QuotaReservation; acquired: boolean } | { ok: false; reason: 'exceeded' | 'unavailable' | 'conflict' }> {
  try {
    const existing: any = await db.prepare(
      'SELECT * FROM scan_quota_ledger WHERE idempotency_key = ? OR scan_id = ? LIMIT 1'
    ).bind(input.idempotencyKey, input.scanId).first();
    if (existing && (existing.scan_id !== input.scanId || existing.idempotency_key !== input.idempotencyKey ||
      existing.user_id !== input.userId || existing.household_id !== input.householdId)) {
      return { ok: false, reason: 'conflict' };
    }
    if (input.scan) {
      const existingScan: any = await db.prepare(
        `SELECT id, user_id, household_id, scan_type, request_fingerprint, image_mime_type
           FROM scans WHERE id = ? LIMIT 1`
      ).bind(input.scanId).first();
      if (existingScan && (
        existingScan.user_id !== input.userId ||
        existingScan.household_id !== input.householdId ||
        existingScan.scan_type !== input.scan.scanType ||
        (existingScan.request_fingerprint && existingScan.request_fingerprint !== input.scan.requestFingerprint) ||
        (existingScan.image_mime_type && existingScan.image_mime_type !== input.scan.imageMimeType)
      )) {
        return { ok: false, reason: 'conflict' };
      }
    }
    // Only released rows can move periods; their reclaim always uses today's allowance.
    const now = new Date();
    const period = getScanQuotaPeriod(now).start;
    const sub = await db.prepare(
      'SELECT plan, status, expires_at FROM subscriptions WHERE user_id = ?'
    ).bind(input.userId).first<ScanSubscription>();
    const maxScans = getScanQuotaEntitlement(sub, now).limit;
    const reservationId = `quota_${crypto.randomUUID()}`;
    // D1 serializes this whole batch. The unique ledger is authoritative;
    // used_count is a projection, never an independently incremented counter.
    const available = `(SELECT COUNT(*) FROM scan_quota_ledger
      WHERE user_id = ? AND period_start = ? AND status != 'released') < ?`;
    const statements = [
      db.prepare(`INSERT INTO scan_quota_periods (user_id, household_id, period_start, used_count, max_scans)
        VALUES (?, ?, ?, 0, ?)
        ON CONFLICT(user_id, period_start) DO UPDATE SET max_scans = excluded.max_scans, updated_at = datetime('now')`)
        .bind(input.userId, input.householdId, period, maxScans),
      db.prepare(`INSERT OR IGNORE INTO scan_quota_ledger
        (id, user_id, household_id, scan_id, idempotency_key, period_start, status)
        SELECT ?, ?, ?, ?, ?, ?, 'reserved' WHERE ${available}`)
        .bind(reservationId, input.userId, input.householdId, input.scanId, input.idempotencyKey, period, input.userId, period, maxScans),
      db.prepare(`UPDATE scan_quota_ledger SET id = ?, period_start = ?, status = 'reserved',
          created_at = datetime('now'), completed_at = NULL
        WHERE scan_id = ? AND idempotency_key = ? AND user_id = ? AND household_id = ?
          AND status = 'released' AND ${available}`)
        .bind(reservationId, period, input.scanId, input.idempotencyKey, input.userId, input.householdId, input.userId, period, maxScans),
    ];
    if (input.scan) {
      statements.push(
        db.prepare(`INSERT OR IGNORE INTO scans
          (id, user_id, household_id, image_key, status, scan_type, request_fingerprint, image_mime_type)
          SELECT ?, ?, ?, ?, 'pending', ?, ?, ? WHERE EXISTS (
            SELECT 1 FROM scan_quota_ledger
             WHERE scan_id = ? AND idempotency_key = ? AND user_id = ? AND household_id = ?
               AND status != 'released'
          )`).bind(
            input.scanId,
            input.userId,
            input.householdId,
            input.scan.imageKey,
            input.scan.scanType,
            input.scan.requestFingerprint,
            input.scan.imageMimeType,
            input.scanId,
            input.idempotencyKey,
            input.userId,
            input.householdId,
          ),
        db.prepare(`UPDATE scans
          SET status = 'pending', image_key = ?,
              request_fingerprint = COALESCE(request_fingerprint, ?),
              image_mime_type = COALESCE(image_mime_type, ?),
              updated_at = datetime('now')
          WHERE id = ? AND user_id = ? AND household_id = ? AND scan_type = ?
            AND EXISTS (
              SELECT 1 FROM scan_quota_ledger
               WHERE id = ? AND scan_id = ? AND idempotency_key = ? AND status = 'reserved'
            )`).bind(
              input.scan.imageKey,
              input.scan.requestFingerprint,
              input.scan.imageMimeType,
              input.scanId,
              input.userId,
              input.householdId,
              input.scan.scanType,
              reservationId,
              input.scanId,
              input.idempotencyKey,
            ),
      );
    }
    statements.push(refreshUsage(db, input.userId, period));
    const results = await db.batch(statements);
    if (results.some((result) => !result.success)) return { ok: false, reason: 'unavailable' };
    const row: any = await db.prepare('SELECT * FROM scan_quota_ledger WHERE scan_id = ? OR idempotency_key = ? LIMIT 1')
      .bind(input.scanId, input.idempotencyKey).first();
    if (row && (row.scan_id !== input.scanId || row.idempotency_key !== input.idempotencyKey ||
      row.user_id !== input.userId || row.household_id !== input.householdId)) {
      return { ok: false, reason: 'conflict' };
    }
    if (!row || row.status === 'released') return { ok: false, reason: 'exceeded' };
    const acquired = changes(results[1]) + changes(results[2]) === 1;
    if (input.scan) {
      const persistedScan: any = await db.prepare(
        `SELECT user_id, household_id, scan_type, request_fingerprint, image_mime_type
           FROM scans WHERE id = ? LIMIT 1`
      ).bind(input.scanId).first();
      if (!persistedScan) {
        if (acquired) await finalizeScanQuota(db, reservationId, 'released');
        return { ok: false, reason: 'unavailable' };
      }
      if (
        persistedScan.user_id !== input.userId ||
        persistedScan.household_id !== input.householdId ||
        persistedScan.scan_type !== input.scan.scanType ||
        (persistedScan.request_fingerprint && persistedScan.request_fingerprint !== input.scan.requestFingerprint) ||
        (persistedScan.image_mime_type && persistedScan.image_mime_type !== input.scan.imageMimeType)
      ) {
        if (acquired) await finalizeScanQuota(db, reservationId, 'released');
        return { ok: false, reason: 'conflict' };
      }
    }
    return { ok: true, acquired,
      reservation: { reservationId: acquired ? reservationId : row.id, periodStart: row.period_start, scanId: row.scan_id } };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

function refreshUsage(db: D1DatabaseBinding, userId: string, period: string) {
  return db.prepare(`UPDATE scan_quota_periods SET used_count =
    (SELECT COUNT(*) FROM scan_quota_ledger WHERE user_id = ? AND period_start = ? AND status != 'released'),
    updated_at = datetime('now') WHERE user_id = ? AND period_start = ?`).bind(userId, period, userId, period);
}

export async function finalizeScanQuota(db: D1DatabaseBinding, reservationId: string, status: 'consumed' | 'released'): Promise<void> {
  if (status === 'consumed') {
    await db.prepare("UPDATE scan_quota_ledger SET status = 'consumed', completed_at = datetime('now') WHERE id = ? AND status = 'reserved'").bind(reservationId).run();
    return;
  }
  const row: any = await db.prepare("SELECT user_id, period_start FROM scan_quota_ledger WHERE id = ? AND status = 'reserved'").bind(reservationId).first();
  if (!row) return;
  await db.batch([
    db.prepare("UPDATE scan_quota_ledger SET status = 'released', completed_at = datetime('now') WHERE id = ? AND status = 'reserved'").bind(reservationId),
    refreshUsage(db, row.user_id, row.period_start),
  ]);
}

export interface ScanReservationReconciliation {
  consumed: number;
  released: number;
  expiredJobs: number;
  expiredScans: number;
}

/**
 * Bound ambiguous async enqueue outcomes. A reservation that has already
 * reached a terminal successful scan is consumed. Otherwise, once both the
 * reservation and any queue job are older than the bounded lease, the scan is
 * failed and its quota is released. The operation is one D1 batch so a queue
 * consumer cannot observe a half-reconciled reservation.
 */
export async function reconcileStaleScanReservations(
  db: D1DatabaseBinding,
  staleMinutes: number,
): Promise<ScanReservationReconciliation> {
  const minutes = Number.isFinite(staleMinutes)
    ? Math.min(7 * 24 * 60, Math.max(5, Math.floor(staleMinutes)))
    : 60;
  const modifier = `-${minutes} minutes`;
  const staleReservation = `q.status = 'reserved'
    AND datetime(q.created_at) IS NOT NULL
    AND datetime(q.created_at) < datetime('now', ?)`;
  const staleJob = `datetime(COALESCE(j.locked_at, j.updated_at, j.created_at)) IS NOT NULL
    AND datetime(COALESCE(j.locked_at, j.updated_at, j.created_at)) < datetime('now', ?)`;
  const freshJob = `j.status IN ('pending', 'processing')
    AND datetime(COALESCE(j.locked_at, j.updated_at, j.created_at)) >= datetime('now', ?)`;

  const results = await db.batch([
    // A worker may have completed after the producer lost its response. Do
    // not refund a successful scan in that case.
    db.prepare(`UPDATE scan_quota_ledger AS q SET status = 'consumed', completed_at = datetime('now')
      WHERE ${staleReservation}
        AND EXISTS (SELECT 1 FROM scans s WHERE s.id = q.scan_id AND s.status IN ('ready', 'confirmed'))`)
      .bind(modifier),
    // Expire old pending/processing queue rows so they cannot keep a quota
    // reservation alive indefinitely. A fresh delivery remains untouched.
    db.prepare(`UPDATE scan_queue_jobs AS j SET status = 'failed', error_code = 'RESERVATION_EXPIRED',
        error_message = 'Bản quét đã hết thời gian chờ xử lý.', completed_at = datetime('now'), updated_at = datetime('now')
      WHERE j.status IN ('pending', 'processing') AND ${staleJob}
        AND EXISTS (SELECT 1 FROM scans s WHERE s.id = j.scan_id AND s.status IN ('pending', 'processing', 'failed'))
        AND EXISTS (SELECT 1 FROM scan_quota_ledger q
          WHERE q.scan_id = j.scan_id AND ${staleReservation})`)
      .bind(modifier, modifier),
    db.prepare(`UPDATE scans AS s SET status = 'failed', updated_at = datetime('now')
      WHERE s.status IN ('pending', 'processing')
        AND EXISTS (SELECT 1 FROM scan_quota_ledger q
          WHERE q.scan_id = s.id AND ${staleReservation})
        AND NOT EXISTS (SELECT 1 FROM scan_queue_jobs j
          WHERE j.scan_id = s.id AND ${freshJob})`)
      .bind(modifier, modifier),
    db.prepare(`UPDATE scan_quota_ledger AS q SET status = 'released', completed_at = datetime('now')
      WHERE ${staleReservation}
        AND (
          NOT EXISTS (SELECT 1 FROM scans s WHERE s.id = q.scan_id)
          OR EXISTS (SELECT 1 FROM scans s WHERE s.id = q.scan_id AND s.status = 'failed')
        )`)
      .bind(modifier),
    // Keep the materialized usage projection aligned after either transition.
    db.prepare(`UPDATE scan_quota_periods AS p SET used_count = (
        SELECT COUNT(*) FROM scan_quota_ledger q
        WHERE q.user_id = p.user_id AND q.period_start = p.period_start AND q.status != 'released'
      ), updated_at = datetime('now')
      WHERE EXISTS (SELECT 1 FROM scan_quota_ledger q
        WHERE q.user_id = p.user_id AND q.period_start = p.period_start)`),
  ]);

  if (results.some((result) => !result.success)) throw new Error('SCAN_QUOTA_RECONCILIATION_FAILED');
  const count = (index: number) => Number(results[index]?.meta?.changes || 0);
  return {
    consumed: count(0),
    expiredJobs: count(1),
    expiredScans: count(2),
    released: count(3),
  };
}
