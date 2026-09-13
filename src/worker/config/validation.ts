import { Env } from '../types';
import { applicationOrigin } from './origins';

/**
 * Centralized configuration validation. Production must fail loudly when the
 * deployment is dangerous; every message is a static string and never embeds
 * secret values, token material, or binding identifiers.
 *
 * Production authentication always requires Turnstile; optional providers
 * remain feature-aware.
 */

export const VALID_ENVIRONMENTS = ['development', 'staging', 'production'] as const;

export type ConfigSeverity = 'fatal' | 'warning';

export interface ConfigIssue {
  code: string;
  severity: ConfigSeverity;
  message: string;
}

export interface ConfigValidationResult {
  environment: string;
  /** No fatal issues (non-production environments always pass). */
  ok: boolean;
  fatal: ConfigIssue[];
  warnings: ConfigIssue[];
}

/**
 * Vision providers that can actually be constructed by AIRouter. Keeping this
 * capability calculation in one place prevents readiness from reporting the
 * native AI binding as healthy when the router has no usable OCR provider.
 */
export type EffectiveVisionProvider = 'qwen' | 'groq' | 'cloudflare' | 'glm' | 'mock';

type VisionCapabilityEnv = Pick<
  Env,
  | 'AI'
  | 'AI_MOCK_MODE'
  | 'AI_ENABLED'
  | 'QWEN_API_KEY'
  | 'AI_QWEN_ONLY'
  | 'GROQ_API_KEY'
  | 'GROQ_FALLBACK_ENABLED'
  | 'CLOUDFLARE_VISION_FALLBACK'
  | 'ZAI_API_KEY'
  | 'GLM_FALLBACK_ENABLED'
>;

export function getEffectiveVisionProviders(env: VisionCapabilityEnv): EffectiveVisionProvider[] {
  if (env.AI_MOCK_MODE === 'true') return ['mock'];
  if (env.AI_ENABLED === 'false') return [];

  const providers: EffectiveVisionProvider[] = [];
  if (env.QWEN_API_KEY?.trim()) providers.push('qwen');
  if (env.AI_QWEN_ONLY === 'true') return providers;
  if (env.GROQ_FALLBACK_ENABLED === 'true' && env.GROQ_API_KEY?.trim()) providers.push('groq');
  if (env.CLOUDFLARE_VISION_FALLBACK === 'true' && env.AI) providers.push('cloudflare');
  if (env.GLM_FALLBACK_ENABLED === 'true' && env.ZAI_API_KEY?.trim()) providers.push('glm');
  return providers;
}

export function getAIServiceStatus(env: VisionCapabilityEnv): 'configured' | 'mock' | 'disabled' {
  if (env.AI_MOCK_MODE === 'true') return 'mock';
  return getEffectiveVisionProviders(env).length > 0 ? 'configured' : 'disabled';
}

function fatal(code: string, message: string): ConfigIssue {
  return { code, severity: 'fatal', message };
}

function warning(code: string, message: string): ConfigIssue {
  return { code, severity: 'warning', message };
}

function isValidQwenBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const loopback = url.hostname === 'localhost' || url.hostname.endsWith('.localhost') ||
      url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    return url.protocol === 'https:' && Boolean(url.hostname) && !loopback &&
      !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

function isValidQwenModel(value: string): boolean {
  return value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value);
}

function isQwenModelIdentifier(value: string): boolean {
  return /^qwen[\w.:-]*$/i.test(value);
}

