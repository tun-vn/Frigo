import { createGovernanceConfig } from '../../../packages/ai/src/model-governance';
import type { AIConfig } from '../../../packages/ai/src/types';
import type { AIUsageLog } from '../../../packages/ai/src/schemas';
import type { Env } from '../types';

/** Build one server-side AI policy from Worker vars. Secrets stay in Env. */
export function aiConfigFromEnv(env: Env): AIConfig {
  const governance = createGovernanceConfig(
    env as unknown as Record<string, string | undefined>,
    {
      // Production must opt into the Qwen task runtime. Missing the flag in a
      // local/older environment remains safe because this helper is the only
      // Worker composition point and defaults to Qwen-only here.
      qwenOnly: env.AI_QWEN_ONLY === undefined || env.AI_QWEN_ONLY === 'true',
    },
  );
  return {
    aiMockMode: env.AI_MOCK_MODE === 'true',
    silentFallback: true,
    qwenApiKey: env.QWEN_API_KEY,
    qwenBaseUrl: env.QWEN_BASE_URL,
    qwenModel: env.QWEN_MODEL,
    qwenRequestTimeoutMs: Number(env.QWEN_REQUEST_TIMEOUT_MS) || undefined,
    qwenOnly: governance.qwenOnly,
    governance,
    aiBinding: env.AI,
    groqApiKey: env.GROQ_API_KEY,
    groqBaseUrl: env.GROQ_BASE_URL,
    groqVisionModel: env.GROQ_VISION_MODEL,
    groqFallbackEnabled: env.GROQ_FALLBACK_ENABLED === 'true',
    cloudflareVisionFallback: env.CLOUDFLARE_VISION_FALLBACK === 'true',
    zaiApiKey: env.ZAI_API_KEY,
    zaiBaseUrl: env.ZAI_BASE_URL,
    glmFallbackEnabled: env.GLM_FALLBACK_ENABLED === 'true',
    deepseekApiKey: env.DEEPSEEK_API_KEY,
    deepseekBaseUrl: env.DEEPSEEK_BASE_URL,
    deepseekFallbackEnabled: env.DEEPSEEK_FALLBACK_ENABLED === 'true',
  };
}

/** Emit non-PII usage metadata for Workers observability. */
export function logAIUsage(log: AIUsageLog): void {
  console.log(JSON.stringify({
    level: 'info',
    event: 'ai_usage',
    task: log.task,
    provider: log.provider,
    logicalModel: log.logicalModel,
    physicalModel: log.physicalModel || log.model,
    promptId: log.promptId,
    promptVersion: log.promptVersion,
    inputTokens: log.inputTokens,
    outputTokens: log.outputTokens,
    cachedInputTokens: log.cachedInputTokens || 0,
    estimatedCostUsd: log.estimatedCostUsd ?? log.estimatedCost,
    pricingVersion: log.pricingVersion,
    latencyMs: log.latencyMs,
    attempt: log.attempt || 1,
    escalationReason: log.escalationReason,
    failureCode: log.failureCode,
    status: log.status,
  }));
}
