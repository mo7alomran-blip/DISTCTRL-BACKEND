// إصدار/تحقق JWT + middleware — يحل محل Supabase Auth
// الفرق عن Supabase: التوكن هنا موقّع بسر واحد نعرفه نحن (JWT_SECRET)، مو نظام Auth كامل خارجي.
// شكل الـpayload متعمّد يطابق الحقول اللي يعتمد عليها App.jsx فعليًا (id, role, warehouse_id, employee_id).
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import "dotenv/config";

const JWT_SECRET = process.env.JWT_SECRET;
const ACCESS_TOKEN_TTL = "8h";
const REFRESH_TOKEN_TTL = "30d";
const RESET_TOKEN_TTL = "10m";

export function hashPassword(plain) {
  return bcrypt.hash(plain, 10);
}

export function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

// يصدر زوج (access_token, refresh_token) بنفس شكل session.{access_token,refresh_token} اللي كان يرجعه Supabase،
// حتى طبقة التوافق بالفرونت (src/supabase.js الجديد) تقدر تخزنه بنفس المكان بدون تغيير App.jsx
export function issueSession(userRow) {
  const payload = { sub: userRow.id, employee_id: userRow.employee_id, role: userRow.role };
  const access_token = jwt.sign(payload, JWT_SECRET, { expiresIn: ACCESS_TOKEN_TTL });
  const refresh_token = jwt.sign({ sub: userRow.id, type: "refresh" }, JWT_SECRET, { expiresIn: REFRESH_TOKEN_TTL });
  return { access_token, refresh_token, user: { id: userRow.id } };
}

export function verifyAccessToken(token) {
  return jwt.verify(token, JWT_SECRET); // يرمي استثناء لو منتهي أو غير صالح
}

export function verifyRefreshToken(token) {
  const decoded = jwt.verify(token, JWT_SECRET);
  if (decoded.type !== "refresh") throw new Error("not_a_refresh_token");
  return decoded;
}

// توكن قصير العمر (10 دقائق) يُصدر فقط بعد التحقق الناجح من رمز OTP باستعادة كلمة المرور —
// يحمل معرّف صف password_resets (prid) حتى مسار /confirm يتأكد إن نفس الصف ما استُخدم مرتين
export function issuePasswordResetToken(userId, resetId) {
  return jwt.sign({ sub: userId, prid: resetId, type: "password_reset" }, JWT_SECRET, { expiresIn: RESET_TOKEN_TTL });
}

export function verifyPasswordResetToken(token) {
  const decoded = jwt.verify(token, JWT_SECRET);
  if (decoded.type !== "password_reset") throw new Error("not_a_reset_token");
  return decoded;
}

// middleware: يتحقق من Authorization: Bearer <token> ويحط req.authUserId / req.authRole
// ?token= بالرابط نفسه مقبول كبديل احتياطي (نفس أسلوب اتصال الـWebSocket بـsrc/supabase.js بالضبط) —
// ضروري لأي رابط PDF/ملف يُفتح بتنقّل مباشر (window.open/تنزيل من المتصفح)، ما يقدر يرسل Authorization header
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = (header.startsWith("Bearer ") ? header.slice(7) : null) || req.query.token || null;
  if (!token) return res.status(401).json({ error: "missing_token" });
  try {
    const decoded = verifyAccessToken(token);
    req.authUserId = decoded.sub;
    req.authRole = decoded.role;
    req.authEmployeeId = decoded.employee_id;
    next();
  } catch {
    return res.status(401).json({ error: "invalid_token" });
  }
}

// نسخة اختيارية (ما توقف الطلب لو ما فيه توكن) — تُستخدم لمسارات عامة تحتاج تعرف المستخدم لو موجود بس مو إلزامي
export function optionalAuth(req, _res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (token) {
    try {
      const decoded = verifyAccessToken(token);
      req.authUserId = decoded.sub;
      req.authRole = decoded.role;
      req.authEmployeeId = decoded.employee_id;
    } catch { /* تجاهل توكن غير صالح بالمسار الاختياري */ }
  }
  next();
}
