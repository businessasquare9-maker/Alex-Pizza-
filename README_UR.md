# Alex Pizza NYC — Production AI Calling Agent

یہ repository نیویارک کے **Alex Pizza** AI Calling Agent کا production source code ہے۔ Cloudflare Worker کا اصل نام **`calling-agent-api`** ہے۔ D1 میں tenant-scoped data محفوظ ہوتا ہے اور چار Cloudflare Workflows orders، bookings، notifications اور call-minute metering سنبھالتے ہیں۔

## Automatic deployment — Cloudflare Workers Builds

Cloudflare Workers Builds میں یہ values استعمال ہوں:

| Setting | Value |
|---|---|
| GitHub repository | `businessasquare9-maker/Alex-Pizza-` |
| Production branch | `main` |
| Root directory | `/` |
| Build command (verification کے لیے تجویز کردہ) | `node verify-build.mjs` |
| Deploy command | `npx wrangler deploy` |

اس JavaScript Worker کے لیے Build command optional ہے۔ اگر Cloudflare Dashboard میں یہ ابھی blank ہے تو Workers Builds پھر بھی ہر `main` push پر Deploy command چلاتی ہے، لیکن pre-deploy verification script نہیں چلتی۔ اسے بھی خودکار کرنے کے لیے **Settings → Builds** میں Build command `node verify-build.mjs` رکھیں۔
| Worker | `calling-agent-api` |

جب GitHub کی `main` branch میں commit push ہوتا ہے تو منسلک Workers Builds production pipeline شروع کرتی ہے۔ Git commit SHA اور Cloudflare Deployment ID الگ چیزیں ہیں۔ اصل Active Deployment اور build logs Cloudflare Worker کے Deployments / build history میں ہوتے ہیں۔

## Cloudflare resources

- Worker: `calling-agent-api`
- D1 binding: `DB`
- D1 database: `calling-agent-db`
- Order Workflow: `ORDER_WORKFLOW` → `alex-pizza-order-processing`
- Call usage Workflow: `CALL_USAGE_WORKFLOW` → `alex-pizza-live-call-usage`
- Notification Workflow: `NOTIFICATION_WORKFLOW` → `alex-pizza-notification-delivery`
- Booking Workflow: `BOOKING_CALENDAR_WORKFLOW` → `alex-pizza-booking-calendar-sync`
- روزانہ maintenance cron: `17 10 * * *` UTC

تمام secrets اور runtime credentials Cloudflare میں ہی رہیں؛ GitHub source میں hard-code نہ کریں۔

## Vapi کے 13 tools

Worker کے 12 custom HTTP tools:

`send_booking_notification`, `transfer_to_manager`, `request_manager_status_check`, `book_table`, `check_table_availability`, `request_order_cancel`, `submit_order`, `request_order_change`, `check_order_status`, `get_business_hours`, `calculate_order_tool`, `get_menu`.

تیرہواں `end_outbound_call` Vapi کا native call-control tool ہے؛ اسے Vapi میں الگ configure کیا جاتا ہے، Worker HTTP handler نہیں ہے۔

Vapi endpoints:

- `POST /vapi/alex-pizza/tools`
- `GET /vapi/alex-pizza/tools`
- `POST /vapi/alex-pizza/events`

## کاروباری اوقات اور booking

- Time zone: `America/New_York`
- اوقات: **دوپہر 12 بجے سے رات 2 بجے تک**، midnight crossing کے ساتھ۔
- Closing سے 20 منٹ پہلے نئے orders اور reservations بند۔
- 10 tables × 4 seats = 40 seats زیادہ سے زیادہ۔
- Booking capacity میں D1 reservations اور Google Calendar کی external reservations شامل ہوتی ہیں؛ آخری D1 insert دوبارہ capacity check کرتا ہے۔
- ایک ہی customer کی 30 منٹ کے اندر repeat call پر alert بنتا ہے، اور اسی window کے duplicate alerts روک دیے جاتے ہیں۔

## Order policy

| آرڈر کی عمر | اجازت |
|---|---|
| 0–5 منٹ | Customer کی واضح confirmation کے بعد مکمل change یا cancellation |
| 5 منٹ سے زیادہ، 20 منٹ تک | صرف نئے items اصل bill میں add؛ cancellation، item removal یا مکمل replacement نہیں |
| 20 منٹ سے زیادہ | اصل bill مکمل lock؛ customer کی رضامندی پر الگ linked bill بنایا جا سکتا ہے |

ہر bill کی 8-character reference ہوتی ہے۔ Status، change اور cancellation کے لیے order reference اور customer phone دونوں verify ہوتے ہیں۔ ہر bill tenant کے اندر D1 میں الگ محفوظ ہوتا ہے۔

## Order، Zoho POS اور notifications

