import { AIProvider, VisionScanParams } from '../types';
import { VisionScanResult } from '../schemas';
import { findCanonicalIngredient } from '@frigo/domain';
import {
  createAIHttpError,
  createAINetworkError,
  createAIResponseError,
  isAIProviderError,
} from '../errors';

export class DeepSeekProvider implements AIProvider {
  name = 'deepseek';
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string, baseUrl = 'https://api.deepseek.com/v1') {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async vision(_params: VisionScanParams): Promise<VisionScanResult> {
    throw new Error('DeepSeek is specialized for reasoning/text ranking, vision not supported');
  }

  async normalizeIngredient(rawName: string): Promise<{ canonicalId: string | null; confidence: number }> {
    const canonical = findCanonicalIngredient(rawName);
    return {
      canonicalId: canonical?.id || null,
      confidence: canonical ? 0.95 : 0,
    };
  }

  async rankRecipes(recipeTitles: string[], userIngredients: string[]): Promise<string[]> {
    const prompt = `Bạn là AI Chef của Frigo. Người dùng có các nguyên liệu sau: ${userIngredients.join(', ')}.
Danh sách các món ăn tiềm năng:
${recipeTitles.map((t, idx) => `${idx + 1}. ${t}`).join('\n')}

Hãy xếp hạng lại các món ăn này từ phù hợp nhất đến ít phù hợp nhất để tận dụng tối đa nguyên liệu và ngon miệng.
Trả về danh sách dưới dạng JSON array of strings chính xác tên món: ["Món 1", "Món 2", ...]`;

    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.2,
        }),
      });

      if (!res.ok) throw createAIHttpError('DeepSeek', res.status, await res.text(), 'deepseek-chat');
      let data: {
        choices?: Array<{ message?: { content?: unknown } }>;
      };
      try {
        data = await res.json() as typeof data;
      } catch (error) {
        throw createAIResponseError('DeepSeek', 'DeepSeek returned an invalid JSON envelope', 'deepseek-chat', error);
      }
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) {
        throw createAIResponseError('DeepSeek', 'DeepSeek returned an empty ranking response', 'deepseek-chat');
      }
      const cleaned = content.replace(/```json/gi, '').replace(/```/g, '').trim();
      let parsed: unknown;
      try {
        parsed = JSON.parse(cleaned);
      } catch (error) {
        throw createAIResponseError('DeepSeek', 'DeepSeek returned a non-JSON ranking response', 'deepseek-chat', error);
      }
      if (!Array.isArray(parsed)) {
        throw createAIResponseError('DeepSeek', 'DeepSeek returned an invalid ranking payload', 'deepseek-chat');
      }
      const byNormalizedTitle = new Map(recipeTitles.map((title) => [title.trim().toLocaleLowerCase(), title]));
      const ranked: string[] = [];
      for (const candidate of parsed) {
        if (typeof candidate !== 'string') continue;
        const title = byNormalizedTitle.get(candidate.trim().toLocaleLowerCase());
        if (title && !ranked.includes(title)) ranked.push(title);
      }
      if (!ranked.length) {
        throw createAIResponseError('DeepSeek', 'DeepSeek ranking did not contain any supplied recipe title', 'deepseek-chat');
      }
      return [...ranked, ...recipeTitles.filter((title) => !ranked.includes(title))];
    } catch (error) {
      if (isAIProviderError(error)) throw error;
      throw createAINetworkError('DeepSeek', error, 'deepseek-chat');
    }
  }

  async chat(prompt: string, context?: Record<string, unknown>): Promise<string> {
    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: [
            {
              role: 'system',
              content: 'Bạn là đầu bếp AI thông minh của ứng dụng Frigo Việt Nam. Luôn trả lời ngắn gọn, thân thiện, súc tích.'
            },
            {
              role: 'user',
              content: context ? `${JSON.stringify(context)}\n\n${prompt}` : prompt
            }
          ]
        })
      });
      if (!res.ok) throw createAIHttpError('DeepSeek', res.status, await res.text(), 'deepseek-chat');
      let data: { choices?: Array<{ message?: { content?: unknown } }> };
      try {
        data = await res.json() as typeof data;
      } catch (error) {
        throw createAIResponseError('DeepSeek', 'DeepSeek returned an invalid JSON envelope', 'deepseek-chat', error);
      }
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) {
        throw createAIResponseError('DeepSeek', 'DeepSeek returned an empty chat response', 'deepseek-chat');
      }
      return content.trim();
    } catch (error) {
      if (isAIProviderError(error)) throw error;
      throw createAINetworkError('DeepSeek', error, 'deepseek-chat');
    }
  }
}
