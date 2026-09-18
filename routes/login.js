// مسار تسجيل الدخول — يطابق منطق supabase/functions/login/index.ts الأصلي بالحرف،
// بفرق واحد فقط: التحقق من كلمة المرور عبر bcrypt محلي (password_hash) بدل Supabase Auth signInWithPassword.
import express from "express";
import { pool } from "../db.js";
import { verifyPassword, hashPassword, issueSession, verifyRefreshToken, requireAuth } from "../auth.js";

const router = express.Router();

const MAX_ATTEMPTS = 5;
const WINDOW_MINUTES = 15;
const MAX_IP_ATTEMPTS = 20; // أعلى من حد الحساب الواحد عمدًا — نفس تعليق النسخة الأصلية بالحرف

function getClientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) return String(fwd).split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

router.post("/login", async (req, res) => {
  const { employee_id, password } = req.body || {};
  if (!employee_id || !password) return res.status(400).json({ success: false, error: "missing_fields" });

  const clientIp = getClientIp(req);
  const windowStart = new Date(Date.now() - WINDOW_MINUTES * 60000);

  try {
    // ── فحص حظر IP أول شي ──
    if (clientIp !== "unknown") {
      const [[{ ipFailCount }]] = await pool.query(
        "SELECT COUNT(*) AS ipFailCount FROM login_attempts WHERE ip_address = ? AND success = 0 AND created_at >= ?",
        [clientIp, windowStart]
      );
      if (ipFailCount >= MAX_IP_ATTEMPTS) {
        return res.status(429).json({ success: false, error: "locked_out", retry_after_seconds: WINDOW_MINUTES * 60 });
      }
    }

    // ── فحص حظر الحساب نفسه ──
    const [recent] = await pool.query(
      "SELECT success, created_at FROM login_attempts WHERE employee_id = ? ORDER BY created_at DESC LIMIT ?",
      [employee_id, MAX_ATTEMPTS]
    );
    if (recent.length === MAX_ATTEMPTS && recent.every((r) => !r.success)) {
      const oldest = new Date(recent[recent.length - 1].created_at).getTime();
      const minutesAgo = (Date.now() - oldest) / 60000;
      if (minutesAgo < WINDOW_MINUTES) {
        const retryAfterSeconds = Math.ceil((WINDOW_MINUTES - minutesAgo) * 60);
        return res.status(429).json({ success: false, error: "locked_out", retry_after_seconds: retryAfterSeconds });
      }
    }

    // ── البحث عن الموظف ──
    const [[userRow]] = await pool.query(
      "SELECT id, name, employee_id, role, warehouse_id, is_active, password_hash FROM users WHERE employee_id = ? AND is_active = 1",
      [employee_id]
    );

    if (!userRow || !userRow.password_hash) {
      await pool.query("INSERT INTO login_attempts (employee_id, success, ip_address) VALUES (?, 0, ?)", [employee_id, clientIp]);
      return res.status(401).json({ success: false, error: "invalid_credentials" });
    }

    // ── التحقق من كلمة المرور ──
    const ok = await verifyPassword(password, userRow.password_hash);
    await pool.query("INSERT INTO login_attempts (employee_id, success, ip_address) VALUES (?, ?, ?)", [employee_id, ok ? 1 : 0, clientIp]);

    if (!ok) return res.status(401).json({ success: false, error: "invalid_credentials" });

    const session = issueSession(userRow);
    return res.json({
      success: true,
      session,
      user: {
        id: userRow.id,
        name: userRow.name,
        employee_id: userRow.employee_id,
        role: userRow.role,
        warehouse_id: userRow.warehouse_id,
        is_active: !!userRow.is_active,
      },
    });
  } catch (err) {
    console.error("login error:", err);
    return res.status(500).json({ success: false, error: String(err) });
  }
});

// يقابل supabase.auth.setSession/refresh — الفرونت يستدعيه لما ينتهي access_token
router.post("/refresh", async (req, res) => {
  const { refresh_token } = req.body || {};
  if (!refresh_token) return res.status(400).json({ success: false, error: "missing_refresh_token" });
  try {
    const decoded = verifyRefreshToken(refresh_token);
    const [[userRow]] = await pool.query(
      "SELECT id, employee_id, role FROM users WHERE id = ? AND is_active = 1",
      [decoded.sub]
    );
    if (!userRow) return res.status(401).json({ success: false, error: "invalid_refresh_token" });
    const session = issueSession(userRow);
    return res.json({ success: true, session });
  } catch {
    return res.status(401).json({ success: false, error: "invalid_refresh_token" });
  }
});

// يقابل supabase.auth.updateUser({password}) — تغيير ذاتي لكلمة مرور المستخدم الحالي نفسه (بدون أي قيد نطاق/دور،
// عكس routes/users-admin.js اللي يغيّر كلمة مرور شخص آخر ويحتاج صلاحية إدارية)
router.post("/auth/update-password", requireAuth, async (req, res) => {
  const { password } = req.body || {};
  if (!password || password.length < 8) return res.status(400).json({ error: "invalid_input" });
  try {
    const passwordHash = await hashPassword(password);
    await pool.query("UPDATE users SET password_hash = ? WHERE id = ?", [passwordHash, req.authUserId]);
    res.json({ error: null });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

export default router;
