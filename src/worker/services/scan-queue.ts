import { AIRouter } from '@frigo/ai';
import { findCanonicalIngredient, findCanonicalIngredientById, StandardUnit } from '@frigo/domain';
import { Env } from '../types';
import { sha256Hex } from '../utils/session';
import { aiConfigFromEnv, logAIUsage } from '../config/ai';

export type ScanQueueMessage = {
  type: 'scan.process.v1';
  jobId?: string;
  scanId: string;
  userId: string;
  householdId: string;
  scanType?: 'fridge' | 'food' | 'receipt';
  imageBase64?: string;
  imageKey?: string;
  mimeType?: string;
  idempotencyKey?: string;
  requestFingerprint?: string;
};

export type QueueDecision = 'ack' | 'retry';

// Keep a hung native/provider call from holding a queue lease indefinitely.
// Provider-specific calls have their own shorter timeout where supported.
// Leave enough wall-clock time for full-page receipt OCR while still bounding
// a stuck provider call before the queue lease expires.
export const SCAN_AI_TIMEOUT_MS = 75_000;

export class ScanQueueError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ScanQueueError';
  }
}

/** Persist the queue intent before sending so an ambiguous producer response
 * can be retried by the scheduled reconciler without charging another scan. */
export async function ensureScanQueueIntent(env: Env, message: ScanQueueMessage): Promise<void> {
  const jobId = message.jobId || `scan_job_${message.scanId}`;
  const idempotencyKey = message.idempotencyKey || jobId;
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO scan_queue_jobs
      (id, scan_id, household_id, user_id, idempotency_key, status)
     SELECT ?, ?, ?, ?, ?, 'pending' WHERE EXISTS (
       SELECT 1 FROM scans WHERE id = ? AND user_id = ? AND household_id = ?
         AND status IN ('pending', 'processing'))`,
  ).bind(
    jobId,
    message.scanId,
    message.householdId,
    message.userId,
    idempotencyKey,
    message.scanId,
    message.userId,
    message.householdId,
  ).run();
  if (!inserted.success) throw new ScanQueueError('Queue intent could not be persisted', 'DATABASE_ERROR', true);

  // A client retry is evidence that the producer is still active. Re-arm only
  // a synthetic reservation-expiry tombstone; permanent provider failures and
  // active processing leases must remain untouched.
  const rearmed = await env.DB.prepare(
    `UPDATE scan_queue_jobs SET status = 'pending', attempts = 0,
        claim_token = NULL, claim_attempt = 0, locked_at = NULL,
        error_code = NULL, error_message = NULL, completed_at = NULL,
        updated_at = datetime('now')
       WHERE id = ? AND scan_id = ? AND user_id = ? AND household_id = ?
         AND status = 'failed' AND error_code = 'RESERVATION_EXPIRED'`,
  ).bind(jobId, message.scanId, message.userId, message.householdId).run();
  if (!rearmed.success) throw new ScanQueueError('Queue intent could not be re-armed', 'DATABASE_ERROR', true);

  // Refresh only a pending intent; never disturb a worker's processing lease.
  const refreshed = await env.DB.prepare(
    `UPDATE scan_queue_jobs SET updated_at = datetime('now')
       WHERE id = ? AND scan_id = ? AND user_id = ? AND household_id = ? AND status = 'pending'`,
  ).bind(jobId, message.scanId, message.userId, message.householdId).run();
  if (!refreshed.success) throw new ScanQueueError('Queue intent could not be refreshed', 'DATABASE_ERROR', true);

  const row = await env.DB.prepare(
    `SELECT id, scan_id, user_id, household_id, idempotency_key
       FROM scan_queue_jobs WHERE id = ? OR idempotency_key = ? LIMIT 1`,
  ).bind(jobId, idempotencyKey).first<{
    id: string;
    scan_id: string;
    user_id: string;
    household_id: string;
    idempotency_key: string;
  }>();
  if (!row || row.id !== jobId || row.scan_id !== message.scanId || row.user_id !== message.userId ||
      row.household_id !== message.householdId || row.idempotency_key !== idempotencyKey) {
    throw new ScanQueueError('Queue intent is bound to another scan tenant', 'IDEMPOTENCY_CONFLICT', false);
  }
}

type ProviderFailureShape = {
  code: string;
  retryable: boolean;
};

export type ScanFailureClassification = {
  code: string;
  retryable: boolean;
};

/** Keep provider/database details out of durable queue records and logs. */
export function sanitizedScanErrorMessage(code: string): string {
  switch (code) {
    case 'AI_SCAN_NO_USABLE_ITEMS':
    case 'INVALID_RESPONSE':
    case 'SCHEMA_VALIDATION':
      return 'Không nhận diện được dữ liệu đủ rõ từ ảnh.';
    case 'AI_IMAGE_TOO_LARGE':
      return 'Ảnh bản quét vượt quá giới hạn dung lượng cho phép.';
    case 'UNSUPPORTED_REQUEST_OPTION':
      return 'Dịch vụ nhận diện tạm thời không tương thích với model hiện tại.';
    case 'REQUEST_TIMEOUT':
    case 'AI_SCAN_TIMEOUT':
      return 'Dịch vụ nhận diện phản hồi quá lâu.';
    case 'MODEL_NOT_FOUND':
    case 'AUTHENTICATION_FAILED':
    case 'PERMISSION_DENIED':
    case 'LICENSE_REQUIRED':
    case 'AI_SCAN_UNAVAILABLE':
    case 'AI_UNAVAILABLE':
    case 'AI_ESCALATION_EXHAUSTED':
    case 'AI_BUDGET_EXCEEDED':
      return 'Dịch vụ nhận diện đang tạm thời không khả dụng.';
    case 'NETWORK_ERROR':
    case 'RATE_LIMITED':
    case 'UPSTREAM_ERROR':
      return 'Dịch vụ nhận diện đang bận hoặc mất kết nối.';
    case 'IMAGE_NOT_FOUND':
    case 'IMAGE_UNAVAILABLE':
      return 'Ảnh bản quét không còn khả dụng.';
    case 'MAX_ATTEMPTS_EXCEEDED':
      return 'Bản quét đã hết số lần xử lý tự động.';
    case 'RESERVATION_EXPIRED':
      return 'Bản quét đã hết thời gian chờ xử lý.';
    case 'CLAIM_LOST':
    case 'CLAIM_FAILED':
    case 'DATABASE_ERROR':
      return 'Không thể lưu trạng thái bản quét.';
    default:
      return 'Không thể xử lý bản quét.';
  }
}

function isProviderFailureShape(error: unknown): error is ProviderFailureShape {
  if (!error || typeof error !== 'object') return false;
  const value = error as Partial<ProviderFailureShape>;
  return typeof value.code === 'string' && typeof value.retryable === 'boolean';
}

async function runScanAI<T>(operation: Promise<T>, timeoutMs = SCAN_AI_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new ScanQueueError(`AI scan timed out after ${timeoutMs}ms`, 'REQUEST_TIMEOUT', true));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Convert external AI failures into a bounded queue policy. Model access,
 * authentication, license, schema and malformed-output failures cannot be
 * repaired by replaying the same image; only transport/rate-limit/upstream
 * failures should consume another queue attempt.
 */
export function classifyScanError(error: unknown): ScanFailureClassification {
  if (error instanceof ScanQueueError) {
    return { code: error.code, retryable: error.retryable };
  }
  if (isProviderFailureShape(error)) {
    return { code: error.code, retryable: error.retryable };
  }

  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  if (/(model[_ -]?not[_ -]?found|model[\s\S]{0,120}(?:not found|does not exist)|no access)/i.test(normalized)) {
    return { code: 'MODEL_NOT_FOUND', retryable: false };
  }
  if (/(license|5016|must be accepted|prompt\s*[=:]\s*["']?agree)/i.test(normalized)) {
    return { code: 'LICENSE_REQUIRED', retryable: false };
  }
  if (/(authentication|unauthorized|\b401\b)/i.test(normalized)) {
    return { code: 'AUTHENTICATION_FAILED', retryable: false };
  }
  if (/(forbidden|permission denied|\b403\b)/i.test(normalized)) {
    return { code: 'PERMISSION_DENIED', retryable: false };
  }
  if (/(schema|non[- ]?json|invalid response|no detectable|no receipt items|no usable items|\b404\b|\b422\b)/i.test(normalized)) {
    return { code: 'INVALID_RESPONSE', retryable: false };
  }
  if (/(timeout|timed out|abort|network|fetch failed|connection reset|econn|\b408\b|\b425\b|\b429\b|\b5\d\d\b)/i.test(normalized)) {
    return { code: /\b429\b/.test(normalized) ? 'RATE_LIMITED' : 'UPSTREAM_ERROR', retryable: true };
  }
  // Preserve retry for unknown infrastructure failures (for example a D1
  // trigger/connection error). Provider output failures should arrive as a
  // typed error from @frigo/ai and are handled by the branches above.
  return { code: 'AI_SCAN_FAILED', retryable: true };
}

function parseMessage(body: unknown): ScanQueueMessage {
  if (!body || typeof body !== 'object') {
    throw new ScanQueueError('Queue message must be an object', 'INVALID_MESSAGE', false);
  }
  const value = body as Partial<ScanQueueMessage>;
  if (value.type !== 'scan.process.v1') {
    throw new ScanQueueError('Unsupported queue message type', 'UNSUPPORTED_MESSAGE', false);
  }
  if (!value.scanId || !value.userId || !value.householdId) {
    throw new ScanQueueError('Queue message is missing scan tenancy fields', 'INVALID_MESSAGE', false);
  }
  if (value.scanType && value.scanType !== 'fridge' && value.scanType !== 'food' && value.scanType !== 'receipt') {
    throw new ScanQueueError('Unsupported scan type', 'INVALID_MESSAGE', false);
  }
  return value as ScanQueueMessage;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function canonicalImageBase64(value: string): string {
  const match = value.match(/^data:image\/[A-Za-z0-9.+-]+;base64,([\s\S]*)$/i);
  return (match?.[1] || value).replace(/\s+/g, '');
}

async function verifyScanRequestIdentity(
  env: Env,
  message: ScanQueueMessage,
  image: { data: string; mimeType: string },
): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT request_fingerprint, image_mime_type FROM scans WHERE id = ? AND user_id = ? AND household_id = ?`,
  ).bind(message.scanId, message.userId, message.householdId).first<{ request_fingerprint: string | null; image_mime_type: string | null }>();
  if (!row?.request_fingerprint) return;
  if (message.requestFingerprint && message.requestFingerprint !== row.request_fingerprint) {
    throw new ScanQueueError('Queue image fingerprint does not match scan', 'IDEMPOTENCY_CONFLICT', false);
  }
  const mimeType = (row.image_mime_type || image.mimeType || 'image/jpeg').toLowerCase();
  const actual = await sha256Hex(`${message.scanType || 'fridge'}\n${mimeType}\n${canonicalImageBase64(image.data)}`);
  if (actual !== row.request_fingerprint) {
    throw new ScanQueueError('Scan image does not match persisted request', 'IDEMPOTENCY_CONFLICT', false);
  }
}

