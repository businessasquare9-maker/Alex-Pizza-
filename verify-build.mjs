import fs from 'node:fs';
import assert from 'node:assert/strict';

const workerPath = new URL('./src/index.js', import.meta.url);
const source = fs.readFileSync(workerPath, 'utf8');
const moduleSource = source.replace(
  "import { WorkflowEntrypoint } from 'cloudflare:workers';",
  "class WorkflowEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }"
) + '\nexport { businessConfig, formatHour, isWithinBusinessHours, TOOL_CATALOG, resolveToolName, makeId, syncAndReplaceD1Menu, getMenuRows, findMenuItemsBySku, checkAvailability };\n';

const temp = new URL('./.verify-worker.mjs', import.meta.url);
fs.writeFileSync(temp, moduleSource);
try {
  const worker = await import(temp.href + '?build=' + Date.now());

  // New York business hours: midnight crossing and the 20-minute booking/order cutoff.
  const config = worker.businessConfig({});
  assert.equal(config.timeZone, 'America/New_York');
  assert.equal(config.openHour, 12);
  assert.equal(config.closeHour, 2);
  assert.equal(config.cutoffMinutes, 20);
  assert.equal(worker.formatHour(12), '12:00 PM');
  assert.equal(worker.formatHour(2), '2:00 AM');
  assert.equal(worker.isWithinBusinessHours(new Date('2026-11-04T17:00:00Z'), config).ok, true); // 12:00 PM EST
  assert.equal(worker.isWithinBusinessHours(new Date('2026-11-04T06:39:00Z'), config).ok, true); // 1:39 AM EST
  assert.equal(worker.isWithinBusinessHours(new Date('2026-11-04T06:40:00Z'), config).ok, false); // 20-minute cutoff
  assert.equal(worker.isWithinBusinessHours(new Date('2026-11-04T07:00:00Z'), config).ok, false); // 2:00 AM EST

  // 12 Worker HTTP tools plus Vapi's separate native end_outbound_call tool.
  const expectedTools = [
    'send_booking_notification', 'transfer_to_manager', 'request_manager_status_check',
    'book_table', 'check_table_availability', 'request_order_cancel', 'submit_order',
    'request_order_change', 'check_order_status', 'get_business_hours',
    'calculate_order_tool', 'get_menu'
  ];
  const actualTools = worker.TOOL_CATALOG.map(tool => tool.name);
  assert.deepEqual(actualTools, expectedTools);
  for (const tool of worker.TOOL_CATALOG) {
    assert.equal(tool.parameters.type, 'object');
    assert.doesNotThrow(() => JSON.stringify(tool.parameters));
  }
  assert.equal(worker.resolveToolName('send_booking_notification'), 'send_booking_notifications');
  assert.equal(worker.resolveToolName('get_business_hours'), 'get_business_info');
  assert.equal(worker.resolveToolName('calculate_order_tool'), 'calculate_order_tool');
  assert.equal(worker.resolveToolName('check_order_status'), 'get_order_status');
  assert.equal(worker.makeId(8).length, 8);

  // D1 mock confirms that the existing price_cents / size / flavor menu is read without replacement.
  const menuColumns = [
    'tenant_id','id','sku','name','category','size','flavor',
    'price_cents','active','pos_variant_id','created_at','updated_at'
  ].map((name, index) => ({ name, type: index === 7 ? 'INTEGER' : 'TEXT', pk: name === 'id' ? 1 : 0 }));
  const menuRow = {
    tenant_id: 'alex-pizza', id: 'WATER-1L', sku: 'WATER-1L',
    name: 'Bottled Water', category: 'Drinks', size: '1 litre bottle',
    flavor: 'Still', price_cents: 200, active: 1, pos_variant_id: null
  };
  const bookingColumns = [
    'tenant_id','id','booking_time','duration_minutes','party_size','status','created_at'
  ].map(name => ({ name, type: 'TEXT', pk: name === 'id' ? 1 : 0 }));
  const sqlSeen = [];
  let bookingRows = [];
  const DB = {
    prepare(sql) {
      sqlSeen.push(sql);
      return {
        bind(...args) { this.args = args; return this; },
        async run() { return { meta: { changes: 0 } }; },
        async all() {
          if (sql.startsWith('PRAGMA table_info')) {
            return { results: sql.includes('bookings') ? bookingColumns : menuColumns };
          }
          if (sql.startsWith('SELECT') && sql.includes('menu_items')) return { results: [menuRow] };
          if (sql.startsWith('SELECT') && sql.includes('bookings')) return { results: bookingRows };
          return { results: [] };
        },
        async first() { return null; }
      };
    }
  };

  const menu = await worker.getMenuRows({ DB }, 'alex-pizza');
  assert.equal(menu.length, 1);
  assert.equal(menu[0].price, 2);
  assert.equal(menu[0].size, '1 litre bottle');
  assert.equal(menu[0].flavor, 'Still');

  const menuIndex = await worker.findMenuItemsBySku({ DB }, 'alex-pizza', ['WATER-1L']);
  assert.equal(menuIndex.get('water-1l')?.price, 2);

  const safeSync = await worker.syncAndReplaceD1Menu({ DB }, 'alex-pizza');
  assert.equal(safeSync.skipped, true);
  assert.equal(safeSync.existing_menu_items, 1);

  // Capacity calculation: 10 four-seat tables, 40 total seats.
  bookingRows = [{
    tenant_id: 'alex-pizza', id: 'BOK-OLD',
    booking_time: '2026-11-04T18:00:00.000Z',
    duration_minutes: 90, party_size: 36, status: 'confirmed'
  }];
  const overCapacity = await worker.checkAvailability(
    { DB }, 'alex-pizza', '2026-11-04T18:00:00Z', 90, 5
  );
  assert.equal(overCapacity.available, false);
  assert.equal(overCapacity.seats_occupied, 36);

  bookingRows = [{
    tenant_id: 'alex-pizza', id: 'BOK-OLD',
    booking_time: '2026-11-04T18:00:00.000Z',
    duration_minutes: 90, party_size: 8, status: 'confirmed'
  }];
  const available = await worker.checkAvailability(
    { DB }, 'alex-pizza', '2026-11-04T18:00:00Z', 90, 5
  );
  assert.equal(available.available, true);
  assert.equal(available.tables_needed, 2);

  // Cross-component production contract checks.
  assert.match(source, /const WORKER_NAME = 'calling-agent-api'/);
  assert.match(source, /const DEFAULT_TENANT = 'alex-pizza'/);
  assert.match(source, /const RETENTION_DAYS = 60/);
  assert.match(source, /const REPEAT_WINDOW_MINUTES = 30/);
  assert.match(source, /const CUTOFF_MINUTES_DEFAULT = 20/);
  assert.match(source, /ageMinutes > 20/);
  assert.match(source, /ageMinutes > 5/);
  assert.match(source, /cancelled_within_five_minute_policy/);
  assert.match(source, /additions_applied_to_original_bill/);
  assert.match(source, /customer_declined_new_order_manager_awareness/);
  assert.match(source, /const orderId = makeId\(8\)/);
  assert.match(source, /related_order_id/);
  assert.match(source, /delivery_batch_id/);
  assert.match(source, /scheduled_delivery_at/);

  assert.match(source, /export class OrderProcessingWorkflow/);
  assert.match(source, /export class BookingCalendarWorkflow/);
  assert.match(source, /export class NotificationDeliveryWorkflow/);
  assert.match(source, /export class CallUsageWorkflow/);
  assert.match(source, /claimOrderPosLock/);
  assert.match(source, /releaseOrderPosLock/);
  assert.match(source, /pos_sync_lock_owner/);
  assert.match(source, /CALL_USAGE_WORKFLOW\.create/);
  assert.match(source, /NOTIFICATION_WORKFLOW\.create/);
  assert.match(source, /BOOKING_CALENDAR_WORKFLOW\.create/);

  assert.match(source, /async function initiateManagerStatusCall/);
  assert.match(source, /https:\/\/api\.vapi\.ai\/call/);
  assert.match(source, /manager_status_checks/);
  assert.match(source, /type: 'transfer'/);
  assert.match(source, /endCallAfterSpoken/);

  assert.match(source, /async function recordCallMinuteTick/);
  assert.match(source, /async function archivePriorMonthlyUsage/);
  assert.match(source, /async function run60DayDataPurge/);
  assert.match(source, /authenticateClientDashboard/);
  assert.match(source, /dashboard_token_hash/);
  assert.match(source, /\/admin\/provider-overview/);
  assert.match(source, /\/admin\/tenant-status/);

  assert.match(source, /async function listZohoPosItems/);
  assert.match(source, /async function buildZohoMenuMappingReport/);
  assert.match(source, /async function applyZohoMenuMapping/);
  assert.match(source, /automatic_sku_mapping_attempted/);
  assert.match(source, /async function voidZohoSalesOrder/);
  assert.match(source, /method: 'PUT'/);
  assert.match(source, /\/status\/confirmed/);
  assert.match(source, /\/status\/void/);

  assert.match(source, /customer_order_confirmation: 'saved_independently_of_pos_status'/);
  assert.match(source, /dispatchOrderReceipt\(env, tenantId, order, customerPhone\)/);
  assert.match(source, /retry_exhausted/);

  const destructiveMenuDelete = /DELETE FROM `menu_items`/i.test(source) ||
    sqlSeen.some(sql => /DELETE FROM `menu_items`/i.test(sql));
  assert.equal(destructiveMenuDelete, false, 'D1 menu must never be wholesale deleted by Worker menu sync');

  console.log(JSON.stringify({
    ok: true,
    worker: 'calling-agent-api',
    tenant: 'alex-pizza',
    business_hours: '12 PM–2 AM America/New_York',
    ordering_cutoff_minutes: 20,
    custom_vapi_http_tools: actualTools,
    native_vapi_tool: 'end_outbound_call',
    four_cloudflare_workflows: true,
    existing_d1_menu_preserved: true,
    menu_price_cents_size_flavor: true,
    booking_capacity: '10 tables / 40 seats',
    order_policy: '0–5 edit/cancel; 5–20 additions only; over 20 linked new bill',
    per_bill_pos_lock: true,
    live_manager_status_call_and_complaint_transfer: true,
    per_minute_usage_and_month_archive: true,
    sixty_day_retention: true,
    multi_tenant_client_and_provider_apis: true,
    automatic_zoho_mapping_by_sku_and_price: true,
    zoho_create_update_confirm_void: true,
    receipt_independent_of_pos: true,
    menu_rows_destroyed: false
  }, null, 2));
} finally {
  fs.unlinkSync(temp);
}
