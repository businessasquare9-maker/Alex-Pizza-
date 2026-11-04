import { WorkflowEntrypoint } from 'cloudflare:workers';

// ===== BLOCK 1/10: Header and configuration =====
/**
 * ALEX PIZZA NYC - VOICE AGENT WORKER
 * Refined production build in 10 paste blocks.
 *
 * IMPORTANT: This source contains no phone number values.
 * Manager, store, WhatsApp and SMS numbers are read at runtime from
 * Cloudflare Secrets / Variables only. Dynamic customer numbers come from
 * the Vapi tool call payload and are never written into this file.
 *
 * Paste Blocks 1 through 10, in order, into one Cloudflare Worker module.
 */

const WORKER_NAME = 'calling-agent-api';
const DEFAULT_TENANT = 'alex-pizza';
const CURRENCY = 'USD';
const TIME_ZONE_DEFAULT = 'America/New_York';
const ZOHO_TOKEN_URL_DEFAULT = 'https://accounts.zoho.com/oauth/v2/token';
const GOOGLE_TOKEN_URL_DEFAULT = 'https://oauth2.googleapis.com/token';
const GOOGLE_CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

const MAX_TOOL_CALLS = 25;
const MAX_BODY_BYTES = 1000000;
const MAX_MENU_ROWS = 200;
const MAX_ORDER_ITEMS = 50;
const DEFAULT_CALL_SECONDS = 180;
const RETENTION_DAYS = 60;
const REPEAT_WINDOW_MINUTES = 30;
const MAX_TABLES_DEFAULT = 10;
const OPEN_HOUR_DEFAULT = 12;
const CLOSE_HOUR_DEFAULT = 2;
const CUTOFF_MINUTES_DEFAULT = 20;
const SLOT_MIN_MINUTES = 30;
const SLOT_MAX_MINUTES = 240;
const SLOT_DEFAULT_MINUTES = 90;

const ALLOWED_TABLES = new Set([
  'tenants', 'audit_log', 'bookings', 'business_settings', 'calls',
  'integration_status', 'manager_tasks', 'manager_status_checks', 'call_usage_ticks', 'menu_items', 'notifications',
  'order_change_requests', 'order_items', 'orders', 'zoho_oauth_tokens',
  'monthly_call_usage', 'manual_payments', 'invoices'
]);

const TENANT_COLUMNS = [
  'tenant_id', 'client_id', 'business_id', 'restaurant_id', 'tenantid', 'clientid'
];

const ENV_KEYS = {
  toolSecret: ['TOOL_SHARED_SECRET', 'VAPI_TOOL_SECRET', 'AGENT_TOOL_SECRET'],
  adminToken: ['ADMIN_API_TOKEN', 'ADMIN_SECRET', 'WORKER_ADMIN_TOKEN'],
  managerDashboardToken: ['MANAGER_DASHBOARD_TOKEN'],
  managerPhones: [
    'MANAGER_PHONE', 'MANAGER_PHONES', 'MANAGER_WHATSAPP',
    'MANAGER_WHATSAPP_PHONE', 'ALERT_PHONE', 'WHATSAPP_MANAGER_PHONE',
    'OWNER_PHONE', 'NOTIFY_PHONE'
  ],
  businessPhones: [
    'BUSINESS_PHONE', 'STORE_PHONE', 'RESTAURANT_PHONE', 'SMS_FROM_PHONE',
    'WHATSAPP_FROM_PHONE', 'SIGNALWIRE_PHONE_NUMBER', 'TWILIO_PHONE_NUMBER', 'VAPI_PHONE_NUMBER',
    'CALLER_ID', 'SENDER_PHONE'
  ],
  phoneBook: ['PHONE_CONTACTS', 'PHONE_BOOK', 'NOTIFICATION_CONTACTS'],
  allowedOrigins: ['ALLOWED_ORIGINS', 'CORS_ALLOWED_ORIGINS'],
  webhookUrl: ['NOTIFICATION_WEBHOOK_URL', 'MESSAGING_WEBHOOK_URL'],
  webhookToken: ['NOTIFICATION_WEBHOOK_TOKEN', 'MESSAGING_WEBHOOK_TOKEN'],
  signalwireProject: ['SIGNALWIRE_PROJECT_ID'],
  signalwireToken: ['SIGNALWIRE_API_TOKEN'],
  signalwireSpace: ['SIGNALWIRE_SPACE_URL'],
  managerChannel: ['MANAGER_CHANNEL'],
  zohoTokenUrl: ['ZOHO_TOKEN_URL', 'ZOHO_ACCOUNTS_TOKEN_URL'],
  zohoClientId: ['ZOHO_CLIENT_ID'],
  zohoClientSecret: ['ZOHO_CLIENT_SECRET'],
  zohoPosUrl: ['ZOHO_POS_ORDER_URL', 'ZOHO_ORDER_WEBHOOK_URL'],
  zohoRefreshToken: ['ZOHO_REFRESH_TOKEN'],
  zohoTenant: ['ZOHO_TENANT_ID'],
  zohoOrganization: ['ZOHO_ORGANIZATION_ID'],
  zohoCustomer: ['ZOHO_CUSTOMER_ID'],
  zohoItemIdMap: ['ZOHO_ITEM_ID_MAP'],
  zohoApiBaseUrl: ['ZOHO_API_BASE_URL'],
  googleClientId: ['GOOGLE_CLIENT_ID'],
  googleClientSecret: ['GOOGLE_CLIENT_SECRET'],
  googleRefreshToken: ['GOOGLE_REFRESH_TOKEN'],
  googleCalendarId: ['GOOGLE_CALENDAR_ID'],
  googleTokenUrl: ['GOOGLE_TOKEN_URL'],
  callerSalt: ['CALLER_HASH_SALT', 'TOOL_SHARED_SECRET', 'ADMIN_API_TOKEN'],
  storeRawPhone: ['STORE_RAW_CALLER_PHONE'],
  requireCustomerPhone: ['REQUIRE_CUSTOMER_PHONE'],
  allowManualTotal: ['ALLOW_MANUAL_TOTAL'],
  vapiApiKey: ['VAPI_PRIVATE_API_KEY', 'VAPI_API_KEY', 'VAPI_TOKEN'],
  vapiAssistantId: ['VAPI_MANAGER_ASSISTANT_ID', 'VAPI_ASSISTANT_ID'],
  vapiPhoneNumberId: ['VAPI_PHONE_NUMBER_ID'],
  vapiPublicApiKey: ['VAPI_PUBLIC_API_KEY'],
  vapiControlAuth: ['VAPI_CONTROL_AUTHENTICATION_ENABLED']
};

const PHONE_KEY_HINT = /phone|whatsapp|mobile|sms|number|contact|recipient|msisdn|e164/i;
const MANAGER_HINT = /manager|owner|admin|alert|notify|notification/i;
const BUSINESS_HINT = /business|store|restaurant|shop|sender|from|signalwire|twilio|vapi|caller|sms|default|main|office/i;
const GENERIC_HINT = /^(phone|phone_number|contact_number|whatsapp_number|hotline|support_phone)$/i;

const PURGE_TABLES = [
  'audit_log', 'bookings', 'calls', 'call_usage_ticks', 'notifications', 'manager_tasks', 'manager_status_checks',
  'order_change_requests', 'order_items', 'orders'
];

const DQ = String.fromCharCode(34);
const NL = String.fromCharCode(10);
const columnCache = new Map();
let schemaPromise = null;

// ===== BLOCK 2/10: Shared utilities, phone resolution and security =====
class AppError extends Error {
  constructor(message, code = 'bad_request', status = 400, details = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details || {};
  }
}

function nowIso() { return new Date().toISOString(); }
function norm(value) { return String(value ?? '').trim().toLowerCase(); }
function clean(value, max = 500) { return String(value ?? '').trim().slice(0, max); }
function roundMoney(n) {
  const value = Number(n);
  return Number.isFinite(value) ? Math.round((value + Number.EPSILON) * 100) / 100 : 0;
}
function parseMoney(value) {
  if (typeof value === 'number') return roundMoney(value);
  const n = Number(String(value ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? roundMoney(n) : 0;
}
function money(n) { return '$' + roundMoney(n).toFixed(2); }

function makeId(length = 12) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => alphabet[byte % alphabet.length]).join('');
}

function quoteIdent(name) {
  const value = String(name ?? '');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new AppError('Unsafe SQL identifier rejected.', 'unsafe_identifier', 500);
  }
  return DQ + value.split(DQ).join(DQ + DQ) + DQ;
}
function q(name) { return quoteIdent(name); }

function envValue(env, names) {
  for (const name of names || []) {
    const value = env?.[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}
function envFlag(env, names, fallback = false) {
  const raw = envValue(env, names);
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(norm(raw));
}
function envNumber(env, names, fallback, min, max) {
  const raw = envValue(env, names);
  const value = Number(raw);
  if (!raw || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function normalizePhone(value) {
  let raw = String(value ?? '').trim();
  if (!raw || raw.startsWith('{') || raw.startsWith('[')) return '';
  raw = raw
    .replace(/^whatsapp:/i, '')
    .replace(/^tel:/i, '')
    .replace(/^sms:/i, '')
    .trim();
  if (raw.startsWith('00')) raw = '+' + raw.slice(2);
  let digits = raw.replace(/[^+0-9]/g, '');
  if (digits.startsWith('+')) digits = '+' + digits.slice(1).replace(/[+]/g, '');
  else digits = digits.replace(/[+]/g, '');
  if (!new RegExp('^[+]?[0-9]{8,15}$').test(digits)) return '';
  return digits;
}
function normalizePhoneList(value) {
  const raw = String(value ?? '');
  if (raw.trim().startsWith('{') || raw.trim().startsWith('[')) return [];
  const parts = raw.split(/[,;|]+/).map(normalizePhone).filter(Boolean);
  return Array.from(new Set(parts)).slice(0, 10);
}
function contactValueToPhones(value) {
  if (value == null) return [];
  if (typeof value === 'string' || typeof value === 'number') return normalizePhoneList(value);
  if (Array.isArray(value)) return value.flatMap(contactValueToPhones);
  if (typeof value === 'object') {
    return normalizePhoneList(value.phone || value.number || value.value || value.e164 || value.whatsapp || '');
  }
  return [];
}
function phoneBookFromEnv(env) {
  const raw = envValue(env, ENV_KEYS.phoneBook);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return Object.fromEntries(parsed.map((item, index) => [
        clean(item?.role || item?.name || item?.label || String(index), 80), item
      ]));
    }
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}
function contactMatchesRole(key, role) {
  const k = norm(key).replace(/[ ._-]+/g, '_');
  if (role === 'manager') {
    if (/business|store|sender|from|customer|twilio|vapi/.test(k)) return false;
    return /manager|owner|admin|alert|notify|whatsapp|primary|default/.test(k);
  }
  if (/manager|owner|alert/.test(k) && !/from|sender|business|store/.test(k)) return false;
  return /business|store|restaurant|shop|sender|from|twilio|vapi|caller|sms|default|main|office|whatsapp/.test(k);
}
function resolvePhones(env, role) {
  const explicitKeys = role === 'manager' ? ENV_KEYS.managerPhones : ENV_KEYS.businessPhones;
  const found = [];
  for (const key of explicitKeys) found.push(...normalizePhoneList(env?.[key]));

  const book = phoneBookFromEnv(env);
  for (const [key, value] of Object.entries(book)) {
    if (!contactMatchesRole(key, role)) continue;
    found.push(...contactValueToPhones(value));
  }

  if (!found.length) {
    for (const key of Object.keys(env || {})) {
      if (!PHONE_KEY_HINT.test(key)) continue;
      const isManager = MANAGER_HINT.test(key);
      const isBusiness = BUSINESS_HINT.test(key);
      if (role === 'manager' && !(isManager || GENERIC_HINT.test(key)) && !isBusiness) continue;
      if (role === 'manager' && isBusiness && !isManager && !GENERIC_HINT.test(key)) continue;
      if (role === 'business' && !isBusiness) continue;
      if (role === 'business' && isManager && !isBusiness) continue;
      found.push(...normalizePhoneList(env[key]));
    }
  }

  return Array.from(new Set(found)).slice(0, 10);
}
function requirePhones(env, role) {
  const phones = resolvePhones(env, role);
  if (!phones.length) {
    const preferred = role === 'manager' ? ENV_KEYS.managerPhones[0] : ENV_KEYS.businessPhones[0];
    throw new AppError(
      'No ' + role + ' phone configured. Set ' + preferred + ' or PHONE_CONTACTS in Cloudflare.',
      'phone_config_missing',
      503,
      { role, preferred_variable: preferred }
    );
  }
  return phones;
}
function customerPhoneFrom(args, required = false) {
  const value = args?.customer_phone ?? args?.phone ?? args?.caller_phone ?? args?.from ?? args?.customerNumber;
  const normalized = normalizePhone(value);
  if (required && !normalized) {
    throw new AppError('A valid customer_phone is required in tool arguments.', 'customer_phone_required', 400);
  }
  return normalized;
}
async function callerFingerprint(env, phoneValue) {
  const normalized = normalizePhone(phoneValue);
  if (!normalized) return 'anon';
  const salt = envValue(env, ENV_KEYS.callerSalt) || 'alex-pizza-caller-ref';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + '|' + normalized));
  return 'cr_' + Array.from(new Uint8Array(digest)).slice(0, 12)
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function redact(text) {
  return String(text ?? '').replace(new RegExp('[+]?[0-9][0-9 ().-]{7,}[0-9]', 'g'), '[redacted]');
}
function sanitizeDetails(value, depth = 0) {
  if (depth > 3) return '[truncated]';
  if (typeof value === 'string') return redact(clean(value, 500));
  if (Array.isArray(value)) return value.slice(0, 20).map(item => sanitizeDetails(item, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 30)) {
      if (/secret|token|password|authorization|phone|number/i.test(key)) continue;
      out[clean(key, 50)] = sanitizeDetails(item, depth + 1);
    }
    return out;
  }
  return value;
}
function publicError(err) {
  const error = {
    ok: false,
    error: redact(clean(err?.message || 'Unexpected error', 300)),
    code: clean(err?.code || 'internal_error', 80)
  };
  if (err instanceof AppError && Object.keys(err.details || {}).length) {
    error.details = sanitizeDetails(err.details);
  }
  return error;
}
function safeLog(err) {
  try {
    console.error(JSON.stringify({
      level: 'error',
      code: clean(err?.code || 'internal_error', 80),
      message: redact(clean(err?.message || 'Unexpected error', 300))
    }));
  } catch {}
}

function parseArgs(raw) {
  if (raw == null || raw === '') return {};
  if (Array.isArray(raw)) throw new AppError('Tool arguments must be a JSON object.', 'invalid_tool_arguments', 400);
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(String(raw));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed;
  } catch {
    throw new AppError('Tool arguments must be valid JSON.', 'invalid_tool_arguments', 400);
  }
}
function toolResult(callId, value) {
  return { toolCallId: String(callId ?? 'unknown'), result: JSON.stringify(value) };
}

function allowedOrigin(request, env) {
  const configured = envValue(env, ENV_KEYS.allowedOrigins);
  if (!configured) return '*';
  const list = configured.split(/[,;]+/).map(item => item.trim()).filter(Boolean);
  const origin = request?.headers.get('origin') || '';
  return origin && list.includes(origin) ? origin : 'null';
}
function responseHeaders(request, env, extra = {}) {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': allowedOrigin(request, env),
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-agent-tool-secret, x-tool-secret, x-vapi-secret, x-admin-key, x-admin-token, x-admin-secret',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...extra
  };
}
function json(request, env, data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: responseHeaders(request, env, extra) });
}
function preflight(request, env) {
  return new Response(null, { status: 204, headers: responseHeaders(request, env) });
}
function httpErrorResponse(request, env, err) {
  const status = err instanceof AppError ? err.status : 500;
  return json(request, env, publicError(err), status);
}
function requireMethod(request, env, method) {
  if (request.method === method) return null;
  return json(request, env, { ok: false, error: 'Method not allowed', code: 'method_not_allowed' }, 405, { Allow: method });
}

async function hashSecret(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value || '')));
  return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function secureEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b))
  ]);
  const aa = new Uint8Array(ha);
  const bb = new Uint8Array(hb);
  let diff = aa.length ^ bb.length;
  for (let i = 0; i < aa.length; i++) diff |= aa[i] ^ bb[i];
  return diff === 0;
}
function bearerOrHeader(request, names) {
  const auth = request.headers.get('authorization') || '';
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  if (bearer) return bearer;
  for (const name of names) {
    const value = request.headers.get(name);
    if (value) return value.trim();
  }
  return '';
}

async function requireToolAuth(request, env) {
  const envKey = ENV_KEYS.toolSecret.find((name) => {
    const value = env?.[name];
    return (
      (typeof value === 'string' && value.trim()) ||
      (typeof value === 'number' && Number.isFinite(value))
    );
  });

  const expected = envValue(env, ENV_KEYS.toolSecret);

  if (!expected) {
    throw new AppError(
      'Tool authentication is not configured.',
      'tool_auth_unconfigured',
      503,
      { env_key_found: false }
    );
  }

  const auth = request.headers.get('authorization') || '';
  const bearer = auth.toLowerCase().startsWith('bearer ');

  const headerNames = [
    'x-agent-tool-secret',
    'x-tool-secret',
    'x-vapi-secret'
  ];

  let suppliedHeader = '';
  let supplied = '';

  if (bearer) {
    supplied = auth.slice(7).trim();
    suppliedHeader = 'authorization_bearer';
  } else {
    for (const name of headerNames) {
      const value = request.headers.get(name);
      if (value) {
        supplied = value.trim();
        suppliedHeader = name;
        break;
      }
    }
  }

  if (!(await secureEqual(supplied, expected))) {
    throw new AppError(
      'Unauthorized tool request.',
      'unauthorized',
      401,
      {
        env_key_in_use: envKey,
        received_header: suppliedHeader || 'none',
        supplied_value_present: Boolean(supplied)
      }
    );
  }
}

function vapiControlHeaders(env) {
  const headers = { 'Content-Type': 'application/json' };
  if (envFlag(env, ENV_KEYS.vapiControlAuth, false)) {
    const publicKey = envValue(env, ENV_KEYS.vapiPublicApiKey);
    if (!publicKey) throw new AppError('VAPI_PUBLIC_API_KEY is required because Vapi live call control authentication is enabled.', 'vapi_control_auth_key_missing', 503);
    headers.Authorization = 'Bearer ' + publicKey;
  }
  return headers;
}

async function requireAdminAuth(request, env) {
  const expected = envValue(env, ENV_KEYS.adminToken);
  if (!expected) throw new AppError('ADMIN_API_TOKEN is not configured.', 'admin_auth_unconfigured', 503);
  const supplied = bearerOrHeader(request, ['x-admin-key', 'x-admin-token', 'x-admin-secret']);
  if (!(await secureEqual(supplied, expected))) {
    throw new AppError('Unauthorized admin request.', 'unauthorized', 401);
  }
}
async function readJson(request, env) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_BODY_BYTES) throw new AppError('Request body is too large.', 'body_too_large', 413);
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    throw new AppError('Request body is too large.', 'body_too_large', 413);
  }
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    throw new AppError('Request body must be valid JSON.', 'invalid_json', 400);
  }
}
function validateTenant(value) {
  const tenantId = norm(clean(value || DEFAULT_TENANT, 64));
  if (!/^[a-z0-9-]{1,64}$/.test(tenantId)) {
    throw new AppError('Invalid tenant identifier.', 'invalid_tenant', 400);
  }
  return tenantId;
}
function assertHttpsUrl(raw, code) {
  let url;
  try { url = new URL(String(raw)); }
  catch { throw new AppError('Configured URL is invalid.', code, 503); }
  if (url.protocol !== 'https:') throw new AppError('Configured URL must use HTTPS.', code, 503);
  return url.toString();
}
async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ===== BLOCK 3/10: D1 schema bootstrap and safe data helpers =====
const SCHEMA_STATEMENTS = [
  'CREATE TABLE IF NOT EXISTS `tenants` (`tenant_id` TEXT NOT NULL PRIMARY KEY, `name` TEXT, `timezone` TEXT, `status` TEXT NOT NULL DEFAULT \'active\', `suspended_reason` TEXT, `dashboard_token_hash` TEXT, `dashboard_token_created_at` TEXT, `created_at` TEXT, `updated_at` TEXT)',
  'CREATE TABLE IF NOT EXISTS `business_settings` (`tenant_id` TEXT NOT NULL, `id` TEXT NOT NULL, `setting_key` TEXT, `setting_value` TEXT, `created_at` TEXT, PRIMARY KEY (`tenant_id`, `id`))',
  'CREATE TABLE IF NOT EXISTS `audit_log` (`tenant_id` TEXT NOT NULL, `id` TEXT NOT NULL, `event` TEXT, `details` TEXT, `created_at` TEXT, PRIMARY KEY (`tenant_id`, `id`))',
  'CREATE TABLE IF NOT EXISTS `integration_status` (`tenant_id` TEXT NOT NULL, `id` TEXT NOT NULL, `provider` TEXT, `status` TEXT, `details` TEXT, `created_at` TEXT, PRIMARY KEY (`tenant_id`, `id`))',
  'CREATE TABLE IF NOT EXISTS `menu_items` (`tenant_id` TEXT NOT NULL, `id` TEXT NOT NULL, `sku` TEXT, `name` TEXT NOT NULL, `category` TEXT, `size` TEXT, `flavor` TEXT, `price_cents` INTEGER NOT NULL DEFAULT 0, `price` REAL, `active` INTEGER NOT NULL DEFAULT 1, `pos_variant_id` TEXT, `created_at` TEXT, `updated_at` TEXT, PRIMARY KEY (`tenant_id`, `id`))',
  'CREATE TABLE IF NOT EXISTS `bookings` (`tenant_id` TEXT NOT NULL, `id` TEXT NOT NULL, `booking_time` TEXT NOT NULL, `duration_minutes` INTEGER NOT NULL DEFAULT 90, `party_size` INTEGER, `customer_name` TEXT, `customer_phone` TEXT, `caller_hash` TEXT, `status` TEXT, `notes` TEXT, `created_at` TEXT, `updated_at` TEXT, PRIMARY KEY (`tenant_id`, `id`))',
  'CREATE TABLE IF NOT EXISTS `calls` (`tenant_id` TEXT NOT NULL, `id` TEXT NOT NULL, `call_id` TEXT, `customer_phone` TEXT, `caller_hash` TEXT, `purpose` TEXT, `direction` TEXT, `status` TEXT, `started_at` TEXT, `duration_seconds` INTEGER, `billable_minutes` INTEGER NOT NULL DEFAULT 0, `ended_at` TEXT, `created_at` TEXT, PRIMARY KEY (`tenant_id`, `id`))',
  'CREATE TABLE IF NOT EXISTS `manager_tasks` (`tenant_id` TEXT NOT NULL, `id` TEXT NOT NULL, `task_id` TEXT, `title` TEXT, `description` TEXT, `priority` TEXT, `status` TEXT, `caller_hash` TEXT, `dedupe_key` TEXT, `created_at` TEXT, PRIMARY KEY (`tenant_id`, `id`))',
  'CREATE TABLE IF NOT EXISTS `manager_status_checks` (`tenant_id` TEXT NOT NULL, `id` TEXT NOT NULL, `order_reference` TEXT NOT NULL, `customer_phone` TEXT, `caller_hash` TEXT, `manager_phone` TEXT, `inbound_call_id` TEXT, `outbound_call_id` TEXT, `status` TEXT, `manager_response` TEXT, `started_at` TEXT, `completed_at` TEXT, `created_at` TEXT, `updated_at` TEXT, PRIMARY KEY (`tenant_id`, `id`))',
  'CREATE TABLE IF NOT EXISTS `call_usage_ticks` (`tenant_id` TEXT NOT NULL, `id` TEXT NOT NULL, `call_id` TEXT NOT NULL, `minute_index` INTEGER NOT NULL, `month` TEXT NOT NULL, `counted_at` TEXT NOT NULL, `created_at` TEXT NOT NULL, PRIMARY KEY (`tenant_id`, `id`))',
  'CREATE TABLE IF NOT EXISTS `notifications` (`tenant_id` TEXT NOT NULL, `id` TEXT NOT NULL, `notification_id` TEXT, `recipient_phone` TEXT, `sender_phone` TEXT, `message` TEXT, `notification_type` TEXT, `channel` TEXT, `status` TEXT, `provider_message_id` TEXT, `metadata` TEXT, `created_at` TEXT, PRIMARY KEY (`tenant_id`, `id`))',
  'CREATE TABLE IF NOT EXISTS `orders` (`tenant_id` TEXT NOT NULL, `id` TEXT NOT NULL, `order_id` TEXT, `customer_name` TEXT, `customer_phone` TEXT, `caller_hash` TEXT, `order_type` TEXT, `total` REAL NOT NULL DEFAULT 0, `currency` TEXT, `items_json` TEXT, `status` TEXT, `notes` TEXT, `created_at` TEXT, `updated_at` TEXT, PRIMARY KEY (`tenant_id`, `id`))',
  'CREATE TABLE IF NOT EXISTS `order_items` (`tenant_id` TEXT NOT NULL, `id` TEXT NOT NULL, `order_id` TEXT, `sku` TEXT, `name` TEXT, `category` TEXT, `unit_price` REAL NOT NULL DEFAULT 0, `quantity` INTEGER NOT NULL DEFAULT 1, `line_total` REAL NOT NULL DEFAULT 0, `created_at` TEXT, PRIMARY KEY (`tenant_id`, `id`))',
  'CREATE TABLE IF NOT EXISTS `order_change_requests` (`tenant_id` TEXT NOT NULL, `id` TEXT NOT NULL, `order_id` TEXT, `caller_hash` TEXT, `requested_change` TEXT, `reason` TEXT, `status` TEXT, `created_at` TEXT, PRIMARY KEY (`tenant_id`, `id`))',
  'CREATE TABLE IF NOT EXISTS `monthly_call_usage` (`tenant_id` TEXT NOT NULL, `month` TEXT NOT NULL, `total_minutes` INTEGER NOT NULL DEFAULT 0, `last_call_at` TEXT, `status` TEXT, `updated_at` TEXT, PRIMARY KEY (`tenant_id`, `month`))',
  'CREATE TABLE IF NOT EXISTS `manual_payments` (`tenant_id` TEXT NOT NULL, `id` TEXT NOT NULL, `payment_id` TEXT, `amount` REAL NOT NULL, `currency` TEXT NOT NULL DEFAULT \'USD\', `method` TEXT, `reference` TEXT, `notes` TEXT, `recorded_by` TEXT, `created_at` TEXT, PRIMARY KEY (`tenant_id`, `id`))',
  'CREATE TABLE IF NOT EXISTS `invoices` (`tenant_id` TEXT NOT NULL, `id` TEXT NOT NULL, `invoice_id` TEXT, `billing_month` TEXT, `minutes` INTEGER, `amount_due` REAL, `amount_paid` REAL DEFAULT 0, `status` TEXT, `due_at` TEXT, `created_at` TEXT, `updated_at` TEXT, PRIMARY KEY (`tenant_id`, `id`))',
  'CREATE TABLE IF NOT EXISTS `zoho_oauth_tokens` (`tenant_id` TEXT NOT NULL PRIMARY KEY, `access_token` TEXT, `refresh_token` TEXT, `expires_at` INTEGER, `updated_at` TEXT)',
  'CREATE INDEX IF NOT EXISTS `idx_menu_tenant_sku` ON `menu_items` (`tenant_id`, `sku`)',
  'CREATE INDEX IF NOT EXISTS `idx_bookings_tenant_time` ON `bookings` (`tenant_id`, `booking_time`)',
  'CREATE INDEX IF NOT EXISTS `idx_calls_tenant_time` ON `calls` (`tenant_id`, `created_at`)',
  'CREATE INDEX IF NOT EXISTS `idx_notifications_tenant_time` ON `notifications` (`tenant_id`, `created_at`)',
  'CREATE INDEX IF NOT EXISTS `idx_orders_tenant_time` ON `orders` (`tenant_id`, `created_at`)',
  'CREATE INDEX IF NOT EXISTS `idx_tasks_tenant_time` ON `manager_tasks` (`tenant_id`, `created_at`)'
];

