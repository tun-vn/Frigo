import type { AIConfig } from './types';
import { AIBudgetExceededError } from './errors';

export const AI_TASKS = [
  'ingredient_normalization',
  'recipe_generation',
  'recipe_ranking',
  'recipe_explanation',
  'fridge_chat',
  'receipt_ocr',
  'label_ocr',
  'fridge_image_analysis',
  'weekly_plan',
  'weekly_plan_repair',
  'weekly_plan_complex',
  'inventory_candidate_extraction',
  'offline_evaluation',
] as const;

export type AITask = (typeof AI_TASKS)[number];

export const AI_MODEL_ROLES = [
  'QWEN_FAST',
  'QWEN_FAST_CANARY',
  'QWEN_MULTIMODAL',
  'QWEN_OCR',
  'QWEN_REASONING',
  'QWEN_JUDGE',
] as const;

export type AIModelRole = (typeof AI_MODEL_ROLES)[number];

export interface ModelCapabilities {
  supportsJsonResponseFormat: boolean;
  supportsThinkingControl: boolean;
  supportsVision: boolean;
}

export interface ModelAlias {
  role: AIModelRole;
  physicalModel: string;
  pinned: boolean;
  /** Optional for backward-compatible custom governance overrides. */
  capabilities?: ModelCapabilities;
}

export interface ModelPricing {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  cachedInputUsdPerMillion: number;
  pricingVersion: string;
}

export interface AITaskPolicy {
  task: AITask;
  role: AIModelRole;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxAttempts: number;
  escalationRole?: AIModelRole;
  allowEscalation: boolean;
  structured: boolean;
  promptId: string;
  promptVersion: string;
}

export interface AIGovernanceConfig {
  models: Record<AIModelRole, ModelAlias>;
  pricing: Record<string, ModelPricing>;
  taskPolicies: Record<AITask, AITaskPolicy>;
  aiEnabled: boolean;
  qwenOnly: boolean;
  allowReasoningModel: boolean;
  allowJudgeModel: boolean;
  maxCallsPerOperation: number;
  maxTotalTokensPerOperation: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxImageBytes: number;
  maxOcrImageBytes: number;
  shadowCanaryPercent: number;
}

const TEXT_CAPABILITIES: ModelCapabilities = {
  supportsJsonResponseFormat: true,
  supportsThinkingControl: true,
  supportsVision: false,
};

const MULTIMODAL_CAPABILITIES: ModelCapabilities = {
  supportsJsonResponseFormat: true,
  supportsThinkingControl: true,
  supportsVision: true,
};

const OCR_CAPABILITIES: ModelCapabilities = {
  // Qwen-VL-OCR accepts JSON instructions in the prompt but does not support
  // the chat-completions response_format option.
  supportsJsonResponseFormat: false,
  supportsThinkingControl: false,
  supportsVision: true,
};

export const MODEL_CAPABILITIES: Record<AIModelRole, ModelCapabilities> = {
  QWEN_FAST: TEXT_CAPABILITIES,
  QWEN_FAST_CANARY: TEXT_CAPABILITIES,
  QWEN_MULTIMODAL: MULTIMODAL_CAPABILITIES,
  QWEN_OCR: OCR_CAPABILITIES,
  QWEN_REASONING: TEXT_CAPABILITIES,
  QWEN_JUDGE: TEXT_CAPABILITIES,
};

const DEFAULT_MODELS: Record<AIModelRole, ModelAlias> = {
  QWEN_FAST: { role: 'QWEN_FAST', physicalModel: 'qwen3.7-flash-2026-07-15', pinned: true, capabilities: MODEL_CAPABILITIES.QWEN_FAST },
  QWEN_FAST_CANARY: { role: 'QWEN_FAST_CANARY', physicalModel: 'qwen3.7-flash', pinned: false, capabilities: MODEL_CAPABILITIES.QWEN_FAST_CANARY },
  QWEN_MULTIMODAL: { role: 'QWEN_MULTIMODAL', physicalModel: 'qwen3.8-flash', pinned: true, capabilities: MODEL_CAPABILITIES.QWEN_MULTIMODAL },
  // Alibaba documents this as a rolling OCR alias; keep it explicit rather
  // than claiming a snapshot we cannot verify for the Singapore endpoint.
  QWEN_OCR: { role: 'QWEN_OCR', physicalModel: 'qwen-vl-ocr', pinned: false, capabilities: MODEL_CAPABILITIES.QWEN_OCR },
  QWEN_REASONING: { role: 'QWEN_REASONING', physicalModel: 'qwen3.8-27b', pinned: true, capabilities: MODEL_CAPABILITIES.QWEN_REASONING },
  QWEN_JUDGE: { role: 'QWEN_JUDGE', physicalModel: 'qwen3.8-max-0902', pinned: true, capabilities: MODEL_CAPABILITIES.QWEN_JUDGE },
};

