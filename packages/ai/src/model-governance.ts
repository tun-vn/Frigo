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

export interface ModelAlias {
  role: AIModelRole;
  physicalModel: string;
  pinned: boolean;
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
  shadowCanaryPercent: number;
}

const DEFAULT_MODELS: Record<AIModelRole, ModelAlias> = {
  QWEN_FAST: { role: 'QWEN_FAST', physicalModel: 'qwen3.7-flash-2026-07-15', pinned: true },
  QWEN_FAST_CANARY: { role: 'QWEN_FAST_CANARY', physicalModel: 'qwen3.7-flash', pinned: false },
  QWEN_MULTIMODAL: { role: 'QWEN_MULTIMODAL', physicalModel: 'qwen3.8-flash', pinned: true },
  QWEN_OCR: { role: 'QWEN_OCR', physicalModel: 'qwen-vl-ocr', pinned: true },
  QWEN_REASONING: { role: 'QWEN_REASONING', physicalModel: 'qwen3.8-27b', pinned: true },
  QWEN_JUDGE: { role: 'QWEN_JUDGE', physicalModel: 'qwen3.8-max-0902', pinned: true },
};

// These are estimates, not provider billing truth. Deployments can replace
// them through AI_PRICE_* variables without changing domain/application code.
const DEFAULT_PRICING: Record<string, ModelPricing> = {
  'qwen3.7-flash-2026-07-15': { inputUsdPerMillion: 0.20, outputUsdPerMillion: 0.60, cachedInputUsdPerMillion: 0.04, pricingVersion: 'estimate-2026-09' },
  'qwen3.7-flash': { inputUsdPerMillion: 0.20, outputUsdPerMillion: 0.60, cachedInputUsdPerMillion: 0.04, pricingVersion: 'estimate-2026-09' },
  'qwen3.8-flash': { inputUsdPerMillion: 0.30, outputUsdPerMillion: 0.90, cachedInputUsdPerMillion: 0.06, pricingVersion: 'estimate-2026-09' },
  'qwen-vl-ocr': { inputUsdPerMillion: 0.30, outputUsdPerMillion: 0.90, cachedInputUsdPerMillion: 0.06, pricingVersion: 'estimate-2026-09' },
  'qwen3.8-27b': { inputUsdPerMillion: 1.00, outputUsdPerMillion: 4.00, cachedInputUsdPerMillion: 0.20, pricingVersion: 'estimate-2026-09' },
  'qwen3.8-max-0902': { inputUsdPerMillion: 2.00, outputUsdPerMillion: 8.00, cachedInputUsdPerMillion: 0.40, pricingVersion: 'estimate-2026-09' },
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
  overrides: Partial<Pick<AIGovernanceConfig, 'qwenOnly' | 'models' | 'pricing' | 'taskPolicies'>> = {},
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
    AI_MODEL_ROLES.map((role) => [role, { ...DEFAULT_MODELS[role], physicalModel: modelNames[role] }]),
  ) as Record<AIModelRole, ModelAlias>;
  const models = Object.fromEntries(AI_MODEL_ROLES.map((role) => {
    const configured = configuredModels[role] || DEFAULT_MODELS[role];
    const physicalModel = qwenOnly && !isQwenModelIdentifier(configured.physicalModel)
      ? DEFAULT_MODELS[role].physicalModel
      : configured.physicalModel;
    return [role, { ...configured, physicalModel }];
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
        { ...DEFAULT_MODELS[role], physicalModel: role === 'QWEN_FAST_CANARY' ? DEFAULT_MODELS[role].physicalModel : legacyModel },
      ])) as Record<AIModelRole, ModelAlias>
    : undefined;
  return createGovernanceConfig({}, { qwenOnly, models });
}