async function ensureSchema(env) {
  if (!env?.DB) throw new AppError('D1 binding DB is missing.', 'db_binding_missing', 503);
  if (schemaPromise) return schemaPromise;
  schemaPromise = (async () => {
    let tablesChecked = 0;
    for (const statement of SCHEMA_STATEMENTS) {
      try {
        await env.DB.prepare(statement).run();
        tablesChecked++;
      } catch (err) {
        if (!statement.startsWith('CREATE INDEX IF NOT EXISTS')) throw err;
      }
    }
    // Additive migrations for databases created by earlier Worker versions.
    for (const migration of [
      "ALTER TABLE `tenants` ADD COLUMN `status` TEXT NOT NULL DEFAULT 'active'",
      'ALTER TABLE `tenants` ADD COLUMN `suspended_reason` TEXT',
      'ALTER TABLE `tenants` ADD COLUMN `updated_at` TEXT',
      'ALTER TABLE `tenants` ADD COLUMN `dashboard_token_hash` TEXT',
      'ALTER TABLE `tenants` ADD COLUMN `dashboard_token_created_at` TEXT',
      'ALTER TABLE `orders` ADD COLUMN `delivery_address` TEXT',
      'ALTER TABLE `orders` ADD COLUMN `tool_call_id` TEXT',
      'ALTER TABLE `orders` ADD COLUMN `related_order_id` TEXT',
      'ALTER TABLE `orders` ADD COLUMN `delivery_batch_id` TEXT',
      'ALTER TABLE `orders` ADD COLUMN `scheduled_delivery_at` TEXT',
      'ALTER TABLE `menu_items` ADD COLUMN `price_cents` INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE `menu_items` ADD COLUMN `size` TEXT',
      'ALTER TABLE `menu_items` ADD COLUMN `flavor` TEXT',
      'ALTER TABLE `menu_items` ADD COLUMN `pos_variant_id` TEXT',
      'ALTER TABLE `invoices` ADD COLUMN `due_at` TEXT',
      'ALTER TABLE `calls` ADD COLUMN `duration_seconds` INTEGER',
      'ALTER TABLE `calls` ADD COLUMN `billable_minutes` INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE `calls` ADD COLUMN `ended_at` TEXT',
      'ALTER TABLE `calls` ADD COLUMN `started_at` TEXT',
      'ALTER TABLE `calls` ADD COLUMN `status` TEXT'
    ]) { try { await env.DB.prepare(migration).run(); } catch {} }
    // Preserve legacy dollar-denominated menu prices when adding the cents column.
    try {
      await env.DB.prepare('UPDATE `menu_items` SET `price_cents` = CAST(ROUND(`price` * 100) AS INTEGER) WHERE COALESCE(`price_cents`, 0) = 0 AND `price` IS NOT NULL AND `price` > 0').run();
    } catch {}
    try { await env.DB.prepare('CREATE UNIQUE INDEX IF NOT EXISTS `idx_orders_tool_call` ON `orders` (`tenant_id`, `tool_call_id`)').run(); } catch {}
    try { await env.DB.prepare('CREATE UNIQUE INDEX IF NOT EXISTS `idx_orders_tenant_order_id` ON `orders` (`tenant_id`, `order_id`)').run(); } catch {}
    try { await env.DB.prepare('CREATE UNIQUE INDEX IF NOT EXISTS `idx_calls_tenant_call_id` ON `calls` (`tenant_id`, `call_id`)').run(); } catch {}
    try { await env.DB.prepare('CREATE UNIQUE INDEX IF NOT EXISTS `idx_call_usage_tick` ON `call_usage_ticks` (`tenant_id`, `call_id`, `minute_index`)').run(); } catch {}
    try { await env.DB.prepare('CREATE INDEX IF NOT EXISTS `idx_manager_status_order` ON `manager_status_checks` (`tenant_id`, `order_reference`, `created_at`)').run(); } catch {}
    try { await env.DB.prepare('CREATE UNIQUE INDEX IF NOT EXISTS `idx_manager_status_outbound_call` ON `manager_status_checks` (`tenant_id`, `outbound_call_id`)').run(); } catch {}
    columnCache.clear();
    return { tablesChecked };
  })();
  try {
    return await schemaPromise;
  } catch (err) {
    schemaPromise = null;
    throw new AppError('D1 schema bootstrap failed: ' + clean(err?.message, 160), 'schema_bootstrap_failed', 500);
  }
}

async function getColumns(env, table) {
  if (!ALLOWED_TABLES.has(table)) throw new AppError('Table not allowed: ' + table, 'table_not_allowed', 400);
  if (columnCache.has(table)) return columnCache.get(table);
  await ensureSchema(env);
  const result = await env.DB.prepare('PRAGMA table_info(' + q(table) + ')').all();
  const columns = (result.results || []).map(row => ({
    name: row.name,
    type: row.type || '',
    pk: Number(row.pk || 0)
  }));
  if (!columns.length) throw new AppError('Table is missing or unreadable: ' + table, 'table_missing', 500);
  columnCache.set(table, columns);
  return columns;
}
function findColumn(columns, aliases) {
  const byName = new Map(columns.map(col => [col.name.toLowerCase(), col.name]));
  for (const alias of aliases || []) {
    const found = byName.get(String(alias).toLowerCase());
    if (found) return found;
  }
  return null;
}
async function tenantColumn(env, table) {
  const columns = await getColumns(env, table);
  const column = findColumn(columns, TENANT_COLUMNS);
  if (!column) throw new AppError('Table lacks a tenant column: ' + table, 'tenant_column_missing', 500);
  return column;
}
async function rowsForTenant(env, table, tenantId, limit = 500) {
  const scopeColumn = await tenantColumn(env, table);
  const result = await env.DB.prepare(
    `SELECT * FROM ${q(table)} WHERE ${q(scopeColumn)} = ? LIMIT ?`
  ).bind(tenantId, Math.max(1, Math.min(1000, Number(limit) || 500))).all();
  return result.results || [];
}
async function prepareScopedInsert(env, table, tenantId, entries) {
  const columns = await getColumns(env, table);
  const scopeColumn = findColumn(columns, TENANT_COLUMNS);
  if (!scopeColumn) throw new AppError('Table lacks a tenant column: ' + table, 'tenant_column_missing', 500);
  const data = { [scopeColumn]: tenantId };
  for (const [aliases, value] of entries || []) {
    if (value === undefined || value === null) continue;
    const candidates = Array.isArray(aliases) ? aliases : [aliases];
    const column = findColumn(columns, candidates);
    if (column) data[column] = value;
  }
  const singular = table.endsWith('s') ? table.slice(0, -1) : table;
  const idColumn = findColumn(columns, ['id', singular + '_id', 'uuid']);
  if (idColumn && data[idColumn] === undefined) data[idColumn] = makeId(16);
  const createdColumn = findColumn(columns, ['created_at', 'createdAt', 'created']);
  if (createdColumn && data[createdColumn] === undefined) data[createdColumn] = nowIso();
  const updatedColumn = findColumn(columns, ['updated_at', 'updatedAt']);
  if (updatedColumn && data[updatedColumn] === undefined) data[updatedColumn] = nowIso();
  const keys = Object.keys(data);
  const names = keys.map(key => q(key)).join(', ');
  const placeholders = keys.map(() => '?').join(', ');
  const statement = env.DB.prepare(
    `INSERT INTO ${q(table)} (${names}) VALUES (${placeholders})`
  ).bind(...keys.map(key => data[key]));
  return { statement, data };
}
async function insertScoped(env, table, tenantId, entries) {
  const prepared = await prepareScopedInsert(env, table, tenantId, entries);
  await prepared.statement.run();
  return prepared.data;
}

async function audit(env, tenantId, event, details = {}) {
  try {
    await insertScoped(env, 'audit_log', tenantId, [
      [['event', 'event_type', 'action'], clean(event, 100)],
      [['details', 'payload', 'message'], JSON.stringify(sanitizeDetails(details)).slice(0, 3000)],
      [['created_at'], nowIso()]
    ]);
  } catch {}
}
async function recordIntegrationStatus(env, tenantId, provider, status, details = {}) {
  try {
    await insertScoped(env, 'integration_status', tenantId, [
      [['provider', 'integration', 'service'], clean(provider, 80)],
      [['status', 'state'], clean(status, 80)],
      [['details', 'payload'], JSON.stringify(sanitizeDetails(details)).slice(0, 2000)],
      [['created_at'], nowIso()]
    ]);
  } catch {}
}

// ===== BLOCK 4/10: Official menu, D1 sync and menu lookup =====
async function syncAndReplaceD1Menu(env, tenantId) {
  // Deliberately non-destructive: the live D1 menu is authoritative.
  // Never seed or replace a customer's menu from hard-coded sample data.
  await ensureSchema(env);
  const menu = await getMenuRows(env, tenantId, { includeInactive: true });
  return {
    ok: true,
    skipped: true,
    tenant_id: tenantId,
    existing_menu_items: menu.length,
    reason: 'D1 menu is preserved; import or edit menu rows explicitly through the approved menu workflow.'
  };
}

async function getMenuRows(env, tenantId, options = {}) {
  await ensureSchema(env);
  const columns = await getColumns(env, 'menu_items');
  const scopeColumn = findColumn(columns, TENANT_COLUMNS);
  const skuColumn = findColumn(columns, ['sku', 'id', 'menu_item_id']);
  const nameColumn = findColumn(columns, ['name', 'item_name', 'title']);
  const categoryColumn = findColumn(columns, ['category']);
  const sizeColumn = findColumn(columns, ['size']);
  const flavorColumn = findColumn(columns, ['flavor']);
  const priceColumn = findColumn(columns, ['price_cents', 'price', 'unit_price']);
  const activeColumn = findColumn(columns, ['active', 'is_active']);
  if (!scopeColumn || !nameColumn || !priceColumn) {
    throw new AppError('menu_items schema is incomplete.', 'menu_schema_incomplete', 500);
  }

  const where = [`${q(scopeColumn)} = ?`];
  const params = [tenantId];
  if (activeColumn && !options.includeInactive) {
    where.push(`${q(activeColumn)} = 1`);
  }
  if (categoryColumn && options.category) {
    where.push(`LOWER(${q(categoryColumn)}) = ?`);
    params.push(norm(clean(options.category, 50)));
  }
  if (nameColumn && options.search) {
    where.push(`LOWER(${q(nameColumn)}) LIKE ?`);
    params.push('%' + norm(clean(options.search, 60)) + '%');
  }
  const limit = Math.max(1, Math.min(MAX_MENU_ROWS, Number(options.limit) || MAX_MENU_ROWS));
  const result = await env.DB.prepare(
    `SELECT * FROM ${q('menu_items')} WHERE ${where.join(' AND ')} ORDER BY ${q(nameColumn)} LIMIT ?`
  ).bind(...params, limit).all();

  return (result.results || []).map(row => ({
    id: row.id || row[skuColumn] || '',
    sku: row[skuColumn] || row.id || '',
    name: clean(row[nameColumn], 200),
    category: categoryColumn ? clean(row[categoryColumn], 80) : '',
    size: sizeColumn ? clean(row[sizeColumn], 80) : '',
    flavor: flavorColumn ? clean(row[flavorColumn], 80) : '',
    price: priceColumn.toLowerCase() === 'price_cents' ? roundMoney(Number(row[priceColumn] || 0) / 100) : parseMoney(row[priceColumn]),
    active: activeColumn ? Boolean(row[activeColumn]) : true
  }));
}
async function findMenuItemsBySku(env, tenantId, identifiers) {
  const wanted = Array.from(new Set((identifiers || []).map(norm).filter(Boolean))).slice(0, MAX_ORDER_ITEMS * 2);
  if (!wanted.length) return new Map();
  const columns = await getColumns(env, 'menu_items');
  const scopeColumn = findColumn(columns, TENANT_COLUMNS);
  const skuColumn = findColumn(columns, ['sku', 'id', 'menu_item_id']);
  const nameColumn = findColumn(columns, ['name', 'item_name', 'title']);
  const priceColumn = findColumn(columns, ['price_cents', 'price', 'unit_price']);
  const categoryColumn = findColumn(columns, ['category']);
  const activeColumn = findColumn(columns, ['active', 'is_active']);
  if (!scopeColumn || !skuColumn || !nameColumn || !priceColumn) {
    throw new AppError('menu_items schema is incomplete.', 'menu_schema_incomplete', 500);
  }
  const placeholders = wanted.map(() => '?').join(', ');
  const sql = `SELECT * FROM ${q('menu_items')} WHERE ${q(scopeColumn)} = ? AND (LOWER(${q(skuColumn)}) IN (${placeholders}) OR LOWER(${q(nameColumn)}) IN (${placeholders}))` +
    (activeColumn ? ` AND ${q(activeColumn)} = 1` : '') + ` LIMIT ?`;
  const result = await env.DB.prepare(sql).bind(tenantId, ...wanted, ...wanted, MAX_MENU_ROWS).all();
  const map = new Map();
  for (const row of result.results || []) {
    const item = {
      sku: clean(row[skuColumn], 80),
      name: clean(row[nameColumn], 200),
      category: categoryColumn ? clean(row[categoryColumn], 80) : '',
      price: priceColumn.toLowerCase() === 'price_cents' ? roundMoney(Number(row[priceColumn] || 0) / 100) : parseMoney(row[priceColumn])
    };
    map.set(norm(item.sku), item);
    map.set(norm(item.name), item);
    map.set(norm(item.sku).replace(/[ _-]+/g, ''), item);
  }
  return map;
}

// ===== BLOCK 5/10: Business hours, table booking and repeat caller logic =====
function businessConfig(env) {
  return {
    timeZone: clean(envValue(env, ['BUSINESS_TIME_ZONE', 'TIME_ZONE']) || TIME_ZONE_DEFAULT, 64),
    openHour: envNumber(env, ['OPEN_HOUR', 'OPENING_HOUR', 'BUSINESS_OPEN_HOUR'], OPEN_HOUR_DEFAULT, 0, 23),
    closeHour: envNumber(env, ['CLOSE_HOUR', 'CLOSING_HOUR', 'BUSINESS_CLOSE_HOUR'], CLOSE_HOUR_DEFAULT, 0, 23),
    cutoffMinutes: envNumber(env, ['BOOKING_CUTOFF_MINUTES', 'RESERVATION_CUTOFF_MINUTES'], CUTOFF_MINUTES_DEFAULT, 0, 180),
    maxTables: envNumber(env, ['MAX_TABLES', 'TABLE_CAPACITY', 'BOOKING_CAPACITY'], MAX_TABLES_DEFAULT, 1, 1000),
    minMinutes: envNumber(env, ['MIN_BOOKING_MINUTES'], SLOT_MIN_MINUTES, 15, 240),
    maxMinutes: envNumber(env, ['MAX_BOOKING_MINUTES'], SLOT_MAX_MINUTES, 30, 480),
    defaultMinutes: envNumber(env, ['DEFAULT_BOOKING_MINUTES'], SLOT_DEFAULT_MINUTES, 30, 240)
  };
}
function formatHour(hour) {
  const h = Number(hour) % 24;
  const suffix = h < 12 ? 'AM' : 'PM';
  const display = h % 12 || 12;
  return display + ':00 ' + suffix;
}
function businessHoursMessage(config) {
  return 'Open ' + formatHour(config.openHour) + ' to ' + formatHour(config.closeHour) +
    ' (' + config.timeZone + '). Reservations close ' + config.cutoffMinutes +
    ' minutes before closing.';
}
function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    weekday: 'short'
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second),
    weekday: parts.weekday || ''
  };
}
function timeZoneOffsetMs(date, timeZone) {
  const parts = zonedParts(date, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}
function zonedLocalToUtc(localIso, timeZone) {
  const localAsUtc = new Date(localIso + 'Z').getTime();
  let guess = new Date(localAsUtc);
  if (Number.isNaN(guess.getTime())) return guess;
  for (let i = 0; i < 2; i++) {
    const offset = timeZoneOffsetMs(guess, timeZone);
    guess = new Date(localAsUtc - offset);
  }
  return guess;
}
function parseBookingTime(value, timeZone) {
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  let raw = String(value ?? '').trim();
  if (!raw) throw new AppError('booking_time is required.', 'booking_time_required', 400);
  raw = raw.replace(' ', 'T');
  const match = raw.match(new RegExp('^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2})(?::([0-9]{2}))?(?:[.][0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})?$'));
  let date;
  if (match && !match[7]) {
    const local = match[1] + '-' + match[2] + '-' + match[3] + 'T' + match[4] + ':' + match[5] + ':' + (match[6] || '00');
    date = zonedLocalToUtc(local, timeZone);
  } else {
    date = new Date(raw);
  }
  if (Number.isNaN(date.getTime())) {
    throw new AppError('booking_time must be a valid ISO date/time.', 'invalid_booking_time', 400);
  }
  return date;
}
function isWithinBusinessHours(date, config) {
  const parts = zonedParts(date, config.timeZone);
  const minuteOfDay = parts.hour * 60 + parts.minute;
  const openMinutes = config.openHour * 60;
  const closeMinutes = config.closeHour * 60;
  const totalOpenMinutes = (closeMinutes - openMinutes + 1440) % 1440;
  const lastBookingMinute = totalOpenMinutes - config.cutoffMinutes;
  const elapsed = (minuteOfDay - openMinutes + 1440) % 1440;
  const ok = lastBookingMinute > 0 && elapsed >= 0 && elapsed < lastBookingMinute;
  return { ok, reason: ok ? '' : businessHoursMessage(config), config, parts };
}


function googleCalendarState(env) {
  const keys = ['googleClientId', 'googleClientSecret', 'googleRefreshToken', 'googleCalendarId'];
  const present = keys.filter(key => Boolean(envValue(env, ENV_KEYS[key])));
  return {
    configured: present.length === keys.length,
    partially_configured: present.length > 0 && present.length < keys.length,
    missing: keys.filter(key => !envValue(env, ENV_KEYS[key]))
  };
}
async function getGoogleAccessToken(env) {
  const state = googleCalendarState(env);
  if (!state.configured) {
    throw new AppError(
      state.partially_configured
        ? 'Google Calendar configuration is incomplete. Check GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN and GOOGLE_CALENDAR_ID.'
        : 'Google Calendar is not configured.',
      'google_calendar_not_configured', 503,
      { missing: state.missing }
    );
  }
  const tokenUrl = assertHttpsUrl(
    envValue(env, ENV_KEYS.googleTokenUrl) || GOOGLE_TOKEN_URL_DEFAULT,
    'google_token_url_invalid'
  );
  const response = await fetchWithTimeout(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: envValue(env, ENV_KEYS.googleClientId),
      client_secret: envValue(env, ENV_KEYS.googleClientSecret),
      refresh_token: envValue(env, ENV_KEYS.googleRefreshToken)
    }).toString()
  }, 8000);
  let data = {};
  try { data = await response.json(); } catch {}
  if (!response.ok || !data.access_token) {
    throw new AppError(
      'Google Calendar token refresh failed: ' + clean(data.error || 'provider error', 120),
      'google_token_refresh_failed', 502
    );
  }
  return data.access_token;
}
function googleCalendarUrl(env, suffix = '') {
  const calendarId = envValue(env, ENV_KEYS.googleCalendarId);
  if (!calendarId) throw new AppError('GOOGLE_CALENDAR_ID is required.', 'google_calendar_id_missing', 503);
  return GOOGLE_CALENDAR_API + '/calendars/' + encodeURIComponent(calendarId) + '/events' + suffix;
}
async function googleCalendarRequest(env, url, options = {}) {
  const token = await getGoogleAccessToken(env);
  const response = await fetchWithTimeout(url, {
    ...options,
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  }, 8000);
  let data = {};
  try { data = await response.json(); } catch {}
  if (!response.ok) {
    const reason = data?.error?.message || data?.error_description || data?.error || ('HTTP ' + response.status);
    throw new AppError('Google Calendar API failed: ' + clean(reason, 160), 'google_calendar_api_failed', 502, {
      provider_status: response.status
    });
  }
  return data;
}
async function listGoogleCalendarEvents(env, start, end) {
  const state = googleCalendarState(env);
  if (!state.configured) {
    if (state.partially_configured) {
      throw new AppError('Google Calendar configuration is incomplete.', 'google_calendar_not_configured', 503, {
        missing: state.missing
      });
    }
    return null;
  }
  const events = [];
  let pageToken = '';
  // Calendar API caps maxResults at 2500. Limit pagination to protect Worker CPU.
  for (let page = 0; page < 3; page++) {
    const params = new URLSearchParams({
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      singleEvents: 'true',
      showDeleted: 'false',
      maxResults: '2500',
      orderBy: 'startTime',
      timeZone: TIME_ZONE_DEFAULT
    });
    if (pageToken) params.set('pageToken', pageToken);
    const data = await googleCalendarRequest(env, googleCalendarUrl(env, '?' + params.toString()), { method: 'GET' });
    events.push(...(Array.isArray(data.items) ? data.items : []));
    pageToken = data.nextPageToken || '';
    if (!pageToken) break;
  }
  return events;
}
function eventOverlapsRange(event, startMs, endMs) {
  if (event?.status === 'cancelled') return false;
  const startRaw = event?.start?.dateTime || (event?.start?.date ? event.start.date + 'T00:00:00Z' : '');
  const endRaw = event?.end?.dateTime || (event?.end?.date ? event.end.date + 'T00:00:00Z' : '');
  const eventStart = Date.parse(startRaw);
  const eventEnd = Date.parse(endRaw);
  return Number.isFinite(eventStart) && Number.isFinite(eventEnd) && eventStart < endMs && eventEnd > startMs;
}
async function createGoogleCalendarBooking(env, tenantId, booking) {
  const state = googleCalendarState(env);
  if (!state.configured) {
    if (state.partially_configured) {
      throw new AppError('Google Calendar configuration is incomplete.', 'google_calendar_not_configured', 503, {
        missing: state.missing
      });
    }
    return { configured: false, created: false, reason: 'google_calendar_not_configured' };
  }
  const start = new Date(booking.booking_time);
  const end = new Date(start.getTime() + booking.duration_minutes * 60000);
  const event = {
    summary: 'Alex Pizza Reservation — ' + clean(booking.customer_name || 'Guest', 100),
    description: [
      'Alex Pizza NYC reservation',
      'Booking ID: ' + booking.booking_id,
      'Guests: ' + booking.party_size,
      booking.customer_phone ? 'Customer phone: ' + booking.customer_phone : '',
      booking.notes ? 'Notes: ' + clean(booking.notes, 800) : ''
    ].filter(Boolean).join('\n'),
    start: { dateTime: start.toISOString(), timeZone: TIME_ZONE_DEFAULT },
    end: { dateTime: end.toISOString(), timeZone: TIME_ZONE_DEFAULT },
    extendedProperties: { private: { booking_id: booking.booking_id, tenant_id: tenantId } }
  };
  const data = await googleCalendarRequest(env, googleCalendarUrl(env), {
    method: 'POST',
    body: JSON.stringify(event)
  });
  await recordIntegrationStatus(env, tenantId, 'google_calendar', 'ok', {
    booking_id: booking.booking_id,
    event_id: data.id || null
  });
  return { configured: true, created: true, event_id: data.id || null };
}
async function updateBookingStatus(env, tenantId, bookingId, status) {
  const columns = await getColumns(env, 'bookings');
  const scopeColumn = findColumn(columns, TENANT_COLUMNS);
  const idColumn = findColumn(columns, ['id', 'booking_id', 'uuid']);
  const statusColumn = findColumn(columns, ['status']);
  const updatedColumn = findColumn(columns, ['updated_at', 'updatedAt']);
  if (!scopeColumn || !idColumn || !statusColumn) return;
  const sets = [`${q(statusColumn)} = ?`];
  const params = [status];
  if (updatedColumn) { sets.push(`${q(updatedColumn)} = ?`); params.push(nowIso()); }
  params.push(tenantId, bookingId);
  await env.DB.prepare(
    `UPDATE ${q('bookings')} SET ${sets.join(', ')} WHERE ${q(scopeColumn)} = ? AND ${q(idColumn)} = ?`
  ).bind(...params).run();
}

