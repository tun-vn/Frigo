import { AIProvider, AIProviderUsage, VisionScanParams } from '../types';
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
import { resolveProviderCanonical, normalizeOcrNumber } from '../normalization';
import { findCanonicalIngredient } from '@frigo/domain';

const DEFAULT_BASE_URL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
const DEFAULT_MODEL = 'qwen3.7-flash';
// Vision extraction can legitimately take ~50s on a full-page receipt.
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

type ChatMessageContent = string | Array<{
  type?: string;
  text?: string;
  image_url?: { url: string };
}> | Record<string, unknown>;
type StandardUnit = 'g' | 'kg' | 'ml' | 'l' | 'piece' | 'pack' | 'bunch' | 'slice';
type QwenProviderOptions = {
  model?: string;
  requestTimeoutMs?: number;
};

export interface QwenCallOptions {
  maxTokens?: number;
  temperature?: number;
  jsonMode?: boolean;
}

function recordValue(record: Record<string, unknown>, aliases: readonly string[]): unknown {
  for (const alias of aliases) {
    if (record[alias] !== undefined && record[alias] !== null) return record[alias];
  }
  return undefined;
}

function unwrapResult(payload: unknown): unknown {
  let current = payload;
  for (let depth = 0; depth < 3; depth += 1) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return current;
    const next = recordValue(current as Record<string, unknown>, ['result', 'data', 'output']);
    if (next === undefined || next === current) return current;
    current = next;
  }
  return current;
}

function normalizeUnit(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const aliases: Record<string, StandardUnit> = {
    gram: 'g', grams: 'g', gam: 'g', 'g.': 'g',
    kilogram: 'kg', kilograms: 'kg', 'kg.': 'kg',
    milliliter: 'ml', milliliters: 'ml', mililit: 'ml', 'ml.': 'ml',
    liter: 'l', liters: 'l', litre: 'l', lít: 'l', 'l.': 'l',
    quả: 'piece', cái: 'piece', con: 'piece', chai: 'piece', lọ: 'piece', piece: 'piece', pieces: 'piece',
    pc: 'piece', pcs: 'piece', ea: 'piece', each: 'piece', unit: 'piece', bottle: 'piece', jar: 'piece', can: 'piece',
    pack: 'pack', packs: 'pack', packet: 'pack', bag: 'pack', box: 'pack', gói: 'pack', hộp: 'pack', túi: 'pack', thùng: 'pack',
    bunch: 'bunch', bundle: 'bunch', bó: 'bunch', mớ: 'bunch',
    slice: 'slice', lát: 'slice', miếng: 'slice',
  };
  return aliases[value.trim().toLowerCase()] || value;
}

function normalizeStorage(value: unknown): unknown {
  if (typeof value !== 'string' || !value.trim()) return value;
  const storage = value.trim().toLowerCase();
  if (storage.includes('freezer') || storage.includes('đông') || storage.includes('đá')) return 'freezer';
  if (storage.includes('pantry') || storage.includes('khô') || storage.includes('bếp') || storage.includes('room') || storage.includes('kitchen')) return 'pantry';
  if (storage === 'fridge' || storage.includes('lạnh') || storage.includes('refrigerat') || storage.includes('cold') || storage.includes('ngăn mát')) return 'fridge';
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

function normalizeConfidence(value: unknown): unknown {
  const normalized = normalizeOcrNumber(value);
  return typeof normalized === 'number' && normalized > 1 && normalized <= 100
    ? normalized / 100
    : normalized;
}

function normalizeItem(item: unknown): unknown {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
  const value = item as Record<string, unknown>;
  return {
    ...value,
    raw_name: recordValue(value, [
      'raw_name', 'rawName', 'name', 'item_name', 'itemName', 'product_name', 'productName',
      'ingredient_name', 'ingredientName', 'ingredient', 'description', 'label',
    ]),
    estimated_quantity: normalizeOcrNumber(recordValue(value, [
      'estimated_quantity', 'estimatedQuantity', 'quantity', 'qty', 'count', 'quantity_value', 'quantityValue',
    ])),
    unit: normalizeUnit(recordValue(value, [
      'unit', 'measurement_unit', 'measurementUnit', 'quantity_unit', 'quantityUnit', 'unit_name', 'unitName',
      'unit_of_measure', 'unitOfMeasure', 'uom',
    ])),
    unit_price_vnd: normalizeOcrNumber(recordValue(value, [
      'unit_price_vnd', 'unitPriceVnd', 'unit_price', 'unitPrice', 'price_per_unit', 'pricePerUnit',
      'unit_cost', 'unitCost',
    ])),
    total_price_vnd: normalizeOcrNumber(recordValue(value, [
      'total_price_vnd', 'totalPriceVnd', 'total_price', 'totalPrice', 'line_total', 'lineTotal',
      'subtotal', 'line_amount', 'lineAmount', 'total_cost', 'totalCost', 'net_amount', 'netAmount', 'amount', 'price',
    ])),
    confidence: normalizeConfidence(recordValue(value, [
      'confidence', 'confidence_score', 'confidenceScore', 'confidence_percent', 'confidencePercent', 'score', 'probability', 'certainty',
    ])),
    canonical_id: recordValue(value, [
      'canonical_id', 'canonicalId', 'canonical_ingredient_id', 'canonicalIngredientId', 'ingredient_id', 'ingredientId',
      'catalog_id', 'catalogId',
    ]),
    storage: normalizeStorage(recordValue(value, [
      'storage', 'storage_location', 'storageLocation', 'storage_recommendation', 'storageRecommendation',
      'storage_type', 'storageType', 'location',
    ])),
    category: normalizeCategory(recordValue(value, ['category', 'food_category', 'foodCategory', 'food_type', 'foodType', 'group'])),
  };
}

function itemArray(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeItem);
  if (value && typeof value === 'object') return [normalizeItem(value)];
  return value;
}

