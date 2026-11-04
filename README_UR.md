# Alex Pizza Worker — Staging Candidate

یہ build **ابھی staging candidate ہے**۔ GitHub production branch یا Cloudflare Worker پر commit/deploy نہیں کیا گیا۔

## Files اور Cloudflare resources
- `src/index.js` — Cloudflare Worker اور `OrderProcessingWorkflow`
- `wrangler.toml` — D1 اور Workflow binding
- Worker: `alex-pizza-voice-agent`
- D1 binding: `DB`
- D1 database: `calling-agent-db`
- D1 database ID: `c721e81a-0c7a-47f3-bc47-eabe38f2bcb2`
- Workflow binding: `ORDER_WORKFLOW`
- Workflow name: `alex-pizza-order-processing`
- Workflow class: `OrderProcessingWorkflow`

## Vapi tools اور endpoints
- `POST /vapi/alex-pizza/tools`
- `GET /vapi/alex-pizza/tools`
- `POST /vapi/alex-pizza/events` — Vapi `end-of-call-report`
- 12 Worker HTTP tools موجودہ ناموں کے ساتھ رجسٹر ہیں؛ `end_outbound_call` Vapi کا native call-control tool ہے اور اسے Vapi میں الگ configure کرنا ہوگا۔
- `transfer_to_manager` صرف customer complaint/human assistance کے لیے استعمال کریں۔ یہ Worker manager task/alert بناتا ہے؛ خود live call transfer ہونے کا دعویٰ نہیں کرتا۔

## تصدیق شدہ کاروباری اصول
- کاروباری اوقات: **12:00 PM سے 2:00 AM، America/New_York**؛ midnight عبور کرنے کا time check شامل ہے۔ اگر Cloudflare Variables میں `OPEN_HOUR` یا `CLOSE_HOUR` موجود ہوں تو ان کی values بالترتیب `12` اور `2` رکھیں۔
- Reservations: 10 tables، ہر table پر 4 seats، مجموعی حد 40 seats۔ Party size کے مطابق table-equivalent capacity بھی check ہوتی ہے۔ D1 میں final insert ایک ہی conditional SQL statement کے ذریعے دوبارہ seat/table capacity check کرتا ہے، تاکہ concurrent Worker requests local D1 bookings کی حد cross نہ کریں؛ Google Calendar کی external bookings پہلے availability check میں شامل ہوتی ہیں۔
- پہلے 5 منٹ میں cancellation موجودہ Worker order کو cancelled نشان زد کرتی ہے۔ اگر Zoho/kitchen کو order پہلے پہنچ چکا ہو تو manager کو فوری manual stop/reconciliation alert جاتا ہے؛ Worker خود Zoho Sales Order cancellation نہیں کرتا۔
- پہلے 5 منٹ میں change کے لیے مکمل revised `items` array، نیا calculated total، اور `customer_confirmed: true` لازم ہے۔ Worker D1 order update کرتا ہے اور manager کو alert کرتا ہے؛ اگر order پہلے ہی Zoho POS میں جا چکا ہو تو POS copy خودکار طور پر update نہیں ہوتی۔
- 5 منٹ کے بعد اصل order کبھی modify یا cancel نہیں ہوتا۔ AI صارف سے پوچھتا ہے کہ کیا الگ نیا order اصل order کے ساتھ deliver/pickup کروانا ہے۔ YES پر الگ unique bill/reference بنتا ہے اور `related_order_id`، `delivery_batch_id` اور دستیاب ہو تو `scheduled_delivery_at` سے دونوں link ہوتے ہیں؛ delivery کے لیے اصل address دوبارہ استعمال ہوتا ہے۔ Zoho کو combined-order note بھیجا جاتا ہے، مگر چونکہ POS میں دو الگ sales orders رہتے ہیں، kitchen/dispatch کو دونوں کو ایک ہی physical delivery/pickup batch میں handle کرنا ہوگا۔ NO پر اصل order برقرار رہتا ہے اور manager/dashboard awareness task بنتا ہے؛ manager approval یا live transfer نہیں ہوتا۔
- ہر order status/change/cancel کے لیے order reference اور matching customer phone verify ہوتا ہے۔ New order صرف customer کی explicit confirmation کے بعد submit ہوتا ہے۔
- Repeat caller alert 30 منٹ کی window میں deduplicate ہوتا ہے۔
- Call minutes صرف Vapi `end-of-call-report` سے record ہوتے ہیں؛ فی call duration اگلے پورے minute تک round ہوتی ہے اور billing month New York timezone میں بنتا ہے۔
- Operational data کے لیے 60-day scheduled purge ہے؛ invoices، payments اور monthly usage محفوظ رہتے ہیں۔

## موجودہ D1 menu کا تحفظ
- D1 menu ہی source of truth ہے۔ Code میں کوئی hard-coded sample menu باقی نہیں رکھا گیا اور menu sync endpoint destructive نہیں ہے۔
- موجودہ `price_cents` values کو dollars میں convert کرکے پڑھا جاتا ہے؛ `size` اور `flavor` بھی واپس کیے جاتے ہیں۔
- Zoho item IDs کے لیے `ZOHO_ITEM_ID_MAP` JSON variable یا D1 `menu_items.pos_variant_id` استعمال ہوگا۔ موجودہ menu rows کے `pos_variant_id` خالی ہیں، اس لیے ان 16 SKUs کے حقیقی Zoho item IDs map کیے بغیر Zoho POS sync مکمل نہیں ہوگا۔ IDs خود سے generate نہیں کیے جا سکتے۔

## Admin اور manager dashboard
تمام admin routes کو موجودہ admin bearer token اور POST method درکار ہے:
- `/admin/bootstrap` — D1 schema اور additive columns
- `/admin/tenant-status` — tenant کو `active` یا `suspended` کرنا
- `/admin/invoice`، `/admin/manual-payment`، `/admin/usage`
- `/admin/zoho-token`، `/admin/google-calendar-test`
- `/manager` — dashboard UI
- `/manager/data?tenant_id=alex-pizza` اور `/manager/export?tenant_id=alex-pizza` — manager token کے ساتھ tenant-scoped records

`MANAGER_DASHBOARD_TOKEN` الگ Cloudflare Secret کے طور پر درکار ہے۔ اسے Vapi یا Admin token کے طور پر reuse نہ کریں۔ Invoice میں `due_at` دیا ہو تو روزانہ cron due date گزرنے اور invoice `unpaid`/`partially_paid` رہنے پر tenant کو خودکار suspend کرتا ہے۔ `due_at` خالی ہو تو auto-suspension نہیں ہوتی۔ ادائیگی کے بعد admin `/admin/tenant-status` سے tenant کو دوبارہ `active` کر سکتا ہے؛ خودکار reactivation نہیں کی جاتی۔

## Deployment safety
- Secrets/credentials source میں hard-code نہیں کیے گئے۔ `keep_vars = true` موجودہ dashboard variables کو Wrangler deploy کے دوران preserve کرنے کے لیے ہے۔
- Worker code syntax check اور local smoke checks پاس کر چکا ہے۔ حقیقی Cloudflare D1، Workflow، SignalWire، Google Calendar، Zoho POS، Vapi اور concurrent booking end-to-end tests ابھی نہیں ہوئے۔
- Build deploy کرنے سے پہلے `MANAGER_DASHBOARD_TOKEN`، Zoho item mapping، Workflow binding اور تمام existing runtime bindings verify کریں۔ کوئی secret GitHub میں commit نہ کریں۔