export type StandardUnit = 'g' | 'kg' | 'ml' | 'l' | 'piece' | 'pack' | 'bunch' | 'slice';

export type IngredientCategory =
  | 'meat'
  | 'vegetable'
  | 'egg'
  | 'dairy'
  | 'spice'
  | 'seafood'
  | 'grain'
  | 'fruit'
  | 'other';

export type FreshnessStatus = 'fresh' | 'use_soon' | 'expiring' | 'out_of_stock';

export type InventoryEventType =
  | 'ADD'
  | 'MANUAL_UPDATE'
  | 'SCAN_CONFIRM'
  | 'SCAN_CORRECTION'
  | 'COOK'
  | 'DISCARD'
  | 'SHOPPING_IMPORT';

export interface CanonicalIngredient {
  id: string; // e.g. 'PORK_BELLY'
  nameVi: string; // 'Thịt ba chỉ'
  nameEn: string; // 'Pork belly'
  aliases: string[]; // ['ba chỉ', 'ba rọi', 'thịt ba rọi', 'thịt heo ba chỉ']
  category: IngredientCategory;
  defaultUnit: StandardUnit;
  defaultShelfLifeDays: number;
  icon?: string;
}

export interface InventoryItem {
  id: string;
  householdId: string;
  ingredientId: string; // Canonical ID
  name: string;
  quantity: number;
  unit: StandardUnit;
  category: IngredientCategory;
  storage: 'fridge' | 'freezer' | 'pantry';
  expiryDate?: string; // ISO date string YYYY-MM-DD
  addedDate: string; // ISO date string
  freshness: FreshnessStatus;
  dataSource?: 'scan' | 'manual' | 'shopping';
  /** Monotonic server-side revision used to reject concurrent lost updates. */
  version?: number;
  updatedAt: string;
}