async function checkAvailability(env, tenantId, bookingTime, durationMinutes, requestedPartySize = 1) {
  await ensureSchema(env);
  const config = businessConfig(env);
  const start = parseBookingTime(bookingTime, config.timeZone).getTime();
  if (start < Date.now() - 5 * 60000) {
    return { available: false, reason: 'Booking time cannot be in the past.' };
  }
  const hours = isWithinBusinessHours(new Date(start), config);
  if (!hours.ok) return { available: false, reason: hours.reason };

  const partySize = Math.max(1, Math.min(40, Math.floor(Number(requestedPartySize) || 1)));
  const tablesNeeded = Math.ceil(partySize / 4);
  const duration = Math.max(config.minMinutes, Math.min(config.maxMinutes, Number(durationMinutes) || config.defaultMinutes));
  const end = start + duration * 60000;
  const columns = await getColumns(env, 'bookings');
  const scopeColumn = findColumn(columns, TENANT_COLUMNS);
  const timeColumn = findColumn(columns, ['booking_time', 'start_time', 'reservation_time']);
  const durationColumn = findColumn(columns, ['duration_minutes', 'duration']);
  const statusColumn = findColumn(columns, ['status']);
  if (!scopeColumn || !timeColumn) throw new AppError('bookings schema is incomplete.', 'bookings_schema_incomplete', 500);

  const lowerBound = new Date(start - config.maxMinutes * 60000).toISOString();
  const upperBound = new Date(end).toISOString();
  const where = [
    `${q(scopeColumn)} = ?`,
    `${q(timeColumn)} >= ?`,
    `${q(timeColumn)} <= ?`
  ];
  const params = [tenantId, lowerBound, upperBound];
  if (statusColumn) {
    where.push(`LOWER(COALESCE(${q(statusColumn)}, '')) NOT IN ('cancelled', 'canceled', 'rejected', 'no_show')`);
  }
  const result = await env.DB.prepare(
    `SELECT * FROM ${q('bookings')} WHERE ${where.join(' AND ')} LIMIT 1000`
  ).bind(...params).all();

  const occupiedRows = (result.results || []).filter(row => {
    const bStart = new Date(row[timeColumn]).getTime();
    if (Number.isNaN(bStart)) return false;
    const bEnd = bStart + (Number(row[durationColumn]) || config.defaultMinutes) * 60000;
    return start < bEnd && end > bStart;
  });
  const occupiedSeats = occupiedRows.reduce((sum, row) => sum + Math.max(1, Number(row.party_size || row.guests || 1)), 0);
  const occupiedTablesLocal = occupiedRows.reduce((sum, row) => sum + Math.ceil(Math.max(1, Number(row.party_size || row.guests || 1)) / 4), 0);
  const localBookingIds = new Set(occupiedRows.map(row => clean(row.booking_id || row.id || '', 100)).filter(Boolean));
  let externalCalendarBookings = 0;
  const calendarEvents = await listGoogleCalendarEvents(env, new Date(start - config.maxMinutes * 60000), new Date(end));
  if (calendarEvents) {
    externalCalendarBookings = calendarEvents.filter(event => {
      if (!eventOverlapsRange(event, start, end)) return false;
      const linkedBookingId = clean(event?.extendedProperties?.private?.booking_id || '', 100);
      return !linkedBookingId || !localBookingIds.has(linkedBookingId);
    }).length;
  }
  const occupiedTables = occupiedTablesLocal + externalCalendarBookings;
  const seatsRemaining = Math.max(0, 40 - occupiedSeats - externalCalendarBookings * 4);
  if (occupiedTables + tablesNeeded > config.maxTables || occupiedSeats + partySize + externalCalendarBookings * 4 > 40) {
    return {
      available: false,
      reason: 'There is not enough table or seat capacity for a party of ' + partySize + '. Alex Pizza has 10 tables and 40 seats.',
      tables_occupied: occupiedTables,
      tables_needed: tablesNeeded,
      seats_occupied: occupiedSeats + externalCalendarBookings * 4,
      seats_remaining: seatsRemaining
    };
  }
  const occupied = occupiedTables;
  return {
    available: true,
    booking_time: new Date(start).toISOString(),
    duration_minutes: duration,
    tables_occupied: occupied,
    tables_remaining: config.maxTables - occupied,
    seats_remaining: Math.max(0, 40 - occupiedSeats - externalCalendarBookings * 4 - partySize),
    tables_needed: tablesNeeded,
    max_tables: config.maxTables,
    hours: businessHoursMessage(config)
  };
}
async function insertBookingWithinCapacity(env, tenantId, booking) {
  const columns = await getColumns(env, 'bookings');
  const scopeColumn = findColumn(columns, TENANT_COLUMNS);
  const timeColumn = findColumn(columns, ['booking_time', 'start_time', 'reservation_time']);
  const durationColumn = findColumn(columns, ['duration_minutes', 'duration']);
  const partyColumn = findColumn(columns, ['party_size', 'guests']);
  const statusColumn = findColumn(columns, ['status']);
  if (!scopeColumn || !timeColumn || !partyColumn) {
    throw new AppError('Booking schema lacks tenant, time or party-size columns.', 'bookings_schema_incomplete', 500);
  }
  const data = { [scopeColumn]: tenantId };
  const entries = [
    [['id'], booking.bookingId], [['booking_id'], booking.bookingId],
    [['booking_time', 'start_time', 'reservation_time'], booking.bookingTime],
    [['duration_minutes', 'duration'], booking.durationMinutes],
    [['party_size', 'guests'], booking.partySize],
    [['customer_name', 'name'], booking.customerName],
    [['customer_phone', 'phone'], booking.customerPhone || null],
    [['caller_hash'], booking.callerRef], [['status'], booking.status],
    [['notes', 'special_requests'], booking.notes || ''],
    [['created_at'], booking.createdAt], [['updated_at'], booking.createdAt]
  ];
  for (const [aliases, value] of entries) {
    if (value === undefined || value === null) continue;
    const column = findColumn(columns, aliases);
    if (column) data[column] = value;
  }
  const keys = Object.keys(data);
  const partyValue = `CASE WHEN CAST(COALESCE(${q(partyColumn)}, 1) AS INTEGER) > 0 THEN CAST(COALESCE(${q(partyColumn)}, 1) AS INTEGER) ELSE 1 END`;
  const tablesValue = `((${partyValue} + 3) / 4)`;
  const overlap = [
    `${q(scopeColumn)} = ?`,
    `datetime(${q(timeColumn)}) < datetime(?)`,
    `datetime(${q(timeColumn)}, '+' || COALESCE(${durationColumn ? q(durationColumn) : '90'}, 90) || ' minutes') > datetime(?)`
  ];
  if (statusColumn) overlap.push(`LOWER(COALESCE(${q(statusColumn)}, '')) NOT IN ('cancelled', 'canceled', 'rejected', 'no_show')`);
  const overlapSql = overlap.join(' AND ');
  const sql = `INSERT INTO ${q('bookings')} (${keys.map(q).join(', ')}) SELECT ${keys.map(() => '?').join(', ')} WHERE ` +
    `(COALESCE((SELECT SUM(${partyValue}) FROM ${q('bookings')} WHERE ${overlapSql}), 0) + ?) <= 40 AND ` +
    `(COALESCE((SELECT SUM(${tablesValue}) FROM ${q('bookings')} WHERE ${overlapSql}), 0) + ?) <= ?`;
  const start = new Date(booking.bookingTime).toISOString();
  const end = new Date(new Date(start).getTime() + booking.durationMinutes * 60000).toISOString();
  const params = [
    ...keys.map(key => data[key]),
    tenantId, end, start, booking.partySize,
    tenantId, end, start, booking.partySize, booking.maxTables
  ];
  const result = await env.DB.prepare(sql).bind(...params).run();
  return Number(result.meta?.changes || 0) === 1;
}

async function createBooking(env, tenantId, args) {
  const availability = await checkAvailability(env, tenantId, args.booking_time, args.duration_minutes, args.party_size || args.guests || 1);
  if (!availability.available) {
    return { ok: false, code: 'booking_unavailable', ...availability };
  }
  const required = envFlag(env, ENV_KEYS.requireCustomerPhone, false);
  const customerPhone = customerPhoneFrom(args, required);
  const callerRef = await callerFingerprint(env, customerPhone);
  const bookingId = 'BOK-' + makeId(8);
  const partySize = Math.max(1, Math.min(40, Math.floor(Number(args.party_size || args.guests) || 1)));
  const bookingCreatedAt = nowIso();
  const bookingStatusInitial = googleCalendarState(env).configured ? 'pending_calendar_sync' : 'confirmed';
  const inserted = await insertBookingWithinCapacity(env, tenantId, {
    bookingId,
    bookingTime: availability.booking_time,
    durationMinutes: availability.duration_minutes,
    partySize,
    customerName: clean(args.customer_name || args.name || '', 120),
    customerPhone,
    callerRef,
    status: bookingStatusInitial,
    notes: clean(args.notes || '', 1000),
    createdAt: bookingCreatedAt,
    maxTables: businessConfig(env).maxTables
  });
  if (!inserted) {
    return { ok: false, code: 'booking_unavailable', available: false, reason: 'Another reservation was confirmed for this time. Please choose another time.' };
  }
  let calendarSync = { configured: false, created: false, reason: 'google_calendar_not_configured' };
  let bookingStatus = 'confirmed';
  if (googleCalendarState(env).configured) {
    try {
      calendarSync = await createGoogleCalendarBooking(env, tenantId, {
        booking_id: bookingId,
        booking_time: availability.booking_time,
        duration_minutes: availability.duration_minutes,
        party_size: partySize,
        customer_name: args.customer_name || args.name || '',
        customer_phone: customerPhone,
        notes: args.notes || ''
      });
      await updateBookingStatus(env, tenantId, bookingId, 'confirmed');
    } catch (err) {
      bookingStatus = 'pending_calendar_sync';
      calendarSync = { configured: true, created: false, error: clean(publicError(err).error, 160) };
      await recordIntegrationStatus(env, tenantId, 'google_calendar', 'error', {
        booking_id: bookingId,
        code: clean(err?.code || 'google_calendar_sync_failed', 80)
      });
      try {
        await queueRoleNotification(env, tenantId, 'manager',
          'Reservation needs Google Calendar sync. Booking ID: ' + bookingId + ', requested time: ' + availability.booking_time,
          'google_calendar_sync_error');
      } catch {}
    }
  }
  let confirmation = { queued: false, reason: 'no_customer_phone' };
  if (customerPhone) {
    const sender = resolvePhones(env, 'business')[0] || '';
    const message = bookingStatus === 'confirmed'
      ? 'Alex Pizza reservation confirmed for ' + availability.booking_time + ' (' + availability.duration_minutes + ' minutes). Reference: ' + bookingId + '.'
      : 'Alex Pizza received your reservation request for ' + availability.booking_time + '. Reference: ' + bookingId + '. The team is verifying the calendar entry and will contact you if anything needs attention.';
    try {
      confirmation = await queueNotification(env, tenantId, {
        to: customerPhone,
        from: sender,
        message,
        kind: bookingStatus === 'confirmed' ? 'booking_confirmation' : 'booking_pending_calendar_sync',
        channel: 'sms',
        metadata: { booking_id: bookingId, caller_ref: callerRef, calendar_sync_pending: bookingStatus !== 'confirmed' }
      });
    } catch (err) {
      confirmation = { queued: false, error: clean(publicError(err).error, 160) };
      await recordIntegrationStatus(env, tenantId, 'booking_notification', 'error', {
        booking_id: bookingId, code: clean(err?.code || 'booking_notification_failed', 80)
      });
    }
  }
  await audit(env, tenantId, 'booking_created', {
    booking_id: bookingId, caller_ref: callerRef,
    tables_remaining: availability.tables_remaining, status: bookingStatus,
    google_calendar_created: Boolean(calendarSync.created)
  });
  return {
    ok: true,
    booking_id: bookingId,
    booking_time: availability.booking_time,
    duration_minutes: availability.duration_minutes,
    tables_remaining: availability.tables_remaining,
    status: bookingStatus,
    google_calendar: calendarSync,
    confirmation
  };
}
async function hasRecentRepeatTask(env, tenantId, dedupeKey, since) {
  const columns = await getColumns(env, 'manager_tasks');
  const scopeColumn = findColumn(columns, TENANT_COLUMNS);
  const createdColumn = findColumn(columns, ['created_at', 'createdAt']);
  const dedupeColumn = findColumn(columns, ['dedupe_key', 'dedupe', 'reference']);
  const descColumn = findColumn(columns, ['description', 'details', 'message']);
  if (!scopeColumn) return false;
  const where = [`${q(scopeColumn)} = ?`];
  const params = [tenantId];
  if (createdColumn) { where.push(`${q(createdColumn)} >= ?`); params.push(since); }
  if (dedupeColumn) { where.push(`${q(dedupeColumn)} = ?`); params.push(dedupeKey); }
  else if (descColumn) { where.push(`${q(descColumn)} LIKE ?`); params.push('%' + dedupeKey + '%'); }
  else return false;
  const row = await env.DB.prepare(
    `SELECT 1 FROM ${q('manager_tasks')} WHERE ${where.join(' AND ')} LIMIT 1`
  ).bind(...params).first();
  return Boolean(row);
}
async function detectRepeatCaller(env, tenantId, customerPhone, purpose = 'Order / support query', existingCallId = '') {
  await ensureSchema(env);
  const normalizedPhone = normalizePhone(customerPhone);
  const callerRef = await callerFingerprint(env, normalizedPhone);
  const since = new Date(Date.now() - REPEAT_WINDOW_MINUTES * 60000).toISOString();
  const columns = await getColumns(env, 'calls');
  const scopeColumn = findColumn(columns, TENANT_COLUMNS);
  const createdColumn = findColumn(columns, ['created_at', 'createdAt']);
  const hashColumn = findColumn(columns, ['caller_hash', 'phone_hash', 'customer_hash']);
  const phoneColumn = findColumn(columns, ['customer_phone', 'phone', 'caller_phone', 'from_phone']);
  if (!scopeColumn) throw new AppError('calls schema is incomplete.', 'calls_schema_incomplete', 500);

  const where = [`${q(scopeColumn)} = ?`];
  const params = [tenantId];
  if (createdColumn) { where.push(`${q(createdColumn)} >= ?`); params.push(since); }
  const idConditions = [];
  if (hashColumn && normalizedPhone) {
    idConditions.push(`${q(hashColumn)} = ?`);
    params.push(callerRef);
  }
  if (phoneColumn && normalizedPhone) {
    idConditions.push(`${q(phoneColumn)} = ?`);
    params.push(normalizedPhone);
  }
  if (!idConditions.length) where.push('1 = 0');
  else where.push('(' + idConditions.join(' OR ') + ')');

  if (existingCallId) {
    const currentCallColumn = findColumn(columns, ['call_id']);
    if (currentCallColumn) {
      where.push(`${q(currentCallColumn)} != ?`);
      params.push(existingCallId);
    }
  }
  const recent = await env.DB.prepare(
    `SELECT * FROM ${q('calls')} WHERE ${where.join(' AND ')} LIMIT 100`
  ).bind(...params).all();
  const priorCount = (recent.results || []).length;

  let currentCallExists = false;
  if (existingCallId) {
    const current = await env.DB.prepare(
      'SELECT 1 FROM `calls` WHERE `tenant_id` = ? AND `call_id` = ? LIMIT 1'
    ).bind(tenantId, existingCallId).first();
    currentCallExists = Boolean(current);
  }
  if (!currentCallExists) {
    const callId = existingCallId || ('CALL-' + makeId(8));
    await insertScoped(env, 'calls', tenantId, [
      [['id'], callId], [['call_id'], callId],
      [['customer_phone', 'phone', 'caller_phone'], envFlag(env, ENV_KEYS.storeRawPhone, true) ? (normalizedPhone || null) : null],
      [['caller_hash'], callerRef], [['purpose', 'reason'], clean(purpose, 250)],
      [['direction'], 'inbound'], [['status'], 'in_progress'], [['started_at'], nowIso()], [['created_at'], nowIso()]
    ]);
  }

  if (priorCount < 1) return { flagged: false, callCount: 1, callerRef };

  const windowBucket = Math.floor(Date.now() / (REPEAT_WINDOW_MINUTES * 60000));
  const dedupeKey = 'repeat:' + callerRef + ':' + windowBucket;
  if (await hasRecentRepeatTask(env, tenantId, dedupeKey, since)) {
    return { flagged: true, callCount: priorCount + 1, callerRef, taskId: null, deduplicated: true };
  }

  const taskId = 'TASK-' + makeId(8);
  const description = 'Repeat caller alert. Call count in the last ' + REPEAT_WINDOW_MINUTES +
    ' minutes: ' + (priorCount + 1) + '. Stated purpose: ' + clean(purpose, 300) +
    '. Caller ref: ' + callerRef + '. Dedupe: ' + dedupeKey + '.';
  await insertScoped(env, 'manager_tasks', tenantId, [
    [['id'], taskId],
    [['task_id'], taskId],
    [['title'], 'HIGH PRIORITY: Repeat caller'],
    [['description', 'details'], description],
    [['priority'], 'urgent'],
    [['status'], 'flagged_repeat_caller'],
    [['caller_hash'], callerRef],
    [['dedupe_key', 'dedupe'], dedupeKey],
    [['created_at'], nowIso()]
  ]);
  let notification = { queued: 0, reason: 'manager_phone_unavailable' };
  try {
    notification = await queueRoleNotification(env, tenantId, 'manager', description, 'repeat_caller_alert');
  } catch (err) {
    notification = { queued: 0, reason: clean(err?.code || 'notification_failed', 80) };
  }
  await audit(env, tenantId, 'repeat_caller_flagged', { caller_ref: callerRef, call_count: priorCount + 1, task_id: taskId, notifications: notification.queued });
  return { flagged: true, callCount: priorCount + 1, callerRef, taskId, notification };
}