function normalizeVisionPayload(payload: unknown): unknown {
  const unwrapped = unwrapResult(payload);
  if (Array.isArray(unwrapped)) return { items: unwrapped.map(normalizeItem) };
  if (!unwrapped || typeof unwrapped !== 'object') return unwrapped;
  const record = unwrapped as Record<string, unknown>;
  const items = recordValue(record, [
    'items', 'ingredients', 'detected_items', 'detectedItems', 'detected_ingredients', 'detectedIngredients',
    'ingredient_list', 'ingredientList', 'food_items', 'foodItems', 'products', 'results', 'detections',
  ]);
  return {
    ...record,
    items: itemArray(items),
  };
}

function normalizeReceiptPayload(payload: unknown): unknown {
  const unwrapped = unwrapResult(payload);
  if (Array.isArray(unwrapped)) return { items: unwrapped.map(normalizeItem) };
  if (!unwrapped || typeof unwrapped !== 'object') return unwrapped;
  const record = unwrapped as Record<string, unknown>;
  const items = recordValue(record, [
    'items', 'line_items', 'lineItems', 'receipt_items', 'receiptItems', 'purchased_items', 'purchasedItems',
    'products', 'goods', 'food_items', 'foodItems',
  ]);
  return {
    ...record,
    merchant_name: recordValue(record, [
      'merchant_name', 'merchantName', 'store_name', 'storeName', 'merchant', 'store', 'shop_name', 'shopName',
      'vendor_name', 'vendorName', 'vendor',
    ]),
    invoice_number: recordValue(record, [
      'invoice_number', 'invoiceNumber', 'receipt_number', 'receiptNumber', 'bill_number', 'billNumber',
      'transaction_id', 'transactionId',
    ]),
    purchase_date: recordValue(record, [
      'purchase_date', 'purchaseDate', 'transaction_date', 'transactionDate', 'invoice_date', 'invoiceDate', 'date',
    ]),
    total_amount_vnd: normalizeOcrNumber(recordValue(record, [
      'total_amount_vnd', 'totalAmountVnd', 'total_amount', 'totalAmount', 'grand_total', 'grandTotal',
      'amount_due', 'amountDue', 'amount_payable', 'amountPayable', 'total',
    ])),
    items: itemArray(items),
  };
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => contentText(part)).join('');
  }
  if (!content || typeof content !== 'object') return '';
  const record = content as Record<string, unknown>;
  if (typeof record.text === 'string') return record.text;
  if (record.content !== undefined) return contentText(record.content);
  if (record.output_text !== undefined) return contentText(record.output_text);
  if (record.response !== undefined) return contentText(record.response);
  if (record.answer !== undefined) return contentText(record.answer);
  if (record.value !== undefined) return contentText(record.value);
  return '';
}