const GENERIC_QWEN_CAPABILITIES: ModelCapabilities = {
  supportsJsonResponseFormat: true,
  supportsThinkingControl: true,
  supportsVision: true,
};

const PHYSICAL_MODEL_CAPABILITIES: Record<string, ModelCapabilities> = {
  'qwen-vl-ocr': OCR_CAPABILITIES,
};

export function capabilitiesForPhysicalModel(model: string): ModelCapabilities {
  const normalized = model.trim().toLowerCase();
  if (normalized === 'qwen-vl-ocr' || normalized.startsWith('qwen-vl-ocr-')) return OCR_CAPABILITIES;
  return PHYSICAL_MODEL_CAPABILITIES[normalized] || GENERIC_QWEN_CAPABILITIES;
}

// These are estimates, not provider billing truth. Deployments can replace
// them through AI_PRICE_* variables without changing domain/application code.
const DEFAULT_PRICING: Record<string, ModelPricing> = {
  // Singapore low-context planning estimates. Frigo caps normal input at 12K.
  'qwen3.7-flash-2026-07-15': { inputUsdPerMillion: 0.03, outputUsdPerMillion: 0.13, cachedInputUsdPerMillion: 0.006, pricingVersion: 'estimate-2026-09-sg-low-context' },
  'qwen3.7-flash': { inputUsdPerMillion: 0.03, outputUsdPerMillion: 0.13, cachedInputUsdPerMillion: 0.006, pricingVersion: 'estimate-2026-09-sg-low-context' },
  'qwen3.8-flash': { inputUsdPerMillion: 0.15, outputUsdPerMillion: 0.47, cachedInputUsdPerMillion: 0.03, pricingVersion: 'estimate-2026-09-sg-low-context' },
  'qwen-vl-ocr': { inputUsdPerMillion: 0.07, outputUsdPerMillion: 0.16, cachedInputUsdPerMillion: 0.014, pricingVersion: 'estimate-2026-09-sg-low-context' },
  'qwen3.8-27b': { inputUsdPerMillion: 0.50, outputUsdPerMillion: 3.00, cachedInputUsdPerMillion: 0.10, pricingVersion: 'estimate-2026-09-sg-low-context' },
  // Judge pricing is retained as a rounded planning estimate only; this role
  // remains disabled for normal live routing.
  'qwen3.8-max-0902': { inputUsdPerMillion: 2.00, outputUsdPerMillion: 8.00, cachedInputUsdPerMillion: 0.40, pricingVersion: 'estimate-2026-09-judge-planning' },
};

const DEFAULT_TASK_POLICIES: Record<AITask, AITaskPolicy> = {
  ingredient_normalization: policy('ingredient_normalization', 'QWEN_FAST', 2_048, 128, 'ingredient-normalization', '1'),
  recipe_generation: policy('recipe_generation', 'QWEN_FAST', 4_096, 1_024, 'recipe-generation', '1', 'QWEN_MULTIMODAL'),
  recipe_ranking: policy('recipe_ranking', 'QWEN_FAST', 4_096, 512, 'recipe-ranking', '1'),
  recipe_explanation: policy('recipe_explanation', 'QWEN_FAST', 2_048, 256, 'recipe-explanation', '1'),
  fridge_chat: policy('fridge_chat', 'QWEN_FAST', 4_096, 768, 'fridge-chat', '1'),
  receipt_ocr: policy('receipt_ocr', 'QWEN_OCR', 12_000, 2_048, 'receipt-ocr', '1', 'QWEN_MULTIMODAL'),
  label_ocr: policy('label_ocr', 'QWEN_OCR', 8_000, 1_024, 'label-ocr', '1', 'QWEN_MULTIMODAL'),
  fridge_image_analysis: policy('fridge_image_analysis', 'QWEN_MULTIMODAL', 12_000, 1_024, 'fridge-image-analysis', '1', 'QWEN_REASONING'),
  weekly_plan: policy('weekly_plan', 'QWEN_FAST', 8_000, 2_048, 'weekly-plan', '1', 'QWEN_MULTIMODAL'),
  weekly_plan_repair: policy('weekly_plan_repair', 'QWEN_FAST', 8_000, 1_536, 'weekly-plan-repair', '1', 'QWEN_MULTIMODAL'),
  weekly_plan_complex: policy('weekly_plan_complex', 'QWEN_MULTIMODAL', 12_000, 2_048, 'weekly-plan-complex', '1', 'QWEN_REASONING'),
  inventory_candidate_extraction: policy('inventory_candidate_extraction', 'QWEN_FAST', 4_096, 1_024, 'inventory-candidate-extraction', '1'),
  offline_evaluation: {
    ...policy('offline_evaluation', 'QWEN_JUDGE', 16_000, 2_048, 'offline-evaluation', '1'),
    maxAttempts: 1,
  },
};