// ===== BLOCK 6/10: Retention, call minutes, notification queue and receipts =====
async function run60DayDataPurge(env) {
  await ensureSchema(env);
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  let purgedRecords = 0;
  const tables = [];
  for (const table of PURGE_TABLES) {
    try {
      const columns = await getColumns(env, table);
      const createdColumn = findColumn(columns, ['created_at', 'createdAt', 'created']);
      if (!createdColumn) continue;
      const result = await env.DB.prepare(
        `DELETE FROM ${q(table)} WHERE ${q(createdColumn)} < ?`
      ).bind(cutoff).run();
      const changes = Number(result.meta?.changes || 0);
      purgedRecords += changes;
      tables.push({ table, deleted: changes });
    } catch {}
  }
  return { ok: true, purgedRecords, cutoffDate: cutoff, retentionDays: RETENTION_DAYS, tables };
}
async function addMonthlyUsageMinute(env, tenantId, monthKey, countedAt) {
  await env.DB.prepare(
    "INSERT INTO `monthly_call_usage` (`tenant_id`, `month`, `total_minutes`, `last_call_at`, `status`, `updated_at`) VALUES (?, ?, 1, ?, 'active', ?) ON CONFLICT(`tenant_id`, `month`) DO UPDATE SET `total_minutes` = `monthly_call_usage`.`total_minutes` + 1, `last_call_at` = excluded.`last_call_at`, `status` = 'active', `updated_at` = excluded.`updated_at`"
  ).bind(tenantId, monthKey, countedAt, nowIso()).run();
  const row = await env.DB.prepare(
    'SELECT `total_minutes` FROM `monthly_call_usage` WHERE `tenant_id` = ? AND `month` = ? LIMIT 1'
  ).bind(tenantId, monthKey).first();
  return Number(row?.total_minutes || 0);
}
async function recordCallMinuteTick(env, tenantId, callId, minuteIndex, countedAt) {
  const at = new Date(countedAt);
  if (Number.isNaN(at.getTime())) throw new AppError('Invalid call usage tick time.', 'invalid_call_timestamp', 400);
  const monthKey = localDateForTimeZone(at, TIME_ZONE_DEFAULT).slice(0, 7);
  const tickId = callId + ':' + String(minuteIndex);
  const inserted = await env.DB.prepare(
    'INSERT OR IGNORE INTO `call_usage_ticks` (`tenant_id`, `id`, `call_id`, `minute_index`, `month`, `counted_at`, `created_at`) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(tenantId, tickId, callId, minuteIndex, monthKey, at.toISOString(), nowIso()).run();
  if (Number(inserted.meta?.changes || 0) !== 1) return { counted: false, month: monthKey };
  const monthlyTotal = await addMonthlyUsageMinute(env, tenantId, monthKey, at.toISOString());
  await env.DB.prepare(
    'UPDATE `calls` SET `billable_minutes` = MAX(COALESCE(`billable_minutes`, 0), ?) WHERE `tenant_id` = ? AND `call_id` = ?'
  ).bind(minuteIndex, tenantId, callId).run();
  return { counted: true, month: monthKey, monthlyTotal };
}
async function recordCallMinutes(env, tenantId, durationSeconds, endedAt, callId = '') {
  await ensureSchema(env);
  const seconds = Math.max(1, Math.min(86400, Number(durationSeconds) || DEFAULT_CALL_SECONDS));
  const totalMinutes = Math.ceil(seconds / 60);
  const ended = endedAt ? new Date(endedAt) : new Date();
  if (Number.isNaN(ended.getTime())) throw new AppError('Invalid call end timestamp.', 'invalid_call_timestamp', 400);
  const id = clean(callId, 120);
  const callRow = id ? await env.DB.prepare(
    'SELECT `started_at`, `created_at`, `billable_minutes` FROM `calls` WHERE `tenant_id` = ? AND `call_id` = ? LIMIT 1'
  ).bind(tenantId, id).first() : null;
  const alreadyCounted = Math.max(0, Number(callRow?.billable_minutes || 0));
  const startMs = Date.parse(callRow?.started_at || callRow?.created_at || new Date(ended.getTime() - seconds * 1000).toISOString());
  const start = Number.isFinite(startMs) ? startMs : ended.getTime() - seconds * 1000;
  const missing = Math.max(0, totalMinutes - alreadyCounted);
  const monthTotals = {};
  for (let index = alreadyCounted + 1; index <= totalMinutes; index++) {
    const tickTime = index === totalMinutes ? ended : new Date(Math.min(ended.getTime(), start + index * 60000));
    if (id) {
      const tick = await recordCallMinuteTick(env, tenantId, id, index, tickTime);
      if (tick.counted) monthTotals[tick.month] = tick.monthlyTotal;
    } else {
      const month = localDateForTimeZone(tickTime, TIME_ZONE_DEFAULT).slice(0, 7);
      monthTotals[month] = await addMonthlyUsageMinute(env, tenantId, month, tickTime.toISOString());
    }
  }
  if (id) {
    await env.DB.prepare(
      'UPDATE `calls` SET `billable_minutes` = MAX(COALESCE(`billable_minutes`, 0), ?), `duration_seconds` = ?, `ended_at` = ?, `status` = ? WHERE `tenant_id` = ? AND `call_id` = ?'
    ).bind(totalMinutes, Math.ceil(seconds), ended.toISOString(), 'ended', tenantId, id).run();
  }
  const currentMonth = localDateForTimeZone(ended, TIME_ZONE_DEFAULT).slice(0, 7);
  const current = await env.DB.prepare(
    'SELECT `total_minutes` FROM `monthly_call_usage` WHERE `tenant_id` = ? AND `month` = ? LIMIT 1'
  ).bind(tenantId, currentMonth).first();
  return {
    currentMonth,
    addedMinutes: missing,
    monthlyTotal: Number(current?.total_minutes || 0),
    totalBillableMinutes: totalMinutes,
    alreadyCountedMinutes: alreadyCounted,
    monthTotals
  };
}

async function setNotificationStatus(env, tenantId, notificationId, status, providerMessageId) {
  try {
    const columns = await getColumns(env, 'notifications');
    const scopeColumn = findColumn(columns, TENANT_COLUMNS);
    const idColumn = findColumn(columns, ['notification_id', 'id']);
    const statusColumn = findColumn(columns, ['status']);
    const providerColumn = findColumn(columns, ['provider_message_id', 'provider_id']);
    if (!scopeColumn || !idColumn || !statusColumn) return;
    const set = [`${q(statusColumn)} = ?`];
    const params = [status];
    if (providerColumn && providerMessageId) { set.push(`${q(providerColumn)} = ?`); params.push(clean(providerMessageId, 200)); }
    params.push(tenantId, notificationId);
    await env.DB.prepare(
      `UPDATE ${q('notifications')} SET ${set.join(', ')} WHERE ${q(scopeColumn)} = ? AND ${q(idColumn)} = ?`
    ).bind(...params).run();
  } catch {}
}
function signalwireConfig(env) {
  const project = envValue(env, ENV_KEYS.signalwireProject);
  const token = envValue(env, ENV_KEYS.signalwireToken);
  const space = envValue(env, ENV_KEYS.signalwireSpace).replace(/^https?:[/][/]/i, '').replace(/[/].*$/, '');
  if (!project || !token || !space) return null;
  return { project, token, space };
}
function signalWireAddress(value, channel) {
  const number = normalizePhone(value || '');
  if (!number) return '';
  return norm(channel) === 'whatsapp' ? 'whatsapp:' + number : number;
}
async function deliverViaSignalWire(env, payload) {
  const sw = signalwireConfig(env);
  if (!sw) return null;
  const channel = clean(payload.channel || 'sms', 40);
  const from = signalWireAddress(payload.from, channel);
  const to = signalWireAddress(payload.to, channel);
  if (!from) return { delivered: false, skipped: false, provider: 'signalwire', error: 'signalwire_sender_missing' };
  if (!to) return { delivered: false, skipped: false, provider: 'signalwire', error: 'recipient_invalid' };
  const form = new URLSearchParams();
  form.set('To', to); form.set('From', from); form.set('Body', payload.message);
  const response = await fetchWithTimeout(
    'https://' + sw.space + '/api/laml/2010-04-01/Accounts/' + encodeURIComponent(sw.project) + '/Messages.json',
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + btoa(sw.project + ':' + sw.token) }, body: form.toString() },
    8000
  );
  let data = {}; try { data = await response.json(); } catch {}
  return { delivered: response.ok, skipped: false, provider: 'signalwire', provider_status: response.status, provider_message_id: data.sid || null,
    error: response.ok ? undefined : redact(clean(data.message || data.error_message || 'signalwire_error', 160)) };
}
async function deliverNotification(env, payload) {
  const signalwire = await deliverViaSignalWire(env, payload);
  if (signalwire) return signalwire;
  const rawUrl = envValue(env, ENV_KEYS.webhookUrl);
  if (!rawUrl) return { delivered: false, skipped: true, reason: 'no_delivery_provider_configured' };
  const url = assertHttpsUrl(rawUrl, 'webhook_url_invalid');
  const token = envValue(env, ENV_KEYS.webhookToken);
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const response = await fetchWithTimeout(url, { method: 'POST', headers, body: JSON.stringify({ ...payload, sent_at: nowIso() }) }, 8000);
  return { delivered: response.ok, skipped: false, provider: 'webhook', provider_status: response.status };
}
async function queueNotification(env, tenantId, options) {
  await ensureSchema(env);
  const to = normalizePhone(options?.to);
  if (!to) throw new AppError('A valid recipient phone is required.', 'recipient_phone_missing', 400);
  const from = normalizePhone(options?.from || '');
  const channel = clean(options?.channel || (String(options?.kind || '').includes('whatsapp') ? 'whatsapp' : 'sms'), 40);
  const id = 'NOT-' + makeId(8);
  const payload = {
    notification_id: id,
    tenant_id: tenantId,
    to,
    from: from || null,
    channel,
    kind: clean(options?.kind || 'general', 80),
    message: clean(options?.message || '', 3000),
    metadata: sanitizeDetails(options?.metadata || {})
  };
  await insertScoped(env, 'notifications', tenantId, [
    [['id'], id],
    [['notification_id'], id],
    [['recipient_phone', 'to_phone'], to],
    [['sender_phone', 'from_phone'], from || null],
    [['message'], payload.message],
    [['notification_type', 'type'], payload.kind],
    [['channel'], channel],
    [['status'], 'queued'],
    [['metadata', 'payload'], JSON.stringify(payload.metadata).slice(0, 2000)],
    [['created_at'], nowIso()]
  ]);
  let delivery;
  try {
    delivery = await deliverNotification(env, payload);
    const status = delivery.skipped ? 'queued' : (delivery.delivered ? 'sent_to_provider' : 'provider_rejected');
    await setNotificationStatus(env, tenantId, id, status);
  } catch (err) {
    delivery = { delivered: false, skipped: false, error: clean(publicError(err).error, 160) };
    await setNotificationStatus(env, tenantId, id, 'provider_error');
  }
  if (!delivery.delivered && env.NOTIFICATION_WORKFLOW && typeof env.NOTIFICATION_WORKFLOW.create === 'function') {
    try {
      await env.NOTIFICATION_WORKFLOW.create({
        id: 'notification-' + id.toLowerCase(),
        params: { tenant_id: tenantId, notification_id: id }
      });
      await setNotificationStatus(env, tenantId, id, 'retry_scheduled');
    } catch (err) {
      await recordIntegrationStatus(env, tenantId, 'notification_workflow', 'start_failed', {
        notification_id: id, code: clean(err?.code || 'notification_workflow_failed', 80)
      });
    }
  }
  return { id, queued: true, channel, ...delivery };
}
async function queueRoleNotification(env, tenantId, role, message, kind) {
  const phones = requirePhones(env, role);
  const sender = resolvePhones(env, 'business')[0] || '';
  const configuredManagerChannel = norm(envValue(env, ENV_KEYS.managerChannel) || 'whatsapp');
  const channel = role === 'manager' ? (configuredManagerChannel === 'sms' ? 'sms' : 'whatsapp') : (String(kind).includes('sms') ? 'sms' : 'dashboard');
  const results = [];
  for (const phone of phones) {
    results.push(await queueNotification(env, tenantId, {
      to: phone,
      from: sender,
      message,
      kind,
      channel,
      metadata: { role }
    }));
  }
  return { queued: results.length, ids: results.map(item => item.id) };
}
function buildReceiptText(order) {
  const lines = [
    'Order ' + order.order_id,
    'Customer: ' + clean(order.customer_name || 'Guest', 120),
    'Phone: ' + clean(order.customerPhone || order.customer_phone || 'not stored', 40),
    'Type: ' + order.order_type,
    ...order.items.map(item => item.quantity + ' x ' + item.name + ' @ ' + money(item.unit_price ?? item.unitPrice) + ' = ' + money(item.line_total ?? item.lineTotal)),
    'Total: ' + money(order.total) + ' ' + order.currency
  ];
  if (order.related_order_id) lines.push('Deliver together with original order: ' + order.related_order_id);
  if (order.notes) lines.push('Notes: ' + order.notes);
  return lines.join(NL).slice(0, 2500);
}
async function dispatchOrderReceipt(env, tenantId, order, customerPhone) {
  const receipt = buildReceiptText(order);
  let manager = { queued: 0, reason: 'manager_phone_unavailable' };
  try {
    manager = await queueRoleNotification(env, tenantId, 'manager', 'POS ORDER: ' + receipt, 'whatsapp_manager_pos');
  } catch (err) {
    manager = { queued: 0, reason: clean(err?.code || 'notification_failed', 80) };
  }
  let customer = { queued: false, reason: 'no_customer_phone' };
  if (customerPhone) {
    customer = await queueNotification(env, tenantId, {
      to: customerPhone,
      from: resolvePhones(env, 'business')[0] || '',
      message: 'Alex Pizza Receipt:' + NL + receipt,
      kind: 'customer_carrier_sms',
      channel: 'sms',
      metadata: { order_id: order.order_id }
    });
  }
  return { status: 'queued_for_dashboard_and_provider', manager, customer, receipt_preview: receipt.slice(0, 300) };
}

// ===== BLOCK 7/10: Zoho OAuth and optional POS push =====
async function ensureZohoTokenRow(env, tenantId) {
  const columns = await getColumns(env, 'zoho_oauth_tokens');
  const scopeColumn = findColumn(columns, TENANT_COLUMNS);
  const refreshColumn = findColumn(columns, ['refresh_token']);
  const updatedColumn = findColumn(columns, ['updated_at']);
  if (!scopeColumn || !refreshColumn) {
    throw new AppError('zoho_oauth_tokens schema is incomplete.', 'zoho_schema_incomplete', 500);
  }
  const envRefresh = envValue(env, ENV_KEYS.zohoRefreshToken);
  if (envRefresh) {
    const existing = await env.DB.prepare(
      `SELECT 1 FROM ${q('zoho_oauth_tokens')} WHERE ${q(scopeColumn)} = ? LIMIT 1`
    ).bind(tenantId).first();
    if (existing) {
      const set = [`${q(refreshColumn)} = ?`];
      const params = [envRefresh];
      if (updatedColumn) { set.push(`${q(updatedColumn)} = ?`); params.push(nowIso()); }
      params.push(tenantId);
      await env.DB.prepare(
        `UPDATE ${q('zoho_oauth_tokens')} SET ${set.join(', ')} WHERE ${q(scopeColumn)} = ?`
      ).bind(...params).run();
    } else {
      const data = { [scopeColumn]: tenantId, [refreshColumn]: envRefresh };
      if (updatedColumn) data[updatedColumn] = nowIso();
      const keys = Object.keys(data);
      await env.DB.prepare(
        `INSERT INTO ${q('zoho_oauth_tokens')} (${keys.map(key => q(key)).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`
      ).bind(...keys.map(key => data[key])).run();
    }
  }
  return { columns, scopeColumn, refreshColumn };
}
async function getZohoAccessToken(env, tenantId) {
  await ensureSchema(env);
  const { columns, scopeColumn, refreshColumn } = await ensureZohoTokenRow(env, tenantId);
  const clientId = envValue(env, ENV_KEYS.zohoClientId);
  const clientSecret = envValue(env, ENV_KEYS.zohoClientSecret);
  const row = await env.DB.prepare(
    `SELECT * FROM ${q('zoho_oauth_tokens')} WHERE ${q(scopeColumn)} = ? LIMIT 1`
  ).bind(tenantId).first();
  const refreshToken = row?.[refreshColumn] || envValue(env, ENV_KEYS.zohoRefreshToken);
  if (!clientId || !clientSecret || !refreshToken) {
    throw new AppError('Zoho POS is not fully configured.', 'zoho_not_configured', 503);
  }
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = Number(row?.expires_at || 0);
  if (row?.access_token && expiresAt > now + 120) return row.access_token;

  const tokenUrl = assertHttpsUrl(
    envValue(env, ENV_KEYS.zohoTokenUrl) || ZOHO_TOKEN_URL_DEFAULT,
    'zoho_token_url_invalid'
  );
  const response = await fetchWithTimeout(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken
    }).toString()
  }, 8000);
  let data = {};
  try { data = await response.json(); } catch {}
  if (!response.ok || !data.access_token) {
    throw new AppError('Zoho token refresh failed: ' + clean(data.error || 'provider error', 120), 'zoho_token_refresh_failed', 502);
  }
  const newExpiry = now + (Number(data.expires_in) || 3600);
  const set = [];
  const params = [];
  const accessColumn = findColumn(columns, ['access_token']);
  const expiryColumn = findColumn(columns, ['expires_at']);
  const updatedColumn = findColumn(columns, ['updated_at']);
  if (accessColumn) { set.push(`${q(accessColumn)} = ?`); params.push(data.access_token); }
  if (expiryColumn) { set.push(`${q(expiryColumn)} = ?`); params.push(newExpiry); }
  if (updatedColumn) { set.push(`${q(updatedColumn)} = ?`); params.push(nowIso()); }
  if (set.length) {
    params.push(tenantId);
    await env.DB.prepare(
      `UPDATE ${q('zoho_oauth_tokens')} SET ${set.join(', ')} WHERE ${q(scopeColumn)} = ?`
    ).bind(...params).run();
  }
  return data.access_token;
}

function parseZohoItemIdMap(env) {
  const raw = envValue(env, ENV_KEYS.zohoItemIdMap);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    throw new AppError('ZOHO_ITEM_ID_MAP must be valid JSON mapping menu SKUs to Zoho POS item IDs.', 'zoho_item_map_invalid', 503);
  }
}
function zohoItemIdForSku(env, sku) {
  const map = parseZohoItemIdMap(env);
  const id = map[sku] ?? map[norm(sku)] ?? map[String(sku || '').toUpperCase()];
  return id == null || String(id).trim() === '' ? '' : String(id).trim();
}
async function loadZohoItemIdMap(env, tenantId) {
  const map = {};
  const configured = parseZohoItemIdMap(env);
  for (const [sku, id] of Object.entries(configured)) if (id != null && String(id).trim()) map[norm(sku)] = String(id).trim();
  const columns = await getColumns(env, 'menu_items');
  const scopeColumn = findColumn(columns, TENANT_COLUMNS);
  const skuColumn = findColumn(columns, ['sku', 'id', 'menu_item_id']);
  const itemIdColumn = findColumn(columns, ['pos_variant_id', 'zoho_item_id', 'pos_item_id']);
  if (scopeColumn && skuColumn && itemIdColumn) {
    const rows = await env.DB.prepare(`SELECT ${q(skuColumn)} AS sku, ${q(itemIdColumn)} AS item_id FROM ${q('menu_items')} WHERE ${q(scopeColumn)} = ? AND ${q(itemIdColumn)} IS NOT NULL AND ${q(itemIdColumn)} != ''`).bind(tenantId).all();
    for (const row of rows.results || []) if (row.item_id) map[norm(row.sku)] = String(row.item_id).trim();
  }
  return map;
}
function zohoSalesOrdersUrl(env) {
  const configuredOrderUrl = envValue(env, ENV_KEYS.zohoPosUrl);
  const apiBase = (envValue(env, ENV_KEYS.zohoApiBaseUrl) || 'https://api.zakya.com').replace(/\/+$/, '');
  let rawUrl = configuredOrderUrl || (apiBase + '/inventory/v1/salesorders');
  let url = new URL(assertHttpsUrl(rawUrl, 'zoho_pos_url_invalid'));
  if (!url.pathname.replace(/\/+$/, '').endsWith('/inventory/v1/salesorders')) {
    // A generic callback/webhook is not a native Zoho POS endpoint. Never send
    // Zoho's OAuth token or sales-order payload to an unrelated URL.
    if (url.pathname === '/' && /(^|\.)zakya\.com$/i.test(url.hostname)) {
      url.pathname = '/inventory/v1/salesorders';
    } else {
      throw new AppError(
        'ZOHO_POS_ORDER_URL must be the native Zoho POS /inventory/v1/salesorders endpoint. Otherwise set ZOHO_API_BASE_URL to https://api.zakya.com and remove the webhook URL.',
        'zoho_pos_url_invalid', 503
      );
    }
  }
  const orgId = envValue(env, ENV_KEYS.zohoOrganization);
  if (!orgId) throw new AppError('ZOHO_ORGANIZATION_ID is required for native Zoho POS orders.', 'zoho_organization_id_missing', 503);
  if (!url.searchParams.has('organization_id')) url.searchParams.set('organization_id', orgId);
  return url.toString();
}
function localDateForTimeZone(date, timeZone) {
  const parts = zonedParts(date, timeZone);
  return parts.year + '-' + String(parts.month).padStart(2, '0') + '-' + String(parts.day).padStart(2, '0');
}

async function pushOrderToZoho(env, tenantId, order) {
  const orgId = envValue(env, ENV_KEYS.zohoOrganization);
  const customerId = envValue(env, ENV_KEYS.zohoCustomer);
  const hasZohoCredentials = Boolean(
    envValue(env, ENV_KEYS.zohoClientId) &&
    envValue(env, ENV_KEYS.zohoClientSecret) &&
    envValue(env, ENV_KEYS.zohoRefreshToken)
  );
  if (!hasZohoCredentials || !orgId || !customerId) {
    const missing = [
      !envValue(env, ENV_KEYS.zohoClientId) ? 'ZOHO_CLIENT_ID' : '',
      !envValue(env, ENV_KEYS.zohoClientSecret) ? 'ZOHO_CLIENT_SECRET' : '',
      !envValue(env, ENV_KEYS.zohoRefreshToken) ? 'ZOHO_REFRESH_TOKEN' : '',
      !orgId ? 'ZOHO_ORGANIZATION_ID' : '',
      !customerId ? 'ZOHO_CUSTOMER_ID' : '',
      !envValue(env, ENV_KEYS.zohoItemIdMap) ? 'ZOHO_ITEM_ID_MAP' : ''
    ].filter(Boolean);
    await recordIntegrationStatus(env, tenantId, 'zoho_pos', 'configuration_error', {
      order_id: order.order_id, missing
    });
    return { pushed: false, reason: 'zoho_pos_configuration_incomplete', missing };
  }
  const itemIdMap = await loadZohoItemIdMap(env, tenantId);
  const itemIdFor = sku => itemIdMap[norm(sku)] || itemIdMap[String(sku || '').toUpperCase()] || '';
  const missingSkus = order.items.filter(item => !itemIdFor(item.sku)).map(item => item.sku);
  if (missingSkus.length) {
    await recordIntegrationStatus(env, tenantId, 'zoho_pos', 'configuration_error', {
      order_id: order.order_id, missing_item_skus: missingSkus
    });
    return { pushed: false, reason: 'zoho_item_id_mapping_missing', missing_item_skus: missingSkus };
  }

  const token = await getZohoAccessToken(env, tenantId);
  const url = zohoSalesOrdersUrl(env);
  const payload = {
    customer_id: Number(customerId),
    salesorder_number: order.order_id,
    date: localDateForTimeZone(new Date(order.createdAt || Date.now()), TIME_ZONE_DEFAULT),
    reference_number: order.order_id,
    notes: [
      'Created by ' + WORKER_NAME,
      'Tenant: ' + tenantId,
      'Order type: ' + order.order_type,
      order.notes ? 'Customer notes: ' + clean(order.notes, 800) : '',
      order.delivery_address ? 'Delivery address: ' + clean(order.delivery_address, 300) : '',
      order.related_order_id ? 'Combined delivery with original order: ' + clean(order.related_order_id, 100) : '',
      order.scheduled_delivery_at ? 'Scheduled delivery: ' + clean(order.scheduled_delivery_at, 80) : ''
    ].filter(Boolean).join('\n'),
    line_items: order.items.map((item, index) => ({
      item_id: Number(itemIdFor(item.sku)),
      name: item.name,
      rate: item.unit_price,
      quantity: item.quantity,
      item_order: index
    }))
  };
  if (!Number.isFinite(payload.customer_id) || payload.customer_id <= 0 ||
      payload.line_items.some(item => !Number.isFinite(item.item_id) || item.item_id <= 0)) {
    throw new AppError('Zoho customer or item IDs must be valid positive numeric IDs.', 'zoho_id_invalid', 503);
  }
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Zoho-oauthtoken ' + token
    },
    body: JSON.stringify(payload)
  }, 10000);
  let data = {};
  try { data = await response.json(); } catch {}
  const returnedSalesOrder = data.sales_order || data.salesorder || null;
  const returnedSalesOrderId = returnedSalesOrder?.salesorder_id || data.salesorder_id || null;
  const providerOk = response.ok && data.code === 0 && Boolean(returnedSalesOrder || data.message === 'success');
  await recordIntegrationStatus(env, tenantId, 'zoho_pos', providerOk ? 'ok' : 'error', {
    order_id: order.order_id,
    provider_status: response.status,
    provider_code: data.code ?? null,
    salesorder_id: returnedSalesOrderId
  });
  if (!providerOk) {
    throw new AppError(
      'Zoho POS rejected the sales order: ' + clean(data.message || data.error || ('HTTP ' + response.status), 160),
      'zoho_order_push_failed', 502,
      { provider_status: response.status, provider_code: data.code ?? null }
    );
  }
  return {
    pushed: true,
    provider_status: response.status,
    salesorder_id: returnedSalesOrderId
  };
}


async function loadOrderForWorkflow(env, tenantId, orderId) {
  await ensureSchema(env);
  const order = await env.DB.prepare(
    'SELECT * FROM `orders` WHERE `tenant_id` = ? AND (`order_id` = ? OR `id` = ?) LIMIT 1'
  ).bind(tenantId, orderId, orderId).first();
  if (!order) throw new AppError('Order not found for workflow.', 'order_not_found', 404);
  const itemRows = await env.DB.prepare(
    'SELECT * FROM `order_items` WHERE `tenant_id` = ? AND `order_id` = ? ORDER BY `created_at`'
  ).bind(tenantId, orderId).all();
  const items = (itemRows.results || []).map(row => ({
    sku: row.sku, name: row.name, category: row.category,
    unit_price: Number(row.unit_price || 0), quantity: Number(row.quantity || 1),
    line_total: Number(row.line_total || 0)
  }));
  return {
    order_id: orderId, customer_name: order.customer_name || '',
    customerPhone: order.customer_phone || '', callerRef: order.caller_hash || '',
    order_type: order.order_type || 'pickup', delivery_address: order.delivery_address || '', currency: order.currency || CURRENCY,
    total: Number(order.total || 0), items, notes: order.notes || '',
    related_order_id: order.related_order_id || null, delivery_batch_id: order.delivery_batch_id || null,
    scheduled_delivery_at: order.scheduled_delivery_at || null,
    status: order.status || 'pending_pos_sync', createdAt: order.created_at || nowIso()
  };
}
async function updateOrderStatus(env, tenantId, orderId, status) {
  await env.DB.prepare(
    'UPDATE `orders` SET `status` = ?, `updated_at` = ? WHERE `tenant_id` = ? AND (`order_id` = ? OR `id` = ?)'
  ).bind(status, nowIso(), tenantId, orderId, orderId).run();
}
export class OrderProcessingWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const tenantId = validateTenant(event?.payload?.tenant_id);
    const orderId = clean(event?.payload?.order_id, 100);
    await ensureTenantActive(this.env, tenantId);
    if (!orderId) throw new AppError('Workflow order_id is required.', 'order_id_required', 400);
    const order = await step.do('load-order-' + orderId, async () =>
      await loadOrderForWorkflow(this.env, tenantId, orderId)
    );
    if (norm(order.status) === 'cancelled' || norm(order.status) === 'canceled') {
      return { ok: true, order_id: orderId, status: 'cancelled_before_pos_sync', skipped: true };
    }
    let result;
    try {
      result = await step.do('push-zoho-' + orderId, {
        retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
        timeout: '2 minutes'
      }, async () => await pushOrderToZoho(this.env, tenantId, order));
    } catch (err) {
      await step.do('mark-pos-failed-' + orderId, async () => {
        await updateOrderStatus(this.env, tenantId, orderId, 'pos_sync_failed');
        await recordIntegrationStatus(this.env, tenantId, 'zoho_pos', 'error', { order_id: orderId, code: clean(err?.code || 'zoho_push_failed', 80) });
        try { await queueRoleNotification(this.env, tenantId, 'manager', 'Zoho POS sync failed after automatic retries for order ' + orderId + '. Manual review is required.', 'zoho_pos_sync_error'); } catch {}
        return { status: 'pos_sync_failed' };
      });
      return { ok: false, order_id: orderId, status: 'pos_sync_failed' };
    }
    if (result?.pushed) {
      await step.do('mark-pos-confirmed-' + orderId, async () => {
        await updateOrderStatus(this.env, tenantId, orderId, 'pos_confirmed');
        await audit(this.env, tenantId, 'order_pos_confirmed', { order_id: orderId, salesorder_id: result.salesorder_id || null });
        return { status: 'pos_confirmed' };
      });
      return { ok: true, order_id: orderId, status: 'pos_confirmed', zoho: result, receipt_dispatched_at_order_acceptance: true };
    }
    await step.do('mark-pos-pending-' + orderId, async () => {
      await updateOrderStatus(this.env, tenantId, orderId, 'pending_pos_configuration');
      await queueRoleNotification(this.env, tenantId, 'manager',
        'Order ' + orderId + ' is saved but not confirmed in Zoho POS. Reason: ' + clean(result?.reason || 'not_configured', 120),
        'zoho_pos_sync_error');
      return { status: 'pending_pos_configuration' };
    });
    return { ok: false, order_id: orderId, status: 'pending_pos_configuration', zoho: result };
  }
}

