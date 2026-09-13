import {
  ReceiptScanResult,
  ReceiptScanResultSchema,
  VisionScanResult,
  VisionScanResultSchema,
} from './schemas';
import { AIProviderError } from './errors';

/** Provider output below this threshold is not safe to create a scan draft. */
export const AI_SCAN_MIN_CONFIDENCE = 0.6;
export const AI_SCAN_NO_USABLE_ITEMS = 'AI_SCAN_NO_USABLE_ITEMS';

const GENERIC_LABELS = new Set([
  'fridge',
  'refrigerator',
  'tu lanh',
  'freezer',
  'tu dong',
  'unknown',
  'unknown item',
  'unknown product',
  'item',
  'food',
  'food item',
  'product',
  'ingredient',
  'san pham',
  'nguyen lieu',
  'thuc pham',
  'mat hang',
  'hang hoa',
  'ten san pham',
  'ten nguyen lieu',
  'ten thuc pham',
  'ten cua hang',
  'ten sieu thi',
  'n a',
  'none',
  'null',
  'nil',
  'undefined',
  'khong ro',
  'khong xac dinh',
  'khong chac',
  'no item',
  'no product',
  'not sure',
  'not identified',
  'unrecognized',
]);

const GENERIC_LABEL_PATTERN = /^(?:item|food|product|ingredient|unknown|fridge|refrigerator|freezer|tu lanh|tu dong|san pham|nguyen lieu|thuc pham)(?:\s+\d+)?$|^ten (?:san pham|nguyen lieu|thuc pham|cua hang|sieu thi)(?:\s|$)/;

function normalizeLabel(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Returns true for empty, placeholder, or model-template labels. */
export function isGenericScanLabel(value: string): boolean {
  const normalized = normalizeLabel(value);
  return normalized.length === 0 || GENERIC_LABELS.has(normalized) || GENERIC_LABEL_PATTERN.test(normalized);
}

export class AIScanQualityError extends AIProviderError {
  readonly scanType: 'vision' | 'receipt';

  constructor(scanType: 'vision' | 'receipt', totalItems: number) {
    super(
      `${AI_SCAN_NO_USABLE_ITEMS}: Không có mục ${scanType === 'receipt' ? 'hóa đơn' : 'thực phẩm'} đủ tin cậy ` +
        `(${totalItems} mục bị loại; ngưỡng confidence ${AI_SCAN_MIN_CONFIDENCE}).`,
      {
        code: AI_SCAN_NO_USABLE_ITEMS,
        retryable: false,
        provider: 'quality-gate',
      },
    );
    this.name = 'AIScanQualityError';
    this.scanType = scanType;
  }
}

function usable<T extends { raw_name: string; confidence: number }>(item: T): boolean {
  return !isGenericScanLabel(item.raw_name) && Number.isFinite(item.confidence) && item.confidence >= AI_SCAN_MIN_CONFIDENCE;
}

/** Validate and remove unusable vision items before they reach persistence. */
export function applyVisionScanQualityGate(result: unknown): VisionScanResult {
  const validated = VisionScanResultSchema.parse(result);
  const items = validated.items
    .filter(usable)
    .map((item) => ({ ...item, raw_name: item.raw_name.trim() }));
  if (items.length === 0) throw new AIScanQualityError('vision', validated.items.length);
  return { items };
}

/** Validate and remove unusable receipt lines before they reach persistence. */
export function applyReceiptScanQualityGate(result: unknown): ReceiptScanResult {
  const validated = ReceiptScanResultSchema.parse(result);
  const items = validated.items
    .filter(usable)
    .map((item) => ({ ...item, raw_name: item.raw_name.trim() }));
  if (items.length === 0) throw new AIScanQualityError('receipt', validated.items.length);
  return { ...validated, items };
}
