import { AIProvider, VisionScanParams } from '../types';
import {
  ReceiptScanResult,
  ReceiptScanResultSchema,
  VisionScanResult,
  VisionScanResultSchema,
} from '../schemas';
import {
  createAIHttpError,
  createAINetworkError,
  createAIResponseError,
  createAISchemaError,
  createAITimeoutError,
  isAIProviderError,
} from '../errors';
import { normalizeOcrNumber, resolveProviderCanonical } from '../normalization';
import { findCanonicalIngredient } from '@frigo/domain';

const DEFAULT_BASE_URL = 'https://api.groq.com/openai/v1';
// Qwen's multimodal model is available on Groq's current production catalog.
// Keep this explicit: an inaccessible model makes every scan wait through the
// queue retry window before the user sees a failure.
const DEFAULT_VISION_MODEL = 'qwen/qwen3.6-27b';
const DEFAULT_CHAT_MODEL = 'llama-3.1-8b-instant';
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

type ChatMessageContent = string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
type StandardUnit = 'g' | 'kg' | 'ml' | 'l' | 'piece' | 'pack' | 'bunch' | 'slice';

function imageUrl(params: VisionScanParams): string {
  const value = params.imageBase64OrUrl.trim();
  if (value.startsWith('http://') || value.startsWith('https://') || value.startsWith('data:')) {
    return value;
  }
  return `data:${params.mimeType || 'image/jpeg'};base64,${value}`;
}

function parseJsonObject(content: unknown): unknown {
  if (typeof content !== 'string') return content;
  const text = content.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced?.[1]) {
      try {
        return JSON.parse(fenced[1]);
      } catch {
        // Continue to the bounded object extraction below.
      }
    }
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function contentText(content: ChatMessageContent | undefined): string {
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    const text = (content as { text?: unknown }).text;
    return typeof text === 'string' ? text : '';
  }
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

function standardizeResult(result: VisionScanResult): VisionScanResult {
  return {
    items: result.items.map((item) => {
      const canonical = resolveProviderCanonical(item.raw_name, item.canonical_id);
      return {
        ...item,
        canonical_id: canonical?.id,
        category: canonical?.category || item.category || 'other',
        storage: item.storage || 'fridge',
      };
    }),
  };
}

function normalizeUnit(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const unit = value.trim().toLowerCase();
  const aliases: Record<string, StandardUnit> = {
    gram: 'g', grams: 'g', gam: 'g', grams_: 'g', 'g.': 'g',
    kilogram: 'kg', kilograms: 'kg', 'kg.': 'kg',
    milliliter: 'ml', milliliters: 'ml', mililit: 'ml', 'ml.': 'ml',
    liter: 'l', liters: 'l', litre: 'l', lít: 'l', 'l.': 'l',
    quả: 'piece', cái: 'piece', con: 'piece', chai: 'piece', lọ: 'piece', piece: 'piece', pieces: 'piece',
    pack: 'pack', packs: 'pack', gói: 'pack', hộp: 'pack', túi: 'pack', thùng: 'pack',
    bunch: 'bunch', bó: 'bunch', mớ: 'bunch',
    slice: 'slice', lát: 'slice', miếng: 'slice',
  };
  return aliases[unit] || value;
}

function normalizeStorage(value: unknown): unknown {
  if (typeof value !== 'string' || !value.trim()) return value;
  const storage = value.trim().toLowerCase();
  if (storage.includes('freezer') || storage.includes('đông') || storage.includes('đá')) return 'freezer';
  if (storage.includes('pantry') || storage.includes('khô') || storage.includes('bếp') || storage.includes('room') || storage.includes('kitchen')) return 'pantry';
  if (storage === 'fridge' || storage.includes('lạnh')) return 'fridge';
  return value;
}

function normalizeCategory(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const category = value.trim().toLowerCase();
  if (category.includes('thịt') || category.includes('meat')) return 'meat';
  if (category.includes('rau') || category.includes('vegetable')) return 'vegetable';
  if (category.includes('trứng') || category.includes('egg')) return 'egg';
  if (category.includes('cá') || category.includes('hải sản') || category.includes('seafood')) return 'seafood';
  if (category.includes('sữa') || category.includes('dairy')) return 'dairy';
  if (category.includes('gia vị') || category.includes('condiment')) return 'condiment';
  return value;
}

