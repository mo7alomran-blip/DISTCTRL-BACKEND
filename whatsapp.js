// عميل بوابة واتساب (Hermosa WhatsApp Gateway) — يغلّف REST API الموصوف بـ
// hermosa-whatsapp.postman_collection.json. لا نتحدث لواتساب مباشرة؛ هذي بوابة SaaS خارجية
// تحتفظ هي بجلسة (session) الرقم المرتبط عبر QR، ونحن بس نستدعيها.
//
// إعدادات مطلوبة بـ.env (المستخدم يضيفها بنفسه مباشرة على السيرفر، ما تمر عبر الكود):
//   WHATSAPP_BASE_URL    — مثال: https://whatsapp.hermosaapp.com
//   WHATSAPP_API_KEY     — x-api-key
//   WHATSAPP_API_SECRET  — x-api-secret
//   WHATSAPP_SESSION_ID  — الـsession اللي فيها الرقم المرتبط (تُنشأ مرة وحدة عبر setup-session.mjs)
//
// نفس فلسفة RESEND_API_KEY الفاضي بالمشروع: أي دالة هنا ترجع {success:false, error:"not_configured"}
// بهدوء لو الإعدادات ناقصة، بدون ما توقف العملية الأساسية اللي استدعتها (إرسال إشعار/تقرير ثانوي دائمًا).
import "dotenv/config";

function config() {
  const baseUrl = process.env.WHATSAPP_BASE_URL;
  const apiKey = process.env.WHATSAPP_API_KEY;
  const apiSecret = process.env.WHATSAPP_API_SECRET;
  const sessionId = process.env.WHATSAPP_SESSION_ID;
  if (!baseUrl || !apiKey || !apiSecret || !sessionId) return null;
  return { baseUrl, apiKey, apiSecret, sessionId };
}

export function isWhatsAppConfigured() {
  return !!config();
}

// يحوّل أي شكل رقم شائع (05xxxxxxxx، +9665xxxxxxxx، 9665xxxxxxxx، بمسافات/شرطات) لصيغة دولية أرقام فقط
// بدون + — نفس الصيغة اللي يطلبها API (مثال recipient بالكولكشن: "14155552671").
// معرّف قروب (Group JID، شكله عادة "12345...-1234567890@g.us" أو "12345...@g.us") يمر بدون تعديل —
// نميّزه بوجود "@" اللي ما توجد إطلاقًا برقم هاتف عادي، فمحاولة تطبيعه كرقم كانت بتكسره (تشيل كل الحروف).
export function normalizePhone(raw, defaultCountryCode = "966") {
  if (!raw) return null;
  const str = String(raw).trim();
  if (str.includes("@")) return str; // group/chat JID جاهز — يُستخدم كما هو
  let digits = str.replace(/\D/g, "");
  if (!digits) return null;
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = defaultCountryCode + digits.slice(1);
  if (!digits.startsWith(defaultCountryCode) && digits.length <= 10) digits = defaultCountryCode + digits;
  return digits;
}

