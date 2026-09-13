import { AIConfig, AIProvider, VisionScanParams } from './types';
import { VisionScanResult, AIUsageLog } from './schemas';
import { MockAIProvider } from './providers/mock';
import { QwenProvider, QWEN_DEFAULT_MODEL } from './providers/qwen';
import { GLMProvider } from './providers/glm';
import { DeepSeekProvider } from './providers/deepseek';
import { CloudflareAIProvider } from './providers/cloudflare';
import { GroqProvider, GROQ_DEFAULT_VISION_MODEL } from './providers/groq';
import { findCanonicalIngredient } from '@frigo/domain';
import { AIProviderError, isAIProviderError } from './errors';
import { applyReceiptScanQualityGate, applyVisionScanQualityGate } from './quality-gate';

type ScanFailureType = 'vision' | 'receipt';

function normalizeProviderFailure(error: unknown, provider: AIProvider): AIProviderError {
  if (isAIProviderError(error)) return error;

  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  const permanent = /(model[_ -]?not[_ -]?found|model[\s\S]{0,120}(?:not found|does not exist)|no access|license|5016|unauthorized|\b401\b|forbidden|\b403\b|schema|non[- ]?json|invalid response|non-parsable|invalid or empty image)/i.test(normalized);
  const code = /model[_ -]?not[_ -]?found|model[\s\S]{0,120}(?:not found|does not exist)|no access/i.test(normalized)
    ? 'MODEL_NOT_FOUND'
    : /license|5016/i.test(normalized)
      ? 'LICENSE_REQUIRED'
      : /unauthorized|\b401\b/i.test(normalized)
        ? 'AUTHENTICATION_FAILED'
        : /forbidden|\b403\b/i.test(normalized)
          ? 'PERMISSION_DENIED'
          : permanent ? 'INVALID_RESPONSE' : 'UPSTREAM_ERROR';
  return new AIProviderError(`${provider.name} vision provider failed`, {
    code,
    retryable: !permanent,
    provider: provider.name,
    cause: error,
  });
}

function aggregateScanFailure(type: ScanFailureType, failures: AIProviderError[]): AIProviderError {
  const retryable = failures.some((failure) => failure.retryable);
  if (retryable) {
    return new AIProviderError(
      `AI_SCAN_UNAVAILABLE: Không thể ${type === 'receipt' ? 'đọc hóa đơn' : 'phân tích ảnh'} lúc này. Vui lòng thử lại hoặc nhập thủ công.`,
      { code: 'AI_SCAN_UNAVAILABLE', retryable: true, provider: 'router', cause: failures[0] },
    );
  }

  // A quality failure is more actionable than a provider's generic schema
  // error and is always permanent for the current image.
  const qualityFailure = failures.find((failure) => failure.code === 'AI_SCAN_NO_USABLE_ITEMS');
  if (qualityFailure) return qualityFailure;
  if (failures[0]) return failures[0];
  return new AIProviderError(
    `AI_SCAN_UNAVAILABLE: Không có nhà cung cấp AI ${type === 'receipt' ? 'đọc hóa đơn' : 'phân tích ảnh'} khả dụng.`,
    { code: 'AI_SCAN_UNAVAILABLE', retryable: false, provider: 'router' },
  );
}

export class AIRouter {
  private config: AIConfig;
  private visionProviders: AIProvider[] = [];
  private textProviders: AIProvider[] = [];
  private mockProvider: MockAIProvider;
  private silentFallback: boolean;
  private onUsageLogged?: (log: AIUsageLog) => void;