1. Customer order کی واضح confirmation دیتا ہے۔
2. Worker bill اور order items کو D1 میں محفوظ کرتا ہے۔
3. Customer receipt اور manager notification کی dispatch کوشش Zoho POS کے نتیجے کا انتظار کیے بغیر ہوتی ہے۔
4. SignalWire delivery record D1 میں بنتا ہے اور `NOTIFICATION_WORKFLOW` ناکام notifications کو retry کرتا ہے۔
5. `ORDER_WORKFLOW` Zoho Sales Order create یا update کرتا ہے اور اسے Confirmed کرنے کی کوشش کرتا ہے۔
6. ایک bill کے لیے D1 POS lease lock لگتا ہے؛ initial order اور subsequent edits/additions الگ الگ duplicate Zoho bills نہیں بناتے۔ ہر workflow lock لینے کے بعد D1 سے تازہ bill دوبارہ load کرتا ہے۔
7. پہلے پانچ منٹ میں cancellation پر اگر Zoho Sales Order پہلے بن چکا ہو تو اسے Void کرنے کی کوشش ہوتی ہے۔

Zoho POS failure customer کے confirmed D1 order، customer receipt یا manager notification کو delete/reject نہیں کرتا؛ POS status الگ محفوظ رہتا ہے۔

## D1 Menu اور Zoho mapping

D1 `menu_items` اصل menu source of truth ہے۔ Worker ان کالمز کو پڑھتا ہے:

`tenant_id, sku, name, category, size, flavor, price_cents, active, pos_variant_id`.

Menu sync destructive نہیں؛ existing rows delete یا reseed نہیں ہوتیں۔ Legacy `price` کو additive migration کے ذریعے `price_cents` میں convert کیا جاتا ہے۔

اگر `pos_variant_id` خالی ہو تو Worker Zoho POS item list میں unique exact SKU اور active/sellable item تلاش کرتا ہے۔ Duplicate SKU، disabled item، missing SKU یا پہلے سے موجود conflicting D1 ID کو guess یا overwrite نہیں کیا جاتا۔

Customer bill کے لیے D1 `price_cents` اصل price ہے۔ اگر Zoho catalog rate مختلف ہو تو mapping report میں `price_override_required` دکھایا جاتا ہے؛ Zoho Sales Order line میں D1 کا approved rate بھیجا جاتا ہے۔ Zoho catalog کی قیمت خود سے تبدیل نہیں ہوتی۔ CSV reconciliation template repository میں شامل ہے۔

Zoho POS OAuth scopes:
- `ZohoPOSAPI.items.READ`
- `ZohoPOSAPI.salesorders.CREATE`
- `ZohoPOSAPI.salesorders.UPDATE`

## Manager status call اور complaint transfer

Order-status سوال پر AI پہلے phone اور bill reference verify کرتا ہے، customer کو hold پر رکھتا ہے، Vapi کے configured manager assistant سے outbound call کرتا ہے، manager کا جواب محفوظ کرتا ہے اور اسی inbound customer call پر factual status واپس سناتا ہے۔ AI status خود سے نہیں بناتا۔

Live transfer صرف explicit complaint پر ہے۔ Live Vapi control URL ملنے پر transfer command جاتا ہے؛ ورنہ manager callback task اور notification بنتی ہے۔ AI manager کے answer کیے بغیر transfer کامیاب ہونے کا دعویٰ نہیں کرتا۔

## Usage، retention اور tenant controls

- `CALL_USAGE_WORKFLOW` active calls کے دوران ہر منٹ usage tick کرتا ہے؛ Vapi end-of-call report final duration reconcile کرتا ہے۔
- Usage New York calendar month کے حساب سے محفوظ ہوتا ہے؛ ہر نئے مہینے کے پہلے New York دن پچھلا month archive ہوتا ہے۔
- Operational records 60 دن rolling retention میں رہتے ہیں۔ 61ویں دن پہلا دن حذف ہوتا ہے، 62ویں دن دوسرا دن، اسی طرح۔ Invoices، payments، tenants اور monthly usage history برقرار رہتی ہے۔
- Client dashboard token hashed صورت میں D1 میں محفوظ ہوتا ہے؛ client صرف اپنے tenant کا data دیکھتا ہے۔
- Provider admin تمام clients کا overview دیکھ سکتا ہے، invoices/payments record کر سکتا ہے، اور tenant کو activate/suspend کر سکتا ہے۔
- Due date کے بعد unpaid/partially-paid invoice tenant کو خودکار suspend کر سکتی ہے؛ payment کے بعد provider admin اسے دوبارہ activate کرتا ہے۔

## Dashboard APIs

- Manager UI: `GET /manager`
- Manager data/export: `GET /manager/data`, `GET /manager/export`
- Client data/export: `GET /client/data`, `GET /client/export` — tenant صرف dashboard token سے identify ہوتا ہے۔
- Provider overview/control: protected `POST /admin/*` routes۔

Worker میں dashboard data/API اور tenant controls موجود ہیں؛ موجودہ `/manager` ایک basic operational viewer ہے۔ آپ کی planned animated client/provider dashboard UI الگ frontend کے طور پر بنائی جا سکتی ہے اور ان APIs سے data لے سکتی ہے۔

## Build verification

`verify-build.mjs` Worker module import/syntax، New York hours، Vapi tool names، D1 cents/menu compatibility، booking capacity، order policy، چاروں Workflows، bill-level POS lock، manager calls/transfers، tenant isolation، retention اور Zoho sync paths کو check کرتا ہے۔

```bash
node verify-build.mjs
```

D1 کے read-only inspection queries `D1_PREDEPLOY_CHECKS.sql` میں ہیں۔