export function validateEnvironment(env: Env): ConfigValidationResult {
  const environment = env.ENVIRONMENT || 'development';
  const warnings: ConfigIssue[] = [];

  if (!VALID_ENVIRONMENTS.includes(environment as (typeof VALID_ENVIRONMENTS)[number])) {
    warnings.push(
      warning(
        'CONFIG_INVALID_ENVIRONMENT',
        'ENVIRONMENT must be one of development, staging, production; treating the deployment as non-production.'
      )
    );
  }

  if (environment !== 'production') {
    return { environment, ok: true, fatal: [], warnings };
  }

  const fatalIssues: ConfigIssue[] = [];

  // Cookie mutations need a configured trusted origin, not just a reachable host.
  if (!applicationOrigin(env)) {
    fatalIssues.push(
      fatal('CONFIG_PRODUCTION_APP_URL', 'APP_URL must be a public HTTPS URL in production; missing, invalid, credential-bearing and loopback URLs are rejected.')
    );
  }

  if (env.AI_MOCK_MODE === 'true') {
    fatalIssues.push(fatal('CONFIG_MOCK_MODE_IN_PRODUCTION', 'AI_MOCK_MODE must not be true in production.'));
  }

  if (env.AI_ENABLED !== undefined && env.AI_ENABLED !== 'true') {
    fatalIssues.push(fatal('CONFIG_AI_DISABLED_IN_PRODUCTION', 'AI_ENABLED must be true in production; disabling the AI runtime leaves scan and explanation paths unavailable.'));
  }

  if (env.AI_QWEN_ONLY !== undefined && env.AI_QWEN_ONLY !== 'true') {
    fatalIssues.push(fatal('CONFIG_QWEN_ONLY_REQUIRED', 'AI_QWEN_ONLY must be true in production; non-Qwen provider routing is disabled.'));
  }

  if (env.WEEK_SCHEMA_MODE && env.WEEK_SCHEMA_MODE !== 'dual') {
    fatalIssues.push(
      fatal('CONFIG_WEEK_SCHEMA_MODE', 'WEEK_SCHEMA_MODE must be dual in production; legacy mode disables the shadow write.')
    );
  }

  if (env.SCAN_QUEUE_MODE && env.SCAN_QUEUE_MODE !== 'async') {
    fatalIssues.push(
      fatal('CONFIG_SCAN_QUEUE_MODE', 'SCAN_QUEUE_MODE must be async in production; sync mode bypasses the durable queue.')
    );
  }

  if (!env.DB) {
    fatalIssues.push(fatal('CONFIG_BINDING_DB_MISSING', 'Required D1 binding DB is absent.'));
  }
  if (!env.CACHE) {
    fatalIssues.push(
      fatal(
        'CONFIG_BINDING_CACHE_MISSING',
        'Required KV namespace CACHE is absent; shared rate limiting cannot be enforced.'
      )
    );
  }
  if (!env.JWT_SECRET) {
    fatalIssues.push(
      fatal('CONFIG_JWT_SECRET_MISSING', 'Required auth secret JWT_SECRET is absent; every authenticated request fails closed.')
    );
  }
  if (!env.OTP_HASH_SECRET?.trim()) {
    fatalIssues.push(
      fatal('CONFIG_OTP_HASH_SECRET_MISSING', 'Required OTP secret OTP_HASH_SECRET is absent; OTP issuance and verification fail closed.')
    );
  }

  // Qwen is the production OCR/text primary. A native Workers AI binding is
  // optional unless its explicit fallback flag asks the router to use it.
  if (env.AI_MOCK_MODE !== 'true' && !env.QWEN_API_KEY?.trim()) {
    fatalIssues.push(
      fatal(
        'CONFIG_QWEN_API_KEY_MISSING',
        'QWEN_API_KEY is required in production while AI_MOCK_MODE is false.'
      )
    );
  }
  if (env.AI_MOCK_MODE !== 'true' && env.QWEN_BASE_URL !== undefined &&
      !isValidQwenBaseUrl(env.QWEN_BASE_URL.trim())) {
    fatalIssues.push(
      fatal(
        'CONFIG_QWEN_BASE_URL_INVALID',
        'QWEN_BASE_URL must be a public HTTPS URL without credentials when provided.'
      )
    );
  }
  if (env.AI_MOCK_MODE !== 'true' && env.QWEN_MODEL !== undefined &&
      (!isValidQwenModel(env.QWEN_MODEL.trim()) || !isQwenModelIdentifier(env.QWEN_MODEL.trim()))) {
    fatalIssues.push(
      fatal(
        'CONFIG_QWEN_MODEL_INVALID',
        'QWEN_MODEL must be a non-empty model identifier when provided.'
      )
    );
  }
  const modelKeys = [
    'AI_MODEL_FAST', 'AI_MODEL_FAST_CANARY', 'AI_MODEL_MULTIMODAL',
    'AI_MODEL_OCR', 'AI_MODEL_REASONING', 'AI_MODEL_JUDGE',
  ] as const;
  for (const key of modelKeys) {
    const value = env[key]?.trim();
    if (env.AI_MOCK_MODE !== 'true' && value !== undefined &&
        (!isValidQwenModel(value) || !isQwenModelIdentifier(value))) {
      fatalIssues.push(fatal('CONFIG_AI_MODEL_INVALID', `${key} must be a valid Qwen model identifier in production.`));
    }
  }
  if (env.AI_MOCK_MODE !== 'true' && env.CLOUDFLARE_VISION_FALLBACK === 'true' && !env.AI) {
    fatalIssues.push(
      fatal(
        'CONFIG_AI_BINDING_MISSING',
        'AI binding is absent while CLOUDFLARE_VISION_FALLBACK is true.'
      )
    );
  }
  // The queue is the production scan path; without the binding async mode is a lie.
  if (env.SCAN_QUEUE_MODE !== 'sync' && !env.SCAN_QUEUE) {
    fatalIssues.push(
      fatal('CONFIG_QUEUE_BINDING_MISSING', 'SCAN_QUEUE binding is absent while SCAN_QUEUE_MODE is async.')
    );
  }
  if (env.SCAN_QUEUE_MODE === 'async' && !env.IMAGES) {
    fatalIssues.push(
      fatal(
        'CONFIG_SCAN_IMAGE_STORAGE_MISSING',
        'IMAGES R2 binding is required when SCAN_QUEUE_MODE is async so queued scans can be replayed.'
      )
    );
  }

  if (!env.TURNSTILE_SECRET_KEY?.trim()) {
    fatalIssues.push(
      fatal(
        'CONFIG_TURNSTILE_MISSING_SECRET',
        'Production authentication requires TURNSTILE_SECRET_KEY.'
      )
    );
  }
  if (!env.TURNSTILE_SITE_KEY?.trim()) {
    fatalIssues.push(
      fatal(
        'CONFIG_TURNSTILE_MISSING_SITE_KEY',
        'Production authentication requires TURNSTILE_SITE_KEY.'
      )
    );
  }

  // Account creation depends on OTP email delivery; the service degrades to
  // provider 'none' without both paths, so this must be surfaced.
  if (!env.SEND_EMAIL && !env.RESEND_API_KEY) {
    warnings.push(
      warning(
        'CONFIG_EMAIL_DELIVERY_UNAVAILABLE',
        'No email provider configured (SEND_EMAIL binding or RESEND_API_KEY); transactional OTP mail cannot be sent.'
      )
    );
  }

  if (!env.PLUS_GRANT_SECRET) {
    warnings.push(
      warning(
        'CONFIG_PLUS_GRANT_SECRET_MISSING',
        'PLUS_GRANT_SECRET is absent; the manual Frigo Plus grant flow is disabled.'
      )
    );
  }

  return {
    environment,
    ok: fatalIssues.length === 0,
    fatal: fatalIssues,
    warnings,
  };
}