function policy(
  task: AITask,
  role: AIModelRole,
  maxInputTokens: number,
  maxOutputTokens: number,
  promptId: string,
  promptVersion: string,
  escalationRole?: AIModelRole,
): AITaskPolicy {
  return {
    task,
    role,
    maxInputTokens,
    maxOutputTokens,
    maxAttempts: escalationRole ? 3 : 2,
    escalationRole,
    allowEscalation: Boolean(escalationRole),
    structured: task !== 'fridge_chat',
    promptId,
    promptVersion,
  };
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value.trim().toLowerCase() === 'true';
}

function parseBoundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function parseBoundedPercent(value: string | undefined): number {
  return parseBoundedInteger(value, 0, 0, 100);
}

export function isQwenModelIdentifier(value: string): boolean {
  return /^qwen[\w.:-]*$/i.test(value);
}

function envModel(env: Record<string, string | undefined>, key: string, fallback: string, qwenOnly: boolean): string {
  const value = env[key]?.trim();
  return value && value.length <= 128 && (!qwenOnly || isQwenModelIdentifier(value)) ? value : fallback;
}

function envPrice(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const value = Number(env[key]);
  return Number.isFinite(value) && value >= 0 && value <= 10_000 ? value : fallback;
}

export function createGovernanceConfig(
  env: Record<string, string | undefined> = {},
  overrides: Partial<Pick<AIGovernanceConfig, 'qwenOnly' | 'models' | 'pricing' | 'taskPolicies' | 'maxImageBytes' | 'maxOcrImageBytes'>> = {},
): AIGovernanceConfig {
  const qwenOnly = overrides.qwenOnly ?? parseBoolean(env.AI_QWEN_ONLY, true);
  const modelNames: Record<AIModelRole, string> = {
    QWEN_FAST: envModel(env, 'AI_MODEL_FAST', DEFAULT_MODELS.QWEN_FAST.physicalModel, qwenOnly),
    QWEN_FAST_CANARY: envModel(env, 'AI_MODEL_FAST_CANARY', DEFAULT_MODELS.QWEN_FAST_CANARY.physicalModel, qwenOnly),
    QWEN_MULTIMODAL: envModel(env, 'AI_MODEL_MULTIMODAL', DEFAULT_MODELS.QWEN_MULTIMODAL.physicalModel, qwenOnly),
    QWEN_OCR: envModel(env, 'AI_MODEL_OCR', DEFAULT_MODELS.QWEN_OCR.physicalModel, qwenOnly),
    QWEN_REASONING: envModel(env, 'AI_MODEL_REASONING', DEFAULT_MODELS.QWEN_REASONING.physicalModel, qwenOnly),
    QWEN_JUDGE: envModel(env, 'AI_MODEL_JUDGE', DEFAULT_MODELS.QWEN_JUDGE.physicalModel, qwenOnly),
  };
  const configuredModels = overrides.models || Object.fromEntries(
    AI_MODEL_ROLES.map((role) => [role, {
      ...DEFAULT_MODELS[role],
      physicalModel: modelNames[role],
      capabilities: capabilitiesForPhysicalModel(modelNames[role]),
    }]),
  ) as Record<AIModelRole, ModelAlias>;
  const models = Object.fromEntries(AI_MODEL_ROLES.map((role) => {
    const configured = configuredModels[role] || DEFAULT_MODELS[role];
    const physicalModel = qwenOnly && !isQwenModelIdentifier(configured.physicalModel)
      ? DEFAULT_MODELS[role].physicalModel
      : configured.physicalModel;
    return [role, {
      ...configured,
      physicalModel,
      capabilities: configured.capabilities || capabilitiesForPhysicalModel(physicalModel),
    }];
  })) as Record<AIModelRole, ModelAlias>;
  const pricing = overrides.pricing || Object.fromEntries(
    AI_MODEL_ROLES.map((role) => {
      const model = models[role].physicalModel;
      const defaults = DEFAULT_PRICING[model] || DEFAULT_PRICING[DEFAULT_MODELS[role].physicalModel];
      const suffix = role.toLowerCase();
      return [model, {
        inputUsdPerMillion: envPrice(env, `AI_PRICE_${suffix}_INPUT_PER_1M`, defaults.inputUsdPerMillion),
        outputUsdPerMillion: envPrice(env, `AI_PRICE_${suffix}_OUTPUT_PER_1M`, defaults.outputUsdPerMillion),
        cachedInputUsdPerMillion: envPrice(env, `AI_PRICE_${suffix}_CACHED_INPUT_PER_1M`, defaults.cachedInputUsdPerMillion),
        pricingVersion: env[`AI_PRICE_${suffix}_VERSION`]?.trim() || defaults.pricingVersion,
      }];
    }),
  ) as Record<string, ModelPricing>;

  return {
    models,
    pricing,
    taskPolicies: overrides.taskPolicies || DEFAULT_TASK_POLICIES,
    aiEnabled: parseBoolean(env.AI_ENABLED, true),
    qwenOnly,
    allowReasoningModel: parseBoolean(env.AI_ALLOW_REASONING_MODEL, false),
    allowJudgeModel: parseBoolean(env.AI_ALLOW_JUDGE_MODEL, false),
    maxCallsPerOperation: parseBoundedInteger(env.AI_MAX_CALLS_PER_OPERATION, 3, 1, 8),
    maxTotalTokensPerOperation: parseBoundedInteger(env.AI_MAX_TOTAL_TOKENS, 16_000, 1_024, 32_000),
    maxInputTokens: parseBoundedInteger(env.AI_MAX_INPUT_TOKENS, 12_000, 1_024, 32_000),
    maxOutputTokens: parseBoundedInteger(env.AI_MAX_OUTPUT_TOKENS, 2_048, 128, 8_192),
    maxImageBytes: overrides.maxImageBytes ?? parseBoundedInteger(env.AI_MAX_IMAGE_BYTES, 5 * 1024 * 1024, 64 * 1024, 20 * 1024 * 1024),
    maxOcrImageBytes: overrides.maxOcrImageBytes ?? parseBoundedInteger(env.AI_MAX_OCR_IMAGE_BYTES, 5 * 1024 * 1024, 64 * 1024, 20 * 1024 * 1024),
    shadowCanaryPercent: parseBoundedPercent(env.AI_SHADOW_CANARY_PERCENT),
  };
}

