import type { AITask } from './model-governance';

export interface PromptDefinition {
  id: string;
  version: string;
  task: AITask;
  system: string;
  structured: boolean;
}

const STATIC_RULES = 'Frigo AI chỉ tạo quan sát/dự đoán chưa được xác nhận. Không tự ghi inventory, không bịa số lượng, giá, hạn dùng, dinh dưỡng hoặc an toàn dị ứng.';

export const PROMPT_REGISTRY: Record<AITask, PromptDefinition> = {
  ingredient_normalization: {
    id: 'ingredient-normalization',
    version: '1',
    task: 'ingredient_normalization',
    structured: true,
    system: `${STATIC_RULES} Chuẩn hóa tên nguyên liệu vào danh mục đã cung cấp. `
      + 'Trả về JSON {"canonicalId": string|null, "confidence": number}; canonicalId phải đúng một ID trong danh mục hoặc null.',
  },
  recipe_generation: { id: 'recipe-generation', version: '1', task: 'recipe_generation', structured: true, system: `${STATIC_RULES} Đề xuất công thức có cấu trúc; không thực hiện phép tính tồn kho.` },
  recipe_ranking: { id: 'recipe-ranking', version: '1', task: 'recipe_ranking', structured: true, system: `${STATIC_RULES} Xếp hạng đúng các món được cung cấp; không thêm món mới.` },
  recipe_explanation: { id: 'recipe-explanation', version: '1', task: 'recipe_explanation', structured: true, system: `${STATIC_RULES} Chỉ sắp xếp các mã lý do được cung cấp; không thêm sự kiện mới.` },
  fridge_chat: { id: 'fridge-chat', version: '1', task: 'fridge_chat', structured: false, system: `${STATIC_RULES} Trả lời ngắn gọn, thân thiện và nêu rõ điều chưa biết.` },
  receipt_ocr: { id: 'receipt-ocr', version: '1', task: 'receipt_ocr', structured: true, system: `${STATIC_RULES} Bóc tách chữ và dòng hàng thô từ hóa đơn; giữ nguyên tên nhìn thấy.` },
  label_ocr: { id: 'label-ocr', version: '1', task: 'label_ocr', structured: true, system: `${STATIC_RULES} Trích xuất chữ in trên nhãn, không suy diễn thông tin không nhìn thấy.` },
  fridge_image_analysis: { id: 'fridge-image-analysis', version: '1', task: 'fridge_image_analysis', structured: true, system: `${STATIC_RULES} Nhận diện ứng viên thực phẩm trong ảnh; số lượng chỉ là ước tính có confidence.` },
  weekly_plan: { id: 'weekly-plan', version: '1', task: 'weekly_plan', structured: true, system: `${STATIC_RULES} Lập candidate plan từ context rút gọn; validator quyết định feasibility.` },
  weekly_plan_repair: { id: 'weekly-plan-repair', version: '1', task: 'weekly_plan_repair', structured: true, system: `${STATIC_RULES} Sửa candidate plan chỉ theo các lỗi validation được cung cấp.` },
  weekly_plan_complex: { id: 'weekly-plan-complex', version: '1', task: 'weekly_plan_complex', structured: true, system: `${STATIC_RULES} Xử lý xung đột planner khó; không thay thế deterministic validator.` },
  inventory_candidate_extraction: { id: 'inventory-candidate-extraction', version: '1', task: 'inventory_candidate_extraction', structured: true, system: `${STATIC_RULES} Tạo InventoryCandidate; kết quả phải qua normalization/reconciliation trước mutation.` },
  offline_evaluation: { id: 'offline-evaluation', version: '1', task: 'offline_evaluation', structured: true, system: 'Đánh giá output theo golden rubric. Không được sử dụng trong customer-facing routing.' },
};

export function getPromptDefinition(task: AITask): PromptDefinition {
  return PROMPT_REGISTRY[task];
}

export function buildPrompt(task: AITask, input: string, context?: string): string {
  const definition = getPromptDefinition(task);
  const contextBlock = context ? `\nDYNAMIC CONTEXT\n${context}` : '';
  return `${definition.system}\n\nSTATIC OUTPUT CONTRACT\nReturn only the requested ${definition.structured ? 'JSON' : 'text'} value.\n${contextBlock}\nDYNAMIC INPUT\n${input}`;
}
