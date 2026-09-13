import { z } from 'zod';
import type { AIConfig, VisionScanParams } from './types';
import type { AIUsageLog, ReceiptScanResult, VisionScanResult } from './schemas';
import {
  AIBudgetExceededError,
  AIEscalationExhaustedError,
  AIImageTooLargeError,
  AIProviderError,
  createAIResponseError,
  createAISchemaError,
  isAIProviderError,
} from './errors';
import {
  assertInputBudget,
  calculateEstimatedCost,
  canUseRole,
  getModelAlias,
  getTaskPolicy,
  governanceFromAIConfig,
  capabilitiesForPhysicalModel,
  serializeForPrompt,
  type AIGovernanceConfig,
  type AIModelRole,
  type AITask,
} from './model-governance';
import { buildPrompt } from './prompts';
import { QwenProvider, type QwenCallOptions } from './providers/qwen';
import { applyReceiptScanQualityGate, applyVisionScanQualityGate } from './quality-gate';

export interface AIRuntimeRequest<T = unknown> {
  task: AITask;
  input: unknown;
  context?: unknown;
  schema?: z.ZodType<T>;
  repairInput?: unknown;
}

export interface AIRuntimeResult<T = unknown> {
  value: T;
  usage: AIUsageLog[];
  attempts: number;
  logicalModel: AIModelRole;
  physicalModel: string;
}

type QwenOperationResult = VisionScanResult | ReceiptScanResult | { canonicalId: string | null; confidence: number } | string;

function outputTokens(value: unknown, fallback: number): number {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value) || '';
  return Math.max(0, Math.ceil(serialized.length / 4) || fallback);
}

function providerCode(error: unknown): string | undefined {
  if (isAIProviderError(error)) return error.code;
  if (error instanceof z.ZodError) return 'SCHEMA_VALIDATION';
  return error instanceof Error ? undefined : 'AI_RUNTIME_ERROR';
}

function parseStructuredValue(value: unknown): unknown {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text) return value;
  try {
    return JSON.parse(text);
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced?.[1]) {
      try { return JSON.parse(fenced[1]); } catch { /* continue */ }
    }
    const objectStart = text.indexOf('{');
    const objectEnd = text.lastIndexOf('}');
    if (objectStart >= 0 && objectEnd > objectStart) {
      try { return JSON.parse(text.slice(objectStart, objectEnd + 1)); } catch { /* continue */ }
    }
    const arrayStart = text.indexOf('[');
    const arrayEnd = text.lastIndexOf(']');
    if (arrayStart >= 0 && arrayEnd > arrayStart) {
      try { return JSON.parse(text.slice(arrayStart, arrayEnd + 1)); } catch { /* continue */ }
    }
  }
  return value;
}

function isVisionTask(task: AITask): boolean {
  return task === 'receipt_ocr' || task === 'label_ocr' || task === 'fridge_image_analysis';
}

