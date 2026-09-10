// نظام تنبيه صحة الخدمات الخارجية (واتساب/Push) — الهدف: أي عطل حقيقي (مو انتهاء اشتراك عادي) ما يفضل
// صامت أبدًا. اكتُشف يوم 2026-09-10 أن جلسة واتساب انقطعت 4 أيام كاملة بدون أي تنبيه — كل الرسائل خلالها
// فشلت بهدوء لأن whatsapp.js/jobNotifications.js مصممة عمدًا تبتلع فشل واتساب حتى ما توقف العملية الأساسية.
//
// الحل هنا: ثلاث قنوات مستقلة عن بعض للتنبيه (Push + بريد + إشعار داخل مركز الإشعارات) حتى لو إحداهن هي
// المتعطلة، مع جدول system_health يمنع التكرار — يتنبّه مرة وحدة بس لما تنقلب الحالة (نجاح<->فشل)، مو بكل
// فحص دوري حتى لو العطل استمر أيام.
import { pool } from "./db.js";
import webpush from "web-push";
import crypto from "crypto";
import "dotenv/config";
import { OWNER_EMPLOYEE_ID } from "./scope.js";

// مستقل عن ترتيب استيراد cron.js/routes/push.js عمدًا (نفس القيم، استدعاء idempotent) — نفس فلسفة
// routes/push.js حتى ما تعتمد صحة هالموديول على ترتيب import ضمني لو استُخدم لحاله يومًا
webpush.setVapidDetails(
  process.env.VAPID_SUBJECT || "mailto:mo7.alomran@gmail.com",
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

async function getOwner() {
  const [[owner]] = await pool.query("SELECT id, email FROM users WHERE employee_id = ?", [OWNER_EMPLOYEE_ID]);
  return owner || null;
}

async function pushToOwner(owner, title, body) {
  if (!owner) return;
  try {
    const [subs] = await pool.query("SELECT endpoint, p256dh, auth_key FROM push_subscriptions WHERE user_id = ?", [owner.id]);
    const payload = JSON.stringify({ title, body, url: "/", tag: "system-health" });
    await Promise.allSettled(
      subs.map((s) => webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth_key } }, payload))
    );
  } catch (err) {
    console.error("systemHealth pushToOwner failed:", err.message || err);
  }
}

async function emailOwner(owner, subject, html) {
  if (!owner?.email || !process.env.RESEND_API_KEY) return;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: "تنبيهات النظام <onboarding@resend.dev>", to: [owner.email], subject, html }),
    });
  } catch (err) {
    console.error("systemHealth emailOwner failed:", err.message || err);
  }
}

async function notifyOwnerInApp(owner, title, body) {
  if (!owner) return;
  try {
    await pool.query(
      "INSERT INTO notifications (id, user_id, title, body, created_at) VALUES (?, ?, ?, ?, NOW(3))",
      [crypto.randomUUID(), owner.id, title, body]
    );
  } catch (err) {
    console.error("systemHealth notifyOwnerInApp failed:", err.message || err);
  }
}

const CHECK_LABELS = { whatsapp: "ربط واتساب", push: "إرسال الإشعارات" };

// checkName: معرّف قصير ('whatsapp'، 'push'...). ok: هل الفحص الحالي نجح. detail: نص وصف الحالة/الخطأ.
// يتنبّه فقط عند الانتقال بين نجاح/فشل — لو الفحص يشتغل كل 15 دقيقة والعطل مستمر لأيام، تنبيه واحد بس
// وقت ما يصير، وتنبيه ثاني وقت الاستعادة، مو رسالة كل 15 دقيقة.
export async function recordHealthCheck(checkName, ok, detail = null) {
  const [[prev]] = await pool.query("SELECT status FROM system_health WHERE check_name = ?", [checkName]);
  const newStatus = ok ? "ok" : "down";
  const wasDown = prev?.status === "down";
  const justChanged = (prev?.status || "ok") !== newStatus;

  await pool.query(
    `INSERT INTO system_health (check_name, status, last_checked_at, detail) VALUES (?, ?, NOW(3), ?)
     ON DUPLICATE KEY UPDATE status = VALUES(status), last_checked_at = NOW(3), detail = VALUES(detail)`,
    [checkName, newStatus, detail]
  );

  if (!justChanged) return;

  const label = CHECK_LABELS[checkName] || checkName;
  const owner = await getOwner();

  if (!ok) {
    const title = `⚠️ انقطع: ${label}`;
    const body = detail ? `${label} متوقف حاليًا — ${detail}` : `${label} متوقف حاليًا، يحتاج مراجعة.`;
    console.error(`[system-health] ${checkName} DOWN:`, detail || "");
    await Promise.allSettled([
      pushToOwner(owner, title, body),
      emailOwner(owner, title, `<div style="font-family:Arial,sans-serif;direction:rtl;"><p>${body}</p></div>`),
      notifyOwnerInApp(owner, title, body),
    ]);
  } else if (wasDown) {
    const title = `✅ عاد: ${label}`;
    const body = `${label} رجع يشتغل بشكل طبيعي.`;
    console.log(`[system-health] ${checkName} RECOVERED`);
    await Promise.allSettled([pushToOwner(owner, title, body), notifyOwnerInApp(owner, title, body)]);
  }
}