function getRouter(env: Env): AIRouter {
  return new AIRouter(aiConfigFromEnv(env), logAIUsage);
}

async function loadImage(env: Env, message: ScanQueueMessage): Promise<{ data: string; mimeType: string }> {
  if (message.imageBase64) {
    const embeddedMime = message.imageBase64.match(/^data:(image\/[A-Za-z0-9.+-]+);base64,/)?.[1];
    return { data: message.imageBase64, mimeType: message.mimeType || embeddedMime || 'image/jpeg' };
  }
  if (!message.imageKey || !env.IMAGES) {
    throw new ScanQueueError('Scan image is unavailable', 'IMAGE_UNAVAILABLE', false);
  }
  const object = await env.IMAGES.get(message.imageKey);
  if (!object) throw new ScanQueueError('Scan image was not found', 'IMAGE_NOT_FOUND', false);
  return {
    data: toBase64(new Uint8Array(await object.arrayBuffer())),
    // R2 metadata is written with the original upload and is authoritative;
    // a stale/replayed queue message must not reinterpret the bytes.
    mimeType: object.httpMetadata?.contentType || message.mimeType || 'image/jpeg',
  };
}

type ScanClaim = { status: 'claimed'; jobId: string; claimToken: string } | { status: 'done' | 'missing' };

