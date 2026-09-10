// استعادة كلمة المرور عبر رمز تحقق (OTP) بالواتساب — 3 خطوات:
//   1) POST /password-reset/request  { employee_id }              → يرسل رمز 6 أرقام بالواتساب لرقم صاحب الحساب
//   2) POST /password-reset/verify   { employee_id, code }        → يرجّع reset_token قصير العمر (10 دقائق) لو صح
//   3) POST /password-reset/confirm  { reset_token, new_password } → يحدّث كلمة المرور فعليًا
//
// قرارات أمان متعمّدة:
//   - ردّ /request دايمًا عام (نفس النص) بغض النظر إن كان الحساب موجود أو له رقم واتساب أو لا —
//     ما نكشف وجود حساب موظف معيّن من عدمه لأي زائر مجهول.
//   - الرمز نفسه لا يُخزَّن أبدًا نص صريح، فقط bcrypt hash له (نفس طريقة كلمات المرور).
//   - تحديد معدّل الطلبات لكل حساب (3 طلبات/15 دقيقة) يمنع إغراق رقم واتساب المستخدم برسائل.
//   - تحديد محاولات التحقق (5 محاولات) يمنع تخمين الرمز بالقوة الغاشمة.
//   - reset_token أحادي الاستخدام فعليًا: نعلّم صف password_resets "مُستخدم" فور نجاح /verify،
//     و"مؤكَّد" فور نجاح /confirm — أي محاولة تكرار لنفس reset_token بعد التأكيد تُرفض.
import express from "express";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { pool } from "../db.js";
import { hashPassword, issuePasswordResetToken, verifyPasswordResetToken } from "../auth.js";
import { sendWhatsAppText, isWhatsAppConfigured } from "../whatsapp.js";

const router = express.Router();

const OTP_TTL_MINUTES = 10;
const MAX_REQUESTS_PER_WINDOW = 3;
const REQUEST_WINDOW_MINUTES = 15;
const MAX_VERIFY_ATTEMPTS = 5;
const MIN_PASSWORD_LENGTH = 4; // نفس الحد المستخدم بـ/api/auth/update-password لباقي التطبيق

function getClientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) return String(fwd).split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

// ── 1) طلب رمز التحقق ──────────────────────────────────────────
router.post("/password-reset/request", async (req, res) => {
  const { employee_id } = req.body || {};
  if (!employee_id) return res.status(400).json({ success: false, error: "missing_fields" });

  const clientIp = getClientIp(req);
  // ردّ عام موحّد — يصدر بغض النظر عن نتيجة أي فحص بالأسفل، حتى ما نكشف وجود/عدم وجود حساب أو رقم
  const GENERIC_OK = { success: true, message: "لو الحساب موجود ومرتبط برقم واتساب، وصلك رمز التحقق خلال لحظات." };

  try {
    const [[user]] = await pool.query(
      "SELECT id, phone FROM users WHERE employee_id = ? AND is_active = 1",
      [String(employee_id).trim()]
    );
    if (!user || !user.phone) return res.json(GENERIC_OK);

    const windowStart = new Date(Date.now() - REQUEST_WINDOW_MINUTES * 60000);
    const [[{ cnt }]] = await pool.query(
      "SELECT COUNT(*) AS cnt FROM password_resets WHERE user_id = ? AND created_at >= ?",
      [user.id, windowStart]
    );
    if (cnt >= MAX_REQUESTS_PER_WINDOW) return res.json(GENERIC_OK); // بلغ الحد — ما نرسل رمز جديد بصمت

    const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
    const codeHash = await bcrypt.hash(code, 10);
    const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60000);
    const id = crypto.randomUUID();
    await pool.query(
      "INSERT INTO password_resets (id, user_id, code_hash, expires_at, ip_address) VALUES (?, ?, ?, ?, ?)",
      [id, user.id, codeHash, expiresAt, clientIp]
    );

    if (isWhatsAppConfigured()) {
      sendWhatsAppText(
        user.phone,
        `🔐 رمز التحقق لاستعادة كلمة المرور: *${code}*\nصالح لمدة ${OTP_TTL_MINUTES} دقائق فقط. لا تشاركه مع أي شخص.`
      ).catch((e) => console.error("password-reset: whatsapp send failed:", e));
    } else {
      console.error("password-reset: WhatsApp not configured — OTP not delivered for user", user.id);
    }

    return res.json(GENERIC_OK);
  } catch (err) {
    console.error("password-reset/request error:", err);
    return res.status(500).json({ success: false, error: "server_error" });
  }
});

