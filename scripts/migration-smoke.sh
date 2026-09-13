#!/usr/bin/env bash
set -euo pipefail

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "sqlite3 is required for the migration smoke test"
  exit 1
fi

sqlite3 ':memory:' <<'SQL'
.bail on
PRAGMA foreign_keys = ON;
.read migrations/0001_initial_schema.sql
.read migrations/0002_seed_data.sql
.read migrations/0003_weekly_planner.sql
.read migrations/0004_auth_system.sql
.read migrations/0005_meal_plans_relational.sql
.read migrations/0006_vietnamese_recipe_bank.sql
.read migrations/0007_week_integrity.sql
.read migrations/0008_week_snapshot_metadata.sql
.read migrations/0009_inventory_optimistic_version.sql
.read migrations/0012_scan_queue_jobs.sql

-- Seed a mixed legacy/current Week dataset before the shadow migration. The
-- fixture exercises metadata preservation and legacy-only recovery.
INSERT INTO meal_plans (id, household_id, start_date, end_date, status)
VALUES ('migration_smoke_plan', 'demo_household_01', '2026-09-07', '2026-09-13', 'READY');
INSERT INTO meal_plan_days (id, plan_id, day_of_week, date, day_type)
VALUES ('migration_smoke_day', 'migration_smoke_plan', 1, '2026-09-07', 'flexible');
INSERT INTO meal_plan_days (id, plan_id, day_of_week, date, day_type)
VALUES ('migration_smoke_sunday', 'migration_smoke_plan', 0, '2026-09-13', 'cooking');
INSERT INTO meal_plan_slots (id, day_id, plan_id, slot_type, recipe_id, servings, status, notes, snapshot_json)
VALUES ('migration_smoke_slot_current', 'migration_smoke_day', 'migration_smoke_plan', 'dinner', 'vn-canh-01', 2, 'PLANNED', 'current metadata', '{"category":"current"}');
INSERT INTO meal_slots (id, day_id, plan_id, slot_type, status, recipe_id, servings, source, is_locked, leftover_source_id, notes)
VALUES ('migration_smoke_slot_current', 'migration_smoke_day', 'migration_smoke_plan', 'dinner', 'PLANNED', 'vn-canh-01', 3, 'USER', 1, 'source_slot_1', 'legacy metadata');
INSERT INTO meal_slots (id, day_id, plan_id, slot_type, status, recipe_id, servings, source, is_locked, leftover_source_id, notes)
VALUES ('migration_smoke_slot_legacy_only', 'migration_smoke_day', 'migration_smoke_plan', 'lunch', 'LEFTOVER', NULL, 1, 'USER', 0, NULL, 'legacy only');
INSERT INTO meal_plan_shopping_items (id, plan_id, ingredient_id, name, quantity, unit, checked, cannot_buy, snapshot_json)
VALUES ('migration_smoke_shop_current', 'migration_smoke_plan', 'TOMATO', 'Cà chua', 3, 'piece', 1, 0,
        '{"category":"vegetable","requiredQuantity":5,"existingInventoryQuantity":2,"missingQuantity":3,"recommendedPurchaseQuantity":3,"estimatedPriceMin":10000,"estimatedPriceMax":15000}');
INSERT INTO meal_plan_shopping_items (id, plan_id, ingredient_id, name, quantity, unit, checked, cannot_buy)
VALUES ('migration_smoke_shop_enriched', 'migration_smoke_plan', 'GARLIC', 'Tỏi', 2, 'piece', 1, 0);
INSERT INTO meal_plan_ingredient_requirements
  (id, plan_id, ingredient_id, name, category, required_quantity, inventory_quantity, missing_quantity, purchase_quantity, unit, estimated_price_min, estimated_price_max, is_checked)
VALUES ('migration_smoke_req_legacy', 'migration_smoke_plan', 'GARLIC', 'Tỏi', 'spice', 2, 0, 2, 2, 'piece', 5000, 7000, 0);
INSERT INTO meal_plan_ingredient_requirements
  (id, plan_id, ingredient_id, name, category, required_quantity, inventory_quantity, missing_quantity, purchase_quantity, unit, estimated_price_min, estimated_price_max, is_checked)
