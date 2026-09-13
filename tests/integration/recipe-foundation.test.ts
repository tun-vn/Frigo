import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addIngredientAlias,
  createIngredientDefinition,
  resolveIngredientAlias,
} from '../../packages/db/src/catalog';
import { UNIT_DEFINITIONS } from '../../packages/domain/src/foundation';
import { SqliteD1 } from '../helpers/sqlite-d1';

const migrationDirectory = path.resolve(process.cwd(), 'migrations');
const foundationMigration = readFileSync(
  path.join(migrationDirectory, '0019_recipe_domain_foundation.sql'),
  'utf8',
);

function migrateThrough0018(db: SqliteD1): void {
  for (const file of readdirSync(migrationDirectory)
    .filter((name) => /^00(?:0[1-9]|1[0-8]).*\.sql$/.test(name))
    .sort()) {
    db.seed(readFileSync(path.join(migrationDirectory, file), 'utf8'));
  }
}

function ingredientInput(id: string, aliases: Array<{ language: string; alias: string }> = []) {
  return {
    id,
    defaultName: `Chicken breast ${id}`,
    names: [
      { language: 'vi', name: `Ức gà ${id}` },
      { language: 'en', name: `Chicken breast ${id}` },
      { language: 'ja', name: `鶏むね肉 ${id}` },
    ],
    aliases,
    category: 'meat',
    defaultUnit: 'g',
    defaultShelfLifeDays: 3,
  };
}

