import { AIProvider, VisionScanParams } from '../types';
import { VisionScanResult, ReceiptScanResult, DetectedIngredient, ReceiptItem } from '../schemas';
import { findCanonicalIngredient } from '@frigo/domain';

export interface CloudflareAIBinding {
  run: (model: string, inputs: any, options?: any) => Promise<any>;
}

/** Legacy compatibility model; production Frigo routing never selects it. */
export const CLOUDFLARE_EXPLANATION_MODEL = '@cf/meta/llama-3.1-8b-instruct';

export async function runLegacyCloudflareExplanation(
  ai: CloudflareAIBinding,
  facts: { locale: string; reasonCodes: readonly string[] },
  system: string,
  maxTokens: number,
): Promise<string> {
  const result = await ai.run(CLOUDFLARE_EXPLANATION_MODEL, {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify(facts) },
    ],
    max_tokens: maxTokens,
    temperature: 0,
  });
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object') {
    const value = result as Record<string, unknown>;
    if (typeof value.response === 'string') return value.response;
    if (typeof value.content === 'string') return value.content;
    if (typeof value.output_text === 'string') return value.output_text;
  }
  throw new Error('Explanation provider returned an invalid response');
}

function base64ToByteArray(input: string): number[] {
  try {
    const cleanBase64 = input.replace(/^data:image\/\w+;base64,/, '').trim();
    const binary = atob(cleanBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return Array.from(bytes);
  } catch (err) {
    console.error('Failed to parse base64 image into byte array:', err);
    return [];
  }
}

function parseJsonFromText(text: string): any {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // Try extract from markdown ```json ... ```
    const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (match && match[1]) {
      try {
        return JSON.parse(match[1]);
      } catch {
        // continue
      }
    }
    // Try extract first { ... }
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(text.substring(firstBrace, lastBrace + 1));
      } catch {
        // continue
      }
    }
  }
  return null;
}

function standardizeUnit(rawUnit?: string): 'g' | 'kg' | 'ml' | 'l' | 'piece' | 'pack' | 'bunch' | 'slice' {
  const u = (rawUnit || '').toLowerCase().trim();
  if (u.includes('kg') || u === 'kí' || u === 'ký') return 'kg';
  if (u.includes('g') || u === 'gram') return 'g';
  if (u.includes('ml')) return 'ml';
  if (u.includes('l') || u === 'lít') return 'l';
  if (u.includes('bó') || u.includes('bunch')) return 'bunch';
  if (u.includes('gói') || u.includes('hộp') || u.includes('pack') || u.includes('túi')) return 'pack';
  if (u.includes('lát') || u.includes('slice')) return 'slice';
  return 'piece';
}

export class CloudflareAIProvider implements AIProvider {
  name = 'cloudflare';
  private ai: CloudflareAIBinding;
  private licenseAgreed = false;

  constructor(ai: CloudflareAIBinding) {
    this.ai = ai;
  }