  constructor(config: AIConfig, onUsageLogged?: (log: AIUsageLog) => void) {
    this.config = config;
    this.onUsageLogged = onUsageLogged;
    this.mockProvider = new MockAIProvider();
    this.silentFallback = config.silentFallback !== false; // default ON (fail loudly)

    if (!config.aiMockMode) {
      // Qwen is the primary multimodal/text provider. Other adapters remain
      // explicit fallbacks so a retired test model cannot silently take over.
      const qwenProvider = config.qwenApiKey
        ? new QwenProvider(config.qwenApiKey, config.qwenBaseUrl, config.qwenModel)
        : undefined;
      if (qwenProvider) {
        this.visionProviders.push(qwenProvider);
        this.textProviders.push(qwenProvider);
      }

      // Preserve the legacy Groq adapter for migrations and local fixtures,
      // but do not call it once Qwen is configured unless explicitly enabled.
      const useGroqFallback = Boolean(config.groqApiKey && config.groqFallbackEnabled === true);
      if (useGroqFallback) {
        const groqProvider = new GroqProvider(config.groqApiKey!, config.groqBaseUrl, config.groqVisionModel);
        this.visionProviders.push(groqProvider);
        if (!qwenProvider || config.groqFallbackEnabled === true) this.textProviders.push(groqProvider);
      }
      // Native Workers AI is an explicit fallback only; a missing flag must
      // not silently switch providers or hide a production configuration gap.
      if (config.aiBinding && config.cloudflareVisionFallback === true) {
        this.visionProviders.push(new CloudflareAIProvider(config.aiBinding));
      }
      if (config.deepseekApiKey && config.deepseekFallbackEnabled === true) {
        this.textProviders.push(new DeepSeekProvider(config.deepseekApiKey, config.deepseekBaseUrl));
      }
      if (config.zaiApiKey && config.glmFallbackEnabled === true) {
        const glmProvider = new GLMProvider(config.zaiApiKey, config.zaiBaseUrl);
        this.visionProviders.push(glmProvider);
        this.textProviders.push(glmProvider);
      }
    }
  }

  async vision(params: VisionScanParams): Promise<VisionScanResult> {
    const startTime = Date.now();

    // Mock data is allowed only when explicitly enabled. A missing provider in
    // production must fail closed instead of fabricating inventory items.
    if (this.config.aiMockMode) {
      const result = await this.mockProvider.vision(params);
      const qualityChecked = applyVisionScanQualityGate(result);
      this.logUsage({
        task: 'fridge_scan',
        provider: 'mock',
        model: 'mock-vision',
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: Date.now() - startTime,
        estimatedCost: 0,
        status: 'success',
        createdAt: new Date().toISOString()
      });
      return qualityChecked;
    }

    if (this.visionProviders.length === 0) {
      if (!this.silentFallback) {
        const result = await this.mockProvider.vision(params);
        const qualityChecked = applyVisionScanQualityGate(result);
        this.logUsage({
          task: 'fridge_scan',
          provider: 'mock-fallback',
          model: 'mock-vision',
          inputTokens: 0,
          outputTokens: 0,
          latencyMs: Date.now() - startTime,
          estimatedCost: 0,
          status: 'fallback',
          createdAt: new Date().toISOString()
        });
        return qualityChecked;
      }
      throw aggregateScanFailure('vision', []);
    }

    // Try every configured provider in deterministic priority order.
    const providerFailures: AIProviderError[] = [];
    for (let index = 0; index < this.visionProviders.length; index += 1) {
      const provider = this.visionProviders[index];
      try {
        const result = await provider.vision(params);
        const qualityChecked = applyVisionScanQualityGate(result);
        this.logUsage({
          task: 'fridge_scan',
          provider: provider.name,
          model: this.modelFor(provider),
          inputTokens: 1000,
          outputTokens: 200,
          latencyMs: Date.now() - startTime,
          estimatedCost: 0.0015,
          status: index === 0 ? 'success' : 'fallback',
          createdAt: new Date().toISOString()
        });
        return qualityChecked;
      } catch (providerErr) {
        const normalizedFailure = normalizeProviderFailure(providerErr, provider);
        providerFailures.push(normalizedFailure);
        // Provider responses can contain OCR text or other user-controlled
        // content. Keep logs useful for operations without persisting it.
        console.warn(JSON.stringify({
          level: 'warn',
          event: 'ai_provider_failed',
          provider: provider.name,
          model: this.modelFor(provider),
          code: normalizedFailure.code,
          retryable: normalizedFailure.retryable,
        }));
      }
    }

    // 4. Ultimate fallback: mock fixture ONLY when silentFallback is disabled
    // (dev/testing). In production we fail loudly — fabricated items must never
    // silently enter a real household inventory (B4).
    if (!this.silentFallback) {
      console.warn('All vision providers failed, falling back to mock fixture');
      const mockResult = await this.mockProvider.vision(params);
      const qualityChecked = applyVisionScanQualityGate(mockResult);
      this.logUsage({
        task: 'fridge_scan',
        provider: 'mock-fallback',
        model: 'mock-vision',
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: Date.now() - startTime,
        estimatedCost: 0,
        status: 'fallback',
        createdAt: new Date().toISOString()
      });
      return qualityChecked;
    }

    throw aggregateScanFailure('vision', providerFailures);
  }