export interface InventoryEvent {
  id: string;
  inventoryItemId: string;
  householdId: string;
  eventType: InventoryEventType;
  quantityDelta: number;
  unit: StandardUnit;
  reason?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

// Canonical Ingredients Catalog
export const CANONICAL_INGREDIENTS: CanonicalIngredient[] = [
  // MEAT & POULTRY
  {
    id: 'PORK_BELLY',
    nameVi: 'Thịt ba chỉ',
    nameEn: 'Pork belly',
    aliases: ['ba chỉ', 'ba rọi', 'thịt ba rọi', 'thịt ba chỉ heo', 'pork belly'],
    category: 'meat',
    defaultUnit: 'g',
    defaultShelfLifeDays: 4,
    icon: '🥓',
  },
  {
    id: 'GROUND_PORK',
    nameVi: 'Thịt heo xay',
    nameEn: 'Ground pork',
    aliases: ['thịt băm', 'thịt xay', 'thịt lợn xay', 'thịt bằm'],
    category: 'meat',
    defaultUnit: 'g',
    defaultShelfLifeDays: 3,
    icon: '🥩',
  },
  {
    id: 'BEEF_SIRLOIN',
    nameVi: 'Thịt bò',
    nameEn: 'Beef sirloin',
    aliases: ['thịt bò', 'bò phi lê', 'thịt thăn bò', 'bắp bò'],
    category: 'meat',
    defaultUnit: 'g',
    defaultShelfLifeDays: 4,
    icon: '🥩',
  },
  {
    id: 'CHICKEN_BREAST',
    nameVi: 'Ức gà',
    nameEn: 'Chicken breast',
    aliases: ['ức gà', 'thịt ức gà', 'gà phi lê'],
    category: 'meat',
    defaultUnit: 'g',
    defaultShelfLifeDays: 3,
    icon: '🍗',
  },
  {
    id: 'CHICKEN_THIGH',
    nameVi: 'Đùi gà',
    nameEn: 'Chicken thigh',
    aliases: ['đùi gà', 'má đùi gà', 'thịt đùi gà'],
    category: 'meat',
    defaultUnit: 'g',
    defaultShelfLifeDays: 3,
    icon: '🍗',
  },
  // SEAFOOD
  {
    id: 'SHRIMP',
    nameVi: 'Tôm tươi',
    nameEn: 'Fresh shrimp',
    aliases: ['tôm', 'tôm sú', 'tôm thẻ', 'tôm lột'],
    category: 'seafood',
    defaultUnit: 'g',
    defaultShelfLifeDays: 2,
    icon: '🦐',
  },
  {
    id: 'SALMON_FILLET',
    nameVi: 'Cá hồi',
    nameEn: 'Salmon fillet',
    aliases: ['cá hồi', 'phi lê cá hồi'],
    category: 'seafood',
    defaultUnit: 'g',
    defaultShelfLifeDays: 2,
    icon: '🐟',
  },
  // EGGS & DAIRY
  {
    id: 'CHICKEN_EGG',
    nameVi: 'Trứng gà',
    nameEn: 'Chicken egg',
    aliases: ['trứng', 'trứng gà', 'trứng gà ta', 'trứng vịt', 'egg'],
    category: 'egg',
    defaultUnit: 'piece',
    defaultShelfLifeDays: 14,
    icon: '🥚',
  },
  {
    id: 'FRESH_MILK',
    nameVi: 'Sữa tươi',
    nameEn: 'Fresh milk',
    aliases: ['sữa', 'sữa tươi', 'sữa không đường', 'sữa có đường'],
    category: 'dairy',
    defaultUnit: 'ml',
    defaultShelfLifeDays: 7,
    icon: '🥛',
  },
  {
    id: 'CHEDDAR_CHEESE',
    nameVi: 'Phô mai',
    nameEn: 'Cheese',
    aliases: ['phô mai', 'pho mát', 'cheddar', 'mozzarella'],
    category: 'dairy',
    defaultUnit: 'g',
    defaultShelfLifeDays: 21,
    icon: '🧀',
  },
  {
    id: 'BUTTER',
    nameVi: 'Bơ thực vật/động vật',
    nameEn: 'Butter',
    aliases: ['bơ', 'bơ lạt', 'bơ phe', 'butter'],
    category: 'dairy',
    defaultUnit: 'g',
    defaultShelfLifeDays: 30,
    icon: '🧈',
  },
  // VEGETABLES
  {
    id: 'TOMATO',
    nameVi: 'Cà chua',
    nameEn: 'Tomato',
    aliases: ['cà chua', 'cà chua bi', 'tomato'],
    category: 'vegetable',
    defaultUnit: 'piece',
    defaultShelfLifeDays: 7,
    icon: '🍅',
  },
  {
    id: 'WATER_SPINACH',
    nameVi: 'Rau muống',
    nameEn: 'Water spinach',
    aliases: ['rau muống', 'muống nước', 'rau muống đồng'],
    category: 'vegetable',
    defaultUnit: 'bunch',
    defaultShelfLifeDays: 4,
    icon: '🥬',
  },
  {
    id: 'SPINACH',
    nameVi: 'Rau chân vịt',
    nameEn: 'Spinach',
    aliases: ['rau bina', 'cải bó xôi', 'rau chân vịt'],
    category: 'vegetable',
    defaultUnit: 'g',
    defaultShelfLifeDays: 4,
    icon: '🥬',
  },
  {
    id: 'TOFU',
    nameVi: 'Đậu phụ',
    nameEn: 'Tofu',
    aliases: ['đậu phụ', 'đậu hũ', 'tàu hũ', 'tofu'],
    category: 'vegetable',
    defaultUnit: 'piece',
    defaultShelfLifeDays: 4,
    icon: '🧊',
  },
  {
    id: 'BROCCOLI',
    nameVi: 'Bông cải xanh',
    nameEn: 'Broccoli',
    aliases: ['súp lơ', 'súp lơ xanh', 'bông cải xanh', 'broccoli'],
    category: 'vegetable',
    defaultUnit: 'piece',
    defaultShelfLifeDays: 6,
    icon: '🥦',
  },
  {
    id: 'CARROT',
    nameVi: 'Cà rốt',
    nameEn: 'Carrot',
    aliases: ['cà rốt', 'carrot'],
    category: 'vegetable',
    defaultUnit: 'piece',
    defaultShelfLifeDays: 14,
    icon: '🥕',
  },
  {
    id: 'ONION',
    nameVi: 'Hành tây',
    nameEn: 'Onion',
    aliases: ['hành tây', 'củ hành tây'],
    category: 'vegetable',
    defaultUnit: 'piece',
    defaultShelfLifeDays: 20,
    icon: '🧅',
  },
  {
    id: 'GARLIC',
    nameVi: 'Tỏi',
    nameEn: 'Garlic',
    aliases: ['tỏi', 'tỏi cô đơn', 'tỏi ta', 'củ tỏi'],
    category: 'spice',
    defaultUnit: 'piece',
    defaultShelfLifeDays: 30,
    icon: '🧄',
  },
  {
    id: 'GINGER',
    nameVi: 'Gừng',
    nameEn: 'Ginger',
    aliases: ['gừng', 'củ gừng'],
    category: 'spice',
    defaultUnit: 'g',
    defaultShelfLifeDays: 20,
    icon: '🫚',
  },
  {
    id: 'SCALLION',
    nameVi: 'Hành lá',
    nameEn: 'Green onion',
    aliases: ['hành lá', 'hành hoa', 'scallion'],
    category: 'vegetable',
    defaultUnit: 'bunch',
    defaultShelfLifeDays: 5,
    icon: '🌱',
  },
  {
    id: 'CHILI',
    nameVi: 'Ớt',
    nameEn: 'Chili',
    aliases: ['ớt', 'ớt hiểm', 'ớt sừng', 'ớt đỏ'],
    category: 'spice',
    defaultUnit: 'piece',
    defaultShelfLifeDays: 14,
    icon: '🌶️',
  },
  {
    id: 'CUCUMBER',
    nameVi: 'Dưa leo',
    nameEn: 'Cucumber',
    aliases: ['dưa chuột', 'dưa leo'],
    category: 'vegetable',
    defaultUnit: 'piece',
    defaultShelfLifeDays: 7,
    icon: '🥒',
  },
  {
    id: 'CABBAGE',
    nameVi: 'Bắp cải',
    nameEn: 'Cabbage',
    aliases: ['bắp cải', 'cải bắp'],
    category: 'vegetable',
    defaultUnit: 'piece',
    defaultShelfLifeDays: 12,
    icon: '🥬',
  },
  {
    id: 'KIMCHI',
    nameVi: 'Kim chi',
    nameEn: 'Kimchi',
    aliases: ['kimchi', 'kim chi hàn quốc'],
    category: 'vegetable',
    defaultUnit: 'g',
    defaultShelfLifeDays: 45,
    icon: '🥬',
  },
  {
    id: 'MUSHROOM',
    nameVi: 'Nấm đùi gà / nấm hương',
    nameEn: 'Mushroom',
    aliases: ['nấm', 'nấm hương', 'nấm kim châm', 'nấm đùi gà', 'nấm rơm'],
    category: 'vegetable',
    defaultUnit: 'g',
    defaultShelfLifeDays: 5,
    icon: '🍄',
  },
  {
    id: 'RICE',
    nameVi: 'Gạo / Cơm nguội',
    nameEn: 'Rice',
    aliases: ['gạo', 'cơm', 'cơm nguội', 'gạo thơm'],
    category: 'grain',
    defaultUnit: 'g',
    defaultShelfLifeDays: 90,
    icon: '🍚',
  },
  {
    id: 'SPAGHETTI_PASTA',
    nameVi: 'Mì Ý / Pasta',
    nameEn: 'Pasta',
    aliases: ['mì ý', 'spaghetti', 'pasta', 'mì sợi'],
    category: 'grain',
    defaultUnit: 'g',
    defaultShelfLifeDays: 180,
    icon: '🍝',
  },
  {
    id: 'NOODLE',
    nameVi: 'Bún / Mì sợi',
    nameEn: 'Noodles',
    aliases: ['bún', 'mì', 'phở', 'hủ tiếu', 'bún tươi'],
    category: 'grain',
    defaultUnit: 'g',
    defaultShelfLifeDays: 2,
    icon: '🍜',
  },
  {
    id: 'FISH_SAUCE',
    nameVi: 'Nước mắm',
    nameEn: 'Fish sauce',
    aliases: ['nước mắm', 'mắm nam ngư', 'mắm'],
    category: 'spice',
    defaultUnit: 'ml',
    defaultShelfLifeDays: 365,
    icon: '🥫',
  },
  {
    id: 'SOY_SAUCE',
    nameVi: 'Xì dầu / Nước tương',
    nameEn: 'Soy sauce',
    aliases: ['xì dầu', 'nước tương', 'tương đậu nành'],
    category: 'spice',
    defaultUnit: 'ml',
    defaultShelfLifeDays: 365,
    icon: '🍶',
  },
  {
    id: 'COOKING_OIL',
    nameVi: 'Dầu ăn',
    nameEn: 'Cooking oil',
    aliases: ['dầu ăn', 'dầu mè', 'dầu olive', 'dầu thực vật'],
    category: 'spice',
    defaultUnit: 'ml',
    defaultShelfLifeDays: 365,
    icon: '🫗',
  },
  {
    id: 'PORK_RIBS',
    nameVi: 'Sườn heo / Sườn non',
    nameEn: 'Pork ribs',
    aliases: ['sườn', 'sườn heo', 'sườn non', 'sườn sụn'],
    category: 'meat',
    defaultUnit: 'g',
    defaultShelfLifeDays: 3,
    icon: '🍖',
  },
  {
    id: 'CRAB_MEAT',
    nameVi: 'Cua đồng / Cua thịt',
    nameEn: 'Crab meat / Field crab',
    aliases: ['cua đồng', 'cua', 'riêu cua', 'thịt cua'],
    category: 'seafood',
    defaultUnit: 'g',
    defaultShelfLifeDays: 2,
    icon: '🦀',
  },
  {
    id: 'SQUID',
    nameVi: 'Mực tươi',
    nameEn: 'Squid',
    aliases: ['mực', 'mực ống', 'mực lá', 'mực tươi'],
    category: 'seafood',
    defaultUnit: 'g',
    defaultShelfLifeDays: 2,
    icon: '🦑',
  },
  {
    id: 'FISH_FRESHWATER',
    nameVi: 'Cá tươi (Cá lóc, cá điêu hồng, rô phi)',
    nameEn: 'Freshwater fish',
    aliases: ['cá lóc', 'cá quả', 'cá điêu hồng', 'cá rô', 'cá tươi', 'cá trắm'],
    category: 'seafood',
    defaultUnit: 'g',
    defaultShelfLifeDays: 2,
    icon: '🐟',
  },
  {
    id: 'BITTER_MELON',
    nameVi: 'Khổ qua / Mướp đắng',
    nameEn: 'Bitter melon',
    aliases: ['khổ qua', 'mướp đắng'],
    category: 'vegetable',
    defaultUnit: 'piece',
    defaultShelfLifeDays: 5,
    icon: '🥒',
  },
  {
    id: 'WINTER_MELON',
    nameVi: 'Bí đao',
    nameEn: 'Winter melon',
    aliases: ['bí đao', 'bí xanh'],
    category: 'vegetable',
    defaultUnit: 'piece',
    defaultShelfLifeDays: 10,
    icon: '🍈',
  },
  {
    id: 'PUMPKIN',
    nameVi: 'Bí đỏ',
    nameEn: 'Pumpkin',
    aliases: ['bí đỏ', 'bí ngô'],
    category: 'vegetable',
    defaultUnit: 'piece',
    defaultShelfLifeDays: 20,
    icon: '🎃',
  },
  {
    id: 'PINEAPPLE',
    nameVi: 'Dứa / Thơm',
    nameEn: 'Pineapple',
    aliases: ['dứa', 'thơm', 'khóm'],
    category: 'fruit',
    defaultUnit: 'piece',
    defaultShelfLifeDays: 7,
    icon: '🍍',
  },
  {
    id: 'BEAN_SPROUTS',
    nameVi: 'Giá đỗ',
    nameEn: 'Bean sprouts',
    aliases: ['giá đỗ', 'giá sống'],
    category: 'vegetable',
    defaultUnit: 'g',
    defaultShelfLifeDays: 3,
    icon: '🌱',
  },
  {
    id: 'CHAYOTE',
    nameVi: 'Su su',
    nameEn: 'Chayote',
    aliases: ['su su', 'quả su su'],
    category: 'vegetable',
    defaultUnit: 'piece',
    defaultShelfLifeDays: 10,
    icon: '🍐',
  },
  {
    id: 'LEMONGRASS',
    nameVi: 'Sả tươi',
    nameEn: 'Lemongrass',
    aliases: ['sả', 'củ sả', 'cây sả'],
    category: 'spice',
    defaultUnit: 'piece',
    defaultShelfLifeDays: 14,
    icon: '🌾',
  },
  {
    id: 'LIME',
    nameVi: 'Chanh tươi',
    nameEn: 'Lime',
    aliases: ['chanh', 'quả chanh', 'nước cốt chanh'],
    category: 'fruit',
    defaultUnit: 'piece',
    defaultShelfLifeDays: 14,
    icon: '🍋',
  },
  {
    id: 'RICE_PAPER',
    nameVi: 'Bánh tráng cuốn',
    nameEn: 'Rice paper',
    aliases: ['bánh tráng', 'bánh đa nem', 'ram'],
    category: 'grain',
    defaultUnit: 'pack',
    defaultShelfLifeDays: 180,
    icon: '🫓',
  }
];

// Helper to find canonical ingredient by raw text or alias
export function findCanonicalIngredient(input: string): CanonicalIngredient | null {
  if (!input) return null;
  const clean = input.toLowerCase().trim();
  
  // Exact match on ID
  const byId = CANONICAL_INGREDIENTS.find(i => i.id.toLowerCase() === clean);
  if (byId) return byId;

  // Exact match on Vietnamese or English name
  const byName = CANONICAL_INGREDIENTS.find(
    i => i.nameVi.toLowerCase() === clean || i.nameEn.toLowerCase() === clean
  );
  if (byName) return byName;

  // Match alias
  const byAlias = CANONICAL_INGREDIENTS.find(
    i => i.aliases.some(alias => alias.toLowerCase() === clean || clean.includes(alias.toLowerCase()))
  );
  if (byAlias) return byAlias;

  return null;
}

/** Resolve a catalog ID without applying the fuzzy name/alias matching above. */
export function findCanonicalIngredientById(input: unknown): CanonicalIngredient | null {
  if (typeof input !== 'string') return null;
  const clean = input.trim().toLowerCase();
  if (!clean) return null;
  return CANONICAL_INGREDIENTS.find((ingredient) => ingredient.id.toLowerCase() === clean) || null;
}

export * from './units';
export * from './availability';
export * from './quantity';

// Calculate freshness status given expiry date or added date
export function computeFreshness(expiryDate?: string, addedDate?: string, shelfLifeDays = 7): FreshnessStatus {
  const now = new Date();
  let targetExpiry: Date;

  if (expiryDate) {
    targetExpiry = new Date(expiryDate);
  } else if (addedDate) {
    targetExpiry = new Date(new Date(addedDate).getTime() + shelfLifeDays * 24 * 60 * 60 * 1000);
  } else {
    return 'fresh';
  }

  const diffHours = (targetExpiry.getTime() - now.getTime()) / (1000 * 60 * 60);

  if (diffHours <= 0) return 'expiring';
  if (diffHours <= 24) return 'expiring';
  if (diffHours <= 72) return 'use_soon'; // <= 3 days
  return 'fresh';
}

// Export Frigo Week domain modules
export * from './week';
export * from './foundation';
export * from './meal-planning-api';
export * from './meal-shopping-api';
