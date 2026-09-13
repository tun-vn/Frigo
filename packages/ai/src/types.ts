import { VisionScanResult, ReceiptScanResult } from './schemas';

export interface VisionScanParams {
  imageBase64OrUrl: string;
  mimeType?: string;
  promptOverride?: string;
}

export interface AIProvider {
  name: string;
  vision(params: VisionScanParams): Promise<VisionScanResult>;
  receiptScan?(params: VisionScanParams): Promise<ReceiptScanResult>;
  normalizeIngredient(rawName: string): Promise<{ canonicalId: string | null; confidence: number }>;
  rankRecipes(recipeTitles: string[], userIngredients: string[]): Promise<string[]>;
  chat(prompt: string, context?: Record<string, unknown>): Promise<string>;
}

export interface AIConfig {
  aiMockMode?: boolean;
  // B4: when true (production default), a failed AI call surfaces an error
  // instead of returning fabricated fixture items that would pollute real inventory.
  silentFallback?: boolean;
  qwenApiKey?: string;
  qwenBaseUrl?: string;
  /** Shared Qwen model for multimodal, chat, and ranking requests. */
  qwenModel?: string;
  /** Provider timeout; vision OCR can take longer than short text requests. */
  qwenRequestTimeoutMs?: number;
  zaiApiKey?: string;
  zaiBaseUrl?: string;
  /** Enable GLM only as an explicit future fallback. */
  glmFallbackEnabled?: boolean;
  deepseekApiKey?: string;
  deepseekBaseUrl?: string;
  /** Enable DeepSeek only as an explicit future text fallback. */
  deepseekFallbackEnabled?: boolean;
  groqApiKey?: string;
  groqBaseUrl?: string;
  groqVisionModel?: string;
  /** Keep the legacy Groq adapter available only when explicitly requested. */
  groqFallbackEnabled?: boolean;
  /** Use native Workers AI after external vision providers fail. */
  cloudflareVisionFallback?: boolean;
  aiGatewayUrl?: string;
  aiBinding?: any;
}
