import { D1DatabaseBinding } from '@frigo/db';
import type {
  Fetcher,
  KVNamespace,
  Queue,
  R2Bucket,
  SendEmail,
} from '@cloudflare/workers-types';

export type WeekSchemaMode = 'legacy' | 'dual';

export interface Env {
  DB: D1DatabaseBinding;
  AI?: any;
  IMAGES?: R2Bucket;
  CACHE?: KVNamespace;
  SCAN_QUEUE?: Queue<any>;
  SCAN_QUEUE_MODE?: 'sync' | 'async';
  ASSETS?: Fetcher;
  // B1: native Workers email (Paid plan). Present when send_email binding is
  // configured in wrangler.jsonc.
  SEND_EMAIL?: SendEmail;

  ENVIRONMENT?: string;
  WEEK_SCHEMA_MODE?: WeekSchemaMode;
  APP_URL?: string;
  AI_MOCK_MODE?: string;
  MEAL_PLANNER_ENABLED?: string;
  MEAL_PLANNER_AI_ENABLED?: string;
  // Deploy traceability: injected by the deploy workflow as a Wrangler var.
  GIT_COMMIT?: string;
  // Best-effort (default) degrades to isolate-local counters when KV fails;
  // fail-closed rejects the request instead. Per-limiter call sites can
  // override this with `enforcement`.
  RATE_LIMIT_ENFORCEMENT?: 'best-effort' | 'fail-closed';
  // Scheduled cleanup retention overrides (days), see config/retention.ts.
  CLEANUP_OTP_RETENTION_DAYS?: string;
  CLEANUP_SESSION_RETENTION_DAYS?: string;
  CLEANUP_READY_JOB_RETENTION_DAYS?: string;
  CLEANUP_FAILED_JOB_RETENTION_DAYS?: string;
  CLEANUP_RESERVED_SCAN_RETENTION_MINUTES?: string;

  QWEN_API_KEY?: string;
  QWEN_BASE_URL?: string;
  QWEN_MODEL?: string;

  GROQ_API_KEY?: string;
  GROQ_BASE_URL?: string;
  GROQ_VISION_MODEL?: string;
  GROQ_FALLBACK_ENABLED?: string;
  CLOUDFLARE_VISION_FALLBACK?: string;

  ZAI_API_KEY?: string;
  ZAI_BASE_URL?: string;
  // Future GLM/Z.ai fallback is opt-in; a stored key alone must not alter the
  // production provider order.
  GLM_FALLBACK_ENABLED?: string;

  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_BASE_URL?: string;
  // DeepSeek is a text/ranking extension and is disabled unless explicitly
  // enabled for the deployment.
  DEEPSEEK_FALLBACK_ENABLED?: string;

  AI_GATEWAY_URL?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  JWT_SECRET?: string;
  OTP_HASH_SECRET?: string;
  RESEND_API_KEY?: string;
  // S2: server-held code required to manually/back-office grant Frigo Plus.
  // Never exposed to the client; acts as the payment-verification hook until a
  // real NAPAS callback reconciles transfers.
  PLUS_GRANT_SECRET?: string;
  PAYOS_CHECKSUM_KEY?: string;
}

export interface AuthContext {
  userId: string;
  householdId: string;
  isGuest: boolean;
  email?: string;
  role?: string;
  sessionId?: string;
}