function estimateDecodedImageBytes(value: string): number | undefined {
  const input = value.trim();
  if (!input || /^https?:\/\//i.test(input)) return undefined;
  const match = input.match(/^data:[^;,]+;base64,([\s\S]*)$/i);
  const encoded = (match?.[1] ?? input).replace(/\s+/g, '');
  if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return undefined;
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  // Base64 carries four characters for every three decoded bytes. The
  // decoded length is exact for valid padded input and conservative for
  // unpadded input, without allocating a second copy of the image.
  return Math.floor((encoded.length * 3) / 4) - padding;
}

function visionInputForBudget(input: VisionScanParams, repairInput?: unknown): unknown {
  // Image bytes are provider-tokenized independently of prompt characters.
  // Count a bounded marker here so a large base64 string cannot bypass or
  // exhaust the text context ceiling before reaching the provider.
  return {
    mimeType: input.mimeType || 'image/jpeg',
    imagePayloadUnits: Math.ceil(input.imageBase64OrUrl.length / 100_000),
    promptOverride: input.promptOverride,
    ...(repairInput === undefined ? {} : { repairInput }),
  };
}

function asVisionInput(input: unknown): VisionScanParams {
  if (!input || typeof input !== 'object') throw new Error('AI_RUNTIME_INVALID_INPUT: vision input is required');
  const value = input as Partial<VisionScanParams>;
  if (typeof value.imageBase64OrUrl !== 'string' || !value.imageBase64OrUrl.trim()) {
    throw new Error('AI_RUNTIME_INVALID_INPUT: image payload is required');
  }
  return {
    imageBase64OrUrl: value.imageBase64OrUrl,
    ...(typeof value.mimeType === 'string' ? { mimeType: value.mimeType } : {}),
    ...(typeof value.promptOverride === 'string' ? { promptOverride: value.promptOverride } : {}),
  };
}

function textInput(input: unknown, context: unknown, task: AITask, repairInput?: unknown): string {
  const primary = serializeForPrompt(input);
  const contextBlock = context === undefined ? '' : `\nCONTEXT\n${serializeForPrompt(context)}`;
  const repairBlock = repairInput === undefined ? '' : `\nVALIDATION FAILURES\n${serializeForPrompt(repairInput)}`;
  return buildPrompt(task, primary, `${contextBlock}${repairBlock}`.trim());
}

/**
 * Qwen-only task runtime. It owns model-role selection, bounded attempts,
 * structured parsing, budget checks and usage telemetry; feature services only
 * need to provide a logical task and input.
 */
export class QwenTaskRuntime {
  private readonly governance: AIGovernanceConfig;
  private readonly providers = new Map<AIModelRole, QwenProvider>();
  private readonly onUsageLogged?: (log: AIUsageLog) => void;
  private readonly backgroundExecutor?: (promise: Promise<unknown>) => void;

  constructor(config: AIConfig, onUsageLogged?: (log: AIUsageLog) => void) {
    this.governance = governanceFromAIConfig(config);
    this.onUsageLogged = onUsageLogged;
    this.backgroundExecutor = config.backgroundExecutor;
    if (config.qwenApiKey?.trim()) {
      for (const role of Object.keys(this.governance.models) as AIModelRole[]) {
        const alias = getModelAlias(this.governance, role);
        this.providers.set(role, new QwenProvider(
          config.qwenApiKey,
          config.qwenBaseUrl,
          alias.physicalModel,
          config.qwenRequestTimeoutMs,
          alias.capabilities || capabilitiesForPhysicalModel(alias.physicalModel),
        ));
      }
    }
  }

  get governanceConfig(): AIGovernanceConfig {
    return this.governance;
  }

  async generate<T = unknown>(request: AIRuntimeRequest<T>): Promise<AIRuntimeResult<T>> {
    if (!this.governance.aiEnabled) throw new Error('AI_DISABLED: AI runtime is disabled by policy');
    const policy = getTaskPolicy(this.governance, request.task);
    const maxOutputTokens = Math.min(policy.maxOutputTokens, this.governance.maxOutputTokens);
    const roles = this.rolesFor(policy.role, policy.escalationRole, policy.allowEscalation);
    const visionInput = isVisionTask(request.task) ? asVisionInput(request.input) : undefined;
    if (visionInput) this.assertImageSize(request.task, visionInput);
    const usage: AIUsageLog[] = [];
    let totalTokens = 0;
    let reservedCalls = 0;
    let lastError: unknown;
    let repairInput = request.repairInput;

    for (let index = 0; index < Math.min(policy.maxAttempts, this.governance.maxCallsPerOperation, roles.length); index += 1) {
      const role = roles[index];
      if (!canUseRole(this.governance, role)) {
        lastError = new AIEscalationExhaustedError(`AI_ESCALATION_DISABLED: ${role} is disabled by policy`, request.task);
        break;
      }
      const provider = this.providers.get(role);
      if (!provider) {
        lastError = new AIProviderError('AI_UNAVAILABLE: Qwen API key is not configured', {
          code: 'AI_UNAVAILABLE',
          retryable: false,
          provider: 'qwen',
        });
        break;
      }
      const attemptInput = isVisionTask(request.task)
        ? visionInputForBudget(visionInput!, repairInput)
        : textInput(request.input, index > 0 ? undefined : request.context, request.task, repairInput);
      const inputBudget = assertInputBudget(this.governance, request.task, attemptInput);
      if (totalTokens + inputBudget.inputTokens + maxOutputTokens > this.governance.maxTotalTokensPerOperation) {
        throw new AIBudgetExceededError(`AI_BUDGET_EXCEEDED: ${request.task} operation token ceiling reached`, request.task);
      }
      const alias = getModelAlias(this.governance, role);
      const startedAt = Date.now();
      reservedCalls += 1;
      const callOptions: QwenCallOptions = {
        maxTokens: maxOutputTokens,
        temperature: policy.structured ? 0.1 : 0.2,
        jsonMode: policy.structured,
      };
      try {
        const value = await this.callProvider(provider, { ...request, repairInput }, index, callOptions);
        const gated = request.task === 'receipt_ocr' || request.task === 'label_ocr'
          ? applyReceiptScanQualityGate(value)
          : request.task === 'fridge_image_analysis' ? applyVisionScanQualityGate(value) : value;
        let parsed: unknown = policy.structured ? parseStructuredValue(gated) : gated;
        if (policy.structured && (parsed === null || typeof parsed !== 'object')) {
          throw createAIResponseError('Qwen', 'Qwen returned a non-structured response', alias.physicalModel);
        }
        if (request.schema) {
          try {
            parsed = request.schema.parse(parsed);
          } catch (error) {
            if (error instanceof z.ZodError) {
              throw createAISchemaError('Qwen', 'Qwen response failed runtime schema validation', alias.physicalModel, error);
            }
            throw error;
          }
        }
        const providerUsage = provider.getLastUsage();
        const measuredInput = providerUsage?.inputTokens ?? inputBudget.inputTokens;
        const measuredOutput = providerUsage?.outputTokens ?? outputTokens(parsed, maxOutputTokens);
        const cachedInputTokens = providerUsage?.cachedInputTokens ?? 0;
        if (measuredOutput > maxOutputTokens) {
          throw new AIBudgetExceededError(
            `AI_BUDGET_EXCEEDED: ${request.task} output exceeds ${maxOutputTokens} estimated tokens`,
            request.task,
          );
        }
        totalTokens += measuredInput + measuredOutput;
        if (totalTokens > this.governance.maxTotalTokensPerOperation) {
          throw new AIBudgetExceededError(
            `AI_BUDGET_EXCEEDED: ${request.task} operation token ceiling reached`,
            request.task,
          );
        }
        const estimatedCostUsd = calculateEstimatedCost(
          this.governance,
          alias.physicalModel,
          measuredInput,
          measuredOutput,
          cachedInputTokens,
        );
        const escalationReason = index === 0
          ? undefined
          : policy.allowEscalation && role !== policy.role && index === roles.length - 1
            ? 'controlled_escalation'
            : 'bounded_repair';
        const log = this.makeLog(request.task, role, alias.physicalModel, measuredInput,
          measuredOutput, cachedInputTokens, Date.now() - startedAt, estimatedCostUsd, index + 1,
          escalationReason, role === policy.role ? 'success' : 'fallback', provider);
        usage.push(log);
        this.onUsageLogged?.(log);
        const shadowInputTokens = Math.max(inputBudget.inputTokens, measuredInput);
        const shadowReservation = shadowInputTokens + maxOutputTokens;
        if (index === 0 && role === 'QWEN_FAST' && reservedCalls < this.governance.maxCallsPerOperation
            && this.shouldShadow()
            && totalTokens + shadowReservation <= this.governance.maxTotalTokensPerOperation
            && this.backgroundExecutor) {
          // Reserve the optional shadow call before it is detached from this
          // operation so canary traffic cannot bypass the operation ceilings.
          reservedCalls += 1;
          totalTokens += shadowReservation;
          this.backgroundExecutor(this.runShadow(request, shadowInputTokens, maxOutputTokens).catch(() => undefined));
        }
        return { value: parsed as T, usage, attempts: index + 1, logicalModel: role, physicalModel: alias.physicalModel };
      } catch (error) {
        lastError = error;
        const code = providerCode(error);
        const providerUsage = provider.getLastUsage();
        const measuredInput = providerUsage?.inputTokens ?? inputBudget.inputTokens;
        const measuredOutput = providerUsage?.outputTokens ?? 0;
        const estimatedCostUsd = calculateEstimatedCost(this.governance, alias.physicalModel, measuredInput, measuredOutput, providerUsage?.cachedInputTokens ?? 0);
        const escalationReason = index === 0
          ? undefined
          : policy.allowEscalation && role !== policy.role && index === roles.length - 1
            ? 'controlled_escalation'
            : 'bounded_repair';
        const log = this.makeLog(request.task, role, alias.physicalModel, measuredInput,
          measuredOutput, providerUsage?.cachedInputTokens ?? 0, Date.now() - startedAt, estimatedCostUsd,
          index + 1, escalationReason, 'error', provider, code);
        usage.push(log);
        this.onUsageLogged?.(log);
        if (!(isAIProviderError(error) && error.code === 'AI_BUDGET_EXCEEDED')) {
          totalTokens += measuredInput + measuredOutput;
        }
        if (isAIProviderError(error) && (
          error.code === 'SCHEMA_VALIDATION'
          || error.code === 'INVALID_RESPONSE'
          || error.code === 'AI_SCAN_NO_USABLE_ITEMS'
        )) {
          repairInput = { previousError: error.code, detail: error.message.slice(0, 500), ...(repairInput === undefined ? {} : { prior: repairInput }) };
        }
        if (isAIProviderError(error) && !error.retryable) {
          const repairable = error.code === 'SCHEMA_VALIDATION'
            || error.code === 'INVALID_RESPONSE'
            || error.code === 'AI_SCAN_NO_USABLE_ITEMS'
            || error.code === 'MODEL_NOT_FOUND';
          if (!repairable || index >= roles.length - 1) break;
          if (error.code === 'MODEL_NOT_FOUND' && roles[index + 1] === role) {
            // A missing model cannot be repaired by retrying the same model;
            // jump directly to the configured Qwen-only fallback role.
            roles.splice(index + 1, 1);
          }
        }
      }
    }

    if (lastError) throw lastError;
    throw new AIEscalationExhaustedError(`AI_ESCALATION_EXHAUSTED: ${request.task} attempts exhausted`, request.task);
  }

  private rolesFor(initial: AIModelRole, escalation: AIModelRole | undefined, allowEscalation: boolean): AIModelRole[] {
    const roles: AIModelRole[] = [initial];
    // Attempt two is a cheap repair on the same model; attempt three is the
    // only model escalation. Duplicate roles are intentional here.
    if (allowEscalation || escalation === undefined) roles.push(initial);
    if (allowEscalation && escalation) roles.push(escalation);
    return roles;
  }

  private shouldShadow(): boolean {
    return this.governance.shadowCanaryPercent > 0
      && Math.random() * 100 < this.governance.shadowCanaryPercent;
  }

  private assertImageSize(task: AITask, image: VisionScanParams): void {
    const estimatedBytes = estimateDecodedImageBytes(image.imageBase64OrUrl);
    if (estimatedBytes === undefined) return;
    const limit = task === 'receipt_ocr' || task === 'label_ocr'
      ? this.governance.maxOcrImageBytes
      : this.governance.maxImageBytes;
    if (estimatedBytes > limit) {
      throw new AIImageTooLargeError(
        `AI_IMAGE_TOO_LARGE: ${task} image exceeds the ${Math.round(limit / (1024 * 1024))} MiB limit`,
        task,
      );
    }
  }

  private async runShadow(
    request: AIRuntimeRequest,
    inputTokens: number,
    maxOutputTokens: number,
  ): Promise<void> {
    const role: AIModelRole = 'QWEN_FAST_CANARY';
    const provider = this.providers.get(role);
    if (!provider) return;
    const alias = getModelAlias(this.governance, role);
    const startedAt = Date.now();
    try {
      const value = await this.callProvider(provider, { ...request, repairInput: undefined }, 0, {
        maxTokens: maxOutputTokens,
        temperature: getTaskPolicy(this.governance, request.task).structured ? 0.1 : 0.2,
        jsonMode: getTaskPolicy(this.governance, request.task).structured,
      });
      const parsedValue = getTaskPolicy(this.governance, request.task).structured
        ? parseStructuredValue(value)
        : value;
      if (getTaskPolicy(this.governance, request.task).structured
          && (parsedValue === null || typeof parsedValue !== 'object')) {
        throw createAIResponseError('Qwen', 'Qwen shadow response was not structured', alias.physicalModel);
      }
      const parsed = request.schema ? request.schema.parse(parsedValue) : parsedValue;
      const providerUsage = provider.getLastUsage();
      const measuredInput = providerUsage?.inputTokens ?? inputTokens;
      const measuredOutput = providerUsage?.outputTokens ?? outputTokens(parsed, maxOutputTokens);
      if (measuredOutput > maxOutputTokens) {
        const log = this.makeLog(
          request.task,
          role,
          alias.physicalModel,
          measuredInput,
          measuredOutput,
          providerUsage?.cachedInputTokens ?? 0,
          Date.now() - startedAt,
          calculateEstimatedCost(this.governance, alias.physicalModel, measuredInput, measuredOutput, providerUsage?.cachedInputTokens ?? 0),
          1,
          'shadow_canary',
          'error',
          provider,
          'AI_BUDGET_EXCEEDED',
        );
        this.onUsageLogged?.(log);
        return;
      }
      const log = this.makeLog(
        request.task,
        role,
        alias.physicalModel,
        measuredInput,
        measuredOutput,
        providerUsage?.cachedInputTokens ?? 0,
        Date.now() - startedAt,
        calculateEstimatedCost(this.governance, alias.physicalModel, measuredInput, measuredOutput, providerUsage?.cachedInputTokens ?? 0),
        1,
        'shadow_canary',
        'fallback',
        provider,
      );
      this.onUsageLogged?.(log);
    } catch (error) {
      const providerUsage = provider.getLastUsage();
      const measuredInput = providerUsage?.inputTokens ?? inputTokens;
      const measuredOutput = providerUsage?.outputTokens ?? 0;
      const log = this.makeLog(
        request.task,
        role,
        alias.physicalModel,
        measuredInput,
        measuredOutput,
        providerUsage?.cachedInputTokens ?? 0,
        Date.now() - startedAt,
        calculateEstimatedCost(this.governance, alias.physicalModel, measuredInput, measuredOutput, providerUsage?.cachedInputTokens ?? 0),
        1,
        'shadow_canary',
        'error',
        provider,
        providerCode(error),
      );
      this.onUsageLogged?.(log);
    }
  }

  private async callProvider(
    provider: QwenProvider,
    request: AIRuntimeRequest,
    attempt: number,
    options: QwenCallOptions,
  ): Promise<QwenOperationResult> {
    if (request.task === 'receipt_ocr' || request.task === 'label_ocr') {
      const image = asVisionInput(request.input);
      const repair = attempt > 0 && request.repairInput !== undefined
        ? `${image.promptOverride || ''}\nRepair only these validation failures: ${serializeForPrompt(request.repairInput)}`
        : image.promptOverride;
      return provider.receiptScan({ ...image, ...(repair ? { promptOverride: repair } : {}) }, options);
    }
    if (request.task === 'fridge_image_analysis') {
      const image = asVisionInput(request.input);
      const repair = attempt > 0 && request.repairInput !== undefined
        ? `${image.promptOverride || ''}\nRepair only these validation failures: ${serializeForPrompt(request.repairInput)}`
        : image.promptOverride;
      return provider.vision({ ...image, ...(repair ? { promptOverride: repair } : {}) }, options);
    }
    const prompt = textInput(
      request.input,
      attempt > 0 ? undefined : request.context,
      request.task,
      attempt > 0 ? request.repairInput : undefined,
    );
    return provider.chat(prompt, undefined, options);
  }

  private makeLog(
    task: AITask,
    role: AIModelRole,
    physicalModel: string,
    inputTokens: number,
    outputTokensValue: number,
    cachedInputTokens: number,
    latencyMs: number,
    estimatedCostUsd: number,
    attempt: number,
    escalationReason: string | undefined,
    status: 'success' | 'error' | 'fallback',
    _provider: QwenProvider,
    failureCode?: string,
  ): AIUsageLog {
    const policy = getTaskPolicy(this.governance, task);
    return {
      // New task runtime logs retain semantic task names. Legacy AIRouter
      // wrappers continue to emit fridge_scan/receipt_scan/chat aliases.
      task,
      provider: 'qwen',
      model: physicalModel,
      logicalModel: role,
      physicalModel,
      promptId: policy.promptId,
      promptVersion: policy.promptVersion,
      inputTokens,
      outputTokens: outputTokensValue,
      cachedInputTokens,
      latencyMs,
      estimatedCost: estimatedCostUsd,
      estimatedCostUsd,
      pricingVersion: this.governance.pricing[physicalModel]?.pricingVersion,
      attempt,
      escalationReason,
      failureCode,
      status,
      createdAt: new Date().toISOString(),
    };
  }
}