function newClaimToken(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `claim_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
}

/** Claim a job with a fenced lease. Busy deliveries remain retryable. */
async function claimScanJobWithLease(env: Env, message: ScanQueueMessage): Promise<ScanClaim> {
  const scan = await env.DB.prepare(
    `SELECT id, status, scan_type FROM scans WHERE id = ? AND user_id = ? AND household_id = ?`,
  ).bind(message.scanId, message.userId, message.householdId).first<{ id: string; status: string; scan_type: string }>();
  if (!scan) return { status: 'missing' };

  const scanType = message.scanType || 'fridge';
  if (scan.scan_type !== scanType) {
    throw new ScanQueueError('Queue scan type does not match persisted scan', 'SCAN_TYPE_MISMATCH', false);
  }
  if (['ready', 'confirmed', 'failed'].includes(scan.status)) return { status: 'done' };

  const jobId = message.jobId || `scan_job_${message.scanId}`;
  const idempotencyKey = message.idempotencyKey || jobId;
  const existingByKey = await env.DB.prepare(
    `SELECT id, status, locked_at, attempts, max_attempts, scan_id, user_id, household_id, claim_token
       FROM scan_queue_jobs WHERE idempotency_key = ? LIMIT 1`,
  ).bind(idempotencyKey).first<{ id: string; status: string; locked_at: string | null; attempts: number; max_attempts: number; scan_id: string; user_id: string; household_id: string; claim_token: string | null }>();
  if (existingByKey && (existingByKey.id !== jobId || existingByKey.scan_id !== message.scanId || existingByKey.user_id !== message.userId || existingByKey.household_id !== message.householdId)) {
    throw new ScanQueueError('Queue idempotency key is bound to another scan tenant', 'IDEMPOTENCY_CONFLICT', false);
  }
  if (!existingByKey) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO scan_queue_jobs
        (id, scan_id, household_id, user_id, idempotency_key)
       SELECT ?, ?, ?, ?, ? WHERE EXISTS (
         SELECT 1 FROM scans WHERE id = ? AND user_id = ? AND household_id = ?
           AND status IN ('pending', 'processing'))`,
    ).bind(jobId, message.scanId, message.householdId, message.userId, idempotencyKey,
      message.scanId, message.userId, message.householdId).run();
  }

  const existing = await env.DB.prepare(
    `SELECT id, status, scan_id, user_id, household_id, idempotency_key
       FROM scan_queue_jobs WHERE id = ? OR idempotency_key = ?`,
  ).bind(jobId, idempotencyKey).first<{ id: string; status: string; scan_id: string; user_id: string; household_id: string; idempotency_key: string }>();
  if (existing && (existing.id !== jobId || existing.scan_id !== message.scanId || existing.user_id !== message.userId || existing.household_id !== message.householdId || existing.idempotency_key !== idempotencyKey)) {
    throw new ScanQueueError('Queue idempotency key is bound to another scan tenant', 'IDEMPOTENCY_CONFLICT', false);
  }
  if (existing?.status === 'ready' || existing?.status === 'failed') return { status: 'done' };

  const claimToken = newClaimToken();
  const exhaustedToken = newClaimToken();
  const eligible = `(status = 'pending' OR (status = 'processing'
    AND (locked_at IS NULL OR datetime(locked_at) <= datetime('now', '-10 minutes'))))`;
  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE scan_queue_jobs SET status = 'failed', error_code = 'MAX_ATTEMPTS_EXCEEDED',
      error_message = 'Processing lease expired after maximum attempts', completed_at = datetime('now'), updated_at = datetime('now'), claim_token = ?
      WHERE id = ? AND attempts >= max_attempts AND ${eligible}
        AND EXISTS (SELECT 1 FROM scans WHERE id = ? AND user_id = ? AND household_id = ? AND status IN ('pending', 'processing'))`)
      .bind(exhaustedToken, jobId, message.scanId, message.userId, message.householdId),
    env.DB.prepare(`UPDATE scans SET status = 'failed', updated_at = datetime('now')
      WHERE id = ? AND user_id = ? AND household_id = ? AND status IN ('pending', 'processing')
        AND EXISTS (SELECT 1 FROM scan_queue_jobs WHERE id = ? AND status = 'failed' AND claim_token = ?)`)
      .bind(message.scanId, message.userId, message.householdId, jobId, exhaustedToken),
    env.DB.prepare(`UPDATE scan_queue_jobs
       SET status = 'processing', attempts = attempts + 1,
           locked_at = datetime('now'), updated_at = datetime('now'),
           error_code = NULL, error_message = NULL,
           claim_token = ?, claim_attempt = attempts + 1
     WHERE id = ? AND attempts < max_attempts AND ${eligible}
       AND EXISTS (SELECT 1 FROM scans WHERE id = ? AND user_id = ? AND household_id = ?
         AND status IN ('pending', 'processing'))`)
      .bind(claimToken, jobId, message.scanId, message.userId, message.householdId),
    env.DB.prepare(`UPDATE scans SET status = 'processing', updated_at = datetime('now')
      WHERE id = ? AND status IN ('pending', 'processing')
        AND EXISTS (SELECT 1 FROM scan_queue_jobs WHERE id = ? AND status = 'processing' AND claim_token = ?)`)
      .bind(message.scanId, jobId, claimToken),
  ]);
  if (results.some((result) => !result.success)) throw new ScanQueueError('Scan claim failed', 'CLAIM_FAILED', true);
  if (results[2].meta?.changes === 1) return { status: 'claimed', jobId, claimToken };
  const current = await env.DB.prepare(`SELECT scans.status AS scan_status, scan_queue_jobs.status AS job_status
    FROM scans LEFT JOIN scan_queue_jobs ON scan_queue_jobs.id = ? WHERE scans.id = ?`)
    .bind(jobId, message.scanId).first<{ scan_status: string; job_status: string | null }>();
  if (!current) return { status: 'missing' };
  if (['ready', 'confirmed', 'failed'].includes(current.scan_status) || ['ready', 'failed'].includes(current.job_status || '')) {
    return { status: 'done' };
  }
  throw new ScanQueueError('Scan job is already being processed', 'JOB_IN_PROGRESS', true);
}

function commitFence(env: Env, message: ScanQueueMessage, jobId: string, claimToken: string) {
  const token = newClaimToken();
  // Rotate to a transaction-only token before any side effects. A lost/expired
  // claim cannot produce this token, so every later statement becomes a no-op.
  const acquire = env.DB.prepare(`UPDATE scan_queue_jobs SET claim_token = ?
    WHERE id = ? AND scan_id = ? AND user_id = ? AND household_id = ?
      AND status = 'processing' AND claim_token = ?
      AND datetime(locked_at) > datetime('now', '-10 minutes')
      AND EXISTS (SELECT 1 FROM scans WHERE id = ? AND status = 'processing')`)
    .bind(token, jobId, message.scanId, message.userId, message.householdId, claimToken, message.scanId);
  const guard = `EXISTS (SELECT 1 FROM scan_queue_jobs WHERE id = ? AND status = 'processing' AND claim_token = ?)`;
  const bindings = [jobId, token] as const;
  return { acquire, guard, bindings };
}

function assertFencedCommit(results: { success: boolean; meta: Record<string, unknown> }[]): void {
  if (results.some((result) => !result.success)) throw new ScanQueueError('Scan persistence failed', 'DATABASE_ERROR', true);
  if (results[0].meta?.changes !== 1 || results[results.length - 1].meta?.changes !== 1) {
    throw new ScanQueueError('Scan result claim was lost before commit', 'CLAIM_LOST', true);
  }
}

/** Backward-compatible status helper for tests and operational tooling. */
export async function claimScanJob(env: Env, message: ScanQueueMessage): Promise<'claimed' | 'done' | 'missing'> {
  const claim = await claimScanJobWithLease(env, message);
  return claim.status;
}

export async function processScanJob(env: Env, messageBody: unknown): Promise<void> {
  const message = parseMessage(messageBody);
  const claim = await claimScanJobWithLease(env, message);
  if (claim.status === 'missing') {
    throw new ScanQueueError('Scan record was not found for queue job', 'SCAN_NOT_FOUND', false);
  }
  if (claim.status !== 'claimed') return;

  const { jobId, claimToken } = claim;
  try {
    const image = await loadImage(env, message);
    await verifyScanRequestIdentity(env, message, image);
    const router = getRouter(env);
    const scanType = message.scanType || 'fridge';
    const fence = commitFence(env, message, jobId, claimToken);
    if (scanType === 'receipt') {
      const receipt = await runScanAI(router.receiptScan({ imageBase64OrUrl: image.data, mimeType: image.mimeType }));
      const statements = receipt.items.map((item, index) => {
        const canonical = findCanonicalIngredient(item.raw_name);
        const providerCanonical = item.canonical_id ? findCanonicalIngredientById(item.canonical_id) : null;
        return env.DB.prepare(
          `INSERT INTO scan_items
            (id, scan_id, raw_name, canonical_id, estimated_quantity, unit, confidence, category, storage,
             unit_price_vnd, total_price_vnd)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${fence.guard}`,
        ).bind(
          `scan_item_${message.scanId}_${index}`,
          message.scanId,
          item.raw_name,
          canonical?.id || providerCanonical?.id || null,
          item.estimated_quantity,
          item.unit as StandardUnit,
          item.confidence,
          canonical?.category || item.category || 'other',
          item.storage || 'fridge',
          item.unit_price_vnd ?? null,
          item.total_price_vnd ?? null,
          ...fence.bindings,
        );
      });
      const commitStatements = [
        fence.acquire,
        env.DB.prepare(`DELETE FROM scan_items WHERE scan_id = ? AND ${fence.guard}`).bind(message.scanId, ...fence.bindings),
        ...statements,
        env.DB.prepare(
          `UPDATE scans SET status = 'ready', merchant_name = ?, invoice_number = ?, purchase_date = ?,
             total_amount_vnd = ?, updated_at = datetime('now')
           WHERE id = ? AND status = 'processing' AND ${fence.guard}`,
        ).bind(receipt.merchant_name ?? null, receipt.invoice_number ?? null, receipt.purchase_date ?? null, receipt.total_amount_vnd ?? null, message.scanId, ...fence.bindings),
        env.DB.prepare(
          `UPDATE scan_queue_jobs SET status = 'ready', completed_at = datetime('now'), updated_at = datetime('now')
           WHERE id = ? AND status = 'processing' AND claim_token = ?`,
        ).bind(...fence.bindings),
      ];
      const commitResults = await env.DB.batch(commitStatements);
      assertFencedCommit(commitResults);
    } else {
      const result = await runScanAI(router.vision({
        imageBase64OrUrl: image.data,
        mimeType: image.mimeType,
      }));
      const statements = result.items.map((item, index) => {
        const canonical = findCanonicalIngredient(item.raw_name);
        const providerCanonical = item.canonical_id
          ? findCanonicalIngredientById(item.canonical_id)
          : null;
        return env.DB.prepare(
        `INSERT INTO scan_items
          (id, scan_id, raw_name, canonical_id, estimated_quantity, unit, confidence, category, storage)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${fence.guard}`,
        ).bind(
          `scan_item_${message.scanId}_${index}`,
          message.scanId,
          item.raw_name,
          canonical?.id || providerCanonical?.id || null,
          item.estimated_quantity,
          item.unit as StandardUnit,
          item.confidence,
          canonical?.category || providerCanonical?.category || item.category || 'other',
          item.storage || 'fridge',
          ...fence.bindings,
        );
      });
      const commitStatements = [
        fence.acquire,
        env.DB.prepare(`DELETE FROM scan_items WHERE scan_id = ? AND ${fence.guard}`).bind(message.scanId, ...fence.bindings),
        ...statements,
        env.DB.prepare(`UPDATE scans SET status = 'ready', updated_at = datetime('now') WHERE id = ? AND status = 'processing' AND ${fence.guard}`)
          .bind(message.scanId, ...fence.bindings),
        env.DB.prepare(
          `UPDATE scan_queue_jobs SET status = 'ready', completed_at = datetime('now'), updated_at = datetime('now')
           WHERE id = ? AND status = 'processing' AND claim_token = ?`,
        ).bind(...fence.bindings),
      ];
      const commitResults = await env.DB.batch(commitStatements);
      assertFencedCommit(commitResults);
    }
  } catch (error) {
    const classification = classifyScanError(error);
    const code = classification.code;
    const requestedRetry = classification.retryable;
    const attemptsRow = await env.DB.prepare(
      `SELECT attempts, max_attempts FROM scan_queue_jobs WHERE id = ? AND status = 'processing' AND claim_token = ?`,
    ).bind(jobId, claimToken).first<{ attempts: number; max_attempts: number }>();
    if (!attemptsRow) throw new ScanQueueError('Scan job claim is no longer owned', 'CLAIM_LOST', true);
    const retryable = requestedRetry && attemptsRow.attempts < attemptsRow.max_attempts;
    const fence = commitFence(env, message, jobId, claimToken);
    const failureResults = await env.DB.batch([
      fence.acquire,
      env.DB.prepare(`UPDATE scans SET status = ?, updated_at = datetime('now')
        WHERE id = ? AND status = 'processing' AND ${fence.guard}`)
        .bind(retryable ? 'pending' : 'failed', message.scanId, ...fence.bindings),
      env.DB.prepare(`UPDATE scan_queue_jobs SET status = ?, error_code = ?, error_message = ?,
        completed_at = CASE WHEN ? = 'failed' THEN datetime('now') ELSE NULL END, updated_at = datetime('now')
        WHERE id = ? AND status = 'processing' AND claim_token = ?`)
        .bind(retryable ? 'pending' : 'failed', code, sanitizedScanErrorMessage(code),
          retryable ? 'pending' : 'failed', ...fence.bindings),
    ]);
    assertFencedCommit(failureResults);
    throw new ScanQueueError(sanitizedScanErrorMessage(code), code, retryable);
  }
}

export { parseMessage };