// ===== BLOCK 8/10: Order pricing, order persistence and order tools =====
function normalizeOrderItems(raw) {
  let items = raw;
  if (typeof items === 'string') {
    try { items = JSON.parse(items); }
    catch { throw new AppError('order items must be valid JSON.', 'invalid_items', 400); }
  }
  if (!Array.isArray(items) && items && typeof items === 'object') {
    if (Array.isArray(items.items)) items = items.items;
    else items = Object.entries(items).map(([sku, value]) =>
      value && typeof value === 'object' ? { sku, ...value } : { sku, quantity: value }
    );
  }
  if (!Array.isArray(items)) return [];
  return items.slice(0, MAX_ORDER_ITEMS).map(item => {
    const source = item && typeof item === 'object' ? item : { sku: item };
    const quantity = Math.max(1, Math.min(99, Math.floor(Number(source.quantity ?? source.qty ?? source.count) || 1)));
    return {
      sku: clean(source.sku ?? source.id ?? source.menu_item_id ?? '', 80),
      name: clean(source.name ?? source.item_name ?? '', 200),
      requestedPrice: parseMoney(source.price ?? source.unit_price ?? 0),
      quantity
    };
  });
}
async function loadPricedItems(env, tenantId, rawItems, argsTotal) {
  const requested = normalizeOrderItems(rawItems);
  if (!requested.length) {
    const manualTotal = parseMoney(argsTotal);
    if (manualTotal > 0 && envFlag(env, ENV_KEYS.allowManualTotal, false)) {
      return [{
        sku: 'CUSTOM-TOTAL',
        name: 'Custom order total',
        category: 'Custom',
        unitPrice: manualTotal,
        quantity: 1,
        lineTotal: manualTotal
      }];
    }
    throw new AppError('Order items are required.', 'order_items_required', 400);
  }
  const identifiers = requested.flatMap(item => [item.sku, item.name]).filter(Boolean);
  const menuMap = await findMenuItemsBySku(env, tenantId, identifiers);
  return requested.map(item => {
    const key = norm(item.sku || item.name).replace(/[ _-]+/g, '');
    const menuItem = menuMap.get(norm(item.sku)) || menuMap.get(key) || menuMap.get(norm(item.name));
    if (!menuItem) {
      throw new AppError('Menu item not found: ' + clean(item.sku || item.name, 80), 'menu_item_not_found', 400);
    }
    const unitPrice = roundMoney(menuItem.price);
    return {
      sku: menuItem.sku,
      name: menuItem.name,
      category: menuItem.category,
      unitPrice,
      quantity: item.quantity,
      lineTotal: roundMoney(unitPrice * item.quantity)
    };
  });
}
async function createOrderRecord(env, tenantId, args, pricedItems, callerRef, resolvedCustomerPhone) {
  const total = roundMoney(pricedItems.reduce((sum, item) => sum + item.lineTotal, 0));
  const customerPhone = resolvedCustomerPhone === undefined
    ? customerPhoneFrom(args, true)
    : normalizePhone(resolvedCustomerPhone);
  const customerName = clean(args.customer_name || args.name || '', 120);
  const orderType = (() => {
    const value = norm(args.order_type || args.fulfillment_type || 'pickup');
    return ['pickup', 'delivery', 'dine_in'].includes(value) ? value : 'pickup';
  })();
  const notes = clean(args.notes || args.special_instructions || '', 1000);
  const createdAt = nowIso();

  // Exactly eight characters are retained for the customer-facing reference.
  // A tenant-scoped unique D1 index is the final collision guard; retry a collision.
  for (let attempt = 1; attempt <= 5; attempt++) {
    const orderId = makeId(8);
    const orderInsert = await prepareScopedInsert(env, 'orders', tenantId, [
      [['id'], orderId], [['order_id'], orderId],
      [['customer_name', 'name'], customerName],
      [['customer_phone', 'phone'], envFlag(env, ENV_KEYS.storeRawPhone, true) ? customerPhone : null],
      [['caller_hash'], callerRef], [['order_type', 'fulfillment_type'], orderType],
      [['delivery_address'], clean(args.delivery_address || '', 300) || null],
      [['related_order_id'], clean(args.__related_order_id || '', 100) || null],
      [['delivery_batch_id'], clean(args.__delivery_batch_id || '', 100) || null],
      [['scheduled_delivery_at'], clean(args.__scheduled_delivery_at || '', 80) || null],
      [['tool_call_id'], clean(args.__tool_call_id || '', 120) || null],
      [['total', 'total_amount', 'amount'], total], [['currency'], CURRENCY],
      [['items_json', 'items'], JSON.stringify(pricedItems).slice(0, 8000)],
      [['status'], 'submitted'], [['notes', 'special_instructions'], notes],
      [['created_at'], createdAt], [['updated_at'], createdAt]
    ]);
    const itemInserts = [];
    for (const item of pricedItems) {
      const prepared = await prepareScopedInsert(env, 'order_items', tenantId, [
        [['id'], makeId(16)], [['order_id'], orderId], [['sku'], item.sku],
        [['name', 'item_name'], item.name], [['category'], item.category],
        [['unit_price', 'price'], item.unitPrice], [['quantity'], item.quantity],
        [['line_total'], item.lineTotal], [['created_at'], createdAt]
      ]);
      itemInserts.push(prepared.statement);
    }
    try {
      // D1 batch is transactional: the bill and every line item commit together.
      await env.DB.batch([orderInsert.statement, ...itemInserts]);
      return {
        order_id: orderId, customer_name: customerName, customerPhone,
        callerRef, order_type: orderType, currency: CURRENCY, total,
        items: pricedItems, notes, status: 'submitted', createdAt
      };
    } catch (err) {
      const detail = clean(err?.message || err?.cause?.message || '', 300).toLowerCase();
      const isOrderReferenceCollision = /unique constraint failed/.test(detail) &&
        (detail.includes('orders.order_id') || detail.includes('orders.id') || detail.includes('orders.tenant_id'));
      if (isOrderReferenceCollision && attempt < 5) continue;
      throw err;
    }
  }
  throw new AppError('Could not allocate a unique eight-character bill reference.', 'bill_reference_collision', 503);
}

async function submitOrder(env, tenantId, args, ctx) {
  await ensureSchema(env);
  const orderHours = isWithinBusinessHours(new Date(), businessConfig(env));
  if (!orderHours.ok) {
    throw new AppError('Alex Pizza is not accepting new orders at this time. ' + orderHours.reason,
      'ordering_closed', 409, { time_zone: businessConfig(env).timeZone, cutoff_minutes: businessConfig(env).cutoffMinutes });
  }
  // A missing/failed Workflow must never discard a customer-confirmed order; persist and dispatch it first.
  if (args.customer_confirmed !== true) throw new AppError('Customer confirmation is required before submitting an order.', 'customer_confirmation_required', 400);
  const customerPhone = customerPhoneFrom(args, true);
  let relatedOrder = null;
  const relatedOrderReference = clean(args.related_order_reference || '', 100);
  if (relatedOrderReference) {
    if (args.deliver_with_original !== true) throw new AppError('deliver_with_original must be true when linking a follow-up order.', 'combined_delivery_confirmation_required', 400);
    await getOrderStatus(env, tenantId, { order_reference: relatedOrderReference, customer_phone: customerPhone });
    relatedOrder = await env.DB.prepare('SELECT * FROM `orders` WHERE `tenant_id` = ? AND (`order_id` = ? OR `id` = ?) LIMIT 1').bind(tenantId, relatedOrderReference, relatedOrderReference).first();
    if (!relatedOrder) throw new AppError('Original order not found.', 'related_order_not_found', 404);
    const originalType = norm(relatedOrder.order_type || 'pickup');
    if (originalType !== norm(args.order_type || 'pickup')) throw new AppError('The new order must use the same pickup/delivery method as the original order.', 'combined_delivery_type_mismatch', 400);
    const originalAddress = clean(relatedOrder.delivery_address || '', 300);
    const requestedAddress = clean(args.delivery_address || '', 300);
    if (originalType === 'delivery') {
      if (requestedAddress && requestedAddress.toLowerCase() !== originalAddress.toLowerCase()) {
        throw new AppError('A combined follow-up order must use the original delivery address.', 'combined_delivery_address_mismatch', 400);
      }
      if (!requestedAddress && originalAddress) args.delivery_address = originalAddress;
    }
  }
  if (norm(args.order_type) === 'delivery' && !clean(args.delivery_address, 300)) throw new AppError('delivery_address is required for delivery orders.', 'delivery_address_required', 400);
  const pricedItems = await loadPricedItems(env, tenantId, args.items ?? args.order_items, args.total);
  if (relatedOrder) {
    args = {
      ...args,
      __related_order_id: relatedOrder.order_id || relatedOrder.id,
      __delivery_batch_id: relatedOrder.delivery_batch_id || relatedOrder.order_id || relatedOrder.id,
      __scheduled_delivery_at: relatedOrder.scheduled_delivery_at || relatedOrder.promised_delivery_at || relatedOrder.requested_delivery_at || ''
    };
    args.notes = clean((args.notes || '') + ' | COMBINED DELIVERY WITH ORIGINAL ORDER ' + (relatedOrder.order_id || relatedOrder.id), 1000);
  }
  const toolCallId = clean(args.__tool_call_id || '', 120);
  if (toolCallId) {
    const existing = await env.DB.prepare('SELECT `order_id`, `status`, `total`, `currency` FROM `orders` WHERE `tenant_id` = ? AND `tool_call_id` = ? LIMIT 1').bind(tenantId, toolCallId).first();
    if (existing) return { ok: true, order_id: existing.order_id, status: existing.status, total: Number(existing.total || 0), currency: existing.currency || CURRENCY, idempotent_replay: true, zoho_pos: 'status_from_existing_order' };
  }
  const callerRef = await callerFingerprint(env, customerPhone);
  const repeat = await detectRepeatCaller(env, tenantId, customerPhone, args.call_purpose || 'New order submission', clean(args.__call_id || '', 120));
  const order = await createOrderRecord(env, tenantId, args, pricedItems, callerRef, customerPhone);
  await updateOrderStatus(env, tenantId, order.order_id, 'pending_pos_sync');
  let receiptDispatch = { status: 'not_dispatched', reason: 'receipt_dispatch_not_attempted' };
  try {
    receiptDispatch = await dispatchOrderReceipt(env, tenantId, order, customerPhone);
    await audit(env, tenantId, 'order_receipt_dispatched', {
      order_id: order.order_id,
      customer_notification_queued: Boolean(receiptDispatch.customer?.queued),
      manager_notifications_queued: Number(receiptDispatch.manager?.queued || 0)
    });
  } catch (err) {
    receiptDispatch = { status: 'dispatch_error', error: clean(publicError(err).error, 160) };
    await recordIntegrationStatus(env, tenantId, 'order_receipts', 'error', {
      order_id: order.order_id, code: clean(err?.code || 'receipt_dispatch_failed', 80)
    });
    try {
      await queueRoleNotification(env, tenantId, 'manager',
        'Customer-confirmed order ' + order.order_id + ' is saved in D1, but receipt dispatch needs attention.',
        'order_receipt_dispatch_error');
    } catch {}
  }
  let workflowQueued = true;
  try {
    await env.ORDER_WORKFLOW.create({
      id: 'order-' + order.order_id.toLowerCase(),
      params: { tenant_id: tenantId, order_id: order.order_id }
    });
  } catch (err) {
    workflowQueued = false;
    await updateOrderStatus(env, tenantId, order.order_id, 'workflow_start_failed');
    await recordIntegrationStatus(env, tenantId, 'order_workflow', 'error', {
      order_id: order.order_id, code: clean(err?.code || 'workflow_start_failed', 80)
    });
    try { await queueRoleNotification(env, tenantId, 'manager', 'Order ' + order.order_id + ' was saved but its POS workflow could not start. Manual review required.', 'order_workflow_error'); } catch {}
  }
  await audit(env, tenantId, 'order_submitted', {
    order_id: order.order_id,
    total: order.total,
    item_count: order.items.length,
    caller_ref: callerRef,
    repeat_flagged: repeat.flagged
  });
  return {
    ok: true,
    order_id: order.order_id,
    status: workflowQueued ? 'pending_pos_sync' : 'workflow_start_failed',
    total: order.total,
    currency: order.currency,
    item_count: order.items.length,
    repeat_caller_alert: repeat.flagged,
    caller_ref: callerRef,
    receipt: receiptDispatch,
    customer_order_confirmation: 'saved_independently_of_pos_status',
    zoho_pos: workflowQueued ? 'workflow_queued_pending_confirmation' : 'manual_review_required',
    ...(relatedOrder ? { related_order_id: relatedOrder.order_id || relatedOrder.id, delivery_batch_id: args.__delivery_batch_id, scheduled_delivery_at: args.__scheduled_delivery_at || null, combined_delivery: true } : {})
  };
}
async function getOrderStatus(env, tenantId, args) {
  await ensureSchema(env);
  const orderId = clean(args.order_id || args.order_reference || args.id || '', 100);
  const phone = customerPhoneFrom(args, true);
  if (!orderId) throw new AppError('order_reference is required.', 'order_id_required', 400);
  const columns = await getColumns(env, 'orders');
  const scopeColumn = findColumn(columns, TENANT_COLUMNS);
  const idColumn = findColumn(columns, ['order_id', 'id']);
  const statusColumn = findColumn(columns, ['status']);
  const totalColumn = findColumn(columns, ['total', 'total_amount', 'amount']);
  const createdColumn = findColumn(columns, ['created_at']);
  const currencyColumn = findColumn(columns, ['currency']);
  const phoneColumn = findColumn(columns, ['customer_phone', 'phone']);
  if (!scopeColumn || !idColumn || !phoneColumn) throw new AppError('orders schema does not support verified lookup.', 'orders_schema_incomplete', 500);
  const row = await env.DB.prepare(
    `SELECT * FROM ${q('orders')} WHERE ${q(scopeColumn)} = ? AND ${q(idColumn)} = ? LIMIT 1`
  ).bind(tenantId, orderId).first();
  if (!row) throw new AppError('Order not found.', 'order_not_found', 404);
  let verified = Boolean(row[phoneColumn] && normalizePhone(row[phoneColumn]) === normalizePhone(phone));
  if (!verified && row.caller_hash) verified = (await callerFingerprint(env, phone)) === row.caller_hash;
  if (!verified) throw new AppError('Order reference and customer phone do not match.', 'order_verification_failed', 403);
  return {
    ok: true, order_id: orderId,
    status: statusColumn ? clean(row[statusColumn], 80) : 'unknown',
    total: totalColumn ? parseMoney(row[totalColumn]) : 0,
    currency: currencyColumn ? clean(row[currencyColumn], 10) : CURRENCY,
    created_at: createdColumn ? row[createdColumn] : null
  };
}
async function requestOrderChange(env, tenantId, args) {
  await ensureSchema(env);
  const orderId = clean(args.order_reference || args.order_id || args.id || '', 100);
  const phone = customerPhoneFrom(args, true);
  const requestedChange = clean(args.requested_changes || args.requested_change || args.change || '', 2000);
  if (!orderId || !requestedChange) {
    throw new AppError('order_reference and requested_changes are required.', 'change_request_incomplete', 400);
  }
  const verified = await getOrderStatus(env, tenantId, { order_reference: orderId, customer_phone: phone });
  const ageMinutes = Math.max(0, (Date.now() - new Date(verified.created_at || Date.now()).getTime()) / 60000);
  const decision = norm(args.customer_decision || '');

  // After 20 minutes the original bill is immutable. A separate linked order may be created.
  if (ageMinutes > 20) {
    const requestId = 'CHG-' + makeId(8);
    if (decision === 'no') {
      await insertScoped(env, 'order_change_requests', tenantId, [
        [['id', 'request_id'], requestId], [['order_id'], orderId],
        [['requested_change', 'change', 'message'], requestedChange],
        [['reason'], 'Customer declined a separate follow-up order after the 20-minute change window.'],
        [['status'], 'customer_declined_new_order_manager_awareness'], [['created_at'], nowIso()]
      ]);
      const task = await createManagerTask(env, tenantId, 'Customer declined separate order after 20 minutes',
        'Original order ' + orderId + ' remains unchanged. Requested change: ' + requestedChange, 'normal');
      await audit(env, tenantId, 'late_order_change_declined', { order_id: orderId, request_id: requestId, task_id: task.task_id });
      return { ok: true, original_order_unchanged: true, new_order_created: false, status: 'manager_awareness_recorded',
        message_for_assistant: 'Tell the customer the original order remains unchanged. The manager has been notified for awareness; do not transfer the call.' };
    }
    if (decision === 'yes') {
      return { ok: true, original_order_unchanged: true, new_order_created: false, requires_new_order_submission: true,
        related_order_reference: orderId,
        message_for_assistant: 'The customer agreed to a separate new order. Collect the complete new items, read them back, get explicit confirmation, then call submit_order with related_order_reference set to this original order reference and deliver_with_original true. The original order and bill must remain unchanged.' };
    }
    return { ok: true, original_order_unchanged: true, requires_customer_decision: true,
      message_for_assistant: 'More than 20 minutes have passed. Do not change or cancel the original bill. Ask whether the customer wants a separate new order delivered together with the original at its scheduled delivery time. If yes, collect and confirm the new order. If no, call request_order_change again with customer_decision no to record manager awareness. Do not transfer the call.' };
  }

  // Between 5 and 20 minutes, only additions to the original bill are allowed.
  if (ageMinutes > 5) {
    if (args.customer_confirmed !== true) {
      return { ok: true, within_addition_window: true, original_order_unchanged: true,
        requires_customer_confirmation: true,
        message_for_assistant: 'Between 5 and 20 minutes, the customer may only ADD items to the existing bill. Do not remove items, replace the order, or cancel it. Read the added items and revised total back and obtain explicit confirmation.' };
    }
    if (!Array.isArray(args.items) || !args.items.length) {
      throw new AppError('For a 5-to-20-minute addition, provide only the additional items and customer_confirmed true.',
        'addition_items_required', 400);
    }
    const addedItems = await loadPricedItems(env, tenantId, args.items, null);
    const original = await env.DB.prepare(
      'SELECT * FROM `orders` WHERE `tenant_id` = ? AND (`order_id` = ? OR `id` = ?) LIMIT 1'
    ).bind(tenantId, orderId, orderId).first();
    if (!original) throw new AppError('Order not found.', 'order_not_found', 404);

    let existingItems = [];
    try {
      const parsed = JSON.parse(original.items_json || '[]');
      if (Array.isArray(parsed)) existingItems = parsed;
    } catch {}
    if (!existingItems.length) {
      const rows = await env.DB.prepare(
        'SELECT * FROM `order_items` WHERE `tenant_id` = ? AND `order_id` = ? ORDER BY `created_at`'
      ).bind(tenantId, orderId).all();
      existingItems = (rows.results || []).map(row => ({
        sku: row.sku, name: row.name, category: row.category,
        unitPrice: Number(row.unit_price || 0), quantity: Number(row.quantity || 1),
        lineTotal: Number(row.line_total || 0)
      }));
    }
    const combinedItems = [...existingItems, ...addedItems].map(item => ({
      sku: clean(item.sku, 80), name: clean(item.name, 200), category: clean(item.category, 80),
      unitPrice: roundMoney(item.unitPrice ?? item.unit_price),
      quantity: Math.max(1, Math.floor(Number(item.quantity) || 1)),
      lineTotal: roundMoney(item.lineTotal ?? item.line_total)
    }));
    const newTotal = roundMoney(combinedItems.reduce((sum, item) => sum + item.lineTotal, 0));
    const stamp = nowIso();
    const minCreated = new Date(Date.now() - 20 * 60000).toISOString();
    const maxCreated = new Date(Date.now() - 5 * 60000).toISOString();
    const statements = [
      env.DB.prepare(
        "UPDATE `orders` SET `items_json` = ?, `total` = ?, `updated_at` = ? WHERE `tenant_id` = ? AND (`order_id` = ? OR `id` = ?) AND `created_at` >= ? AND `created_at` < ? AND LOWER(COALESCE(`status`, '')) NOT IN ('cancelled', 'canceled')"
      ).bind(JSON.stringify(combinedItems), newTotal, stamp, tenantId, orderId, orderId, minCreated, maxCreated),
      env.DB.prepare(
        'DELETE FROM `order_items` WHERE `tenant_id` = ? AND `order_id` = ? AND EXISTS (SELECT 1 FROM `orders` WHERE `tenant_id` = ? AND (`order_id` = ? OR `id` = ?) AND `updated_at` = ?)'
      ).bind(tenantId, orderId, tenantId, orderId, orderId, stamp),
      ...combinedItems.map(item => env.DB.prepare(
        'INSERT INTO `order_items` (`tenant_id`, `id`, `order_id`, `sku`, `name`, `category`, `unit_price`, `quantity`, `line_total`, `created_at`) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM `orders` WHERE `tenant_id` = ? AND (`order_id` = ? OR `id` = ?) AND `updated_at` = ?)'
      ).bind(tenantId, makeId(16), orderId, item.sku, item.name, item.category, item.unitPrice, item.quantity, item.lineTotal, stamp, tenantId, orderId, orderId, stamp))
    ];
    const batch = await env.DB.batch(statements);
    if (Number(batch?.[0]?.meta?.changes || 0) !== 1) {
      throw new AppError('The 5-to-20-minute addition window expired or the order is no longer editable. No additions were applied.',
        'addition_window_expired', 409);
    }
    await insertScoped(env, 'order_change_requests', tenantId, [
      [['id', 'request_id'], 'ADD-' + makeId(8)], [['order_id'], orderId],
      [['requested_change', 'change', 'message'], requestedChange],
      [['reason'], 'Customer-confirmed additions within the 5-to-20-minute policy.'],
      [['status'], 'additions_applied_to_original_bill'], [['created_at'], nowIso()]
    ]);
    await audit(env, tenantId, 'order_additions_applied_5_to_20_minutes', {
      order_id: orderId, added_item_count: addedItems.length, new_total: newTotal
    });
    try {
      await queueRoleNotification(env, tenantId, 'manager',
        'CUSTOMER-APPROVED ADDITION added to existing bill ' + orderId + '. Revised total: ' + money(newTotal),
        'order_addition_applied');
    } catch {}
    let updatedReceipt = { status: 'not_sent' };
    try {
      updatedReceipt = await dispatchOrderReceipt(env, tenantId, {
        order_id: orderId, customer_name: original.customer_name || 'Guest', customerPhone: phone,
        order_type: original.order_type || 'pickup', currency: original.currency || CURRENCY,
        total: newTotal, items: combinedItems, notes: original.notes || '',
        related_order_id: original.related_order_id || null
      }, phone);
    } catch (err) {
      updatedReceipt = { status: 'dispatch_error', error: clean(publicError(err).error, 160) };
    }
    return { ok: true, additions_applied: true, updated_receipt: updatedReceipt, original_order_unchanged: false,
      order_id: orderId, total: newTotal, currency: CURRENCY, item_count: combinedItems.length,
      status: 'additions_applied_to_original_bill',
      message_for_assistant: 'The additional items were added to the original bill. Cancellation is not allowed after the first 5 minutes. Do not claim the Zoho POS or kitchen ticket was automatically amended; the manager has been notified.' };
  }

  // First five minutes: a complete replacement is permitted after explicit confirmation.
  if (args.customer_confirmed !== true) {
    return { ok: true, within_change_window: true, change_applied: false, requires_customer_confirmation: true,
      message_for_assistant: 'The order is within the first 5 minutes. Prepare the complete revised items, read the revised order and total back, and get an explicit yes. Then call request_order_change with the complete revised items and customer_confirmed true.' };
  }
  if (!Array.isArray(args.items) || !args.items.length) {
    throw new AppError('For a change within 5 minutes, provide the complete revised items array and customer_confirmed true.',
      'structured_order_items_required', 400);
  }
  const priced = await loadPricedItems(env, tenantId, args.items, null);
  const total = roundMoney(priced.reduce((sum, item) => sum + item.lineTotal, 0));
  const itemsJson = JSON.stringify(priced.map(item => ({
    sku: item.sku, name: item.name, category: item.category,
    unit_price: item.unitPrice, quantity: item.quantity, line_total: item.lineTotal
  })));
  const original = await env.DB.prepare(
    'SELECT * FROM `orders` WHERE `tenant_id` = ? AND (`order_id` = ? OR `id` = ?) LIMIT 1'
  ).bind(tenantId, orderId, orderId).first();
  if (!original) throw new AppError('Order not found.', 'order_not_found', 404);

  const stamp = nowIso();
  const update = env.DB.prepare(
    "UPDATE `orders` SET `items_json` = ?, `total` = ?, `updated_at` = ? WHERE `tenant_id` = ? AND (`order_id` = ? OR `id` = ?) AND `created_at` >= ? AND LOWER(COALESCE(`status`, '')) NOT IN ('cancelled', 'canceled')"
  ).bind(itemsJson, total, stamp, tenantId, orderId, orderId, new Date(Date.now() - 5 * 60000).toISOString());
  const removeOldItems = env.DB.prepare(
    'DELETE FROM `order_items` WHERE `tenant_id` = ? AND `order_id` = ? AND EXISTS (SELECT 1 FROM `orders` WHERE `tenant_id` = ? AND (`order_id` = ? OR `id` = ?) AND `updated_at` = ?)'
  ).bind(tenantId, orderId, tenantId, orderId, orderId, stamp);
  const insertNewItems = priced.map(item => env.DB.prepare(
    'INSERT INTO `order_items` (`tenant_id`, `id`, `order_id`, `sku`, `name`, `category`, `unit_price`, `quantity`, `line_total`, `created_at`) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM `orders` WHERE `tenant_id` = ? AND (`order_id` = ? OR `id` = ?) AND `updated_at` = ?)'
  ).bind(tenantId, makeId(16), orderId, item.sku, item.name, item.category, item.unitPrice, item.quantity, item.lineTotal, stamp, tenantId, orderId, orderId, stamp));
  const batch = await env.DB.batch([update, removeOldItems, ...insertNewItems]);
  if (Number(batch?.[0]?.meta?.changes || 0) !== 1) {
    throw new AppError('The 5-minute change window expired or the order is no longer editable. No changes were applied.',
      'change_window_expired', 409);
  }
  await audit(env, tenantId, 'order_changed_within_five_minutes', {
    order_id: orderId, new_total: total, item_count: priced.length
  });
  try {
    await queueRoleNotification(env, tenantId, 'manager',
      'ORDER UPDATED within the first 5 minutes: ' + orderId + ', new total ' + money(total),
      'order_changed');
  } catch {}
  let updatedReceipt = { status: 'not_sent' };
  try {
    updatedReceipt = await dispatchOrderReceipt(env, tenantId, {
      order_id: orderId, customer_name: original.customer_name || 'Guest', customerPhone: phone,
      order_type: original.order_type || 'pickup', currency: original.currency || CURRENCY,
      total, items: priced, notes: original.notes || '',
      related_order_id: original.related_order_id || null
    }, phone);
  } catch (err) {
    updatedReceipt = { status: 'dispatch_error', error: clean(publicError(err).error, 160) };
  }
  return { ok: true, change_applied: true, updated_receipt: updatedReceipt, order_id: orderId,
    total, currency: CURRENCY, item_count: priced.length, status: 'updated_within_policy',
    message_for_assistant: 'The complete revised order was saved atomically within the first 5 minutes. The manager and customer receipt dispatch were initiated. Do not claim the POS or kitchen copy was changed automatically.' };
}