function parseJsonValue(content: unknown): unknown {
  if (content && typeof content === 'object') return content;
  if (typeof content !== 'string') return null;
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
        // Continue to bounded object extraction below.
      }
    }
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        // Try a bounded array next.
      }
    }
    const arrayStart = text.indexOf('[');
    const arrayEnd = text.lastIndexOf(']');
    if (arrayStart >= 0 && arrayEnd > arrayStart) {
      try {
        return JSON.parse(text.slice(arrayStart, arrayEnd + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function imageUrl(params: VisionScanParams): string {
  const value = params.imageBase64OrUrl.trim();
  return value.startsWith('http://') || value.startsWith('https://') || value.startsWith('data:')
    ? value
    : `data:${params.mimeType || 'image/jpeg'};base64,${value}`;
}

export class QwenProvider implements AIProvider {
  readonly name = 'qwen';
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly requestTimeoutMs: number;
  private lastUsage: AIProviderUsage | undefined;

  constructor(
    apiKey: string,
    baseUrl = DEFAULT_BASE_URL,
    modelOrOptions: string | number | QwenProviderOptions = DEFAULT_MODEL,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ) {
    if (!apiKey.trim()) throw new Error('Qwen API key is required');
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    // The numeric third argument was the historical timeout parameter. Keep
    // accepting it while allowing deployments to select a Qwen model.
    if (typeof modelOrOptions === 'number') {
      this.model = DEFAULT_MODEL;
      this.requestTimeoutMs = Math.max(1_000, modelOrOptions);
    } else if (typeof modelOrOptions === 'string') {
      this.model = modelOrOptions.trim() || DEFAULT_MODEL;
      this.requestTimeoutMs = Math.max(1_000, requestTimeoutMs);
    } else {
      this.model = modelOrOptions.model?.trim() || DEFAULT_MODEL;
      this.requestTimeoutMs = Math.max(1_000, modelOrOptions.requestTimeoutMs ?? requestTimeoutMs);
    }
  }

  getLastUsage(): AIProviderUsage | undefined {
    return this.lastUsage ? { ...this.lastUsage } : undefined;
  }

  async vision(params: VisionScanParams, options: QwenCallOptions = {}): Promise<VisionScanResult> {
    const prompt = params.promptOverride || `Bạn là chuyên gia nhận diện nguyên liệu thực phẩm trong tủ lạnh cho ứng dụng Frigo tại Việt Nam.
Hãy phân tích bức ảnh và trả về DUY NHẤT một JSON object hợp lệ theo định dạng:
{
  "items": [
    {
      "raw_name": "Tên tiếng Việt của nguyên liệu (ví dụ: Thịt ba chỉ, Trứng gà, Cà chua, Rau muống)",
      "estimated_quantity": 400,
      "unit": "g" hoặc "kg" hoặc "piece" hoặc "bunch" hoặc "pack" hoặc "ml" hoặc "l" hoặc "slice",
      "confidence": 0.95
    }
  ]
}
Chỉ trả về JSON thuần, không thêm markdown code block thừa.`;

    const parsed = await this.completeVision(prompt, params, options.maxTokens ?? 1024, options.temperature);
    let validated: VisionScanResult;
    try {
      validated = VisionScanResultSchema.parse(normalizeVisionPayload(parsed));
    } catch (error) {
      throw createAISchemaError('Qwen', 'Qwen response failed vision schema validation', this.model, error);
    }
    if (validated.items.length === 0) {
      throw createAIResponseError('Qwen', 'Qwen returned no detectable ingredients', this.model);
    }

    // Annotate canonical IDs
    validated.items = validated.items.map(item => {
      const canonical = resolveProviderCanonical(item.raw_name, item.canonical_id);
      return {
        ...item,
        canonical_id: canonical?.id,
        category: canonical?.category || item.category || 'other',
        storage: item.storage || 'fridge'
      };
    });

    return validated;
  }

  async receiptScan(params: VisionScanParams, options: QwenCallOptions = {}): Promise<ReceiptScanResult> {
    const prompt = params.promptOverride || `Bạn là hệ thống OCR hóa đơn thực phẩm cho ứng dụng Frigo tại Việt Nam.
Đọc ảnh hóa đơn và trả về DUY NHẤT một JSON object hợp lệ theo định dạng:
{
  "merchant_name": "Tên cửa hàng",
  "invoice_number": "Mã hóa đơn",
  "purchase_date": "YYYY-MM-DD",
  "total_amount_vnd": 0,
  "items": [
    {
      "raw_name": "Tên sản phẩm thực phẩm",
      "estimated_quantity": 1,
      "unit": "g" hoặc "kg" hoặc "piece" hoặc "pack" hoặc "bunch" hoặc "ml" hoặc "l" hoặc "slice",
      "unit_price_vnd": 0,
      "total_price_vnd": 0,
      "confidence": 0.9
    }
  ]
}
Bỏ qua dòng không phải thực phẩm và không tự bịa sản phẩm không nhìn thấy.`;
    const parsed = await this.completeVision(prompt, params, options.maxTokens ?? 1_500, options.temperature);
    let validated: ReceiptScanResult;
    try {
      validated = ReceiptScanResultSchema.parse(normalizeReceiptPayload(parsed));
    } catch (error) {
      throw createAISchemaError('Qwen', 'Qwen response failed receipt schema validation', this.model, error);
    }
    if (validated.items.length === 0) {
      throw createAIResponseError('Qwen', 'Qwen returned no receipt items', this.model);
    }
    return {
      ...validated,
      items: validated.items.map((item) => {
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

  private async complete(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: ChatMessageContent }>,
    options: { maxTokens?: number; jsonMode?: boolean; temperature?: number } = {},
  ): Promise<unknown> {
    this.lastUsage = undefined;
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.requestTimeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature: options.temperature ?? 0.1,
          // Qwen3.7 can spend most of a short OCR request in reasoning. The
          // structured extraction tasks deliberately use the fast path.
          enable_thinking: false,
          ...(options.jsonMode ? { response_format: { type: 'json_object' } } : {}),
          ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
        }),
      });
      if (!res.ok) throw createAIHttpError('Qwen', res.status, await res.text(), this.model);

      let data: {
        choices?: Array<{
          text?: unknown;
          message?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown };
        }>;
        output_text?: unknown;
        output?: unknown;
        usage?: {
          prompt_tokens?: unknown;
          completion_tokens?: unknown;
          input_tokens?: unknown;
          output_tokens?: unknown;
          prompt_tokens_details?: { cached_tokens?: unknown };
          input_tokens_details?: { cached_tokens?: unknown };
        };
      };
      try {
        data = await res.json() as typeof data;
      } catch (error) {
        throw createAIResponseError('Qwen', 'Qwen returned an invalid JSON envelope', this.model, error);
      }
      const usage = data.usage;
      if (usage) {
        const inputTokens = Number(usage.input_tokens ?? usage.prompt_tokens);
        const outputTokens = Number(usage.output_tokens ?? usage.completion_tokens);
        const cachedInputTokens = Number(
          usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens,
        );
        this.lastUsage = {
          inputTokens: Number.isFinite(inputTokens) && inputTokens >= 0 ? inputTokens : 0,
          outputTokens: Number.isFinite(outputTokens) && outputTokens >= 0 ? outputTokens : 0,
          ...(Number.isFinite(cachedInputTokens) && cachedInputTokens >= 0 ? { cachedInputTokens } : {}),
        };
      }
      const choice = data.choices?.[0];
      const message = choice?.message;
      const candidates = [
        message?.content,
        message?.reasoning_content,
        message?.reasoning,
        choice?.text,
        data.output_text,
        data.output,
      ];
      const rawContent = candidates.find((candidate) => {
        if (candidate === undefined || candidate === null) return false;
        return typeof candidate !== 'string' || candidate.trim().length > 0;
      });
      if (rawContent === undefined) {
        throw createAIResponseError('Qwen', 'Qwen returned empty response', this.model);
      }
      return rawContent;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw createAITimeoutError('Qwen', this.requestTimeoutMs, this.model, error);
      }
      if (isAIProviderError(error)) throw error;
      if (timedOut) throw createAITimeoutError('Qwen', this.requestTimeoutMs, this.model, error);
      throw createAINetworkError('Qwen', error, this.model);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async completeVision(prompt: string, params: VisionScanParams, maxTokens: number, temperature?: number): Promise<unknown> {
    const rawContent = await this.complete([
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: imageUrl(params) } },
        ],
      },
    ], { maxTokens, jsonMode: true, temperature: temperature ?? 0.1 });
    const parsed = parseJsonValue(contentText(rawContent) || rawContent);
    if (parsed === null || parsed === undefined) {
      throw createAIResponseError('Qwen', 'Qwen returned empty or non-JSON response', this.model);
    }
    return parsed;
  }

  async normalizeIngredient(rawName: string): Promise<{ canonicalId: string | null; confidence: number }> {
    this.lastUsage = undefined;
    const canonical = findCanonicalIngredient(rawName);
    return {
      canonicalId: canonical?.id || null,
      confidence: canonical ? 0.95 : 0,
    };
  }

  async rankRecipes(recipeTitles: string[], userIngredients: string[] = [], options: QwenCallOptions = {}): Promise<string[]> {
    if (recipeTitles.length < 2) return recipeTitles;

    const prompt = `Bạn là AI Chef của Frigo Việt Nam. Người dùng có các nguyên liệu: ${userIngredients.join(', ') || 'không rõ'}.
Danh sách món ăn cần xếp hạng:
${recipeTitles.map((title, index) => `${index + 1}. ${title}`).join('\n')}

Xếp hạng từ phù hợp nhất đến ít phù hợp nhất để tận dụng nguyên liệu. Chỉ dùng đúng tên có trong danh sách.
Trả về JSON object duy nhất: {"ranked_titles":["Tên món 1","Tên món 2"]}`;

    const rawContent = await this.complete([
      { role: 'user', content: prompt },
    ], { maxTokens: options.maxTokens ?? 1_024, jsonMode: true, temperature: options.temperature ?? 0.2 });
    const parsed = parseJsonValue(contentText(rawContent) || rawContent);
    const candidates = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object'
        ? recordValue(parsed as Record<string, unknown>, [
            'ranked_titles', 'rankedTitles', 'ranked_recipes', 'rankedRecipes', 'recipes', 'items',
          ])
        : undefined;
    if (!Array.isArray(candidates)) {
      // Let AIRouter try the next configured text provider. Returning the
      // original order here would make a failed Qwen call look successful and
      // suppress the configured DeepSeek/GLM fallback.
      throw createAIResponseError('Qwen', 'Qwen returned an invalid recipe ranking payload', this.model);
    }

    const byNormalizedTitle = new Map(recipeTitles.map((title) => [title.trim().toLocaleLowerCase(), title]));
    const ranked: string[] = [];
    for (const candidate of candidates) {
      if (typeof candidate !== 'string') continue;
      const title = byNormalizedTitle.get(candidate.trim().toLocaleLowerCase());
      if (title && !ranked.includes(title)) ranked.push(title);
    }
    if (ranked.length === 0) {
      throw createAIResponseError('Qwen', 'Qwen ranking did not contain any supplied recipe title', this.model);
    }
    return [...ranked, ...recipeTitles.filter((title) => !ranked.includes(title))];
  }

  async chat(prompt: string, context?: Record<string, unknown>, options: QwenCallOptions = {}): Promise<string> {
    const userContent = context ? `${JSON.stringify(context)}\n\n${prompt}` : prompt;
    const rawContent = await this.complete([
      {
        role: 'system',
        content: 'Bạn là trợ lý AI của ứng dụng Frigo Việt Nam. Trả lời ngắn gọn, chính xác và thân thiện.',
      },
      { role: 'user', content: userContent },
    ], {
      maxTokens: options.maxTokens ?? 2_048,
      temperature: options.temperature ?? 0.2,
      jsonMode: options.jsonMode ?? false,
    });
    const content = contentText(rawContent).trim();
    if (!content) throw createAIResponseError('Qwen', 'Qwen returned empty response', this.model);
    return content;
  }
}

export {
  DEFAULT_BASE_URL as QWEN_DEFAULT_BASE_URL,
  DEFAULT_MODEL as QWEN_DEFAULT_MODEL,
  DEFAULT_MODEL as QWEN_DEFAULT_CHAT_MODEL,
  // Keep the old export name for callers that used it for vision telemetry.
  DEFAULT_MODEL as QWEN_DEFAULT_VISION_MODEL,
  DEFAULT_REQUEST_TIMEOUT_MS as QWEN_DEFAULT_REQUEST_TIMEOUT_MS,
};