function normalizePayload(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') return payload;
  const record = payload as Record<string, unknown>;
  const items = Array.isArray(record.items)
    ? record.items.map((item) => {
        if (!item || typeof item !== 'object') return item;
        const value = item as Record<string, unknown>;
        const optional = (input: unknown): unknown => input === null ? undefined : input;
        return {
          ...value,
          raw_name: optional(value.raw_name),
          estimated_quantity: normalizeOcrNumber(value.estimated_quantity),
          unit_price_vnd: normalizeOcrNumber(value.unit_price_vnd),
          total_price_vnd: normalizeOcrNumber(value.total_price_vnd),
          confidence: normalizeOcrNumber(value.confidence),
          unit: optional(normalizeUnit(value.unit)),
          storage: optional(normalizeStorage(value.storage)),
          category: optional(normalizeCategory(value.category)),
        };
      })
    : record.items;
  return {
    ...record,
    merchant_name: record.merchant_name === null ? undefined : record.merchant_name,
    invoice_number: record.invoice_number === null ? undefined : record.invoice_number,
    purchase_date: record.purchase_date === null ? undefined : record.purchase_date,
    total_amount_vnd: record.total_amount_vnd === null ? undefined : normalizeOcrNumber(record.total_amount_vnd),
    items,
  };
}

function standardizeReceipt(result: ReceiptScanResult): ReceiptScanResult {
  return {
    ...result,
    items: result.items.map((item) => {
      const canonical = resolveProviderCanonical(item.raw_name, item.canonical_id);
      return {
        ...item,
        canonical_id: canonical?.id,
        category: canonical?.category || item.category || 'other',
        storage: item.storage || 'fridge',
      };
    }),
  };
}

export class GroqProvider implements AIProvider {
  readonly name = 'groq';
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly visionModel: string;
  private readonly requestTimeoutMs: number;

  constructor(
    apiKey: string,
    baseUrl = DEFAULT_BASE_URL,
    visionModel = DEFAULT_VISION_MODEL,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ) {
    if (!apiKey.trim()) throw new Error('Groq API key is required');
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.visionModel = visionModel;
    this.requestTimeoutMs = Math.max(1_000, requestTimeoutMs);
  }

  async vision(params: VisionScanParams): Promise<VisionScanResult> {
    const prompt = params.promptOverride || `Phân tích ảnh thực phẩm hoặc tủ lạnh. Chỉ trả về JSON object hợp lệ, không markdown:
{"items":[{"raw_name":"Tên thực phẩm tiếng Việt","estimated_quantity":1,"unit":"piece","confidence":0.9,"category":"other","storage":"fridge"}]}
Unit chỉ được là g, kg, ml, l, piece, pack, bunch hoặc slice. Nếu không chắc, dùng piece và confidence thấp.`;
    const parsed = await this.completeVision(prompt, params);
    let validated: VisionScanResult;
    try {
      validated = VisionScanResultSchema.parse(normalizePayload(parsed));
    } catch (error) {
      throw createAISchemaError('Groq', 'Groq response failed vision schema validation', this.visionModel, error);
    }
    if (validated.items.length === 0) {
      throw createAIResponseError('Groq', 'Groq returned no detectable ingredients', this.visionModel);
    }
    return standardizeResult(validated);
  }

  async receiptScan(params: VisionScanParams): Promise<ReceiptScanResult> {
    const prompt = params.promptOverride || `Đọc hóa đơn thực phẩm trong ảnh. Chỉ trả về JSON object hợp lệ, không markdown:
{"merchant_name":"Tên cửa hàng","invoice_number":"Mã hóa đơn","purchase_date":"YYYY-MM-DD","total_amount_vnd":0,"items":[{"raw_name":"Tên sản phẩm","estimated_quantity":1,"unit":"piece","unit_price_vnd":0,"total_price_vnd":0,"confidence":0.9,"category":"other","storage":"fridge"}]}
Unit chỉ được là g, kg, ml, l, piece, pack, bunch hoặc slice. Bỏ qua dòng không phải sản phẩm.`;
    const parsed = await this.completeVision(prompt, params);
    let validated: ReceiptScanResult;
    try {
      validated = ReceiptScanResultSchema.parse(normalizePayload(parsed));
    } catch (error) {
      throw createAISchemaError('Groq', 'Groq response failed receipt schema validation', this.visionModel, error);
    }
    if (validated.items.length === 0) {
      throw createAIResponseError('Groq', 'Groq returned no receipt items', this.visionModel);
    }
    return standardizeReceipt(validated);
  }