async function callApi(path, opts = {}) {
  const cfg = config();
  if (!cfg) return { success: false, error: "not_configured" };
  try {
    const res = await fetch(`${cfg.baseUrl}${path}`, {
      ...opts,
      headers: {
        "x-api-key": cfg.apiKey,
        "x-api-secret": cfg.apiSecret,
        ...(opts.body ? { "Content-Type": "application/json" } : {}),
        ...(opts.headers || {}),
      },
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) return { success: false, error: body?.error || `http_${res.status}`, status: res.status };
    return { success: true, data: body };
  } catch (err) {
    return { success: false, error: String(err.message || err) };
  }
}

// نص عادي
export async function sendWhatsAppText(phone, message) {
  const to = normalizePhone(phone);
  if (!to) return { success: false, error: "invalid_phone" };
  const cfg = config();
  if (!cfg) return { success: false, error: "not_configured" };
  return callApi(`/api/sessions/${cfg.sessionId}/messages`, {
    method: "POST",
    body: JSON.stringify({ to, message }),
  });
}

// وسائط عبر رابط عام (تقارير PDF مستضافة، صور من storage.js العام مثلاً)
export async function sendWhatsAppMediaUrl(phone, mediaUrl, caption) {
  const to = normalizePhone(phone);
  if (!to) return { success: false, error: "invalid_phone" };
  const cfg = config();
  if (!cfg) return { success: false, error: "not_configured" };
  return callApi(`/api/sessions/${cfg.sessionId}/messages`, {
    method: "POST",
    body: JSON.stringify({ to, mediaUrl, caption: caption || undefined }),
  });
}

// وسائط base64 (توليد PDF محلي بالذاكرة بدون ما نستضيفه أول)
export async function sendWhatsAppMediaBase64(phone, { mimetype, data, filename }, caption) {
  const to = normalizePhone(phone);
  if (!to) return { success: false, error: "invalid_phone" };
  const cfg = config();
  if (!cfg) return { success: false, error: "not_configured" };
  return callApi(`/api/sessions/${cfg.sessionId}/messages`, {
    method: "POST",
    body: JSON.stringify({ to, media: { mimetype, data, filename }, caption: caption || undefined }),
  });
}

// حالة الجلسة (ready/waiting_qr/...) — تُستخدم بسكربت الإعداد وبفحص صحة الربط
export async function getWhatsAppSessionStatus() {
  const cfg = config();
  if (!cfg) return { success: false, error: "not_configured" };
  return callApi(`/api/sessions/${cfg.sessionId}`, { method: "GET" });
}

// حالة حيّة موثوقة فعليًا — اكتُشف يوم 2026-09-10 أن GET /api/sessions/:id (أعلاه) يرجّع "status":"ready"
// مُخزَّن/متأخر حتى أيام بعد ما تنقطع الجلسة فعليًا (آخر lastReadyAt ما يتحرك)، بينما محاولة إرسال حقيقية
// كانت تفشل بـ"Session is not ready (status: not_started)". نقطة /qr هي اللي رجّعت الحالة الصحيحة لحظيًا
// (نفس الحقل status بجوابها، حتى لو الرد نفسه 404 "no qr available" وقت الجلسة جاهزة أصلاً) — هذي الدالة
// تُستخدم بفحص الصحة الدوري (systemHealth.js) بدل getWhatsAppSessionStatus لتفادي نفس الخداع مستقبلاً.
export async function getWhatsAppLiveStatus() {
  const cfg = config();
  if (!cfg) return { configured: false, live: null };
  try {
    const res = await fetch(`${cfg.baseUrl}/api/sessions/${cfg.sessionId}/qr`, {
      headers: { "x-api-key": cfg.apiKey, "x-api-secret": cfg.apiSecret },
    });
    const body = await res.json().catch(() => null);
    return { configured: true, live: body?.status || "unknown" };
  } catch (err) {
    return { configured: true, live: "unknown", error: String(err.message || err) };
  }
}

// يحاول يعيد تشغيل الجلسة تلقائيًا — نفس اللي جرّبناه يدويًا يوم 2026-09-10 ورجعت متصلة بدون ما تحتاج
// مسح QR من جديد (الربط بالهاتف نفسه لسه صالح، بس الجلسة بجهة Hermosa كانت متوقفة). آمن يُستدعى حتى
// لو الجلسة أصلاً شغالة (الجهة الخارجية تتجاهله بهدوء بهالحالة).
export async function startWhatsAppSession() {
  const cfg = config();
  if (!cfg) return { success: false, error: "not_configured" };
  return callApi(`/api/sessions/${cfg.sessionId}/start`, { method: "POST" });
}

// إرسال عبر البوت الاحتياطي الذاتي الاستضافة (distctrl-whatsapp-bot، Baileys) بدل Hermosa — مطلوب خصوصًا
// لقروبات واتساب: Hermosa وسيلة الإرسال الرئيسية مرتبطة برقم غير عضو بقروبات العمل الفعلية، بينما البوت
// الاحتياطي (رقم منفصل) عضو فيها فعلاً. انظر resolveJobTargets/broadcastToJob بـjobNotifications.js —
// أي هدف إرسال شكله معرّف قروب (ينتهي بـ@g.us) يُوجَّه هنا تلقائيًا بدل sendWhatsAppText العادي.
function backupBotConfig() {
  const url = process.env.BACKUP_BOT_URL;
  const apiKey = process.env.BACKUP_BOT_API_KEY;
  if (!url || !apiKey) return null;
  return { url: url.replace(/\/$/, ""), apiKey };
}

export function isBackupBotConfigured() {
  return !!backupBotConfig();
}

export async function sendViaBackupBot(to, message) {
  const cfg = backupBotConfig();
  if (!cfg) return { success: false, error: "not_configured" };
  try {
    const res = await fetch(`${cfg.url}/send`, {
      method: "POST",
      headers: { "x-api-key": cfg.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ to, message }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) return { success: false, error: body?.error || `http_${res.status}`, status: res.status };
    return { success: true, data: body };
  } catch (err) {
    return { success: false, error: String(err.message || err) };
  }
}

// مرفق (PDF غالبًا) عبر البوت الاحتياطي — لازم للقروبات تحديدًا: Hermosa (sendWhatsAppMediaUrl) وسيلة
// الإرسال الرئيسية، بس رقمها مو عضو بقروبات العمل الفعلية، فأي مرفق موجَّه لقروب يفشل بصمت عبرها.
// انظر sendJobCompletionPdf/sendQualityPdf/sendEquipmentReplacementPdf بـjobNotifications.js — أي هدف
// شكله معرّف قروب (@g.us) يُوجَّه هنا بدل sendWhatsAppMediaUrl، بنفس فكرة isGroupJid بالرسائل النصية.
export async function sendMediaViaBackupBot(to, mediaUrl, caption, filename) {
  const cfg = backupBotConfig();
  if (!cfg) return { success: false, error: "not_configured" };
  try {
    const res = await fetch(`${cfg.url}/send-media`, {
      method: "POST",
      headers: { "x-api-key": cfg.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ to, mediaUrl, caption, filename }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) return { success: false, error: body?.error || `http_${res.status}`, status: res.status };
    return { success: true, data: body };
  } catch (err) {
    return { success: false, error: String(err.message || err) };
  }
}