  private async ensureVisionLicense(model: string): Promise<void> {
    if (this.licenseAgreed) return;
    // Cloudflare gates Meta vision models behind a one-time license prompt.
    // Keep this handshake in memory so normal scans only pay for one call per
    // Worker isolate and never expose user image data in the agreement request.
    try {
      await this.ai.run(model, { prompt: 'agree' });
    } catch (error) {
      // The binding reports a successful license acknowledgement as a 5016
      // exception containing this message; only other errors are fatal.
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('Thank you for agreeing')) throw error;
    }
    this.licenseAgreed = true;
  }

  async vision(params: VisionScanParams): Promise<VisionScanResult> {
    const imageBytes = base64ToByteArray(params.imageBase64OrUrl);
    if (imageBytes.length === 0) {
      throw new Error('Invalid or empty image byte data for vision scan');
    }

    const prompt = `Phân tích hình ảnh thực phẩm hoặc ngăn chứa tủ lạnh này. Nhận diện các nguyên liệu nhìn thấy.
Chỉ trả về một đối tượng JSON hợp lệ duy nhất theo mẫu sau, không có bất kỳ văn bản nào khác:
{
  "items": [
    {
      "raw_name": "Tên thực phẩm bằng tiếng Việt (ví dụ: Trứng gà, Cà chua, Thịt heo, Rau cải...)",
      "estimated_quantity": 2,
      "unit": "piece hoặc g, kg, ml, l, bunch, pack",
      "confidence": 0.95,
      "category": "meat hoặc vegetable, egg, seafood, dairy, condiment, other",
      "storage": "fridge hoặc freezer, pantry"
    }
  ]
}`;

    const model = '@cf/meta/llama-3.2-11b-vision-instruct';
    await this.ensureVisionLicense(model);
    const res = await this.ai.run(model, {
      prompt,
      image: imageBytes,
      max_tokens: 1024,
    });

    const rawText = res?.response || res?.description || (typeof res === 'string' ? res : JSON.stringify(res));
    const parsed = parseJsonFromText(rawText);

    if (!parsed || !Array.isArray(parsed.items) || parsed.items.length === 0) {
      throw new Error(`Cloudflare Workers AI vision returned non-parsable response: ${rawText?.substring(0, 100)}`);
    }

    const items: DetectedIngredient[] = parsed.items.map((item: any) => {
      const canonical = findCanonicalIngredient(item.raw_name);
      return {
        raw_name: String(item.raw_name || 'Nguyên liệu'),
        estimated_quantity: Math.max(0.1, Number(item.estimated_quantity) || 1),
        unit: standardizeUnit(item.unit || canonical?.defaultUnit),
        confidence: Math.min(1, Math.max(0.5, Number(item.confidence) || 0.9)),
        canonical_id: canonical?.id,
        category: canonical?.category || item.category || 'other',
        storage: item.storage === 'freezer' || item.storage === 'pantry' ? item.storage : 'fridge',
      };
    });

    return { items };
  }

  async receiptScan(params: VisionScanParams): Promise<ReceiptScanResult> {
    const imageBytes = base64ToByteArray(params.imageBase64OrUrl);
    if (imageBytes.length === 0) {
      throw new Error('Invalid or empty image byte data for receipt scan');
    }

    const prompt = `Phân tích hóa đơn mua hàng thực phẩm này. Bóc tách tên siêu thị, ngày mua, số tiền và từng món hàng.
Chỉ trả về một đối tượng JSON hợp lệ duy nhất theo mẫu sau, không có văn bản nào khác:
{
  "merchant_name": "Tên siêu thị/cửa hàng",
  "invoice_number": "Số hóa đơn",
  "purchase_date": "YYYY-MM-DD",
  "total_amount_vnd": 100000,
  "items": [
    {
      "raw_name": "Tên sản phẩm",
      "estimated_quantity": 1,
      "unit": "piece hoặc g, kg, bunch, pack, ml, l",
      "unit_price_vnd": 30000,
      "total_price_vnd": 30000,
      "category": "meat hoặc vegetable, egg, dairy, other",
      "storage": "fridge hoặc freezer, pantry",
      "confidence": 0.95
    }
  ]
}`;

    const model = '@cf/meta/llama-3.2-11b-vision-instruct';
    await this.ensureVisionLicense(model);
    const res = await this.ai.run(model, {
      prompt,
      image: imageBytes,
      max_tokens: 1500,
    });

    const rawText = res?.response || res?.description || (typeof res === 'string' ? res : JSON.stringify(res));
    const parsed = parseJsonFromText(rawText);

    if (!parsed || !Array.isArray(parsed.items)) {
      throw new Error(`Cloudflare Workers AI receipt returned non-parsable response: ${rawText?.substring(0, 600)}`);
    }

    const items: ReceiptItem[] = parsed.items.map((item: any) => {
      const canonical = findCanonicalIngredient(item.raw_name);
      return {
        raw_name: String(item.raw_name || 'Sản phẩm'),
        estimated_quantity: Math.max(0.1, Number(item.estimated_quantity) || 1),
        unit: standardizeUnit(item.unit || canonical?.defaultUnit),
        unit_price_vnd: Number(item.unit_price_vnd) || 0,
        total_price_vnd: Number(item.total_price_vnd) || 0,
        canonical_id: canonical?.id,
        category: canonical?.category || item.category || 'other',
        storage: item.storage === 'freezer' || item.storage === 'pantry' ? item.storage : 'fridge',
        confidence: Math.min(1, Math.max(0.5, Number(item.confidence) || 0.9)),
      };
    });

    return {
      merchant_name: parsed.merchant_name || 'Siêu thị',
      invoice_number: parsed.invoice_number,
      purchase_date: parsed.purchase_date || new Date().toISOString().split('T')[0],
      total_amount_vnd: Number(parsed.total_amount_vnd) || 0,
      items,
    };
  }

  async normalizeIngredient(rawName: string): Promise<{ canonicalId: string | null; confidence: number }> {
    const canonical = findCanonicalIngredient(rawName);
    if (canonical) {
      return { canonicalId: canonical.id, confidence: 0.98 };
    }
    return { canonicalId: null, confidence: 0 };
  }

  async rankRecipes(recipeTitles: string[], _userIngredients: string[]): Promise<string[]> {
    return recipeTitles;
  }

  async chat(prompt: string, context?: Record<string, unknown>): Promise<string> {
    const contextStr = context ? `\nNgữ cảnh hiện tại: ${JSON.stringify(context)}` : '';
    try {
      const res = await this.ai.run('@cf/meta/llama-3.1-8b-instruct', {
        messages: [
          {
            role: 'system',
            content: 'Bạn là chuyên gia ẩm thực và quản lý tủ lạnh Frigo thông minh. Tư vấn súc tích, thực tế, ngôn ngữ tiếng Việt tự nhiên và gần gũi.'
          },
          {
            role: 'user',
            content: `${prompt}${contextStr}`
          }
        ],
        max_tokens: 512,
      });
      return res?.response || res?.content || 'Frigo luôn đồng hành cùng bữa ăn tươi ngon của gia đình bạn!';
    } catch {
      return 'Frigo luôn đồng hành cùng bữa ăn tươi ngon của gia đình bạn!';
    }
  }
}