function getBusinessInfo(env) {
  const config = businessConfig(env);
  return {
    ok: true,
    name: 'Alex Pizza NYC',
    currency: CURRENCY,
    time_zone: config.timeZone,
    hours: businessHoursMessage(config),
    order_cutoff_minutes_before_close: config.cutoffMinutes,
    ordering_window_enforced: true,
    open_hour: config.openHour,
    close_hour: config.closeHour,
    reservation_cutoff_minutes: config.cutoffMinutes,
    max_tables: config.maxTables,
    manager_phone_configured: resolvePhones(env, 'manager').length > 0,
    business_phone_configured: resolvePhones(env, 'business').length > 0,
    google_calendar_configured: googleCalendarState(env).configured
  };
}

// ===== BLOCK 9/10: Vapi tool registry and tool-call executor =====
function toToolKey(name) {
  return String(name ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[ ._-]+/g, '_')
    .toLowerCase();
}
const TOOL_ALIASES = new Map(Object.entries({
  menu: 'get_menu',
  getMenu: 'get_menu',
  checkAvailability: 'check_table_availability',
  checkTableAvailability: 'check_table_availability',
  availability: 'check_table_availability',
  bookTable: 'book_table',
  createBooking: 'book_table',
  reserveTable: 'book_table',
  submitOrder: 'submit_order',
  placeOrder: 'submit_order',
  order: 'submit_order',
  orderStatus: 'get_order_status',
  getOrder: 'get_order_status',
  changeOrder: 'request_order_change',
  requestChange: 'request_order_change',
  businessInfo: 'get_business_info',
  hours: 'get_business_info',
  repeatCaller: 'flag_repeat_caller',
  sendBookingNotifications: 'send_booking_notifications',
  send_booking_notification: 'send_booking_notifications',
  sendBookingNotification: 'send_booking_notifications',
  transferToManager: 'transfer_to_manager',
  requestManagerStatusCheck: 'request_manager_status_check',
  requestOrderCancel: 'request_order_cancel',
  checkOrderStatus: 'get_order_status',
  check_order_status: 'get_order_status',
  getBusinessHours: 'get_business_info',
  get_business_hours: 'get_business_info',
  calculateOrderTool: 'calculate_order_tool',
  calculate_order: 'calculate_order_tool'
}).map(([key, value]) => [toToolKey(key), value]));
function resolveToolName(name) {
  const key = toToolKey(name);
  return TOOL_ALIASES.get(key) || key;
}

async function sendBookingNotifications(env, tenantId, args) {
  await ensureSchema(env);
  const bookingId = clean(args.booking_id || '', 100);
  if (!bookingId) throw new AppError('booking_id is required.', 'booking_id_required', 400);
  const booking = await env.DB.prepare(
    'SELECT * FROM `bookings` WHERE `tenant_id` = ? AND `id` = ? LIMIT 1'
  ).bind(tenantId, bookingId).first();
  if (!booking) throw new AppError('Booking not found.', 'booking_not_found', 404);
  const message = 'Alex Pizza reservation: ' + clean(booking.customer_name || 'Guest', 100) +
    ', ' + clean(booking.booking_time || '', 80) + ', party of ' + Number(booking.party_size || 0) +
    '. Booking reference: ' + bookingId + '. Status: ' + clean(booking.status || 'pending', 60) + '.';
  let manager = { queued: 0, reason: 'manager_phone_unavailable' };
  try { manager = await queueRoleNotification(env, tenantId, 'manager', message, 'booking_manager_notification'); }
  catch (err) { manager = { queued: 0, reason: clean(err?.code || 'notification_failed', 80) }; }
  let customer = { queued: false, reason: 'customer_phone_unavailable' };
  if (booking.customer_phone) {
    customer = await queueNotification(env, tenantId, {
      to: booking.customer_phone, from: resolvePhones(env, 'business')[0] || '',
      message: 'Alex Pizza reservation details. ' + message,
      kind: 'booking_customer_confirmation', channel: 'sms', metadata: { booking_id: bookingId }
    });
  }
  return { ok: true, booking_id: bookingId, manager, customer };
}
async function createManagerTask(env, tenantId, title, description, priority = 'high') {
  const taskId = 'TASK-' + makeId(8);
  await insertScoped(env, 'manager_tasks', tenantId, [
    [['id'], taskId], [['task_id'], taskId], [['title'], clean(title, 160)],
    [['description', 'details'], clean(description, 1500)], [['priority'], priority],
    [['status'], 'open'], [['created_at'], nowIso()]
  ]);
  let notification = { queued: 0, reason: 'manager_phone_unavailable' };
  try { notification = await queueRoleNotification(env, tenantId, 'manager', title + ': ' + description, 'manager_task'); }
  catch (err) { notification = { queued: 0, reason: clean(err?.code || 'notification_failed', 80) }; }
  return { task_id: taskId, status: 'manager_review_required', notification };
}
async function requestOrderCancellation(env, tenantId, args) {
  await ensureSchema(env);
  const orderId = clean(args.order_reference || '', 100);
  const phone = customerPhoneFrom(args, true);
  const reason = clean(args.reason || '', 1000);
  if (!orderId || !reason) {
    throw new AppError('order_reference, customer_phone and reason are required.', 'cancel_request_incomplete', 400);
  }
  const verified = await getOrderStatus(env, tenantId, { order_reference: orderId, customer_phone: phone });
  const ageMinutes = Math.max(0, (Date.now() - new Date(verified.created_at || Date.now()).getTime()) / 60000);

  if (ageMinutes <= 5) {
    const update = await env.DB.prepare(
      "UPDATE `orders` SET `status` = 'cancelled', `updated_at` = ? WHERE `tenant_id` = ? AND (`order_id` = ? OR `id` = ?) AND `created_at` >= ? AND LOWER(COALESCE(`status`, '')) NOT IN ('cancelled', 'canceled')"
    ).bind(nowIso(), tenantId, orderId, orderId, new Date(Date.now() - 5 * 60000).toISOString()).run();
    if (Number(update.meta?.changes || 0) !== 1) {
      throw new AppError('The 5-minute cancellation window expired while processing. The original order was not changed.',
        'cancel_window_expired', 409);
    }
    await insertScoped(env, 'order_change_requests', tenantId, [
      [['id', 'request_id'], 'CNL-' + makeId(8)], [['order_id'], orderId],
      [['requested_change', 'change', 'message'], 'CANCEL ORDER'], [['reason'], reason],
      [['status'], 'cancelled_within_five_minute_policy'], [['created_at'], nowIso()]
    ]);
    try {
      await queueRoleNotification(env, tenantId, 'manager',
        'ORDER CANCELLED within the first 5 minutes: ' + orderId + '. Check Zoho/kitchen if already received.',
        'order_cancelled');
    } catch {}
    await audit(env, tenantId, 'order_cancelled_within_five_minutes', { order_id: orderId });
    return {
      ok: true, cancelled: true, order_reference: orderId, status: 'cancelled_within_policy',
      message_for_assistant: 'The order was cancelled within the first 5 minutes. The manager was alerted to stop kitchen/POS processing if already started.'
    };
  }

  // Cancellation is forbidden after minute five, including the 5–20 minute additions window.
  const requestId = 'CNL-' + makeId(8);
  await insertScoped(env, 'order_change_requests', tenantId, [
    [['id', 'request_id'], requestId], [['order_id'], orderId],
    [['requested_change', 'change', 'message'], 'CANCEL ORDER'],
    [['reason'], reason],
    [['status'], 'cancellation_denied_after_five_minutes_original_order_preserved'],
    [['created_at'], nowIso()]
  ]);
  const task = await createManagerTask(
    env, tenantId,
    'Customer requested cancellation after the 5-minute cutoff',
    'Cancellation was not applied. Original order ' + orderId + ' remains unchanged. Request reason: ' + reason,
    'high'
  );
  await audit(env, tenantId, 'late_order_cancellation_denied', {
    order_id: orderId, request_id: requestId, order_age_minutes: Math.round(ageMinutes * 100) / 100,
    manager_task_id: task.task_id
  });
  return {
    ok: true, cancelled: false, original_order_unchanged: true,
    status: 'cancellation_not_allowed_after_five_minutes',
    order_reference: orderId,
    manager_notified: true,
    message_for_assistant: 'The original order cannot be cancelled after the first 5 minutes. Between 5 and 20 minutes, only additions are allowed. After 20 minutes, the original bill remains locked. Explain this politely; do not create a replacement order from a cancellation request and do not transfer the call.'
  };
}

async function recordInboundCallStart(env, tenantId, call) {
  await ensureSchema(env);
  const callId = clean(call?.id || '', 120);
  if (!callId) return { recorded: false, reason: 'missing_call_id' };
  const existing = await env.DB.prepare(
    'SELECT 1 FROM `calls` WHERE `tenant_id` = ? AND `call_id` = ? LIMIT 1'
  ).bind(tenantId, callId).first();
  if (existing) return { recorded: false, duplicate: true, call_id: callId };

  const callType = clean(call?.type || 'inboundPhoneCall', 40);
  const direction = norm(callType).includes('outbound') ? 'outbound' : 'inbound';
  const phone = normalizePhone(call?.customer?.number || call?.customer?.phone || call?.from || call?.customerNumber || '');
  const callerRef = await callerFingerprint(env, phone);
  const startedAt = nowIso();
  let priorCount = 0;

  // Outbound manager checks are metered but never treated as repeat inbound customers.
  if (direction === 'inbound' && phone) {
    const since = new Date(Date.now() - REPEAT_WINDOW_MINUTES * 60000).toISOString();
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM `calls` WHERE `tenant_id` = ? AND `caller_hash` = ? AND `direction` = 'inbound' AND `created_at` >= ?"
    ).bind(tenantId, callerRef, since).first();
    priorCount = Number(row?.n || 0);
  }

  await insertScoped(env, 'calls', tenantId, [
    [['id'], callId], [['call_id'], callId],
    [['customer_phone'], envFlag(env, ENV_KEYS.storeRawPhone, true) ? (phone || null) : null],
    [['caller_hash'], callerRef],
    [['purpose'], direction === 'outbound' ? 'Vapi outbound manager status call' : 'Inbound Vapi call'],
    [['direction'], direction], [['status'], 'in_progress'], [['started_at'], startedAt],
    [['billable_minutes'], 0], [['created_at'], startedAt]
  ]);

  if (env.CALL_USAGE_WORKFLOW && typeof env.CALL_USAGE_WORKFLOW.create === 'function') {
    try {
      await env.CALL_USAGE_WORKFLOW.create({
        id: 'call-usage-' + callId,
        params: { tenant_id: tenantId, call_id: callId }
      });
    } catch (err) {
      await recordIntegrationStatus(env, tenantId, 'call_usage_workflow', 'start_failed', {
        call_id: callId, code: clean(err?.code || 'call_usage_workflow_failed', 80)
      });
    }
  }

  if (direction === 'outbound' || !phone || priorCount < 1) {
    return { recorded: true, call_id: callId, direction, repeat: false, call_count: priorCount + 1 };
  }

  const windowBucket = Math.floor(Date.now() / (REPEAT_WINDOW_MINUTES * 60000));
  const dedupeKey = 'repeat:' + callerRef + ':' + windowBucket;
  if (await hasRecentRepeatTask(env, tenantId, dedupeKey, new Date(Date.now() - REPEAT_WINDOW_MINUTES * 60000).toISOString())) {
    return { recorded: true, call_id: callId, direction, repeat: true, deduplicated: true, call_count: priorCount + 1 };
  }
  const taskId = 'TASK-' + makeId(8);
  const description = 'Repeat caller alert. This caller has placed ' + (priorCount + 1) +
    ' inbound calls within ' + REPEAT_WINDOW_MINUTES + ' minutes. Caller reference: ' + callerRef +
    '. Current call ID: ' + callId + '.';
  await insertScoped(env, 'manager_tasks', tenantId, [
    [['id'], taskId], [['task_id'], taskId],
    [['title'], 'HIGH PRIORITY: Repeat caller within 30 minutes'],
    [['description'], description], [['priority'], 'urgent'],
    [['status'], 'flagged_repeat_caller'], [['caller_hash'], callerRef],
    [['dedupe_key'], dedupeKey], [['created_at'], startedAt]
  ]);
  let notification = { queued: 0, reason: 'manager_phone_unavailable' };
  try { notification = await queueRoleNotification(env, tenantId, 'manager', description, 'repeat_caller_alert'); }
  catch (err) { notification = { queued: 0, reason: clean(err?.code || 'notification_failed', 80) }; }
  await audit(env, tenantId, 'repeat_caller_flagged_at_call_start', {
    caller_ref: callerRef, call_count: priorCount + 1, call_id: callId,
    task_id: taskId, notifications: notification.queued
  });
  return { recorded: true, call_id: callId, direction, repeat: true, call_count: priorCount + 1, task_id: taskId, notification };
}

async function storeManagerCallResult(env, tenantId, message) {
  await ensureSchema(env);
  const callId = clean(message?.call?.id || message?.callId || '', 120);
  if (!callId) return { matched: false, reason: 'missing_call_id' };
  const row = await env.DB.prepare(
    'SELECT * FROM `manager_status_checks` WHERE `tenant_id` = ? AND `outbound_call_id` = ? LIMIT 1'
  ).bind(tenantId, callId).first();
  if (!row) return { matched: false };
  const artifact = message?.artifact || {};
  const userLines = Array.isArray(artifact.messages)
    ? artifact.messages.filter(item => norm(item?.role) === 'user')
        .map(item => clean(item?.message || item?.content || item?.transcript || '', 1000)).filter(Boolean)
    : [];
  const transcript = clean(artifact.transcript || '', 5000);
  const managerResponse = clean(userLines.join('\n') || transcript, 4000);
  const endedReason = clean(message?.endedReason || message?.call?.endedReason || '', 100);
  const finalStatus = managerResponse ? 'completed' : 'no_manager_response';
  await env.DB.prepare(
    'UPDATE `manager_status_checks` SET `status` = ?, `manager_response` = ?, `completed_at` = ?, `updated_at` = ? WHERE `tenant_id` = ? AND `id` = ?'
  ).bind(finalStatus, managerResponse || ('Manager call ended without a captured reply. ' + endedReason).slice(0, 4000),
    nowIso(), nowIso(), tenantId, row.id).run();
  await audit(env, tenantId, 'manager_status_call_completed', {
    check_id: row.id, order_reference: row.order_reference, status: finalStatus,
    response_captured: Boolean(managerResponse), ended_reason: endedReason
  });
  return { matched: true, check_id: row.id, status: finalStatus };
}

async function initiateManagerStatusCall(env, tenantId, order, checkId, managerPhone, context = {}) {
  const apiKey = envValue(env, ENV_KEYS.vapiApiKey);
  const assistantId = envValue(env, ENV_KEYS.vapiAssistantId);
  const phoneNumberId = envValue(env, ENV_KEYS.vapiPhoneNumberId) || clean(context.phoneNumberId || '', 120);
  if (!apiKey || !assistantId || !phoneNumberId) {
    throw new AppError('Vapi outbound manager-call settings are incomplete.', 'manager_call_config_incomplete', 503);
  }
  const systemPrompt = [
    'You are Alex Pizza NYC internal manager-status assistant, not the customer-facing restaurant agent.',
    'You are calling the Alex Pizza manager to obtain a factual status update for an existing customer order.',
    'Ask for the kitchen/POS progress of order reference ' + order.order_id + '.',
    'Ask whether it is accepted, being prepared, ready for pickup, dispatched, delivered, delayed, or unavailable.',
    'Ask for the estimated ready/delivery time if known and any short explanation the customer can be told.',
    'Do not invent a status, do not claim an order is complete without the manager saying so, and do not place, edit, or cancel orders.',
    'Repeat the order reference to the manager to avoid mixing orders. Confirm the final answer clearly, then politely end the call.'
  ].join(' ');
  const payload = {
    assistantId,
    phoneNumberId,
    customer: { number: managerPhone, name: 'Alex Pizza Manager' },
    name: 'Alex Pizza order status ' + order.order_id,
    assistantOverrides: {
      firstMessage: 'Hello, this is the Alex Pizza automated order-status desk. I am checking order ' + order.order_id + '. Could you tell me its current kitchen or delivery status and the estimated completion time?',
      firstMessageMode: 'assistant-speaks-first',
      model: { messages: [{ role: 'system', content: systemPrompt }], tools: [] },
      variableValues: {
        tenantId, orderReference: order.order_id,
        customerReference: checkId, taskType: 'manager_order_status'
      }
    }
  };
  const response = await fetchWithTimeout('https://api.vapi.ai/call', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }, 8000);
  let data = {};
  try { data = await response.json(); } catch {}
  if (!response.ok || !data.id) {
    throw new AppError('Vapi could not start the manager status call: ' + clean(data.message || data.error || ('HTTP ' + response.status), 160),
      'manager_call_start_failed', 502, { provider_status: response.status });
  }
  await env.DB.prepare(
    'UPDATE `manager_status_checks` SET `outbound_call_id` = ?, `status` = ?, `updated_at` = ? WHERE `tenant_id` = ? AND `id` = ?'
  ).bind(clean(data.id, 120), 'calling_manager', nowIso(), tenantId, checkId).run();
  return { call_id: clean(data.id, 120), status: clean(data.status || 'queued', 40) };
}

async function transferToManager(env, tenantId, args, context = {}) {
  const reason = clean(args.reason || '', 1000);
  if (!reason) throw new AppError('reason is required.', 'reason_required', 400);
  const ref = clean(args.order_reference || '', 100);
  const managerPhone = requirePhones(env, 'manager')[0];
  const controlUrl = clean(context.controlUrl || '', 1000);
  if (!controlUrl) {
    const task = await createManagerTask(env, tenantId, 'Complaint requires manager assistance',
      reason + (ref ? '. Related order: ' + ref : '') + '. Live Vapi call-control URL was not present; manager callback is required.', 'urgent');
    await audit(env, tenantId, 'manager_live_transfer_unavailable', { order_reference: ref || null, task_id: task.task_id });
    return { ok: true, transfer_status: 'manager_callback_requested', live_transfer_started: false, ...task };
  }
  let parsed;
  try { parsed = new URL(controlUrl); } catch { throw new AppError('Vapi live call control URL is invalid.', 'invalid_call_control_url', 502); }
  if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.vapi.ai') || !parsed.pathname.endsWith('/control')) {
    throw new AppError('Vapi live call control URL failed origin validation.', 'invalid_call_control_url', 502);
  }
  const response = await fetchWithTimeout(parsed.toString(), {
    method: 'POST',
    headers: vapiControlHeaders(env),
    body: JSON.stringify({
      type: 'transfer',
      destination: { type: 'number', number: managerPhone },
      content: 'I am sorry about that. I will connect you with the Alex Pizza manager now.'
    })
  }, 8000);
  let data = {};
  try { data = await response.json(); } catch {}
  if (!response.ok) {
    const task = await createManagerTask(env, tenantId, 'Complaint transfer could not be completed',
      reason + (ref ? '. Related order: ' + ref : '') + '. Vapi transfer control returned HTTP ' + response.status + '.', 'urgent');
    await audit(env, tenantId, 'manager_live_transfer_failed', { order_reference: ref || null, provider_status: response.status, task_id: task.task_id });
    return { ok: true, transfer_status: 'manager_callback_requested', live_transfer_started: false, ...task };
  }
  const taskId = 'TASK-' + makeId(8);
  await insertScoped(env, 'manager_tasks', tenantId, [
    [['id'], taskId], [['task_id'], taskId],
    [['title'], 'Customer complaint — live manager transfer initiated'],
    [['description'], reason + (ref ? '. Related order: ' + ref : '')],
    [['priority'], 'urgent'], [['status'], 'live_transfer_initiated'],
    [['created_at'], nowIso()]
  ]);
  await audit(env, tenantId, 'manager_live_transfer_initiated', { order_reference: ref || null, task_id: taskId });
  return { ok: true, transfer_status: 'live_transfer_command_sent', live_transfer_started: true, task_id: taskId,
    message_for_assistant: 'A live transfer command was sent to Vapi. Do not claim that the manager answered; the call provider completes the connection.' };
}

async function requestManagerStatusCheck(env, tenantId, args, context = {}) {
  await ensureSchema(env);
  const phone = customerPhoneFrom(args, true);
  const orderId = clean(args.order_reference || '', 100);
  if (!orderId) throw new AppError('order_reference is required.', 'order_reference_required', 400);
  const orderStatus = await getOrderStatus(env, tenantId, { order_id: orderId, customer_phone: phone });
  const callerRef = await callerFingerprint(env, phone);
  const existing = await env.DB.prepare(
    'SELECT * FROM `manager_status_checks` WHERE `tenant_id` = ? AND `order_reference` = ? AND `caller_hash` = ? ORDER BY `created_at` DESC LIMIT 1'
  ).bind(tenantId, orderId, callerRef).first();
  if (existing && norm(existing.status) === 'completed' && clean(existing.manager_response || '', 20)) {
    return {
      ok: true, order_reference: orderId, current_system_status: orderStatus.status,
      manager_status: existing.manager_response,
      status: 'manager_response_received',
      message_for_assistant: 'The manager has supplied this status. Tell the customer the manager-reported status clearly. Do not transfer the customer.'
    };
  }
  if (existing && ['initiating', 'calling_manager', 'queued', 'in-progress'].includes(norm(existing.status))) {
    return {
      ok: true, order_reference: orderId, current_system_status: orderStatus.status,
      manager_call_status: existing.status, status: 'waiting_for_manager',
      message_for_assistant: 'The manager call is still in progress. Tell the customer you are checking with the manager and ask them to hold. Call request_manager_status_check again with the same order reference and customer phone after a short pause. Do not invent a status and do not transfer the customer.'
    };
  }

  const managerPhone = requirePhones(env, 'manager')[0];
  const checkId = 'MSC-' + makeId(8);
  await insertScoped(env, 'manager_status_checks', tenantId, [
    [['id'], checkId], [['order_reference'], orderId],
    [['customer_phone'], envFlag(env, ENV_KEYS.storeRawPhone, true) ? phone : null],
    [['caller_hash'], callerRef], [['manager_phone'], managerPhone],
    [['inbound_call_id'], clean(context.callId || '', 120)],
    [['status'], 'initiating'], [['started_at'], nowIso()], [['created_at'], nowIso()], [['updated_at'], nowIso()]
  ]);
  // Keep the customer informed while the outbound manager check runs.
  if (context.controlUrl) {
    try {
      const u = new URL(context.controlUrl);
      if (u.protocol === 'https:' && u.hostname.endsWith('.vapi.ai') && u.pathname.endsWith('/control')) {
        await fetchWithTimeout(u.toString(), {
          method: 'POST', headers: vapiControlHeaders(env),
          body: JSON.stringify({ type: 'say', content: 'Please hold for a moment while I contact the manager to verify your order status.', endCallAfterSpoken: false })
        }, 4000);
      }
    } catch {}
  }
  try {
    const managerCall = await initiateManagerStatusCall(env, tenantId, {
      order_id: orderId,
      customer_name: 'Customer order status enquiry'
    }, checkId, managerPhone, context);
    await audit(env, tenantId, 'manager_status_call_started', {
      check_id: checkId, order_reference: orderId, inbound_call_id: clean(context.callId || '', 120),
      outbound_call_id: managerCall.call_id
    });
    return {
      ok: true, order_reference: orderId, current_system_status: orderStatus.status,
      manager_call_status: managerCall.status, status: 'manager_call_started',
      message_for_assistant: 'You have called the manager. Tell the customer you are checking and ask them to hold. Invoke request_manager_status_check again with the same order_reference and customer_phone after a short pause to retrieve the manager response. Never state a guessed order status and never transfer the customer for a routine status check.'
    };
  } catch (err) {
    await env.DB.prepare(
      'UPDATE `manager_status_checks` SET `status` = ?, `manager_response` = ?, `updated_at` = ? WHERE `tenant_id` = ? AND `id` = ?'
    ).bind('call_start_failed', clean(publicError(err).error, 500), nowIso(), tenantId, checkId).run();
    const task = await createManagerTask(env, tenantId, 'Manager order status callback required',
      'Could not start automated manager call for order ' + orderId + '. Current system status: ' + orderStatus.status + '. Please call the customer back or update the dashboard.', 'urgent');
    return {
      ok: true, order_reference: orderId, current_system_status: orderStatus.status,
      manager_call_status: 'callback_required', status: 'manager_callback_requested',
      manager_task_id: task.task_id, message_for_assistant: 'The automated manager call could not start. Tell the customer you are unable to reach the manager right now, do not invent a status, record the manager callback task, and keep the call with the AI. Do not transfer unless the customer has a complaint.'
    };
  }
}

