# Alex Pizza NYC — Production Voice Agent Worker

This repository is the source for the **Alex Pizza NYC** Vapi voice agent, deployed as the Cloudflare Worker **`calling-agent-api`**. It uses Cloudflare D1 for tenant-scoped operational data and four Cloudflare Workflows for order POS sync, booking calendar sync, notification delivery, and live call-minute metering.

## Production deployment

Cloudflare Workers Builds should be connected to this repository with:

| Setting | Value |
|---|---|
| Repository | `businessasquare9-maker/Alex-Pizza-` |
| Production branch | `main` |
| Root directory | `/` |
| Build command (recommended verification gate) | `node verify-build.mjs` |
| Deploy command | `npx wrangler deploy` |

The Build command is optional for this plain JavaScript Worker. If it remains blank in the Cloudflare dashboard, Workers Builds still runs the Deploy command on every production-branch push, but skips this repository's pre-deploy verification script. To make verification automatic, set the Build command to `node verify-build.mjs` in **Settings → Builds**.
| Worker name | `calling-agent-api` |

A commit pushed to `main` triggers the connected Workers Builds production pipeline. The Git commit SHA and Cloudflare Deployment ID are different identifiers. The actual Active Deployment and Build log are visible in the Cloudflare Worker Deployments / build history page.

## Cloudflare resources

- Worker: `calling-agent-api`
- D1 binding: `DB`
- D1 database: `calling-agent-db`
- Order workflow: `ORDER_WORKFLOW` → `alex-pizza-order-processing`
- Call usage workflow: `CALL_USAGE_WORKFLOW` → `alex-pizza-live-call-usage`
- Notification workflow: `NOTIFICATION_WORKFLOW` → `alex-pizza-notification-delivery`
- Booking calendar workflow: `BOOKING_CALENDAR_WORKFLOW` → `alex-pizza-booking-calendar-sync`
- Daily scheduled maintenance: cron `17 10 * * *` UTC

All runtime credentials remain in Cloudflare Secrets/Variables. Do not place secrets in GitHub source.

## Vapi interface

Tenant-scoped endpoints:

- `POST /vapi/alex-pizza/tools` — tool calls
- `GET /vapi/alex-pizza/tools` — registered Worker tool catalog
- `POST /vapi/alex-pizza/events` — Vapi status, tool-call, and end-of-call events

The Worker registers 12 custom HTTP tools:

`send_booking_notification`, `transfer_to_manager`, `request_manager_status_check`, `book_table`, `check_table_availability`, `request_order_cancel`, `submit_order`, `request_order_change`, `check_order_status`, `get_business_hours`, `calculate_order_tool`, `get_menu`.

The thirteenth tool, `end_outbound_call`, is Vapi's native call-control tool and is configured in Vapi, not as a Worker HTTP handler.

## Restaurant rules

- Store time zone: `America/New_York`.
- Default opening/closing time: **12:00 PM to 2:00 AM**, including the midnight crossing.
- New orders and reservations stop 20 minutes before closing.
- Seating: 10 tables × 4 seats = 40 seats. Availability and final D1 insert check seat and table-equivalent capacity; Google Calendar reservations are included in capacity calculation.
- Repeat callers are identified within a 30-minute window and a duplicate alert is suppressed for that window.

### Order-change policy

| Order age | Allowed action |
|---|---|
| 0–5 minutes | Full change or cancellation after explicit customer confirmation |
| Over 5–20 minutes | Add items only to the original bill after explicit confirmation; no cancellation, item removal, or replacement |
| Over 20 minutes | Original bill is immutable; customer may explicitly place a separate linked bill to be handled with the original order |

Every customer bill has an 8-character reference. Order status, change, and cancellation requests verify both the bill reference and customer phone. Orders are isolated by tenant and persisted in D1 after customer confirmation.

## Order, POS and notification lifecycle

