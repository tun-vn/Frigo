import { z } from 'zod';

export const StandardUnitSchema = z.enum([
  'g',
  'kg',
  'ml',
  'l',
  'piece',
  'pack',
  'bunch',
  'slice'
]);

export const DetectedIngredientSchema = z.object({
  raw_name: z.string().min(1, 'Tên nguyên liệu không được để trống'),
  estimated_quantity: z.number().positive('Số lượng phải lớn hơn 0'),
  unit: StandardUnitSchema,
  confidence: z.number().min(0).max(1),
  canonical_id: z.string().optional(),
  category: z.string().optional(),
  storage: z.enum(['fridge', 'freezer', 'pantry']).optional().default('fridge'),
});

export const VisionScanResultSchema = z.object({
  items: z.array(DetectedIngredientSchema),
});

export const ReceiptItemSchema = z.object({
  raw_name: z.string().min(1, 'Tên sản phẩm không được để trống'),
  estimated_quantity: z.number().positive('Số lượng phải lớn hơn 0'),
  unit: StandardUnitSchema,
  unit_price_vnd: z.number().nonnegative().optional(),
  total_price_vnd: z.number().nonnegative().optional(),
  canonical_id: z.string().optional(),
  category: z.string().optional(),
  storage: z.enum(['fridge', 'freezer', 'pantry']).optional().default('fridge'),
  confidence: z.number().min(0).max(1).default(0.9),
});

export const ReceiptScanResultSchema = z.object({
  merchant_name: z.string().default('Siêu thị'),
  invoice_number: z.string().optional(),
  purchase_date: z.string().optional(),
  total_amount_vnd: z.number().nonnegative().optional(),
  items: z.array(ReceiptItemSchema),
});

export type DetectedIngredient = z.infer<typeof DetectedIngredientSchema>;
export type VisionScanResult = z.infer<typeof VisionScanResultSchema>;
export type ReceiptItem = z.infer<typeof ReceiptItemSchema>;
export type ReceiptScanResult = z.infer<typeof ReceiptScanResultSchema>;

export interface AIUsageLog {
  userId?: string;
  task: 'fridge_scan' | 'receipt_scan' | 'ingredient_normalization' | 'recipe_rank' | 'chat'
    | 'recipe_generation' | 'recipe_ranking' | 'recipe_explanation' | 'fridge_chat' | 'receipt_ocr' | 'label_ocr'
    | 'fridge_image_analysis' | 'weekly_plan' | 'weekly_plan_repair' | 'weekly_plan_complex'
    | 'inventory_candidate_extraction' | 'offline_evaluation';
  provider: string;
  model: string;
  logicalModel?: string;
  physicalModel?: string;
  promptId?: string;
  promptVersion?: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  latencyMs: number;
  estimatedCostUsd?: number;
  pricingVersion?: string;
  estimatedCost: number;
  attempt?: number;
  escalationReason?: string;
  failureCode?: string;
  status: 'success' | 'error' | 'fallback';
  createdAt: string;
}