// ── 2) التحقق من الرمز ─────────────────────────────────────────
router.post("/password-reset/verify", async (req, res) => {
  const { employee_id, code } = req.body || {};
  if (!employee_id || !code) return res.status(400).json({ success: false, error: "missing_fields" });

  try {
    const [[user]] = await pool.query(
      "SELECT id FROM users WHERE employee_id = ? AND is_active = 1",
      [String(employee_id).trim()]
    );
    if (!user) return res.status(400).json({ success: false, error: "invalid_code" });

    const [[reset]] = await pool.query(
      "SELECT * FROM password_resets WHERE user_id = ? AND used_at IS NULL ORDER BY created_at DESC LIMIT 1",
      [user.id]
    );
    if (!reset) return res.status(400).json({ success: false, error: "invalid_code" });
    if (new Date(reset.expires_at).getTime() < Date.now()) {
      return res.status(400).json({ success: false, error: "expired" });
    }
    if (reset.attempts >= MAX_VERIFY_ATTEMPTS) {
      return res.status(429).json({ success: false, error: "too_many_attempts" });
    }

    const ok = await bcrypt.compare(String(code).trim(), reset.code_hash);
    if (!ok) {
      await pool.query("UPDATE password_resets SET attempts = attempts + 1 WHERE id = ?", [reset.id]);
      return res.status(400).json({ success: false, error: "invalid_code" });
    }

    // نعلّمه "مُستخدم" فورًا — يمنع استخدام نفس الرمز مرتين حتى لو نفس reset_token ما تأكّد بعد
    await pool.query("UPDATE password_resets SET used_at = NOW(3) WHERE id = ?", [reset.id]);
    const reset_token = issuePasswordResetToken(user.id, reset.id);
    return res.json({ success: true, reset_token });
  } catch (err) {
    console.error("password-reset/verify error:", err);
    return res.status(500).json({ success: false, error: "server_error" });
  }
});

// ── 3) تعيين كلمة مرور جديدة ───────────────────────────────────
router.post("/password-reset/confirm", async (req, res) => {
  const { reset_token, new_password } = req.body || {};
  if (!reset_token || !new_password || new_password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ success: false, error: "invalid_input" });
  }
  try {
    const decoded = verifyPasswordResetToken(reset_token);
    const [[reset]] = await pool.query(
      "SELECT * FROM password_resets WHERE id = ? AND user_id = ?",
      [decoded.prid, decoded.sub]
    );
    // لازم يكون "مُستخدم" (مرّ من /verify فعلاً) و"غير مؤكَّد" بعد (ما تكرر استخدام نفس reset_token)
    if (!reset || !reset.used_at || reset.confirmed_at) {
      return res.status(400).json({ success: false, error: "invalid_token" });
    }
    const passwordHash = await hashPassword(new_password);
    await pool.query("UPDATE users SET password_hash = ? WHERE id = ?", [passwordHash, decoded.sub]);
    await pool.query("UPDATE password_resets SET confirmed_at = NOW(3) WHERE id = ?", [reset.id]);
    return res.json({ success: true });
  } catch (err) {
    // jwt.verify يرمي استثناء لو منتهي/غير صالح — نفس رسالة الخطأ العامة كافية هنا
    return res.status(400).json({ success: false, error: "invalid_token" });
  }
});

export default router;
