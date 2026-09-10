// send-push — يرسل Web Push حقيقي لمجموعة مستخدمين. أي مستخدم مسجّل دخول يقدر يستدعيها (نفس الأصل بالحرف —
// التطبيق نفسه يقرر إرسال أي إشعار لمين ووش محتواه، بدون تقييد دور إضافي هنا).
import express from "express";
import webpush from "web-push";
import "dotenv/config";
import { pool } from "../db.js";
import { requireAuth } from "../auth.js";
import { sendWhatsAppText, isWhatsAppConfigured } from "../whatsapp.js";
import { sendWebPushToSubs } from "../pushSend.js";

const router = express.Router();

// مستقل عن ترتيب استيراد cron.js عمدًا (نفس القيم، استدعاء idempotent) — حتى ما يعتمد صحة هذا الراوت على ترتيب import ضمني
webpush.setVapidDetails(
  process.env.VAPID_SUBJECT || "mailto:mo7.alomran@gmail.com",
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

router.post("/send-push", requireAuth, async (req, res) => {
  const { user_ids, title, body, url, tag, target_screen, target_id } = req.body || {};
  if (!Array.isArray(user_ids) || user_ids.length === 0 || !title) {
    return res.status(400).json({ success: false, error: "invalid_input" });
  }
  try {
    const [subs] = await pool.query(
      `SELECT id, endpoint, p256dh, auth_key FROM push_subscriptions WHERE user_id IN (${user_ids.map(() => "?").join(",")})`,
      user_ids
    );

    const payload = JSON.stringify({
      title, body: body || "", url: url || "/", tag: tag || undefined,
      target_screen: target_screen || undefined, target_id: target_id || undefined,
    });
    // sendWebPushToSubs (pushSend.js) ينظّف الاشتراكات المنتهية تلقائيًا، وأهم من هذا: يسجّل أي خطأ منهجي
    // حقيقي (مو انتهاء اشتراك عادي) بـsystemHealth.js حتى ما يتكرر خلل VAPID الصامت اللي صار قبل هذا
    const { sent: sentCount, expired: expiredCount } = await sendWebPushToSubs(subs, payload);

    // إرسال واتساب موازٍ — يعتمد كليًا على وجود رقم هاتف مسجّل لكل مستخدم (users.phone)، وعلى ضبط
    // WHATSAPP_* بـ.env. ثانوي بالكامل: أي فشل هنا (رقم ناقص، الخدمة غير مفعّلة، خطأ شبكة) ما يوقف
    // ولا حتى يؤثر على نتيجة الـpush الأساسية — نفس فلسفة sendPushNotification بالفرونت (catch(() => {})).
    let whatsappSent = 0;
    if (isWhatsAppConfigured()) {
      const [phoneRows] = await pool.query(
        `SELECT phone FROM users WHERE id IN (${user_ids.map(() => "?").join(",")}) AND phone IS NOT NULL AND phone <> ''`,
        user_ids
      );
      if (phoneRows.length) {
        const waText = body ? `*${title}*\n${body}` : `*${title}*`;
        const waResults = await Promise.allSettled(phoneRows.map((r) => sendWhatsAppText(r.phone, waText)));
        whatsappSent = waResults.filter((r) => r.status === "fulfilled" && r.value?.success).length;
      }
    }

    res.json({ success: true, sent: sentCount, expired: expiredCount, whatsapp_sent: whatsappSent });
  } catch (err) {
    console.error("send-push error:", err);
    res.status(500).json({ success: false, error: String(err.message || err) });
  }
});

export default router;
