// إجراء يدوي على نموذج رصد مخالفة — توليد ملف PDF للنموذج (بيانات الزيارة + كل مخالفة مسجّلة وصورها)
// عشان الواجهة تصدّره/تشاركه (Web Share API أو تنزيل مباشر)، بدون المرور بمسار /api/table العام.
import express from "express";
import { pool } from "../db.js";
import { requireAuth } from "../auth.js";
import { isOwner, isAdminOrViewer } from "../scope.js";
import { generateViolationReportPdfBuffer } from "../violationPdf.js";
import { VIOLATION_TYPES } from "../violationTypes.js";
import { contentDispositionInline } from "../contentDisposition.js";

const router = express.Router();

router.get("/violation-reports/:id/pdf", requireAuth, async (req, res) => {
  try {
    const authUser = { sub: req.authUserId, role: req.authRole, employee_id: req.authEmployeeId };
    if (!isOwner(authUser) && !isAdminOrViewer(authUser)) return res.status(403).json({ success: false, error: "forbidden" });
    const [[report]] = await pool.query("SELECT id, contractor_name, items FROM violation_reports WHERE id = ?", [req.params.id]);
    if (!report) return res.status(404).json({ success: false, error: "report_not_found" });
    const buffer = await generateViolationReportPdfBuffer(report.id);
    const contractor = report.contractor_name || "مقاول";
    // اسم الملف يعكس محتوى المخالفة نفسه (وصف أول مخالفة مسجّلة) بدل عنوان عام ثابت، بناءً على طلب المستخدم
    const items = Array.isArray(report.items) ? report.items : JSON.parse(report.items || "[]");
    const checked = items.filter((it) => it.checked);
    const firstDesc = checked[0] ? (checked[0].desc || VIOLATION_TYPES.find((v) => v.code === checked[0].code)?.desc || "") : "";
    const shortDesc = firstDesc ? firstDesc.slice(0, 45).trim() : "";
    const extra = checked.length > 1 ? ` وأخرى (${checked.length})` : "";
    const violationLabel = shortDesc ? `${shortDesc}${extra}` : "نموذج مخالفات";
    const filename = `${violationLabel} - ${contractor}.pdf`.replace(/[/\\:*?"<>|]/g, "").trim();
    // inline (مو attachment) — يخلي المتصفح/WKWebView يعرض الملف مباشرة بعارض PDF المدمج بدل ما يحاول تنزيله.
    // Cache-Control: no-store إلزامي — بدونه سفاري يخزّن الرد بنفس الرابط (نفس id + توكن) ويرجّعه من الكاش
    // المحلي بدل ما يطلب من السيرفر، فيوصل المستخدم نفس الملف القديم (باسمه ومحتواه) حتى بعد ما يعدّل
    // المخالفات ويصدّر من جديد — بالضبط الخلل اللي بلّغ عنه المستخدم يوم 2026-09-10 (اسم الملف ما يتحدث)
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", contentDispositionInline(filename, "Violation-Report.pdf"));
    res.send(buffer);
  } catch (err) {
    console.error("violation-report-pdf error:", err);
    res.status(500).json({ success: false, error: String(err.message || err) });
  }
});

export default router;
