import { describe, expect, it } from 'vitest';
import { ScanQueueError, classifyScanError, parseMessage } from '../../src/worker/services/scan-queue';

describe('scan queue message contract', () => {
  it('accepts a versioned tenant-scoped scan job', () => {
    expect(parseMessage({
      type: 'scan.process.v1',
      scanId: 'scan_1',
      userId: 'user_1',
      householdId: 'household_1',
      idempotencyKey: 'scan_1:v1',
    })).toMatchObject({ type: 'scan.process.v1', scanId: 'scan_1' });
  });

  it('accepts receipt jobs for the async receipt processor', () => {
    expect(parseMessage({
      type: 'scan.process.v1',
      scanId: 'receipt_1',
      userId: 'user_1',
      householdId: 'household_1',
      scanType: 'receipt',
      idempotencyKey: 'receipt_1:v1',
    })).toMatchObject({ scanType: 'receipt' });
  });

  it('rejects unsupported or cross-tenant-shaped messages as permanent failures', () => {
    expect(() => parseMessage({ type: 'scan.process.v0', scanId: 's', userId: 'u', householdId: 'h' }))
      .toThrowError(ScanQueueError);
    expect(() => parseMessage({ type: 'scan.process.v1', scanId: 's', userId: 'u' }))
      .toThrowError(/missing scan tenancy/);
  });
});

describe('scan queue AI failure policy', () => {
  it.each([
    ['MODEL_NOT_FOUND', false],
    ['AUTHENTICATION_FAILED', false],
    ['PERMISSION_DENIED', false],
    ['LICENSE_REQUIRED', false],
    ['SCHEMA_VALIDATION', false],
    ['INVALID_RESPONSE', false],
    ['AI_SCAN_NO_USABLE_ITEMS', false],
    ['AI_IMAGE_TOO_LARGE', false],
    ['UNSUPPORTED_REQUEST_OPTION', false],
    ['REQUEST_TIMEOUT', true],
    ['NETWORK_ERROR', true],
    ['RATE_LIMITED', true],
    ['UPSTREAM_ERROR', true],
  ] as const)('uses the typed provider retry flag for %s', (code, retryable) => {
    expect(classifyScanError({ code, retryable })).toEqual({ code, retryable });
  });

  it('does not retry an unconfigured model even when only the provider message is available', () => {
    expect(classifyScanError(new Error('Groq API error: 404 model_not_found'))).toEqual({
      code: 'MODEL_NOT_FOUND',
      retryable: false,
    });
    expect(classifyScanError(new Error('Groq API error: 404 The model `legacy-model` does not exist'))).toEqual({
      code: 'MODEL_NOT_FOUND',
      retryable: false,
    });
  });

  it.each([
    ['request timed out after 20000ms', 'UPSTREAM_ERROR'],
    ['fetch failed: connection reset', 'UPSTREAM_ERROR'],
    ['Groq API error: 429 too many requests', 'RATE_LIMITED'],
    ['Groq API error: 503 overloaded', 'UPSTREAM_ERROR'],
  ] as const)('retries transport failure %s', (message, code) => {
    expect(classifyScanError(new Error(message))).toEqual({ code, retryable: true });
  });
});
