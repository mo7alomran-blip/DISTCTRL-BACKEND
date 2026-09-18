// تشغيل يدوي للمهام المجدولة المنقولة فعليًا (بدل انتظار الموعد) — نفس ازدواجية التفويض الأصلية:
// إما x-cron-secret (نفس ما كان يفعله pg_cron)، أو مشرف نشط مسجّل دخول (نفس ما كان يفعله زر "شغّل الآن" بالواجهة)
import express from "express";
import { pool } from "../db.js";
import { optionalAuth, requireAuth } from "../auth.js";
import { checkOverdueJobs, dailyBackup, rescheduleReportCron, checkTodayJobs } from "../cron.js";
import { sendDailyReport, sendPeriodicReport } from "../reportEmails.js";

const router = express.Router();
const OWNER_EMPLOYEE_ID = "90507";

// ملاحظة مهمة: لازم try/catch هنا رغم إنها دالة مساعدة صغيرة — تُستدعى بدون await داخل try/catch بأربع
// routes بالأسفل (قبل بداية try الخاص فيهم)، فأي خطأ DB غير ملتقط هنا يسقط كـunhandled rejection
// ويطيح السيرفر كامل (اكتُشف فعليًا وقت الاختبار — كان يطيح العملية عند انقطاع الاتصال بقاعدة البيانات)
async function authorizedForCron(req) {
  if (req.headers["x-cron-secret"] && req.headers["x-cron-secret"] === process.env.CRON_SECRET) return true;
  if (!req.authUserId) return false;
  try {
    const [[caller]] = await pool.query("SELECT role, is_active FROM users WHERE id = ?", [req.authUserId]);
    return !!caller && (caller.role === "admin" || caller.role === "section_head") && !!caller.is_active;
  } catch {
    return false; // خطأ بقاعدة البيانات = رفض دخول افتراضيًا، أأمن من السماح
  }
}

router.post("/reports/check-overdue", optionalAuth, async (req, res) => {
  if (!(await authorizedForCron(req))) return res.status(401).json({ success: false, error: "unauthorized" });
  try {
    res.json(await checkOverdueJobs());
  } catch (err) {
    res.status(500).json({ success: false, error: String(err.message || err) });
  }
});

router.post("/reports/check-today-jobs", optionalAuth, async (req, res) => {
  if (!(await authorizedForCron(req))) return res.status(401).json({ success: false, error: "unauthorized" });
  try {
    res.json(await checkTodayJobs());
  } catch (err) {
    res.status(500).json({ success: false, error: String(err.message || err) });
  }
});

router.post("/reports/daily-backup", optionalAuth, async (req, res) => {
  if (!(await authorizedForCron(req))) return res.status(401).json({ success: false, error: "unauthorized" });
  try {
    res.json(await dailyBackup());
  } catch (err) {
    res.status(500).json({ success: false, error: String(err.message || err) });
  }
});

// يقابل daily-reportsupabase — نفس ازدواجية التفويض (x-cron-secret أو مشرف نشط)
router.post("/reports/daily", optionalAuth, async (req, res) => {
  if (!(await authorizedForCron(req))) return res.status(401).json({ success: false, error: "unauthorized" });
  try {
    const { scope_type, scope_id, override_recipients } = req.body || {};
    res.json(await sendDailyReport({ scope_type, scope_id, override_recipients }));
  } catch (err) {
    res.status(500).json({ success: false, error: String(err.message || err) });
  }
});

// يقابل periodic-report — النوع عبر ?type=weekly|monthly (نفس الأصل بالضبط)
router.post("/reports/periodic", optionalAuth, async (req, res) => {
  if (!(await authorizedForCron(req))) return res.status(401).json({ success: false, error: "unauthorized" });
  const type = req.query.type === "monthly" ? "monthly" : "weekly";
  try {
    const { scope_type, scope_id } = req.body || {};
    res.json(await sendPeriodicReport(type, { scope_type, scope_id }));
  } catch (err) {
    res.status(500).json({ success: false, error: String(err.message || err) });
  }
});

// يقابل reschedule-report — للمالك فقط (نفس الأصل بالحرف)
router.post("/reports/reschedule", requireAuth, async (req, res) => {
  try {
    const [[caller]] = await pool.query("SELECT employee_id, is_active FROM users WHERE id = ?", [req.authUserId]);
    if (!caller || caller.employee_id !== OWNER_EMPLOYEE_ID || !caller.is_active) {
      return res.status(403).json({ success: false, error: "forbidden" });
    }
    const { report_type, hour, minute, day_of_week, day_of_month } = req.body || {};
    if (!["daily", "weekly", "monthly"].includes(report_type)) return res.status(400).json({ success: false, error: "invalid_type" });
    if (hour == null || minute == null) return res.status(400).json({ success: false, error: "invalid_time" });
    await rescheduleReportCron(report_type, hour, minute, day_of_week ?? 0, day_of_month ?? 1);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err.message || err) });
  }
});

export default router;
