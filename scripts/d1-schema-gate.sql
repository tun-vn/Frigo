WITH
required_migrations(name) AS (
  VALUES
    ('0001_initial_schema.sql'),
    ('0002_seed_data.sql'),
    ('0003_weekly_planner.sql'),
    ('0004_auth_system.sql'),
    ('0005_meal_plans_relational.sql'),
    ('0006_vietnamese_recipe_bank.sql'),
    ('0007_week_integrity.sql'),
    ('0008_week_snapshot_metadata.sql'),
    ('0009_inventory_optimistic_version.sql'),
    ('0010_week_schema_shadow_canonical.sql'),
    ('0011_meal_plan_tenant_ownership.sql'),
    ('0012_scan_queue_jobs.sql'),
    ('0013_scan_receipt_metadata.sql'),
    ('0014_scan_queue_fencing.sql'),
    ('0015_auth_session_otp_hardening.sql'),
    ('0016_scan_quota_ledger.sql'),
    ('0017_auth_otps_remove_plaintext.sql'),
    -- Payment migration remains immutable/protected, but it is part of the
    -- production ledger and must be present for an exact schema check.
    ('0018_payments.sql'),
    ('0019_recipe_domain_foundation.sql'),
    ('0020_t01_foundation_hardening.sql'),
    ('0021_recipe_personalization.sql'),
    ('0022_generated_meal_plans.sql'),
    ('0023_scan_request_fingerprint.sql')
),
required_tables(name) AS (
  VALUES
    ('users'),
    ('households'),
    ('inventory_items'),
    ('inventory_events'),
    ('scans'),
    ('meal_plans'),
    ('shopping_import_commands'),
    ('meal_plan_days_v2'),
    ('meal_plan_slots_v2'),
    ('meal_plan_shopping_items_v2')
    ,('scan_queue_jobs')
    ,('sessions_v2')
    ,('auth_otps')
    ,('scan_quota_periods')
    ,('scan_quota_ledger')
    ,('measurement_units')
    ,('ingredient_tags')
    ,('ingredient_storage_guidelines')
    ,('nutrition_profiles')
    ,('ingredient_nutrition')
    ,('recipe_families')
    ,('recipe_family_slots')
    ,('recipe_family_options')
    ,('recipe_nutrition')
    ,('recipe_classifications')
    ,('household_ranking_preferences')
    ,('member_ranking_preferences')
    ,('recipe_feedback_events')
    ,('generated_meal_plans')
    ,('generated_meal_plan_annotations')
),
required_columns(table_name, column_name) AS (
  VALUES
    ('inventory_items', 'version'),
    ('inventory_items', 'opened_at'),
    ('inventory_items', 'expiry_kind'),
    ('inventory_items', 'expiry_source'),
    ('ingredients', 'default_name'),
    ('ingredients', 'subcategory'),
    ('ingredients', 'allergen_review_state'),
    ('ingredient_aliases', 'language'),
    ('ingredient_aliases', 'normalized_alias'),
    ('recipes', 'family_id'),
    ('recipes', 'prep_time_minutes'),
    ('recipes', 'source_type'),
    ('recipes', 'source_reference'),
    ('recipes', 'verification_state'),
    ('recipes', 'version'),
    ('meal_plans', 'snapshot_json'),
    ('shopping_import_commands', 'request_fingerprint'),
    ('shopping_import_commands', 'lock_token'),
    ('meal_plan_days_v2', 'day_type'),
    ('meal_plan_days_v2', 'snapshot_json'),
    ('meal_plan_slots_v2', 'source'),
    ('meal_plan_slots_v2', 'is_locked'),
    ('meal_plan_slots_v2', 'leftover_source_id'),
    ('meal_plan_slots_v2', 'snapshot_json'),
    ('meal_plan_shopping_items_v2', 'required_quantity'),
    ('meal_plan_shopping_items_v2', 'inventory_quantity'),
    ('meal_plan_shopping_items_v2', 'missing_quantity'),
    ('meal_plan_shopping_items_v2', 'purchase_quantity'),
    ('meal_plan_shopping_items_v2', 'estimated_price_min'),
    ('meal_plan_shopping_items_v2', 'estimated_price_max'),
    ('meal_plan_shopping_items_v2', 'snapshot_json')
    ,('scan_queue_jobs', 'status')
    ,('scan_queue_jobs', 'attempts')
    ,('scan_queue_jobs', 'max_attempts')
    ,('scan_queue_jobs', 'idempotency_key')
    ,('scan_queue_jobs', 'claim_token')
    ,('scan_queue_jobs', 'claim_attempt')
    ,('sessions_v2', 'token_hash')
    ,('sessions_v2', 'revoked_at')
    ,('auth_otps', 'code_digest')
    ,('auth_otps', 'digest_version')
    ,('auth_otps', 'attempt_count')
    ,('auth_otps', 'locked_until')
    ,('auth_otps', 'used_at')
    ,('scan_quota_ledger', 'idempotency_key')
    ,('scan_quota_ledger', 'status')
    ,('scan_quota_periods', 'used_count')
    ,('scans', 'merchant_name')
    ,('scans', 'invoice_number')
    ,('scans', 'purchase_date')
    ,('scans', 'total_amount_vnd')
    ,('scan_items', 'unit_price_vnd')
    ,('scan_items', 'total_price_vnd')
    ,('scans', 'request_fingerprint')
    ,('scans', 'image_mime_type')
),
required_triggers(name) AS (
  VALUES
    ('trg_meal_plans_household_immutable'),
    ('trg_ingredients_canonical_id_insert'),
    ('trg_ingredients_canonical_id_update'),
    ('trg_recipe_nutrition_version_insert'),
    ('trg_recipe_nutrition_version_update'),
    ('trg_recipes_nutrition_version_insert'),
    ('trg_recipes_nutrition_version_update'),
    ('trg_recipes_source_reference_insert'),
    ('trg_recipes_source_reference_update'),
    ('trg_recipe_families_source_reference_insert'),
    ('trg_recipe_families_source_reference_update')
)
SELECT 'missing_migration' AS issue, migration.name AS detail
FROM required_migrations migration
WHERE NOT EXISTS (
  SELECT 1 FROM d1_migrations applied WHERE applied.name = migration.name
)
UNION ALL
SELECT 'missing_table', required.name
FROM required_tables required
WHERE NOT EXISTS (
  SELECT 1
  FROM sqlite_master existing
  WHERE existing.type = 'table' AND existing.name = required.name
)
UNION ALL
SELECT 'missing_column', required.table_name || '.' || required.column_name
FROM required_columns required
WHERE NOT EXISTS (
  SELECT 1
  FROM pragma_table_info(required.table_name) column_info
  WHERE column_info.name = required.column_name
)
UNION ALL
SELECT 'missing_trigger', required.name
FROM required_triggers required
WHERE NOT EXISTS (
  SELECT 1 FROM sqlite_master
  WHERE type = 'trigger' AND name = required.name
)
UNION ALL
SELECT 'foreign_key_violation',
       foreign_keys."table" || '[rowid=' || foreign_keys.rowid || '] -> ' || foreign_keys.parent
FROM pragma_foreign_key_check foreign_keys
ORDER BY issue, detail;