const TOOL_HANDLERS = {
  async get_menu(env, tenantId, args) {
    const menu = await getMenuRows(env, tenantId, {
      category: args.category,
      search: args.search || args.query,
      limit: args.limit,
      includeInactive: envFlag(env, ['MENU_INCLUDE_INACTIVE'], false)
    });
    return {
      ok: true,
      menu,
      count: menu.length,
      currency: CURRENCY,
      ...(menu.length ? {} : { warning: 'No active menu rows exist in D1. The Worker did not create or replace menu data.' })
    };
  },
  async check_table_availability(env, tenantId, args) {
    const partySize = Number(args.party_size);
    if (!Number.isInteger(partySize) || partySize < 1 || partySize > 40) throw new AppError('party_size must be between 1 and 40.', 'invalid_party_size', 400);
    return await checkAvailability(env, tenantId, args.booking_time, args.duration_minutes, partySize);
  },
  async book_table(env, tenantId, args) {
    if (!clean(args.customer_name, 120) || !customerPhoneFrom(args, true)) throw new AppError('customer_name and customer_phone are required.', 'booking_customer_required', 400);
    const partySize = Number(args.party_size);
    if (!Number.isInteger(partySize) || partySize < 1 || partySize > 40) throw new AppError('party_size must be between 1 and 40.', 'invalid_party_size', 400);
    return await createBooking(env, tenantId, args);
  },
  async submit_order(env, tenantId, args, ctx) {
    return await submitOrder(env, tenantId, args, ctx);
  },
  async get_order_status(env, tenantId, args, ctx) {
    const verifiedOrder = await getOrderStatus(env, tenantId, args);
    const managerCheck = await requestManagerStatusCheck(env, tenantId, args, ctx);
    return {
      ...verifiedOrder,
      manager_check: managerCheck,
      message_for_assistant: managerCheck.status === 'manager_response_received'
        ? 'The manager response has been received. Relay the manager-reported status to the customer; do not transfer.'
        : 'The order reference and customer phone were verified. The AI has contacted or is contacting the manager. Keep the customer with the AI, ask them to hold, and call request_manager_status_check again with the same order reference and phone to retrieve the manager reply. Never invent a status.'
    };
  },
  async request_order_change(env, tenantId, args) {
    return await requestOrderChange(env, tenantId, args);
  },
  async get_business_info(env) {
    return getBusinessInfo(env);
  },
  async flag_repeat_caller(env, tenantId, args) {
    const phone = customerPhoneFrom(args, true);
    return { ok: true, ...(await detectRepeatCaller(env, tenantId, phone, args.purpose || 'Caller requested assistance', clean(args.__call_id || '', 120))) };
  },
  async send_booking_notifications(env, tenantId, args) {
    return await sendBookingNotifications(env, tenantId, args);
  },
  async transfer_to_manager(env, tenantId, args, ctx) {
    return await transferToManager(env, tenantId, args, ctx);
  },
  async request_manager_status_check(env, tenantId, args, ctx) {
    return await requestManagerStatusCheck(env, tenantId, args, ctx);
  },
  async request_order_cancel(env, tenantId, args) {
    return await requestOrderCancellation(env, tenantId, args);
  },
  async calculate_order_tool(env, tenantId, args) {
    const items = await loadPricedItems(env, tenantId, args.items, null);
    const total = roundMoney(items.reduce((sum, item) => sum + item.lineTotal, 0));
    return { ok: true, items, total, currency: CURRENCY, note: 'Prices calculated from the active D1 menu; no order was submitted.' };
  }
};

// end_outbound_call is a Vapi-native call-control action, not a Worker HTTP function. Configure it as a native Vapi tool.
const TOOL_CATALOG = [
  { name: 'send_booking_notification', description: 'Send booking notifications using an existing booking reference.', parameters: { type: 'object', properties: { booking_id: { type: 'string' } }, required: ['booking_id'], additionalProperties: false } },
  { name: 'transfer_to_manager', description: 'Use only when the customer explicitly complains and wants human assistance. Sends a live Vapi transfer command to the configured Alex Pizza manager phone number. Never use for normal order-status questions.', parameters: { type: 'object', properties: { reason: { type: 'string', description: 'Brief explanation of why human assistance is required.' }, order_reference: { type: 'string' } }, required: ['reason'], additionalProperties: false } },
  { name: 'request_manager_status_check', description: 'Verify order reference and customer phone. The Worker calls the manager using Vapi outbound calling, keeps the customer with the AI, and stores the manager reply from the Vapi call-end webhook. Call this function again with the same details to retrieve the reply; never invent a status.', parameters: { type: 'object', properties: { customer_phone: { type: 'string' }, order_reference: { type: 'string' } }, required: ['order_reference', 'customer_phone'], additionalProperties: false } },
  { name: 'book_table', description: 'Create a table reservation after checking availability and calendar synchronization.', parameters: { type: 'object', properties: { party_size: { type: 'integer', minimum: 1, maximum: 40 }, booking_time: { type: 'string' }, customer_name: { type: 'string' }, customer_phone: { type: 'string' }, duration_minutes: { type: 'integer' } }, required: ['customer_name', 'customer_phone', 'booking_time', 'party_size'], additionalProperties: false } },
  { name: 'check_table_availability', description: 'Check reservation availability in America/New_York business time.', parameters: { type: 'object', properties: { party_size: { type: 'integer', minimum: 1, maximum: 40, description: 'Number of guests; restaurant capacity is 40 seats across 10 four-seat tables.' }, booking_time: { type: 'string', description: 'ISO 8601 date/time including timezone offset' }, duration_minutes: { type: 'integer', minimum: 30, maximum: 240 } }, required: ['booking_time', 'party_size'], additionalProperties: false } },
  { name: 'request_order_cancel', description: 'Cancel only within the first 5 minutes after verifying both order reference and customer phone. After 5 minutes cancellation is never allowed; do not create a replacement order from a cancellation request.', parameters: { type: 'object', properties: { reason: { type: 'string' }, customer_phone: { type: 'string' }, order_reference: { type: 'string' } }, required: ['order_reference', 'customer_phone', 'reason'], additionalProperties: false } },
  { name: 'submit_order', description: 'Submit customer-confirmed pickup or delivery order. POS confirmation is asynchronous; report pending until confirmed.', parameters: { type: 'object', properties: { items: { type: 'array', minItems: 1, items: { type: 'object', required: ['sku', 'quantity'], properties: { sku: { type: 'string' }, quantity: { type: 'integer', minimum: 1, maximum: 50 } }, additionalProperties: false } }, notes: { type: 'string' }, order_type: { type: 'string', enum: ['pickup', 'delivery'] }, customer_name: { type: 'string' }, customer_phone: { type: 'string' }, delivery_address: { type: 'string' }, customer_confirmed: { type: 'boolean' }, related_order_reference: { type: 'string' }, deliver_with_original: { type: 'boolean' } }, required: ['customer_name', 'customer_phone', 'order_type', 'items', 'customer_confirmed'], additionalProperties: false } },
  { name: 'request_order_change', description: '0-5 minutes: replace the complete order after customer confirmation. 5-20 minutes: only add items to the existing bill after confirmation; no cancellation or removals. After 20 minutes: original bill is locked; offer a separate linked order delivered with the original.', parameters: { type: 'object', properties: { customer_phone: { type: 'string' }, order_reference: { type: 'string' }, requested_changes: { type: 'string' }, items: { type: 'array', items: { type: 'object', required: ['sku', 'quantity'], properties: { sku: { type: 'string' }, quantity: { type: 'integer', minimum: 1, maximum: 50 } }, additionalProperties: false } }, customer_confirmed: { type: 'boolean' }, customer_decision: { type: 'string', enum: ['yes', 'no'] } }, required: ['order_reference', 'customer_phone', 'requested_changes'], additionalProperties: false } },
  { name: 'check_order_status', description: 'Verify customer phone and order reference, automatically call the manager for the latest order status, keep the customer with the AI and return the manager reply when available.', parameters: { type: 'object', properties: { customer_phone: { type: 'string' }, order_reference: { type: 'string' } }, required: ['order_reference', 'customer_phone'], additionalProperties: false } },
  { name: 'get_business_hours', description: 'Return business hours, time zone and reservation cutoff.', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } },
  { name: 'calculate_order_tool', description: 'Calculate a price estimate from active D1 menu items without submitting an order.', parameters: { type: 'object', properties: { items: { type: 'array', minItems: 1, items: { type: 'object', required: ['sku', 'quantity'], properties: { sku: { type: 'string' }, quantity: { type: 'integer', minimum: 1, maximum: 50 } }, additionalProperties: false } } }, required: ['items'], additionalProperties: false } },
  { name: 'get_menu', description: 'Return active Alex Pizza menu items and prices.', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } }
];
// end_outbound_call is a Vapi-native call-control action, not a Worker HTTP tool. Configure it separately in Vapi.