  async receiptScan(params: VisionScanParams): Promise<import('./schemas').ReceiptScanResult> {
    const startTime = Date.now();

    if (this.config.aiMockMode) {
      const result = await this.mockProvider.receiptScan(params);
      const qualityChecked = applyReceiptScanQualityGate(result);
      this.logUsage({
        task: 'receipt_scan',
        provider: 'mock',
        model: 'mock-receipt',
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: Date.now() - startTime,
        estimatedCost: 0,
        status: 'success',
        createdAt: new Date().toISOString()
      });
      return qualityChecked;
    }

    const providerFailures: AIProviderError[] = [];
    if (!this.config.aiMockMode) {
      for (let index = 0; index < this.visionProviders.length; index += 1) {
        const provider = this.visionProviders[index];
        if (!provider.receiptScan) continue;
        try {
          const result = await provider.receiptScan(params);
          const qualityChecked = applyReceiptScanQualityGate(result);
          this.logUsage({
            task: 'receipt_scan',
            provider: provider.name,
            model: this.modelFor(provider),
            inputTokens: 1500,
            outputTokens: 300,
            latencyMs: Date.now() - startTime,
            estimatedCost: 0.001,
            status: index === 0 ? 'success' : 'fallback',
            createdAt: new Date().toISOString()
          });
          return qualityChecked;
        } catch (err) {
          const normalizedFailure = normalizeProviderFailure(err, provider);
          providerFailures.push(normalizedFailure);
          // Do not log raw provider output; receipt text may contain PII.
          console.warn(JSON.stringify({
            level: 'warn',
            event: 'ai_receipt_provider_failed',
            provider: provider.name,
            model: this.modelFor(provider),
            code: normalizedFailure.code,
            retryable: normalizedFailure.retryable,
          }));
        }
      }
    }

    // B4: same fail-loudly policy as fridge scan in production
    if (this.silentFallback) {
      throw aggregateScanFailure('receipt', providerFailures);
    }

    const result = await this.mockProvider.receiptScan(params);
    const qualityChecked = applyReceiptScanQualityGate(result);
    this.logUsage({
      task: 'receipt_scan',
      provider: 'mock',
      model: 'mock-receipt',
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: Date.now() - startTime,
      estimatedCost: 0,
      status: 'fallback',
      createdAt: new Date().toISOString()
    });
    return qualityChecked;
  }

  async normalizeIngredient(rawName: string): Promise<{ canonicalId: string | null; confidence: number }> {
    const deterministic = findCanonicalIngredient(rawName);
    if (deterministic) return { canonicalId: deterministic.id, confidence: 1 };
    if (this.config.aiMockMode) return this.mockProvider.normalizeIngredient(rawName);

    const providers = [...this.textProviders, ...this.visionProviders].filter(
      (provider, index, all): provider is AIProvider => Boolean(provider) && all.indexOf(provider) === index
    );
    for (const provider of providers) {
      try {
        return await provider.normalizeIngredient(rawName);
      } catch {
        // Never turn a failed provider call into a fabricated canonical id.
      }
    }
    throw new Error('AI_NORMALIZATION_UNAVAILABLE: Không thể chuẩn hóa nguyên liệu lúc này.');
  }

  async rankRecipes(recipeTitles: string[], userIngredients: string[]): Promise<string[]> {
    for (const provider of this.textProviders) {
      try {
        return await provider.rankRecipes(recipeTitles, userIngredients);
      } catch (err) {
        console.warn(JSON.stringify({ level: 'warn', event: 'ai_recipe_rank_failed', provider: provider.name }));
      }
    }
    return recipeTitles;
  }

  async chat(prompt: string, context?: Record<string, unknown>): Promise<string> {
    if (this.config.aiMockMode) return this.mockProvider.chat(prompt);
    if (!this.config.aiMockMode) {
      for (const provider of this.textProviders) {
        try {
          return await provider.chat(prompt, context);
        } catch {
          // fallback
        }
      }
    }
    throw new Error('AI_CHAT_UNAVAILABLE: Không có nhà cung cấp AI hội thoại được cấu hình.');
  }

  private logUsage(log: AIUsageLog) {
    if (this.onUsageLogged) {
      this.onUsageLogged(log);
    }
  }

  private modelFor(provider: AIProvider): string {
    switch (provider.name) {
      case 'groq': return this.config.groqVisionModel || GROQ_DEFAULT_VISION_MODEL;
      case 'cloudflare': return '@cf/meta/llama-3.2-11b-vision-instruct';
      case 'qwen': return this.config.qwenModel || QWEN_DEFAULT_MODEL;
      case 'glm': return 'glm-4v';
      default: return 'unknown';
    }
  }
}
