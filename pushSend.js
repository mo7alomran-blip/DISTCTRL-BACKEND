// إرسال Web Push موحّد — يستخدمه routes/push.js وcron.js بدل ما كل واحد يكرر نفس منطق الإرسال/التنظيف.
// يفرّق بين نوعين من الفشل: اشتراك منتهي/محذوف من طرف المتصفح (404/410 — طبيعي تمامًا، ينظّفه بهدوء)،
// وخطأ منهجي حقيقي (مفاتيح VAPID خاطئة، رفض مصادقة...) — هذا النوع بالذات هو اللي صار فيه خلل صامت
// قبل هذا (VapidPkHashMismatch)، فهنا يُسجَّل بـsystemHealth.js بدل ما يفضل صامت أبدًا.
import webpush from "web-push";
import { pool } from "./db.js";
import { recordHealthCheck } from "./systemHealth.js";

const EXPECTED_ERROR_CODES = new Set([404, 410]);

export async function sendWebPushToSubs(subs, payload) {
  if (!subs.length) return { sent: 0, expired: 0 };
  const results = await Promise.allSettled(
    subs.map((s) => webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth_key } }, payload))
  );

  const expiredIds = [];
  let systemicError = null;
  results.forEach((r, i) => {
    if (r.status !== "rejected") return;
    const code = r.reason?.statusCode;
    if (EXPECTED_ERROR_CODES.has(code)) expiredIds.push(subs[i].id);
    else systemicError = `${code || ""} ${r.reason?.body || r.reason?.message || r.reason}`.trim();
  });

  if (expiredIds.length) {
    await pool.query(`DELETE FROM push_subscriptions WHERE id IN (${expiredIds.map(() => "?").join(",")})`, expiredIds);
  }

  const sent = results.filter((r) => r.status === "fulfilled").length;
  // نجاح واحد ولو وسط رفض متوقع لاشتراكات منتهية يكفي إثبات إن القناة شغالة — نمرّره لسجل الصحة كل مرة
  // (recordHealthCheck نفسها ما تسوي شي إلا لو الحالة انقلبت فعليًا، فما فيه إزعاج بكتابة DB زايدة تُذكر)
  if (sent > 0) {
    await recordHealthCheck("push", true).catch(() => {});
  } else if (systemicError) {
    await recordHealthCheck("push", false, systemicError).catch(() => {});
  }

  return { sent, expired: expiredIds.length, systemicError };
}