function extractToolCalls(body) {
  const message = body?.message && typeof body.message === 'object' ? body.message : {};
  const candidates = [
    message.toolCallList, message.toolCalls, message.tool_calls,
    body?.toolCallList, body?.toolCalls, body?.tool_calls, body?.calls
  ];
  const list = candidates.find(value => Array.isArray(value)) || [];
  return list.slice(0, MAX_TOOL_CALLS);
}
function getToolCallId(call, index) {
  return clean(call?.toolCallId || call?.id || call?.callId || ('call-' + index), 120);
}
function getToolName(call) {
  return clean(call?.function?.name || call?.name || call?.tool?.name || '', 120);
}
function getToolArgs(call) {
  return parseArgs(
    call?.function?.arguments ?? call?.arguments ?? call?.parameters ?? call?.tool?.arguments ?? {}
  );
}
async function executeToolCall(env, tenantId, call, index, ctx) {
  const callId = getToolCallId(call, index);
  try {
    const toolName = getToolName(call);
    const key = resolveToolName(toolName);
    const handler = TOOL_HANDLERS[key];
    if (!handler) {
      throw new AppError('Unknown tool: ' + clean(toolName, 100), 'unknown_tool', 404, {
        available_tools: Object.keys(TOOL_HANDLERS)
      });
    }
    const args = getToolArgs(call);
    args.__tool_call_id = (call?.toolCallId || call?.id || call?.callId) ? callId : '';
    args.__call_id = clean(ctx?.callId || '', 120);
    const payload = await handler(env, tenantId, args, ctx);
    return toolResult(callId, payload);
  } catch (err) {
    return toolResult(callId, publicError(err));
  }
}
async function ensureTenantActive(env, tenantId) {
  await ensureSchema(env);
  let tenant = await env.DB.prepare('SELECT `tenant_id`, `status`, `suspended_reason` FROM `tenants` WHERE `tenant_id` = ? LIMIT 1').bind(tenantId).first();
  if (!tenant && tenantId === DEFAULT_TENANT) {
    await env.DB.prepare('INSERT OR IGNORE INTO `tenants` (`tenant_id`, `name`, `timezone`, `status`, `created_at`, `updated_at`) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(tenantId, 'Alex Pizza NYC', TIME_ZONE_DEFAULT, 'active', nowIso(), nowIso()).run();
    tenant = await env.DB.prepare('SELECT `tenant_id`, `status`, `suspended_reason` FROM `tenants` WHERE `tenant_id` = ? LIMIT 1').bind(tenantId).first();
  }
  if (!tenant) throw new AppError('Tenant is not provisioned.', 'tenant_not_provisioned', 403);
  if (norm(tenant.status || 'active') !== 'active') throw new AppError('This AI calling service is temporarily suspended. Please contact the business administrator.', 'tenant_suspended', 403);
  return tenant;
}

async function handleVapiTools(request, env, ctx, tenantId) {
  await requireToolAuth(request, env);
  const blocked = requireMethod(request, env, 'POST');
  if (blocked) return blocked;
  await ensureTenantActive(env, tenantId);
  const body = await readJson(request, env);
  const calls = extractToolCalls(body);
  const vapiCall = body?.message?.call || body?.call || {};
  const callContext = {
    callId: clean(vapiCall.id || '', 120),
    phoneNumberId: clean(vapiCall.phoneNumberId || vapiCall.phoneNumber?.id || '', 120),
    controlUrl: clean(vapiCall.monitor?.controlUrl || '', 1000),
    customerPhone: normalizePhone(vapiCall.customer?.number || vapiCall.customer?.phone || ''),
    callType: clean(vapiCall.type || '', 40)
  };
  const results = [];
  for (let i = 0; i < calls.length; i++) {
    results.push(await executeToolCall(env, tenantId, calls[i], i, callContext));
  }
  return json(request, env, { results, tool_count: results.length, tenant_id: tenantId });
}
async function handleToolCatalog(request, env, tenantId) {
  await requireToolAuth(request, env);
  await ensureTenantActive(env, tenantId);
  return json(request, env, { ok: true, tenant_id: tenantId, tools: TOOL_CATALOG });
}

// ===== BLOCK 10/10: Router, admin endpoints, cron and export =====
async function handleVapiEvents(request, env, tenantId) {
  await requireToolAuth(request, env);
  const blocked = requireMethod(request, env, 'POST');
  if (blocked) return blocked;
  await ensureTenantActive(env, tenantId);
  const body = await readJson(request, env);
  const message = body?.message && typeof body.message === 'object' ? body.message : body;
  const eventType = clean(message?.type || 'unknown', 60);
  const callId = clean(message?.call?.id || message?.callId || '', 120);

  if (eventType === 'status-update') {
    const status = norm(message?.status || '');
    if (status === 'in-progress' && callId) {
      const recorded = await recordInboundCallStart(env, tenantId, message.call || {});
      return json(request, env, { ok: true, event: eventType, status, ...recorded });
    }
    if (status === 'ended' && callId) {
      await env.DB.prepare(
        'UPDATE `calls` SET `status` = ?, `ended_at` = ? WHERE `tenant_id` = ? AND `call_id` = ?'
      ).bind('ended', nowIso(), tenantId, callId).run();
    }
    return json(request, env, { ok: true, event: eventType, status: status || 'received', call_id: callId || null });
  }

  if (eventType !== 'end-of-call-report') {
    return json(request, env, { ok: true, ignored: eventType });
  }

  // The same event endpoint also receives the manager's outbound Vapi status call.
  const managerResult = await storeManagerCallResult(env, tenantId, message);
  if (!callId) return json(request, env, { ok: true, skipped: 'missing_call_id', manager_status: managerResult });

  let seconds = Number(message.durationSeconds) || (Number(message.durationMs) / 1000) || 0;
  if (!seconds && message.startedAt && message.endedAt) {
    seconds = (new Date(message.endedAt).getTime() - new Date(message.startedAt).getTime()) / 1000;
  }
  if (!Number.isFinite(seconds) || seconds <= 0) {
    await env.DB.prepare(
      'UPDATE `calls` SET `status` = ?, `ended_at` = ? WHERE `tenant_id` = ? AND `call_id` = ?'
    ).bind('ended', message.endedAt || nowIso(), tenantId, callId).run();
    return json(request, env, { ok: true, skipped: 'no_duration', manager_status: managerResult });
  }

  const seen = await env.DB.prepare(
    "SELECT 1 AS found FROM `audit_log` WHERE `tenant_id` = ? AND `event` = 'call_minutes' AND `details` LIKE ? LIMIT 1"
  ).bind(tenantId, '%' + callId + '%').first();
  if (seen) return json(request, env, { ok: true, duplicate: true, manager_status: managerResult });

  const endedAt = message.endedAt || nowIso();
  const usage = await recordCallMinutes(env, tenantId, seconds, endedAt, callId);
  const existingCall = await env.DB.prepare(
    'SELECT 1 FROM `calls` WHERE `tenant_id` = ? AND `call_id` = ? LIMIT 1'
  ).bind(tenantId, callId).first();
  if (existingCall) {
    await env.DB.prepare(
      'UPDATE `calls` SET `status` = ?, `duration_seconds` = ?, `billable_minutes` = ?, `ended_at` = ? WHERE `tenant_id` = ? AND `call_id` = ?'
    ).bind('ended', Math.ceil(seconds), Math.ceil(seconds / 60), new Date(endedAt).toISOString(), tenantId, callId).run();
  } else {
    const startedAt = message.startedAt || message.call?.createdAt || endedAt;
    await insertScoped(env, 'calls', tenantId, [
      [['id'], callId], [['call_id'], callId],
      [['customer_phone'], envFlag(env, ENV_KEYS.storeRawPhone, true) ? normalizePhone(message.call?.customer?.number || '') : null],
      [['caller_hash'], await callerFingerprint(env, message.call?.customer?.number || '')],
      [['purpose'], 'Vapi end-of-call report'],
      [['direction'], clean(message.call?.type || 'unknown', 30)],
      [['status'], 'ended'], [['started_at'], new Date(startedAt).toISOString()],
      [['duration_seconds'], Math.ceil(seconds)], [['billable_minutes'], Math.ceil(seconds / 60)],
      [['ended_at'], new Date(endedAt).toISOString()], [['created_at'], new Date(startedAt).toISOString()]
    ]);
  }
  await audit(env, tenantId, 'call_minutes', {
    call_id: callId, duration_seconds: Math.ceil(seconds), ...usage,
    manager_status_check: Boolean(managerResult?.matched)
  });
  return json(request, env, { ok: true, usage, manager_status: managerResult });
}

async function authenticateClientDashboard(request, env) {
  await ensureSchema(env);
  const token = bearerOrHeader(request, ['x-client-dashboard-token']);
  if (!token) throw new AppError('Client dashboard token is required.', 'client_dashboard_auth_required', 401);
  const digest = await hashSecret(token);
  const tenant = await env.DB.prepare(
    'SELECT `tenant_id`, `status` FROM `tenants` WHERE `dashboard_token_hash` = ? LIMIT 1'
  ).bind(digest).first();
  if (!tenant) throw new AppError('Invalid client dashboard token.', 'unauthorized', 401);
  const tenantId = validateTenant(tenant.tenant_id);
  await ensureTenantActive(env, tenantId);
  return tenantId;
}

async function requireManagerDashboardAuth(request, env) {
  const expected = envValue(env, ENV_KEYS.managerDashboardToken);
  if (!expected) throw new AppError('MANAGER_DASHBOARD_TOKEN is not configured.', 'manager_dashboard_auth_unconfigured', 503);
  const supplied = bearerOrHeader(request, ['x-manager-dashboard-token']);
  if (!(await secureEqual(supplied, expected))) throw new AppError('Unauthorized manager dashboard request.', 'unauthorized', 401);
}

function managerDashboardHtml() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Alex Pizza Manager Dashboard</title><style>
  body{font:16px system-ui,sans-serif;max-width:980px;margin:32px auto;padding:0 16px;color:#222}h1{font-size:26px}input,button{font:inherit;padding:10px;margin:5px 4px 5px 0}input{max-width:100%;box-sizing:border-box}button{cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f4f4;padding:14px;border-radius:8px}.row{display:flex;gap:8px;flex-wrap:wrap}#status{margin:12px 0}
  </style></head><body><h1>Alex Pizza — Manager Dashboard</h1><p>View and download operational records retained for the latest 60 days. Access is tenant-scoped.</p>
  <label>Manager dashboard token<br><input id="token" type="password" autocomplete="current-password" placeholder="Enter manager dashboard token"></label><br>
  <label>Tenant ID<br><input id="tenant" value="alex-pizza" autocomplete="organization"></label><div class="row"><button id="load">Load dashboard data</button><button id="download">Download retained data (JSON)</button></div><div id="status" role="status"></div><pre id="output">Sign in with your manager dashboard token to load data.</pre>
  <script>
  const token=document.getElementById('token'),tenant=document.getElementById('tenant'),status=document.getElementById('status'),output=document.getElementById('output');
  async function request(path){const id=encodeURIComponent(tenant.value.trim());if(!id)throw Error('Enter a tenant ID.');const r=await fetch(path+'?tenant_id='+id,{headers:{Authorization:'Bearer '+token.value.trim()}});if(!r.ok){let m='Request failed ('+r.status+')';try{m=(await r.json()).error||m}catch{}throw Error(m)}return r;}
  document.getElementById('load').onclick=async()=>{try{status.textContent='Loading…';const r=await request('/manager/data');const d=await r.json();output.textContent=JSON.stringify(d,null,2);status.textContent='Loaded '+d.record_count+' records. Retention: '+d.retention_days+' days.'}catch(e){status.textContent=e.message}};
  document.getElementById('download').onclick=async()=>{try{status.textContent='Preparing download…';const r=await request('/manager/export');const b=await r.blob();const u=URL.createObjectURL(b);const a=document.createElement('a');a.href=u;a.download='alex-pizza-retained-data-'+tenant.value.trim()+'.json';a.click();URL.revokeObjectURL(u);status.textContent='Download started.'}catch(e){status.textContent=e.message}};
  </script></body></html>`;
}

async function collectManagerData(env, tenantId) {
  await ensureSchema(env);
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400000).toISOString();
  const data = {};
  let recordCount = 0;
  for (const table of PURGE_TABLES) {
    const columns = await getColumns(env, table);
    const tenantColumn = findColumn(columns, TENANT_COLUMNS);
    const createdColumn = findColumn(columns, ['created_at', 'createdAt', 'created']);
    if (!tenantColumn || !createdColumn) { data[table] = []; continue; }
    const result = await env.DB.prepare(`SELECT * FROM ${q(table)} WHERE ${q(tenantColumn)} = ? AND ${q(createdColumn)} >= ? ORDER BY ${q(createdColumn)} DESC LIMIT 5000`).bind(tenantId, cutoff).all();
    data[table] = result.results || [];
    recordCount += data[table].length;
  }
  const usage = await env.DB.prepare('SELECT `month`, `total_minutes`, `last_call_at`, `status`, `updated_at` FROM `monthly_call_usage` WHERE `tenant_id` = ? ORDER BY `month` DESC LIMIT 24').bind(tenantId).all();
  const invoices = await env.DB.prepare('SELECT `invoice_id`, `billing_month`, `minutes`, `amount_due`, `amount_paid`, `status`, `due_at`, `created_at` FROM `invoices` WHERE `tenant_id` = ? ORDER BY `billing_month` DESC LIMIT 24').bind(tenantId).all();
  const payments = await env.DB.prepare('SELECT `payment_id`, `amount`, `currency`, `method`, `reference`, `created_at` FROM `manual_payments` WHERE `tenant_id` = ? ORDER BY `created_at` DESC LIMIT 50').bind(tenantId).all();
  const local = zonedParts(new Date(), TIME_ZONE_DEFAULT);
  const currentMonth = local.year + '-' + String(local.month).padStart(2, '0');
  const currentUsage = (usage.results || []).find(row => row.month === currentMonth) || { month: currentMonth, total_minutes: 0, status: 'active' };
  return { ok: true, tenant_id: tenantId, retention_days: RETENTION_DAYS, retained_since: cutoff, exported_at: nowIso(), record_count: recordCount, data,
    billing: { current_month: currentUsage, monthly_history: usage.results || [], invoices: invoices.results || [], payments: payments.results || [] } };
}

function routePath(url) {
  return url.pathname.replace(/[/]+$/, '') || '/';
}
function adminTenant(request, url, body) {
  return validateTenant(body?.tenant_id || body?.tenantId || url.searchParams.get('tenant_id'));
}
async function handleAdmin(request, env, url, path) {
  await requireAdminAuth(request, env);
  const blocked = requireMethod(request, env, 'POST');
  if (blocked) return blocked;
  const body = await readJson(request, env);
  if (path === '/admin/provider-overview') {
    await ensureSchema(env);
    const tenants = await env.DB.prepare('SELECT `tenant_id`, `name`, `timezone`, `status`, `suspended_reason`, `created_at`, `updated_at` FROM `tenants` ORDER BY `created_at` DESC LIMIT 500').all();
    const usage = await env.DB.prepare('SELECT `tenant_id`, `month`, `total_minutes`, `last_call_at`, `status` FROM `monthly_call_usage` ORDER BY `month` DESC LIMIT 2000').all();
    const invoices = await env.DB.prepare('SELECT `tenant_id`, `invoice_id`, `billing_month`, `minutes`, `amount_due`, `amount_paid`, `status`, `due_at`, `created_at` FROM `invoices` ORDER BY `created_at` DESC LIMIT 2000').all();
    return json(request, env, { ok: true, tenants: tenants.results || [], monthly_usage: usage.results || [], invoices: invoices.results || [], exported_at: nowIso() });
  }
  const tenantId = adminTenant(request, url, body);

  if (path === '/admin/issue-client-token') {
    const tenantId = adminTenant(request, url, body);
    await ensureSchema(env);
    const tenantName = clean(body.name || tenantId, 120);
    const tenantTimeZone = clean(body.timezone || TIME_ZONE_DEFAULT, 64);
    const token = 'APC_' + makeId(48);
    const digest = await hashSecret(token);
    await env.DB.prepare(
      "INSERT INTO `tenants` (`tenant_id`, `name`, `timezone`, `status`, `dashboard_token_hash`, `dashboard_token_created_at`, `created_at`, `updated_at`) VALUES (?, ?, ?, 'active', ?, ?, ?, ?) ON CONFLICT(`tenant_id`) DO UPDATE SET `name` = excluded.`name`, `timezone` = excluded.`timezone`, `dashboard_token_hash` = excluded.`dashboard_token_hash`, `dashboard_token_created_at` = excluded.`dashboard_token_created_at`, `updated_at` = excluded.`updated_at`"
    ).bind(tenantId, tenantName, tenantTimeZone, digest, nowIso(), nowIso(), nowIso()).run();
    await audit(env, tenantId, 'client_dashboard_token_issued', { issued_at: nowIso() });
    return json(request, env, {
      ok: true, tenant_id: tenantId, token,
      warning: 'Copy this client token now. It is shown once; only its SHA-256 hash is stored in D1.',
      dashboard_data_endpoint: '/client/data',
      dashboard_export_endpoint: '/client/export'
    });
  }
  if (path === '/admin/revoke-client-token') {
    const tenantId = adminTenant(request, url, body);
    await ensureSchema(env);
    await env.DB.prepare(
      'UPDATE `tenants` SET `dashboard_token_hash` = NULL, `dashboard_token_created_at` = NULL, `updated_at` = ? WHERE `tenant_id` = ?'
    ).bind(nowIso(), tenantId).run();
    await audit(env, tenantId, 'client_dashboard_token_revoked', {});
    return json(request, env, { ok: true, tenant_id: tenantId, token_revoked: true });
  }
  if (path === '/admin/retry-order-pos') {
    const orderReference = clean(body.order_reference || body.order_id || '', 100);
    if (!orderReference) throw new AppError('order_reference is required.', 'order_reference_required', 400);
    const order = await env.DB.prepare(
      'SELECT `order_id`, `status` FROM `orders` WHERE `tenant_id` = ? AND (`order_id` = ? OR `id` = ?) LIMIT 1'
    ).bind(tenantId, orderReference, orderReference).first();
    if (!order) throw new AppError('Order not found for this tenant.', 'order_not_found', 404);
    if (['cancelled', 'canceled'].includes(norm(order.status))) {
      throw new AppError('A cancelled order cannot be sent to Zoho POS.', 'cancelled_order_not_retryable', 409);
    }
    if (!env.ORDER_WORKFLOW || typeof env.ORDER_WORKFLOW.create !== 'function') {
      throw new AppError('Order processing Workflow binding is unavailable.', 'workflow_binding_missing', 503);
    }
    const workflowId = 'order-retry-' + clean(order.order_id || orderReference, 40).toLowerCase() + '-' + makeId(6).toLowerCase();
    await updateOrderStatus(env, tenantId, order.order_id || orderReference, 'pending_pos_sync');
    try {
      await env.ORDER_WORKFLOW.create({
        id: workflowId,
        params: { tenant_id: tenantId, order_id: order.order_id || orderReference }
      });
    } catch (err) {
      await updateOrderStatus(env, tenantId, order.order_id || orderReference, 'workflow_start_failed');
      throw new AppError('Could not start the Zoho POS retry workflow: ' + clean(err?.message || 'Workflow error', 140),
        'workflow_start_failed', 503);
    }
    await audit(env, tenantId, 'manual_zoho_pos_retry_started', {
      order_id: order.order_id || orderReference, workflow_id: workflowId
    });
    return json(request, env, {
      ok: true, tenant_id: tenantId, order_reference: order.order_id || orderReference,
      workflow_id: workflowId, status: 'pending_pos_sync'
    });
  }
  if (path === '/admin/bootstrap') {
    const schema = await ensureSchema(env);
    await audit(env, tenantId, 'schema_bootstrap', schema);
    return json(request, env, { ok: true, tenant_id: tenantId, schema: 'ready', ...schema });
  }
  if (path === '/admin/sync-menu') {
    const result = await syncAndReplaceD1Menu(env, tenantId);
    return json(request, env, { ok: true, result });
  }
  if (path === '/admin/map-menu-pos-items') {
    await ensureSchema(env);
    if (!Array.isArray(body.items) || !body.items.length || body.items.length > MAX_MENU_ROWS) {
      throw new AppError('items must be a non-empty array with no more than ' + MAX_MENU_ROWS + ' rows.', 'invalid_menu_mapping_rows', 400);
    }
    const columns = await getColumns(env, 'menu_items');
    const scopeColumn = findColumn(columns, TENANT_COLUMNS);
    const skuColumn = findColumn(columns, ['sku', 'id', 'menu_item_id']);
    const posColumn = findColumn(columns, ['pos_variant_id', 'zoho_item_id', 'pos_item_id']);
    if (!scopeColumn || !skuColumn || !posColumn) throw new AppError('D1 menu_items table is missing SKU or POS mapping columns.', 'menu_mapping_schema_incomplete', 500);
    const updates = [];
    const validSkus = [];
    const invalid = [];
    for (const row of body.items) {
      const sku = clean(row?.sku || '', 80);
      const posId = String(row?.pos_variant_id ?? row?.zoho_item_id ?? '').trim();
      if (!sku || !/^[0-9]{1,24}$/.test(posId)) {
        invalid.push({ sku: sku || null, reason: 'A SKU and a numeric Zoho POS item ID are required.' });
        continue;
      }
      validSkus.push(sku);
      updates.push(env.DB.prepare(
        'UPDATE `menu_items` SET ' + q(posColumn) + ' = ? WHERE ' + q(scopeColumn) + ' = ? AND LOWER(' + q(skuColumn) + ') = LOWER(?)'
      ).bind(posId, tenantId, sku));
    }
    const results = updates.length ? await env.DB.batch(updates) : [];
    const mapped = results.reduce((sum, result) => sum + Number(result.meta?.changes || 0), 0);
    const notFound = results.map((result, index) => Number(result.meta?.changes || 0) === 0 ? validSkus[index] : null).filter(Boolean);
    await audit(env, tenantId, 'zoho_menu_item_mapping_updated', { mapped, invalid_rows: invalid.length, sku_not_found: notFound.length });
    return json(request, env, { ok: true, tenant_id: tenantId, mapped, unmatched_skus: notFound, invalid_rows: invalid,
      note: 'Only supplied numeric IDs were saved. No Zoho IDs were generated or guessed.' });
  }
  if (path === '/admin/purge-60-days') {
    const result = await run60DayDataPurge(env);
    await audit(env, tenantId, 'manual_purge', { purgedRecords: result.purgedRecords });
    return json(request, env, { ok: true, result });
  }
  if (path === '/admin/zoho-token') {
    await getZohoAccessToken(env, tenantId);
    return json(request, env, { ok: true, tenant_id: tenantId, token_available: true });
  }
  if (path === '/admin/tenant-status') {
    const status = norm(body.status || '');
    if (!['active', 'suspended'].includes(status)) throw new AppError('status must be active or suspended.', 'invalid_tenant_status', 400);
    const reason = clean(body.reason || '', 500) || null;
    await env.DB.prepare('INSERT INTO `tenants` (`tenant_id`, `name`, `timezone`, `status`, `suspended_reason`, `created_at`, `updated_at`) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(`tenant_id`) DO UPDATE SET `status` = excluded.`status`, `suspended_reason` = excluded.`suspended_reason`, `updated_at` = excluded.`updated_at`')
      .bind(tenantId, tenantId === DEFAULT_TENANT ? 'Alex Pizza NYC' : tenantId, TIME_ZONE_DEFAULT, status, status === 'suspended' ? reason : null, nowIso(), nowIso()).run();
    await audit(env, tenantId, 'tenant_status_changed', { status, reason });
    return json(request, env, { ok: true, tenant_id: tenantId, status });
  }
  if (path === '/admin/invoice') {
    const billingMonth = clean(body.billing_month || '', 7);
    const minutes = Math.max(0, Math.floor(Number(body.minutes) || 0));
    const amountDue = roundMoney(Number(body.amount_due));
    const dueAt = body.due_at ? new Date(body.due_at) : null;
    if (!/^\d{4}-\d{2}$/.test(billingMonth) || !Number.isFinite(amountDue) || amountDue < 0 || (body.due_at && Number.isNaN(dueAt.getTime()))) {
      throw new AppError('billing_month (YYYY-MM) and a non-negative amount_due are required.', 'invalid_invoice', 400);
    }
    const invoiceId = 'INV-' + makeId(8);
    await insertScoped(env, 'invoices', tenantId, [
      [['id'], invoiceId], [['invoice_id'], invoiceId], [['billing_month'], billingMonth],
      [['minutes'], minutes], [['amount_due'], amountDue], [['amount_paid'], 0],
      [['status'], amountDue === 0 ? 'paid' : 'unpaid'], [['due_at'], dueAt ? dueAt.toISOString() : null], [['created_at'], nowIso()], [['updated_at'], nowIso()]
    ]);
    await audit(env, tenantId, 'invoice_created', { invoice_id: invoiceId, billing_month: billingMonth, amount_due: amountDue });
    return json(request, env, { ok: true, tenant_id: tenantId, invoice_id: invoiceId, billing_month: billingMonth, minutes, amount_due: amountDue, due_at: dueAt ? dueAt.toISOString() : null, currency: CURRENCY, status: amountDue === 0 ? 'paid' : 'unpaid' });
  }
  if (path === '/admin/manual-payment') {
    const amount = roundMoney(Number(body.amount));
    if (!Number.isFinite(amount) || amount <= 0) throw new AppError('A positive payment amount is required.', 'invalid_payment_amount', 400);
    const method = clean(body.method || 'manual', 40);
    const paymentId = 'PAY-' + makeId(8);
    await insertScoped(env, 'manual_payments', tenantId, [
      [['id'], paymentId], [['payment_id'], paymentId], [['amount'], amount], [['currency'], CURRENCY],
      [['method'], method], [['reference'], clean(body.reference || '', 160)],
      [['notes'], clean(body.notes || '', 1000)], [['recorded_by'], 'admin'], [['created_at'], nowIso()]
    ]);
    let invoiceUpdate = null;
    if (body.invoice_id) {
      const invoiceId = clean(body.invoice_id, 100);
      const invoice = await env.DB.prepare('SELECT `amount_due`, `amount_paid` FROM `invoices` WHERE `tenant_id` = ? AND `invoice_id` = ? LIMIT 1').bind(tenantId, invoiceId).first();
      if (!invoice) throw new AppError('Invoice not found for this tenant.', 'invoice_not_found', 404);
      const nextPaid = roundMoney(Number(invoice.amount_paid || 0) + amount);
      if (nextPaid > Number(invoice.amount_due || 0) + 0.001) throw new AppError('Payment exceeds the invoice balance.', 'payment_exceeds_balance', 400);
      const status = nextPaid >= Number(invoice.amount_due || 0) ? 'paid' : 'partially_paid';
      await env.DB.prepare('UPDATE `invoices` SET `amount_paid` = ?, `status` = ?, `updated_at` = ? WHERE `tenant_id` = ? AND `invoice_id` = ?').bind(nextPaid, status, nowIso(), tenantId, invoiceId).run();
      invoiceUpdate = { invoice_id: invoiceId, amount_paid: nextPaid, status };
    }
    await audit(env, tenantId, 'manual_payment_recorded', { payment_id: paymentId, amount, method, invoice: invoiceUpdate });
    return json(request, env, { ok: true, tenant_id: tenantId, payment_id: paymentId, amount, currency: CURRENCY, status: 'recorded', invoice: invoiceUpdate });
  }
  if (path === '/admin/usage') {
    const monthParts = zonedParts(new Date(), TIME_ZONE_DEFAULT);
    const currentMonth = monthParts.year + '-' + String(monthParts.month).padStart(2, '0');
    const history = await env.DB.prepare('SELECT `month`, `total_minutes`, `last_call_at`, `status` FROM `monthly_call_usage` WHERE `tenant_id` = ? ORDER BY `month` DESC LIMIT 24').bind(tenantId).all();
    const payments = await env.DB.prepare('SELECT `payment_id`, `amount`, `currency`, `method`, `reference`, `created_at` FROM `manual_payments` WHERE `tenant_id` = ? ORDER BY `created_at` DESC LIMIT 20').bind(tenantId).all();
    const invoices = await env.DB.prepare('SELECT `invoice_id`, `billing_month`, `minutes`, `amount_due`, `amount_paid`, `status`, `created_at` FROM `invoices` WHERE `tenant_id` = ? ORDER BY `billing_month` DESC LIMIT 24').bind(tenantId).all();
    const current = (history.results || []).find(row => row.month === currentMonth) || { month: currentMonth, total_minutes: 0 };
    return json(request, env, { ok: true, tenant_id: tenantId, current_month: current, monthly_history: history.results || [], invoices: invoices.results || [], manual_payments: payments.results || [] });
  }
  if (path === '/admin/google-calendar-test') {
    const state = googleCalendarState(env);
    if (!state.configured) {
      throw new AppError('Google Calendar is not fully configured.', 'google_calendar_not_configured', 503, {
        missing: state.missing
      });
    }
    const now = new Date();
    const events = await listGoogleCalendarEvents(env, now, new Date(now.getTime() + 7 * 86400000));
    await recordIntegrationStatus(env, tenantId, 'google_calendar', 'ok', {
      test: true, events_found_next_7_days: Array.isArray(events) ? events.length : 0
    });
    return json(request, env, {
      ok: true, tenant_id: tenantId, google_calendar: 'connected',
      events_found_next_7_days: Array.isArray(events) ? events.length : 0,
      time_zone: TIME_ZONE_DEFAULT
    });
  }
  return json(request, env, { ok: false, error: 'Admin route not found', code: 'admin_route_not_found' }, 404);
}
function deliveryMode(env) {
  if (signalwireConfig(env)) return 'signalwire';
  return envValue(env, ENV_KEYS.webhookUrl) ? 'webhook' : 'none';
}

async function handleFetch(request, env, ctx) {
  if (request.method === 'OPTIONS') return preflight(request, env);
  const url = new URL(request.url);
  const path = routePath(url);

  try {
    if (request.method === 'GET' && (path === '/' || path === '/health')) {
      return json(request, env, {
        ok: true,
        service: WORKER_NAME,
        status: 'Alex Pizza AI Core Active',
        time: nowIso(),
        db_configured: Boolean(env?.DB),
        order_workflow_configured: Boolean(env?.ORDER_WORKFLOW),
        signalwire_configured: Boolean(signalwireConfig(env)),
        message_delivery: deliveryMode(env),
        tool_auth_configured: Boolean(envValue(env, ENV_KEYS.toolSecret)),
        admin_auth_configured: Boolean(envValue(env, ENV_KEYS.adminToken)),
        manager_dashboard_auth_configured: Boolean(envValue(env, ENV_KEYS.managerDashboardToken)),
        manager_phones_configured: resolvePhones(env, 'manager').length,
        business_phones_configured: resolvePhones(env, 'business').length,
        zoho_pos_configured: Boolean(
          envValue(env, ENV_KEYS.zohoClientId) &&
          envValue(env, ENV_KEYS.zohoClientSecret) &&
          envValue(env, ENV_KEYS.zohoRefreshToken) &&
          envValue(env, ENV_KEYS.zohoOrganization) &&
          envValue(env, ENV_KEYS.zohoCustomer) &&
          envValue(env, ENV_KEYS.zohoItemIdMap)
        ),
        google_calendar_configured: googleCalendarState(env).configured,
        google_calendar_partially_configured: googleCalendarState(env).partially_configured,
        notification_webhook_configured: Boolean(envValue(env, ENV_KEYS.webhookUrl))
      });
    }

    if (path === '/manager' && request.method === 'GET') {
      return new Response(managerDashboardHtml(), { status: 200, headers: { ...responseHeaders(request, env), 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'" } });
    }
    if (path === '/client/data' || path === '/client/export') {
      if (request.method !== 'GET') return json(request, env, { ok: false, error: 'Method not allowed', code: 'method_not_allowed' }, 405, { Allow: 'GET' });
      const tenantId = await authenticateClientDashboard(request, env);
      const result = await collectManagerData(env, tenantId);
      if (path === '/client/export') {
        return new Response(JSON.stringify(result, null, 2), { status: 200, headers: { ...responseHeaders(request, env), 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="${tenantId}-dashboard-export.json"` } });
      }
      return json(request, env, result);
    }

    if (path === '/manager/data' || path === '/manager/export') {
      if (request.method !== 'GET') return json(request, env, { ok: false, error: 'Method not allowed', code: 'method_not_allowed' }, 405, { Allow: 'GET' });
      await requireManagerDashboardAuth(request, env);
      const tenantId = validateTenant(url.searchParams.get('tenant_id') || DEFAULT_TENANT);
      if (tenantId !== DEFAULT_TENANT) throw new AppError('Provider-wide access is not available through the restaurant manager token. Use the provider admin API or the tenant client token.', 'tenant_scope_forbidden', 403);
      await ensureTenantActive(env, tenantId);
      const result = await collectManagerData(env, tenantId);
      if (path === '/manager/export') {
        return new Response(JSON.stringify(result, null, 2), { status: 200, headers: { ...responseHeaders(request, env), 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="${tenantId}-retained-data.json"` } });
      }
      return json(request, env, result);
    }

    if (path.startsWith('/admin/')) return await handleAdmin(request, env, url, path);

    const vapiMatch = path.match(new RegExp('^/vapi/([a-z0-9-]+)/(tools|events)$', 'i'));
    if (vapiMatch) {
      const tenantId = validateTenant(vapiMatch[1]);
      if (vapiMatch[2].toLowerCase() === 'events') {
        if (request.method === 'POST') return await handleVapiEvents(request, env, tenantId);
        return json(request, env, { ok: false, error: 'Method not allowed', code: 'method_not_allowed' }, 405, { Allow: 'POST' });
      }
      if (request.method === 'GET') return await handleToolCatalog(request, env, tenantId);
      if (request.method === 'POST') return await handleVapiTools(request, env, ctx, tenantId);
      return json(request, env, { ok: false, error: 'Method not allowed', code: 'method_not_allowed' }, 405, { Allow: 'GET, POST' });
    }

    return json(request, env, { ok: false, error: 'Route not found', code: 'route_not_found' }, 404);
  } catch (err) {
    safeLog(err);
    return httpErrorResponse(request, env, err);
  }
}
async function suspendOverdueInvoiceTenants(env) {
  await ensureSchema(env);
  const overdue = await env.DB.prepare(
    "SELECT DISTINCT `tenant_id` FROM `invoices` WHERE LOWER(COALESCE(`status`, '')) IN ('unpaid', 'partially_paid') AND `due_at` IS NOT NULL AND datetime(`due_at`) < datetime(?)"
  ).bind(nowIso()).all();
  const suspended = [];
  for (const row of overdue.results || []) {
    const tenantId = validateTenant(row.tenant_id);
    const tenant = await env.DB.prepare('SELECT `status`, `suspended_reason` FROM `tenants` WHERE `tenant_id` = ? LIMIT 1').bind(tenantId).first();
    if (!tenant || norm(tenant.status || 'active') !== 'active') continue;
    const reason = 'Suspended automatically: an invoice is past its due_at date and remains unpaid.';
    await env.DB.prepare('UPDATE `tenants` SET `status` = ?, `suspended_reason` = ?, `updated_at` = ? WHERE `tenant_id` = ?')
      .bind('suspended', reason, nowIso(), tenantId).run();
    await audit(env, tenantId, 'tenant_suspended_overdue_invoice', { reason });
    suspended.push(tenantId);
  }
  return { checked: (overdue.results || []).length, suspended };
}

async function archivePriorMonthlyUsage(env) {
  await ensureSchema(env);
  const local = zonedParts(new Date(), TIME_ZONE_DEFAULT);
  const currentMonth = local.year + '-' + String(local.month).padStart(2, '0');
  if (local.day !== 1) return { archived: 0, current_month: currentMonth, skipped: true };
  const result = await env.DB.prepare(
    "UPDATE `monthly_call_usage` SET `status` = 'archived', `updated_at` = ? WHERE `month` < ? AND LOWER(COALESCE(`status`, '')) != 'archived'"
  ).bind(nowIso(), currentMonth).run();
  return { archived: Number(result.meta?.changes || 0), current_month: currentMonth, skipped: false };
}

async function handleScheduled(env) {
  try {
    await ensureSchema(env);
    const purge = await run60DayDataPurge(env);
    const monthlyArchive = await archivePriorMonthlyUsage(env);
    const overdueInvoices = await suspendOverdueInvoiceTenants(env);
    await audit(env, DEFAULT_TENANT, 'scheduled_maintenance', {
      purgedRecords: purge.purgedRecords, monthlyArchive, overdueInvoices
    });
    return { ...purge, monthlyArchive, overdueInvoices };
  } catch (err) {
    safeLog(err);
    return { ok: false, ...publicError(err) };
  }
}

export class NotificationDeliveryWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const tenantId = validateTenant(event?.payload?.tenant_id);
    const notificationId = clean(event?.payload?.notification_id || '', 100);
    if (!notificationId) throw new AppError('Notification workflow requires notification_id.', 'notification_id_required', 400);
    await ensureTenantActive(this.env, tenantId);
    const retryDelays = ['30 seconds', '1 minute', '3 minutes', '10 minutes'];
    for (let attempt = 1; attempt <= 5; attempt++) {
      if (attempt > 1) await step.sleep('notification-retry-delay-' + attempt, retryDelays[attempt - 2]);
      const result = await step.do('notification-delivery-attempt-' + attempt, {
        retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds'
      }, async () => {
        const row = await this.env.DB.prepare(
          'SELECT * FROM `notifications` WHERE `tenant_id` = ? AND (`notification_id` = ? OR `id` = ?) LIMIT 1'
        ).bind(tenantId, notificationId, notificationId).first();
        if (!row) return { done: true, reason: 'notification_not_found' };
        if (['sent_to_provider', 'delivered', 'sent'].includes(norm(row.status))) {
          return { done: true, reason: 'already_sent' };
        }
        const metadataRaw = row.metadata || '{}';
        let metadata = {};
        try { metadata = JSON.parse(metadataRaw); } catch {}
        const payload = {
          notification_id: notificationId, tenant_id: tenantId,
          to: row.recipient_phone || row.to_phone || '',
          from: row.sender_phone || row.from_phone || '',
          channel: row.channel || 'sms',
          kind: row.notification_type || row.type || 'general',
          message: row.message || '', metadata
        };
        const delivery = await deliverNotification(this.env, payload);
        if (delivery?.delivered) {
          await setNotificationStatus(this.env, tenantId, notificationId, 'sent_to_provider', delivery.provider_message_id);
          return { done: true, delivered: true, provider: delivery.provider || 'configured_provider' };
        }
        await setNotificationStatus(this.env, tenantId, notificationId,
          delivery?.skipped ? 'queued' : 'provider_error');
        return { done: false, skipped: Boolean(delivery?.skipped), error: clean(delivery?.error || delivery?.reason || 'provider_not_confirmed', 160) };
      });
      if (result?.done) return { ok: true, tenant_id: tenantId, notification_id: notificationId, ...result, attempts: attempt };
    }
    await setNotificationStatus(this.env, tenantId, notificationId, 'retry_exhausted');
    await recordIntegrationStatus(this.env, tenantId, 'notifications', 'retry_exhausted', {
      notification_id: notificationId, attempts: 5
    });
    return { ok: false, tenant_id: tenantId, notification_id: notificationId, status: 'retry_exhausted', attempts: 5 };
  }
}

export class CallUsageWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const tenantId = validateTenant(event?.payload?.tenant_id);
    const callId = clean(event?.payload?.call_id || '', 120);
    if (!callId) throw new AppError('Call usage workflow requires call_id.', 'call_id_required', 400);
    await ensureSchema(this.env);
    for (let minuteIndex = 1; minuteIndex <= 720; minuteIndex++) {
      await step.sleep('wait-for-call-minute-' + minuteIndex, '1 minute');
      const tick = await step.do('count-call-minute-' + minuteIndex, {
        retries: { limit: 5, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds'
      }, async () => {
        const call = await this.env.DB.prepare(
          'SELECT `status`, `started_at`, `created_at` FROM `calls` WHERE `tenant_id` = ? AND `call_id` = ? LIMIT 1'
        ).bind(tenantId, callId).first();
        if (!call || norm(call.status) !== 'in_progress') return { active: false, reason: 'call_ended' };
        const startMs = Date.parse(call.started_at || call.created_at || '');
        if (!Number.isFinite(startMs)) return { active: false, reason: 'call_start_time_missing' };
        const countedAt = new Date(startMs + minuteIndex * 60000);
        if (Date.now() < countedAt.getTime()) return { active: true, counted: false, reason: 'minute_not_reached' };
        return { active: true, ...await recordCallMinuteTick(this.env, tenantId, callId, minuteIndex, countedAt) };
      });
      if (!tick.active) return { ok: true, call_id: callId, completed_after_minutes: minuteIndex - 1, reason: tick.reason };
    }
    return { ok: true, call_id: callId, status: 'maximum_tracked_duration_reached', tracked_minutes: 720 };
  }
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(env));
  },
  async fetch(request, env, ctx) {
    return handleFetch(request, env, ctx);
  }
};