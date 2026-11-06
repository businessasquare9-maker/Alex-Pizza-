# Alex Pizza — Zoho POS Menu Mapping

This guide maps the D1 menu SKU values to real Zoho POS item IDs. It does not create Zoho items or invent IDs.

## Tenant and Worker

- Worker: `calling-agent-api`
- Production base URL: `https://calling-agent-api.businessasquare9.workers.dev`
- Default tenant: `alex-pizza`
- D1 mapping column: `menu_items.pos_variant_id` (also supports legacy `zoho_item_id` / `pos_item_id`)

## Required access

Admin endpoints require:
- HTTP method: `POST`
- Header: `Content-Type: application/json`
- Header: `x-admin-key: <your ADMIN_API_TOKEN>`

Use your own Cloudflare secret value locally in your API client. Never put the token in this repository, a URL, or a chat message.

## Step 1 — Preview only (read-only)

Send:

```http
POST https://calling-agent-api.businessasquare9.workers.dev/admin/zoho-item-map-preview
Content-Type: application/json
x-admin-key: YOUR_ADMIN_API_TOKEN

{
  "tenant_id": "alex-pizza"
}
```

The Worker reads the active D1 menu and lists Zoho POS items using the connected Zoho credentials. It matches on SKU and checks uniqueness, active/sellable status, numeric Zoho item ID, and price.

Review every row:
- `exact_match_ready`: unique SKU match and exact price; safe candidate for automatic mapping.
- `already_mapped_exact_match`: already mapped and price matches.
- `zoho_sku_not_found`: no Zoho item has that SKU.
- `duplicate_zoho_sku`: more than one Zoho item has that SKU; resolve the duplicate first.
- `existing_mapping_conflict`: D1 already contains a different POS ID; investigate before changing it.
- `sku_match_price_override` / `already_mapped_price_override`: price differs; verify the Zoho item and intended price before mapping.
- `zoho_item_not_active_or_not_sellable`: activate/allow sale in Zoho only if appropriate.

Do not run the apply endpoint until the preview has been reviewed and every item intended for automatic mapping is an exact SKU + price match. Do not treat a matching name alone as proof.

## Step 2 — Apply reviewed automatic matches

Only after reviewing the preview, send:

```http
POST https://calling-agent-api.businessasquare9.workers.dev/admin/zoho-item-map-apply
Content-Type: application/json
x-admin-key: YOUR_ADMIN_API_TOKEN

{
  "tenant_id": "alex-pizza"
}
```

This writes the matched Zoho item IDs into D1's menu mapping column and returns a refreshed report. Check `applied_now`, `exact_matches`, and `needs_attention`.

Important: the current Worker implementation can also write a unique active SKU match when the price differs (reported as `sku_match_price_override`). Therefore, do not call this endpoint until you have reviewed the entire preview and resolved or explicitly approved every price-mismatch row.

## Step 3 — Resolve unmatched SKUs manually

For each item that has no exact Zoho SKU match, first locate the item in Zoho POS and verify its actual numeric `item_id`. Then map it using:

```http
POST https://calling-agent-api.businessasquare9.workers.dev/admin/map-menu-pos-items
Content-Type: application/json
x-admin-key: YOUR_ADMIN_API_TOKEN

{
  "tenant_id": "alex-pizza",
  "items": [
    {
      "sku": "THE_EXACT_D1_MENU_SKU",
      "pos_variant_id": "THE_REAL_NUMERIC_ZOHO_ITEM_ID"
    }
  ]
}
```

Replace both example values with real values. Never use a product name, a made-up ID, or a placeholder. The endpoint reports how many rows were updated and any unmatched SKUs.

## Where the real values come from

In Zoho POS, open the relevant item and obtain its SKU and item ID, or use the Zoho POS Items API (`GET /inventory/v1/items`) with the connected organization. Zoho documents `item_id` as the server-generated unique item identifier and `sku` as the item's unique stock keeping unit.

Official documentation: https://www.zoho.com/pos/resources/api/items.html

## About `ZOHO_ITEM_ID_MAP` status

The health field `zoho_item_id_map_env_configured` checks only whether the optional Cloudflare environment secret `ZOHO_ITEM_ID_MAP` exists. It does not inspect D1's `pos_variant_id` mappings. The Worker can read mappings stored in D1 even while that health field remains `false`. Do not add a placeholder JSON secret just to turn the flag green.

## Completion criteria

Mapping is ready only when:
1. Every sellable D1 menu SKU used by orders has a verified Zoho item ID.
2. No unresolved duplicate SKU or existing-ID conflict remains.
3. Price mismatches have been deliberately reconciled.
4. A real low-value test order is confirmed in Zoho POS before live customer ordering is enabled.