1. The customer confirms the order.
2. The Worker stores the bill and line items in tenant-scoped D1.
3. The receipt is dispatched immediately, independently of Zoho POS success.
4. SignalWire delivery is recorded in D1 and retried by `NOTIFICATION_WORKFLOW`.
5. `ORDER_WORKFLOW` creates or updates the associated Zoho POS Sales Order, marks it Confirmed, and records its POS state separately from the customer bill.
6. A D1 per-bill POS lease ensures that initial submission and queued edits/additions do not create competing Zoho Sales Orders. The Workflow reloads the newest D1 bill after acquiring the lease.
7. A permitted early cancellation voids the linked Zoho Sales Order when one has already been created. The customer bill remains stored as cancelled in D1.

A POS failure does not delete or reject the customer-confirmed D1 bill or undo the receipt dispatch. The POS sync status remains independently visible for follow-up.

## D1 menu and Zoho POS mapping

D1 `menu_items` is the menu source of truth. The Worker reads:

`tenant_id, sku, name, category, size, flavor, price_cents, active, pos_variant_id`.

The menu sync path is non-destructive. It does not delete or reseed menu rows. Legacy dollar-denominated `price` data is migrated to `price_cents` without replacing the menu.

When a Zoho item ID is missing, the Worker reads the Zoho POS item list and matches on a unique exact SKU and an active/sellable item. A duplicate Zoho SKU, disabled item, missing SKU, or conflicting pre-existing D1 ID is not guessed or overwritten.

D1 `price_cents` remains the customer-facing source of truth. If Zoho's catalog rate differs, the mapping report records `price_override_required`; the Zoho Sales Order line is still sent with the D1-approved rate in dollars. The product catalog rate itself is not silently changed. A CSV template is included for reconciliation.

Zoho POS API scopes used by this integration:
- `ZohoPOSAPI.items.READ`
- `ZohoPOSAPI.salesorders.CREATE` (create, confirm, void)
- `ZohoPOSAPI.salesorders.UPDATE` (update an existing Sales Order)

## Manager status and complaints

For a customer order-status enquiry, the AI verifies the bill reference and customer phone, keeps the inbound caller informed/holding, places an outbound Vapi call to the configured Alex Pizza manager assistant, stores the manager response, and returns the manager-reported answer to the same inbound call. It must not invent status.

Live transfer is reserved for an explicit customer complaint. The Worker sends Vapi's call-control transfer command when the live control URL is present; otherwise it records and notifies the manager that a callback is required. The Worker does not claim that the manager answered until the provider reports that.

## Usage, retention and tenant controls

- `CALL_USAGE_WORKFLOW` counts active call minutes in one-minute intervals; `end-of-call-report` reconciles the final duration.
- Monthly usage is partitioned by New York calendar month; prior usage is archived on the first New York day of the month.
- Operational records use a rolling 60-day retention policy. Day-one records are removed when they become older than 60 days; invoice, manual-payment, tenant and monthly-usage history are retained.
- Client dashboard API requests authenticate using a tenant-specific hashed dashboard token and scope reads to that tenant.
- Provider admin endpoints provide cross-tenant overview, invoice/payment recording, tenant activation/suspension, usage and integration controls.
- An overdue invoice with a due date can automatically suspend that tenant. A paid/satisfied tenant must be reactivated by provider admin.

## Dashboard APIs

- Manager UI: `GET /manager`
- Manager data: `GET /manager/data?tenant_id=alex-pizza`
- Manager export: `GET /manager/export?tenant_id=alex-pizza`
- Client API: `GET /client/data`, `GET /client/export` (tenant is determined by the client dashboard token)
- Provider overview and controls: protected `POST /admin/*` routes in `src/index.js`

The Worker provides tenant-scoped data and provider controls for the later animated client/provider dashboard UI. The current `/manager` page is a basic operational viewer, not the final animated dashboard design.

## Build verification

`verify-build.mjs` checks the Worker module syntax and core contracts: default New York hours/cutoff, Vapi tool names, D1 cents/menu compatibility, non-destructive menu handling, seat capacity, order policy, the four workflow classes, per-bill POS locking, manager-call/transfer paths, tenant dashboard isolation, retention, and Zoho sync routes.

Run locally:

```bash
node verify-build.mjs
```

Read-only D1 inspection queries are in `D1_PREDEPLOY_CHECKS.sql`.
Triggering build