export function defaultGovernanceConfig(): AIGovernanceConfig {
  return createGovernanceConfig();
}

export function getTaskPolicy(config: AIGovernanceConfig, task: AITask): AITaskPolicy {
  return config.taskPolicies[task];
}

export function getModelAlias(config: AIGovernanceConfig, role: AIModelRole): ModelAlias {
  return config.models[role];
}

export function estimateInputTokens(value: unknown): number {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value) || '';
  return Math.ceil(serialized.length / 4);
}

export function serializeForPrompt(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value) || 'null';
}

export function assertInputBudget(
  config: AIGovernanceConfig,
  task: AITask,
  value: unknown,
): { serialized: string; inputTokens: number } {
  const serialized = serializeForPrompt(value);
  const inputTokens = estimateInputTokens(serialized);
  const policy = getTaskPolicy(config, task);
  const ceiling = Math.min(config.maxInputTokens, policy.maxInputTokens);
  if (inputTokens > ceiling) {
    throw new AIBudgetExceededError(`AI_BUDGET_EXCEEDED: ${task} input exceeds ${ceiling} estimated tokens`, task);
  }
  return { serialized, inputTokens };
}

export function calculateEstimatedCost(
  config: AIGovernanceConfig,
  physicalModel: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens = 0,
): number {
  const pricing = config.pricing[physicalModel];
  if (!pricing) return 0;
  const uncachedInput = Math.max(0, inputTokens - cachedInputTokens);
  return (uncachedInput * pricing.inputUsdPerMillion
    + cachedInputTokens * pricing.cachedInputUsdPerMillion
    + Math.max(0, outputTokens) * pricing.outputUsdPerMillion) / 1_000_000;
}

export function isExpensiveRole(role: AIModelRole): boolean {
  return role === 'QWEN_REASONING' || role === 'QWEN_JUDGE';
}

export function canUseRole(config: AIGovernanceConfig, role: AIModelRole): boolean {
  if (role === 'QWEN_REASONING') return config.allowReasoningModel;
  if (role === 'QWEN_JUDGE') return config.allowJudgeModel;
  return true;
}

export function governanceFromAIConfig(config: AIConfig): AIGovernanceConfig {
  if (config.governance) return config.governance;
  const qwenOnly = config.qwenOnly ?? false;
  const legacyModel = config.qwenModel?.trim();
  const models = legacyModel && !qwenOnly
    ? Object.fromEntries(AI_MODEL_ROLES.map((role) => [
        role,
        {
          ...DEFAULT_MODELS[role],
          physicalModel: role === 'QWEN_FAST_CANARY' ? DEFAULT_MODELS[role].physicalModel : legacyModel,
          capabilities: capabilitiesForPhysicalModel(role === 'QWEN_FAST_CANARY' ? DEFAULT_MODELS[role].physicalModel : legacyModel),
        },
      ])) as Record<AIModelRole, ModelAlias>
    : undefined;
  return createGovernanceConfig({}, { qwenOnly, models });
}
