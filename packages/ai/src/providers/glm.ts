import { AIProvider, VisionScanParams } from '../types';
import { VisionScanResult, VisionScanResultSchema } from '../schemas';
import { findCanonicalIngredient } from '@frigo/domain';
import {
  createAIHttpError,
  createAINetworkError,
  createAIResponseError,
  isAIProviderError,
} from '../errors';

export class GLMProvider implements AIProvider {
  name = 'glm';
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string, baseUrl = 'https://open.bigmodel.cn/api/paas/v4') {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async vision(params: VisionScanParams): Promise<VisionScanResult> {
    const prompt = params.promptOverride || `Bạn là chuyên gia nhận diện nguyên liệu thực phẩm trong tủ lạnh cho ứng dụng Frigo.
Hãy phân tích hình ảnh và trả về JSON chuẩn xác:
{
  "items": [
    {
      "raw_name": "Tên nguyên liệu tiếng Việt",
      "estimated_quantity": 400,
      "unit": "g" hoặc "kg" hoặc "piece" hoặc "bunch" hoặc "pack" hoặc "ml" hoặc "l" hoặc "slice",
      "confidence": 0.90
    }
  ]
}`;

    const imageUrl = params.imageBase64OrUrl.startsWith('http') || params.imageBase64OrUrl.startsWith('data:')
      ? params.imageBase64OrUrl
      : `data:${params.mimeType || 'image/jpeg'};base64,${params.imageBase64OrUrl}`;

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: 'glm-4v',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: imageUrl } }
            ]
          }
        ],
        temperature: 0.1
      })
    });

    if (!res.ok) {
      throw new Error(`GLM API error: ${res.status} ${await res.text()}`);
    }

    const data: any = await res.json();
    let content = data.choices?.[0]?.message?.content || '';
    content = content.replace(/```json/g, '').replace(/```/g, '').trim();

    const parsed = JSON.parse(content);
    const validated = VisionScanResultSchema.parse(parsed);

    validated.items = validated.items.map(item => {
      const canonical = findCanonicalIngredient(item.raw_name);
      return {
        ...item,
        canonical_id: canonical?.id,
        category: canonical?.category || 'other',
        storage: 'fridge'
      };
    });

    return validated;
  }

  async normalizeIngredient(rawName: string): Promise<{ canonicalId: string | null; confidence: number }> {
    const canonical = findCanonicalIngredient(rawName);
    return {
      canonicalId: canonical?.id || null,
      confidence: canonical ? 0.9 : 0,
    };
  }

  async rankRecipes(recipeTitles: string[]): Promise<string[]> {
    return recipeTitles;
  }

  async chat(prompt: string): Promise<string> {
    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: 'glm-4-flash',
          messages: [{ role: 'user', content: prompt }]
        })
      });
      if (!res.ok) throw createAIHttpError('GLM', res.status, await res.text(), 'glm-4-flash');
      let data: { choices?: Array<{ message?: { content?: unknown } }> };
      try {
        data = await res.json() as typeof data;
      } catch (error) {
        throw createAIResponseError('GLM', 'GLM returned an invalid JSON envelope', 'glm-4-flash', error);
      }
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) {
        throw createAIResponseError('GLM', 'GLM returned an empty chat response', 'glm-4-flash');
      }
      return content.trim();
    } catch (error) {
      if (isAIProviderError(error)) throw error;
      throw createAINetworkError('GLM', error, 'glm-4-flash');
    }
  }
}