  private async completeVision(prompt: string, params: VisionScanParams): Promise<unknown> {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.requestTimeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.visionModel,
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: imageUrl(params) } }] }],
          temperature: 0.1,
          // Keep the structured response below Groq's free-tier output limit.
          max_completion_tokens: 768,
          response_format: { type: 'json_object' },
          reasoning_effort: 'none',
        }),
      });
      if (!response.ok) {
        const detail = await response.text();
        throw createAIHttpError('Groq', response.status, detail, this.visionModel);
      }

      let payload: { choices?: Array<{ message?: { content?: ChatMessageContent; reasoning?: ChatMessageContent; reasoning_content?: ChatMessageContent } }> };
      try {
        payload = await response.json() as { choices?: Array<{ message?: { content?: ChatMessageContent; reasoning?: ChatMessageContent; reasoning_content?: ChatMessageContent } }> };
      } catch (error) {
        throw createAIResponseError('Groq', 'Groq returned an invalid JSON envelope', this.visionModel, error);
      }
      const message = payload.choices?.[0]?.message;
      const rawContent = message?.content || message?.reasoning_content || message?.reasoning;
      const parsed = parseJsonObject(contentText(rawContent));
      if (!parsed) {
        throw createAIResponseError('Groq', 'Groq returned an empty or non-JSON response', this.visionModel);
      }
      return parsed;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw createAITimeoutError('Groq', this.requestTimeoutMs, this.visionModel, error);
      }
      if (isAIProviderError(error)) throw error;
      if (timedOut) throw createAITimeoutError('Groq', this.requestTimeoutMs, this.visionModel, error);
      throw createAINetworkError('Groq', error, this.visionModel);
    } finally {
      clearTimeout(timeout);
    }
  }

  async normalizeIngredient(rawName: string): Promise<{ canonicalId: string | null; confidence: number }> {
    const canonical = findCanonicalIngredient(rawName);
    return { canonicalId: canonical?.id || null, confidence: canonical ? 0.95 : 0 };
  }

  async rankRecipes(recipeTitles: string[]): Promise<string[]> {
    return recipeTitles;
  }

  async chat(prompt: string, context?: Record<string, unknown>): Promise<string> {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.requestTimeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        signal: controller.signal,
        body: JSON.stringify({
          model: DEFAULT_CHAT_MODEL,
          messages: [{ role: 'user', content: context ? `${JSON.stringify(context)}\n\n${prompt}` : prompt }],
          temperature: 0.2,
        }),
      });
      if (!response.ok) {
        throw createAIHttpError('Groq', response.status, await response.text(), DEFAULT_CHAT_MODEL);
      }
      let payload: { choices?: Array<{ message?: { content?: ChatMessageContent } }> };
      try {
        payload = await response.json() as { choices?: Array<{ message?: { content?: ChatMessageContent } }> };
      } catch (error) {
        throw createAIResponseError('Groq', 'Groq returned an invalid JSON envelope', DEFAULT_CHAT_MODEL, error);
      }
      const content = contentText(payload.choices?.[0]?.message?.content).trim();
      if (!content) throw createAIResponseError('Groq', 'Groq returned an empty response', DEFAULT_CHAT_MODEL);
      return content;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw createAITimeoutError('Groq', this.requestTimeoutMs, DEFAULT_CHAT_MODEL, error);
      }
      if (isAIProviderError(error)) throw error;
      if (timedOut) throw createAITimeoutError('Groq', this.requestTimeoutMs, DEFAULT_CHAT_MODEL, error);
      throw createAINetworkError('Groq', error, DEFAULT_CHAT_MODEL);
    } finally {
      clearTimeout(timeout);
    }
  }
}

export {
  DEFAULT_BASE_URL as GROQ_DEFAULT_BASE_URL,
  DEFAULT_VISION_MODEL as GROQ_DEFAULT_VISION_MODEL,
  DEFAULT_REQUEST_TIMEOUT_MS as GROQ_DEFAULT_REQUEST_TIMEOUT_MS,
};
