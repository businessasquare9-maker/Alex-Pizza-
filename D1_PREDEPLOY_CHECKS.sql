-- READ-ONLY checks for the existing Alex Pizza D1 database.
-- Run these in Cloudflare D1 Console BEFORE deploying the new Worker.
-- These statements do not insert, update, or delete any data.

-- 1) Confirm the existing live menu is still present (expected: 16 active rows).
SELECT
  COUNT(*) AS active_menu_rows,
  COUNT(DISTINCT sku) AS unique_skus,
  SUM(CASE WHEN pos_variant_id IS NULL OR pos_variant_id = '' THEN 1 ELSE 0 END) AS missing_zoho_item_ids
FROM menu_items
WHERE tenant_id = 'alex-pizza' AND active = 1;

-- 2) Inspect the exact menu rows and prices in cents.
SELECT sku, name, category, size, flavor, price_cents, active, pos_variant_id
FROM menu_items
WHERE tenant_id = 'alex-pizza'
ORDER BY category, name, sku;

-- 3) Confirm tenant status before rollout.
SELECT tenant_id, name, timezone, status, suspended_reason
FROM tenants
WHERE tenant_id = 'alex-pizza';

-- 4) Check order fields used for linked follow-up orders.
PRAGMA table_info(orders);

-- 5) Check invoice due-date field used for automatic overdue suspension.
PRAGMA table_info(invoices);

-- 6) Inspect latest monthly call usage without modifying billing records.
SELECT tenant_id, month, total_minutes, last_call_at, status
FROM monthly_call_usage
WHERE tenant_id = 'alex-pizza'
ORDER BY month DESC
LIMIT 12;