describe('recipe domain foundation migration and catalog', () => {
  const databases: SqliteD1[] = [];
  const database = () => {
    const db = new SqliteD1();
    databases.push(db);
    return db;
  };

  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
  });

  it('replays the full migration chain and keeps TypeScript unit definitions synchronized with SQLite', () => {
    const db = database();
    expect(db.migrations.at(-1)).toBe('0023_scan_request_fingerprint.sql');
    expect(db.query('PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    expect(db.query('PRAGMA foreign_key_check')).toEqual([]);

    const units = db.query<{
      code: keyof typeof UNIT_DEFINITIONS;
      dimension: string;
      base_unit: string;
      factor_to_base: number;
    }>('SELECT code, dimension, base_unit, factor_to_base FROM measurement_units ORDER BY code');
    expect(units).toHaveLength(Object.keys(UNIT_DEFINITIONS).length);
    for (const unit of units) {
      expect(unit).toMatchObject({
        dimension: UNIT_DEFINITIONS[unit.code].dimension,
        base_unit: UNIT_DEFINITIONS[unit.code].baseUnit,
        factor_to_base: UNIT_DEFINITIONS[unit.code].factorToBase,
      });
    }
    expect(() =>
      db.seed(
        "INSERT INTO measurement_units (code, dimension, base_unit, factor_to_base) VALUES ('unsafe_pack_g', 'contextual', 'g', 1)",
      ),
    ).toThrow();
    expect(() =>
      db.seed("INSERT INTO measurement_units VALUES ('bad_mass', 'mass', 'ml', 1)"),
    ).toThrow();
    expect(() =>
      db.seed(
        "UPDATE measurement_units SET dimension = 'mass', base_unit = 'g' WHERE code = 'piece'",
      ),
    ).toThrow();
    expect(() =>
      db.seed("UPDATE measurement_units SET factor_to_base = 100 WHERE code = 'kg'"),
    ).toThrow();
  });

  it('resolves Vietnamese, English, and Japanese names to one canonical ingredient without fuzzy stripping', async () => {
    const db = database();
    await createIngredientDefinition(
      db,
      ingredientInput('CATALOG_CHICKEN', [
        { language: 'vi', alias: 'Ức gà' },
        { language: 'en', alias: 'Chicken breast' },
        { language: 'ja', alias: '鶏むね肉' },
        { language: 'vi', alias: 'Thịt ức gà' },
        { language: 'en', alias: 'Chicken breast fillet' },
      ]),
    );

    await expect(resolveIngredientAlias(db, '  ỨC   GÀ ', 'VI')).resolves.toEqual({
      status: 'matched',
      ingredientId: 'CATALOG_CHICKEN',
    });
    await expect(
      resolveIngredientAlias(db, 'Ｃｈｉｃｋｅｎ\u00a0ＢＲＥＡＳＴ', 'en'),
    ).resolves.toEqual({ status: 'matched', ingredientId: 'CATALOG_CHICKEN' });
    await expect(resolveIngredientAlias(db, '鶏むね肉', 'ja')).resolves.toEqual({
      status: 'matched',
      ingredientId: 'CATALOG_CHICKEN',
    });
    await expect(resolveIngredientAlias(db, '鶏むね肉 500g', 'ja')).resolves.toEqual({
      status: 'unmapped',
    });
    await expect(resolveIngredientAlias(db, 'chicken', 'en')).resolves.toEqual({
      status: 'unmapped',
    });
    await expect(resolveIngredientAlias(db, 'chicken breast', 'not_a_locale')).rejects.toThrow(
      'Invalid language tag',
    );
  });

  it('bridges canonical default names into legacy Vietnamese/English columns and writes catalog definitions atomically', async () => {
    const db = database();
    await createIngredientDefinition(db, {
      ...ingredientInput('CATALOG_DEFAULT_BRIDGE'),
      defaultName: 'Fallback chicken',
      names: [],
      aliases: [{ language: 'en', alias: 'Shared chicken alias' }],
    });
    expect(
      db.query(
        'SELECT name_vi, name_en, default_name FROM ingredients WHERE id = ?',
        'CATALOG_DEFAULT_BRIDGE',
      ),
    ).toEqual([
      {
        name_vi: 'Fallback chicken',
        name_en: 'Fallback chicken',
        default_name: 'Fallback chicken',
      },
    ]);

    await expect(
      createIngredientDefinition(db, {
        ...ingredientInput('CATALOG_ROLLBACK'),
        aliases: [{ language: 'en', alias: 'Shared chicken alias' }],
      }),
    ).rejects.toThrow();
    expect(db.query('SELECT id FROM ingredients WHERE id = ?', 'CATALOG_ROLLBACK')).toEqual([]);
    expect(
      db.query(
        'SELECT ingredient_id FROM ingredient_aliases WHERE ingredient_id = ?',
        'CATALOG_ROLLBACK',
      ),
    ).toEqual([]);
  });

  it('enforces alias uniqueness per locale, permits different locales, and reports unmapped or ambiguous aliases explicitly', async () => {
    const db = database();
    await createIngredientDefinition(
      db,
      ingredientInput('CATALOG_FIRST', [{ language: 'vi', alias: 'gà nhà' }]),
    );
    await createIngredientDefinition(
      db,
      ingredientInput('CATALOG_SECOND', [{ language: 'en', alias: 'gà nhà' }]),
    );
    await expect(
      addIngredientAlias(db, 'CATALOG_SECOND', { language: 'vi', alias: '  GÀ   NHÀ ' }),
    ).rejects.toThrow();
    await expect(resolveIngredientAlias(db, 'gà nhà', 'vi')).resolves.toEqual({
      status: 'matched',
      ingredientId: 'CATALOG_FIRST',
    });
    await expect(resolveIngredientAlias(db, 'gà nhà', 'en')).resolves.toEqual({
      status: 'matched',
      ingredientId: 'CATALOG_SECOND',
    });

    await createIngredientDefinition(
      db,
      ingredientInput('CATALOG_UND', [{ language: 'und', alias: 'shared poultry' }]),
    );
    await createIngredientDefinition(
      db,
      ingredientInput('CATALOG_VI', [{ language: 'vi', alias: 'shared poultry' }]),
    );
    await expect(resolveIngredientAlias(db, 'shared poultry', 'vi')).resolves.toEqual({
      status: 'ambiguous',
      ingredientIds: ['CATALOG_UND', 'CATALOG_VI'],
    });
    await expect(resolveIngredientAlias(db, 'unknown food', 'vi')).resolves.toEqual({
      status: 'unmapped',
    });
    expect(() =>
      db.seed(
        "INSERT INTO ingredient_aliases (id, ingredient_id, alias, language, normalized_alias) VALUES ('missing_fk', 'does_not_exist', 'missing', 'en', 'missing')",
      ),
    ).toThrow();
  });

  it('persists nutrition provenance and rejects missing, negative, or non-finite nutrient data', () => {
    const db = database();
    db.seed(`INSERT INTO nutrition_profiles
      (id, basis_quantity, basis_unit, source_type, source_reference, sodium_mg)
      VALUES ('nutrition_known_zero', 100, 'g', 'authoritative', 'USDA FDC 123', 0);`);
    expect(
      db.query(
        'SELECT source_type, source_reference, sodium_mg FROM nutrition_profiles WHERE id = ?',
        'nutrition_known_zero',
      ),
    ).toEqual([{ source_type: 'authoritative', source_reference: 'USDA FDC 123', sodium_mg: 0 }]);
    expect(() =>
      db.seed(
        "INSERT INTO nutrition_profiles (id, basis_quantity, basis_unit, source_type, source_reference) VALUES ('nutrition_unknown', 100, 'g', 'estimated', 'label')",
      ),
    ).toThrow();
    expect(() =>
      db.seed(
        "INSERT INTO nutrition_profiles (id, basis_quantity, basis_unit, source_type, source_reference, sodium_mg) VALUES ('nutrition_negative', 100, 'g', 'imported', 'label', -1)",
      ),
    ).toThrow();
    expect(() =>
      db.seed(
        "INSERT INTO nutrition_profiles (id, basis_quantity, basis_unit, source_type, source_reference, sodium_mg) VALUES ('nutrition_infinite', 100, 'g', 'imported', 'label', 1e999)",
      ),
    ).toThrow();
  });

  it('enforces storage evidence keys and nutrition/classification relationships', () => {
    const db = database();
    db.seed(`INSERT INTO ingredient_storage_guidelines
      (ingredient_id, storage, package_state, shelf_life_days, source_type, source_reference)
      VALUES ('CHICKEN_BREAST', 'fridge', 'opened', 2, 'estimated', 'fixture only');
      INSERT INTO ingredient_tags (ingredient_id, kind, tag, source_reference)
      VALUES ('CHICKEN_EGG', 'allergen', 'egg', 'fixture only');
      INSERT INTO nutrition_profiles (id, basis_quantity, basis_unit, source_type, source_reference, protein_g)
      VALUES ('linked_profile', 100, 'g', 'estimated', 'fixture only', 10);
      INSERT INTO ingredient_nutrition VALUES ('CHICKEN_BREAST', 'linked_profile');
      INSERT INTO recipe_nutrition VALUES ('vn-canh-01', 1, 'linked_profile');
      INSERT INTO recipe_classifications VALUES ('vn-canh-01', 'meal_type', 'dinner');`);
    expect(() =>
      db.seed(`INSERT INTO ingredient_storage_guidelines VALUES
      ('CHICKEN_BREAST', 'fridge', 'opened', 3, 'estimated', 'duplicate')`),
    ).toThrow();
    expect(() =>
      db.seed(`UPDATE ingredient_storage_guidelines SET shelf_life_days = -1`),
    ).toThrow();
    expect(() => db.seed(`UPDATE ingredient_tags SET kind = 'safe'`)).toThrow();
    expect(() =>
      db.seed(`INSERT INTO ingredient_nutrition VALUES ('CHICKEN_BREAST', 'missing_profile')`),
    ).toThrow();
    expect(() => db.seed(`DELETE FROM nutrition_profiles WHERE id = 'linked_profile'`)).toThrow();
    expect(() => db.seed(`UPDATE recipe_nutrition SET recipe_version = 0`)).toThrow();
    expect(() =>
      db.seed(
        `INSERT INTO recipe_classifications VALUES ('missing_recipe', 'dietary', 'vegetarian')`,
      ),
    ).toThrow();
    expect(db.query('PRAGMA foreign_key_check')).toEqual([]);
  });

  it('requires a date for lot expiry evidence while preserving unknown legacy dates', () => {
    const db = database();
    db.seed(
      `INSERT INTO inventory_items (id, household_id, name) VALUES ('condition_lot', 'demo_household_01', 'raw label')`,
    );
    expect(() =>
      db.seed(`UPDATE inventory_items SET expiry_kind = 'use_by' WHERE id = 'condition_lot'`),
    ).toThrow('Expiry evidence requires a date');
    expect(() =>
      db.seed(`INSERT INTO inventory_items (id, household_id, name, expiry_source)
      VALUES ('bad_condition_lot', 'demo_household_01', 'raw label', 'ocr')`),
    ).toThrow('Expiry evidence requires a date');
    db.seed(`UPDATE inventory_items SET expiry_date = '2026-09-09', expiry_kind = 'use_by', expiry_source = 'ocr'
      WHERE id = 'condition_lot'`);
    expect(() =>
      db.seed(`UPDATE inventory_items SET expiry_date = NULL WHERE id = 'condition_lot'`),
    ).toThrow('Expiry evidence requires a date');
    db.seed(`UPDATE inventory_items SET expiry_date = NULL, expiry_kind = 'unknown', expiry_source = 'unknown'
      WHERE id = 'condition_lot'`);
    expect(
      db.query(`SELECT expiry_kind, expiry_source FROM inventory_items WHERE id = 'condition_lot'`),
    ).toEqual([{ expiry_kind: 'unknown', expiry_source: 'unknown' }]);
  });

  it('enforces family slots/options and validates structured recipe writes without rewriting legacy rows', () => {
    const db = database();
    db.seed(`INSERT INTO recipe_families (id, slug, name, base_servings) VALUES ('family_fried_rice', 'family-fried-rice', 'Fried rice', 2);
      INSERT INTO recipe_family_slots (family_id, slot_key, min_selections, max_selections) VALUES
        ('family_fried_rice', 'base', 1, 1), ('family_fried_rice', 'protein', 0, 1);
      INSERT INTO recipe_family_options (family_id, slot_key, ingredient_id, quantity, unit) VALUES
        ('family_fried_rice', 'base', 'RICE', 300, 'g'),
        ('family_fried_rice', 'protein', 'CHICKEN_BREAST', 150, 'g');`);
    expect(
      db.query(
        'SELECT slot_key, min_selections, max_selections FROM recipe_family_slots WHERE family_id = ? ORDER BY slot_key',
        'family_fried_rice',
      ),
    ).toEqual([
      { slot_key: 'base', min_selections: 1, max_selections: 1 },
      { slot_key: 'protein', min_selections: 0, max_selections: 1 },
    ]);
    expect(() =>
      db.seed(
        "INSERT INTO recipe_family_slots (family_id, slot_key, min_selections, max_selections) VALUES ('family_fried_rice', 'invalid', 2, 1)",
      ),
    ).toThrow();
    expect(() =>
      db.seed(
        "INSERT INTO recipe_family_slots (family_id, slot_key, min_selections, max_selections) VALUES ('family_fried_rice', 'base', 1, 1)",
      ),
    ).toThrow();
    expect(() =>
      db.seed(
        "INSERT INTO recipe_family_options (family_id, slot_key, ingredient_id, quantity, unit) VALUES ('family_fried_rice', 'base', 'RICE', 1, 'g')",
      ),
    ).toThrow();
    expect(() =>
      db.seed(
        "INSERT INTO recipe_family_options (family_id, slot_key, ingredient_id, quantity, unit) VALUES ('family_fried_rice', 'base', 'MISSING', 1, 'g')",
      ),
    ).toThrow();

    db.seed(`INSERT INTO recipes (id, slug, title, cuisine, cook_time_minutes, servings, difficulty, source_type, source_reference)
      VALUES ('future_recipe', 'future-recipe', 'Future recipe', 'vietnamese', 20, 2, 'easy', 'ai_generated', 'fixture:future-recipe');
      INSERT INTO recipe_ingredients (id, recipe_id, ingredient_id, name, required_quantity, unit, is_optional)
      VALUES ('future_recipe_chicken', 'future_recipe', 'CHICKEN_BREAST', 'Chicken breast', 200, 'g', 0);`);
    expect(
      db.query('SELECT source_type, verification_state FROM recipes WHERE id = ?', 'future_recipe'),
    ).toEqual([{ source_type: 'ai_generated', verification_state: 'unverified' }]);
    expect(
      db.query("SELECT source_type, verification_state FROM recipes WHERE id = 'vn-canh-01'"),
    ).toEqual([{ source_type: 'legacy', verification_state: 'unverified' }]);
    expect(() =>
      db.seed("UPDATE recipes SET cook_time_minutes = -1 WHERE id = 'vn-canh-01'"),
    ).toThrow('Invalid recipe servings/time/difficulty');
    expect(() =>
      db.seed(
        "UPDATE recipe_ingredients SET required_quantity = 0 WHERE id = 'future_recipe_chicken'",
      ),
    ).toThrow('Invalid structured recipe ingredient');
    expect(() =>
      db.seed(
        "INSERT INTO recipe_ingredients (id, recipe_id, ingredient_id, name, required_quantity, unit, is_optional) VALUES ('bad_unit', 'future_recipe', 'CHICKEN_BREAST', 'Chicken breast', 1, 'unsafe_unit', 0)",
      ),
    ).toThrow('Invalid structured recipe ingredient');
  });

  it('upgrades a legacy 0001–0018 fixture without altering raw unmapped inventory or seeded recipe data', () => {
    const db = new SqliteD1({ migrate: false });
    databases.push(db);
    migrateThrough0018(db);
    const recipesBefore = db.query<{ id: string; title: string }>(
      "SELECT id, title FROM recipes WHERE id = 'vn-canh-01'",
    );
    db.seed(`INSERT INTO ingredient_aliases (id, ingredient_id, alias) VALUES ('legacy_alias', 'CHICKEN_BREAST', 'Ức gà hàng cũ');
      INSERT INTO inventory_items (id, household_id, ingredient_id, name, quantity, unit, category, storage, expiry_date, freshness, data_source)
      VALUES ('legacy_raw_inventory', 'demo_household_01', NULL, '鶏むね肉 500g', 1, 'pack', 'other', 'fridge', NULL, 'fresh', 'scan');`);

    db.seed(foundationMigration);
    expect(
      db.query(
        'SELECT alias, language, normalized_alias FROM ingredient_aliases WHERE id = ?',
        'legacy_alias',
      ),
    ).toEqual([{ alias: 'Ức gà hàng cũ', language: 'und', normalized_alias: null }]);
    expect(
      db.query(
        'SELECT ingredient_id, name, unit, expiry_date, expiry_kind, expiry_source FROM inventory_items WHERE id = ?',
        'legacy_raw_inventory',
      ),
    ).toEqual([
      {
        ingredient_id: null,
        name: '鶏むね肉 500g',
        unit: 'pack',
        expiry_date: null,
        expiry_kind: 'unknown',
        expiry_source: 'unknown',
      },
    ]);
    expect(
      db.query(
        "SELECT COUNT(*) AS count FROM ingredient_tags WHERE ingredient_id = 'CHICKEN_BREAST'",
      ),
    ).toEqual([{ count: 0 }]);
    expect(
      db.query(
        "SELECT id, title, source_type, verification_state FROM recipes WHERE id = 'vn-canh-01'",
      ),
    ).toEqual([{ ...recipesBefore[0], source_type: 'legacy', verification_state: 'unverified' }]);
    expect(db.query('PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    expect(db.query('PRAGMA foreign_key_check')).toEqual([]);
    expect(() => db.seed(foundationMigration)).toThrow();
  });
});
