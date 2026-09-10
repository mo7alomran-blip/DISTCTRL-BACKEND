// إجراءات يدوية على عمل مجدول لا تُعبَّر كتحديث صف عادي عبر /api/table (فعل فوري: توليد ملف + إرساله/تنزيله) —
// حاليًا: PDF مستقل لألبوم "جودة التنفيذ"/"جودة الإرفاق" — POST يرسله واتساب مباشرة (jobNotifications.sendQualityPdf)،
// GET يرجّع بايتات الملف نفسه عشان الواجهة تصدّره/تشاركه بأي طريقة ثانية (مو شرط واتساب — Web Share API أو تنزيل مباشر).
import express from "express";
import { pool } from "../db.js";
import { requireAuth } from "../auth.js";
import { isOwner, isAdmin, inMyScopeSync, loadScopeContext } from "../scope.js";
import { sendQualityPdf } from "../jobNotifications.js";
import { generateJobQualityPdfBuffer, generateJobPermitsPdfBuffer } from "../jobPdf.js";
import { contentDispositionInline } from "../contentDisposition.js";

const router = express.Router();

// نفس روح canWriteJobChild بـpolicies.js (يمرّر section_id كمان الآن)، بس بدون قيد "status === in_progress"
// على الموظف صاحب العمل — إرسال/تصدير ألبوم صور تقرير مو إجراء "كتابة" حساس، ومنطقي يصير حتى بعد اكتمال العمل
function canSendQualityPdf(authUser, scopeCtx, job) {
  if (!job) return false;
  return (
    isOwner(authUser) ||
    (isAdmin(authUser) && inMyScopeSync(scopeCtx, authUser, job.warehouse_id, job.section_id)) ||
    job.employee_id === authUser.sub
  );
}

async function loadJobAndCheck(req, res) {
  const { id } = req.params;
  const kind = req.method === "GET" ? req.query.kind : req.body?.kind;
  if (kind !== "execution" && kind !== "attachment") { res.status(400).json({ success: false, error: "invalid_kind" }); return null; }
  const [[job]] = await pool.query("SELECT * FROM scheduled_jobs WHERE id = ?", [id]);
  if (!job) { res.status(404).json({ success: false, error: "job_not_found" }); return null; }
  const authUser = { sub: req.authUserId, role: req.authRole, employee_id: req.authEmployeeId };
  const scopeCtx = await loadScopeContext(pool);
  if (!canSendQualityPdf(authUser, scopeCtx, job)) { res.status(403).json({ success: false, error: "forbidden" }); return null; }
  return { job, kind };
}

router.post("/jobs/:id/send-quality-pdf", requireAuth, async (req, res) => {
  try {
    const ctx = await loadJobAndCheck(req, res);
    if (!ctx) return;
    const sent = await sendQualityPdf(ctx.job, ctx.kind);
    res.json({ success: true, sent });
  } catch (err) {
    console.error("send-quality-pdf error:", err);
    res.status(500).json({ success: false, error: String(err.message || err) });
  }
});

// يرجّع ملف الـPDF نفسه (بدون إرسال واتساب) — تصدير/مشاركة من الجهاز لأي وجهة (حفظ، بريد، تطبيق ثاني...)
router.get("/jobs/:id/quality-pdf", requireAuth, async (req, res) => {
  try {
    const ctx = await loadJobAndCheck(req, res);
    if (!ctx) return;
    const buffer = await generateJobQualityPdfBuffer(ctx.job.id, ctx.kind);
    const kindLabel = ctx.kind === "execution" ? "جودة التنفيذ" : "جودة الإرفاق";
    const title = (ctx.job.title || kindLabel).replace(/[/\\:*?"<>|]/g, "").trim();
    const filename = `${kindLabel} - ${title}.pdf`;
    // Cache-Control: no-store إلزامي — بدونه سفاري/WKWebView يخزّن الرد بنفس الرابط (نفس id + توكن الجلسة)
    // ويرجّعه من الكاش المحلي بدون ما يطلب من السيرفر أصلاً، فيوصل المستخدم ملف قديم باسمه ومحتواه حتى لو
    // عدّل البيانات وصدّر من جديد — اكتُشف يوم 2026-09-10 (اسم الملف نفسه ما كان يتحدث رغم تعديل البيانات)
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", contentDispositionInline(filename, "Quality-Report.pdf"));
    res.send(buffer);
  } catch (err) {
    console.error("quality-pdf export error:", err);
    res.status(500).json({ success: false, error: String(err.message || err) });
  }
});

// PDF مستقل لألبوم "تصاريح العمل" فقط (بدون kind — الألبوم واحد لكل عمل) — نفس صلاحيات ألبومات الجودة بالضبط
router.get("/jobs/:id/permits-pdf", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const [[job]] = await pool.query("SELECT * FROM scheduled_jobs WHERE id = ?", [id]);
    if (!job) return res.status(404).json({ success: false, error: "job_not_found" });
    const authUser = { sub: req.authUserId, role: req.authRole, employee_id: req.authEmployeeId };
    const scopeCtx = await loadScopeContext(pool);
    if (!canSendQualityPdf(authUser, scopeCtx, job)) return res.status(403).json({ success: false, error: "forbidden" });
    const buffer = await generateJobPermitsPdfBuffer(job.id);
    const title = (job.title || "تصاريح العمل").replace(/[/\\:*?"<>|]/g, "").trim();
    const filename = `تصاريح العمل - ${title}.pdf`;
    res.setHeader("Cache-Control", "no-store"); // نفس سبب quality-pdf أعلاه — يمنع سفاري من إرجاع نسخة قديمة مخزّنة
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", contentDispositionInline(filename, "Work-Permits.pdf"));
    res.send(buffer);
  } catch (err) {
    console.error("permits-pdf export error:", err);
    res.status(500).json({ success: false, error: String(err.message || err) });
  }
});

export default router;