VALUES ('migration_smoke_req_only', 'migration_smoke_plan', 'GINGER', 'Gừng', 'spice', 1, 0, 1, 1, 'piece', 3000, 5000, 0);

-- Replay once to prove this additive backfill is safe if an operator executes
-- the SQL directly after an interrupted bootstrap.
.read migrations/0010_week_schema_shadow_canonical.sql
.read migrations/0010_week_schema_shadow_canonical.sql
.read migrations/0011_meal_plan_tenant_ownership.sql
.read migrations/0011_meal_plan_tenant_ownership.sql
.read migrations/0013_scan_receipt_metadata.sql
.read migrations/0014_scan_queue_fencing.sql
.read migrations/0015_auth_session_otp_hardening.sql
.read migrations/0016_scan_quota_ledger.sql
.read migrations/0017_auth_otps_remove_plaintext.sql
.read migrations/0018_payments.sql
.read migrations/0019_recipe_domain_foundation.sql
.read migrations/0020_t01_foundation_hardening.sql
.read migrations/0021_recipe_personalization.sql
.read migrations/0022_generated_meal_plans.sql
.read migrations/0023_scan_request_fingerprint.sql

CREATE TEMP TABLE assert_zero (value INTEGER NOT NULL CHECK (value = 0));
INSERT INTO assert_zero SELECT COUNT(*) FROM pragma_foreign_key_check;
INSERT INTO assert_zero SELECT COUNT(*) FROM pragma_integrity_check WHERE integrity_check <> 'ok';

CREATE TEMP TABLE assert_one (value INTEGER NOT NULL CHECK (value = 1));
INSERT INTO assert_one SELECT COUNT(*) FROM pragma_table_info('ingredient_aliases') WHERE name = 'normalized_alias';
INSERT INTO assert_one SELECT COUNT(*) FROM pragma_table_info('inventory_items') WHERE name = 'expiry_source';
INSERT INTO assert_one SELECT COUNT(*) FROM pragma_table_info('recipes') WHERE name = 'verification_state';
INSERT INTO assert_one SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'recipe_family_options';
INSERT INTO assert_one SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_ingredients_canonical_id_insert';
INSERT INTO assert_one SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_recipe_nutrition_version_update';
INSERT INTO assert_one SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_recipe_families_source_reference_update';
INSERT INTO assert_one SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'household_ranking_preferences';
INSERT INTO assert_one SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'member_ranking_preferences';
INSERT INTO assert_one SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'recipe_feedback_events';
INSERT INTO assert_one SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'generated_meal_plans';
INSERT INTO assert_one SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'generated_meal_plan_annotations';
INSERT INTO assert_one SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_cooked_meals_ranking_recent';
INSERT INTO assert_zero SELECT COUNT(*) FROM sqlite_master WHERE name = '_t01_hardening_guard';
INSERT INTO assert_one SELECT COUNT(*) FROM pragma_table_info('meal_plan_days') WHERE name = 'day_type';
INSERT INTO assert_one SELECT COUNT(*) FROM pragma_table_info('meal_plans') WHERE name = 'snapshot_json';
INSERT INTO assert_one SELECT COUNT(*) FROM pragma_table_info('meal_plan_slots') WHERE name = 'snapshot_json';
INSERT INTO assert_one SELECT COUNT(*) FROM pragma_table_info('meal_plan_shopping_items') WHERE name = 'snapshot_json';
INSERT INTO assert_one SELECT COUNT(*) FROM pragma_table_info('inventory_items') WHERE name = 'version';
INSERT INTO assert_one SELECT COUNT(*) FROM pragma_table_info('scan_queue_jobs') WHERE name = 'attempts';
INSERT INTO assert_one SELECT COUNT(*) FROM pragma_table_info('scan_queue_jobs') WHERE name = 'claim_token';
INSERT INTO assert_one SELECT COUNT(*) FROM pragma_table_info('sessions_v2') WHERE name = 'token_hash';
INSERT INTO assert_one SELECT COUNT(*) FROM pragma_table_info('auth_otps') WHERE name = 'attempt_count';
INSERT INTO assert_one SELECT COUNT(*) FROM pragma_table_info('auth_otps') WHERE name = 'used_at';
INSERT INTO assert_zero SELECT COUNT(*) FROM pragma_table_info('auth_otps') WHERE name = 'code';
INSERT INTO assert_one SELECT COUNT(*) FROM pragma_table_info('scan_quota_ledger') WHERE name = 'idempotency_key';
INSERT INTO assert_one SELECT COUNT(*) FROM pragma_table_info('scan_quota_periods') WHERE name = 'used_count';
INSERT INTO assert_one SELECT COUNT(*) FROM pragma_table_info('scans') WHERE name = 'request_fingerprint';
INSERT INTO assert_one SELECT COUNT(*) FROM pragma_table_info('scans') WHERE name = 'image_mime_type';
INSERT INTO assert_one SELECT COUNT(*) FROM sqlite_master
  WHERE type = 'index' AND name = 'idx_scans_request_fingerprint';
