/**
 * Normalized failure contract shared by AI providers and the scan worker.
 * Provider failures are untrusted external input, so callers should use the
 * retryable flag rather than guessing from an error message.
 */
export interface AIProviderErrorOptions {
  code: string;
  retryable: boolean;
  status?: number;
  provider?: string;
  model?: string;
  cause?: unknown;
}

export class AIProviderError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status?: number;
  readonly provider?: string;
  readonly model?: string;

  constructor(message: string, options: AIProviderErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AIProviderError';
    this.code = options.code;
    this.retryable = options.retryable;
    this.status = options.status;
    this.provider = options.provider;
    this.model = options.model;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** A request-scoped provider error (HTTP, network, timeout, or bad output). */
export class AIRequestError extends AIProviderError {
  constructor(message: string, options: AIProviderErrorOptions) {
    super(message, options);
    this.name = 'AIRequestError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isAIProviderError(value: unknown): value is AIProviderError {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<AIProviderError>;
  return typeof candidate.code === 'string' && typeof candidate.retryable === 'boolean';
}

export function isRetryableAIStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function classifyAIHttpCode(status: number, detail = ''): string {
  const normalized = detail.toLowerCase();
  if (status === 404 && /(model[_ -]?not[_ -]?found|model[\s\S]{0,120}(?:not found|does not exist)|no access)/i.test(normalized)) {
    return 'MODEL_NOT_FOUND';
  }
  if (status === 401) return 'AUTHENTICATION_FAILED';
  if (status === 403) return 'PERMISSION_DENIED';
  if (status === 404) return 'RESOURCE_NOT_FOUND';
  if (status === 408) return 'REQUEST_TIMEOUT';
  if (status === 425) return 'UPSTREAM_BUSY';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'UPSTREAM_ERROR';
  return 'PROVIDER_REQUEST_REJECTED';
}

export function createAIHttpError(
  provider: string,
  status: number,
  detail = '',
  model?: string,
): AIRequestError {
  const cleanDetail = detail.replace(/\s+/g, ' ').trim().slice(0, 400);
  return new AIRequestError(
    `${provider} API error: ${status}${cleanDetail ? ` ${cleanDetail}` : ''}`,
    {
      code: classifyAIHttpCode(status, cleanDetail),
      retryable: isRetryableAIStatus(status),
      status,
      provider,
      model,
    },
  );
}

export function createAITimeoutError(provider: string, timeoutMs: number, model?: string, cause?: unknown): AIRequestError {
  return new AIRequestError(`${provider} request timed out after ${timeoutMs}ms`, {
    code: 'REQUEST_TIMEOUT',
    retryable: true,
    provider,
    model,
    cause,
  });
}

export function createAINetworkError(provider: string, cause: unknown, model?: string): AIRequestError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new AIRequestError(`${provider} network request failed: ${detail.slice(0, 240)}`, {
    code: 'NETWORK_ERROR',
    retryable: true,
    provider,
    model,
    cause,
  });
}

export function createAIResponseError(
  provider: string,
  message: string,
  model?: string,
  cause?: unknown,
): AIRequestError {
  return new AIRequestError(message, {
    code: 'INVALID_RESPONSE',
    retryable: false,
    provider,
    model,
    cause,
  });
}

export function createAISchemaError(
  provider: string,
  message: string,
  model?: string,
  cause?: unknown,
): AIProviderError {
  return new AIProviderError(message, {
    code: 'SCHEMA_VALIDATION',
    retryable: false,
    provider,
    model,
    cause,
  });
}
