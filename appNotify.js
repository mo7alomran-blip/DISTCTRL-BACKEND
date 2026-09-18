// إشعارات داخل التطبيق (Web Push + مركز الإشعارات) — نسخة موثوقة تُستدعى من الباك اند مباشرة عند
// الحدث نفسه، بعكس sendPushNotification بالفرونت (App.jsx) اللي يعتمد على بقاء متصفح صاحب الفعل نفسه
// مفتوحًا لحظة الحدث لينفّذ الطلب — لو أغلق تبويبه أو صار خطأ شبكة، الإشعار ما يوصل أبدًا بصمت.
// بلاغ حقيقي من المالك (2026-09-18): "الإشعارات الوحيدة اللي توصلني هي واتساب اتصل/انفصل" — لأنها
// الوحيدة المُرسَلة من هنا (systemHealth.js)، بينما البقية (مهمة انسندت، تغيّر حالة طلب...) فرونت-فقط.
import { pool, genId } from "./db.js";
import { sendWebPushToSubs } from "./pushSend.js";

export async function notifyUsersInApp(userIds, { title, body = "", url = "/", tag, target_screen = null, target_id = null }) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  if (!ids.length) return;

  try {
    const [subs] = await pool.query(
      `SELECT id, endpoint, p256dh, auth_key FROM push_subscriptions WHERE user_id IN (${ids.map(() => "?").join(",")})`,
      ids
    );
    const payload = JSON.stringify({ title, body, url, tag, target_screen, target_id });
    await sendWebPushToSubs(subs, payload);
  } catch (err) {
    console.error("notifyUsersInApp push failed:", err.message || err);
  }

  try {
    const values = ids.map((uid) => [genId(), uid, title, body || null, target_screen, target_id]);
    await pool.query(
      `INSERT INTO notifications (id, user_id, title, body, target_screen, target_id) VALUES ${values.map(() => "(?,?,?,?,?,?)").join(",")}`,
      values.flat()
    );
  } catch (err) {
    console.error("notifyUsersInApp notifications insert failed:", err.message || err);
  }
}