INSERT INTO assert_one SELECT COUNT(*) FROM pragma_table_info('meal_plan_days_v2') WHERE name = 'snapshot_json';
INSERT INTO assert_one SELECT COUNT(*) FROM pragma_table_info('meal_plan_slots_v2') WHERE name = 'leftover_source_id';
INSERT INTO assert_one SELECT COUNT(*) FROM pragma_table_info('meal_plan_shopping_items_v2') WHERE name = 'required_quantity';
INSERT INTO assert_one SELECT COUNT(*) FROM sqlite_master
  WHERE type = 'trigger' AND name = 'trg_meal_plans_household_immutable';
INSERT INTO assert_one SELECT COUNT(*) FROM meal_plan_days_v2
  WHERE id = 'migration_smoke_day' AND day_type = 'flexible';
INSERT INTO assert_one SELECT COUNT(*) FROM meal_plan_days_v2
  WHERE id = 'migration_smoke_sunday' AND day_of_week = 7;
INSERT INTO assert_one SELECT COUNT(*) FROM meal_plan_slots_v2
  WHERE id = 'migration_smoke_slot_current' AND servings = 2 AND source = 'USER'
    AND is_locked = 1 AND leftover_source_id = 'source_slot_1';
INSERT INTO assert_one SELECT COUNT(*) FROM meal_plan_slots_v2
  WHERE id = 'migration_smoke_slot_legacy_only' AND notes = 'legacy only';
INSERT INTO assert_one SELECT COUNT(*) FROM meal_plan_shopping_items_v2
  WHERE id = 'migration_smoke_shop_current' AND required_quantity = 5
    AND inventory_quantity = 2 AND missing_quantity = 3 AND purchase_quantity = 3;
INSERT INTO assert_one SELECT COUNT(*) FROM meal_plan_shopping_items_v2
  WHERE id = 'migration_smoke_shop_enriched' AND ingredient_id = 'GARLIC'
    AND category = 'spice' AND required_quantity = 2
    AND estimated_price_min = 5000 AND estimated_price_max = 7000;
INSERT INTO assert_one SELECT COUNT(*) FROM meal_plan_shopping_items_v2
  WHERE id = 'legacy_req_migration_smoke_req_only' AND ingredient_id = 'GINGER';

-- Production was originally bootstrapped with direct SQL execution. If an
-- operator later baselines Wrangler history incorrectly, 0006 may be replayed.
-- Seed updates must preserve user-owned rows that reference catalog recipes.
INSERT INTO favorites (id, user_id, recipe_id)
VALUES ('migration_smoke_favorite', 'demo_user_01', 'vn-canh-01');
INSERT INTO recipe_translations (id, recipe_id, language, title)
VALUES ('migration_smoke_translation', 'vn-canh-01', 'ja', 'Migration smoke');
UPDATE recipes SET title = 'stale seed title' WHERE id = 'vn-canh-01';

.read migrations/0006_vietnamese_recipe_bank.sql

INSERT INTO assert_one
SELECT COUNT(*) FROM favorites WHERE id = 'migration_smoke_favorite';
INSERT INTO assert_one
SELECT COUNT(*) FROM recipe_translations WHERE id = 'migration_smoke_translation';
INSERT INTO assert_one
SELECT COUNT(*) FROM recipes
WHERE id = 'vn-canh-01' AND title = 'Canh chua cá lóc Nam Bộ';
INSERT INTO assert_zero SELECT COUNT(*) FROM pragma_foreign_key_check;

SELECT 'migration-smoke=ok';
SQL
