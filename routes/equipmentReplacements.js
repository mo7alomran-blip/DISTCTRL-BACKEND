// إرسال تلقائي لسجل "استبدال معدة" (PMT/RMU) لقروب واتساب العمل المرتبط به + مرفق PDF — يُستدعى تلقائيًا
// من الواجهة فور حفظ السجل (لو مربوط بمهمة مجدولة)، بدون أي زر مشاركة يدوي منفصل. طلب صريح من المالك
// 2026-09-13: "ابي اذا صار ربط مع مهمة عمل تربط كذلك في القروب المخصص للعمل نفسه بحيث ترسل المعلومات
// وملف PDF دايركت بدون تدخل احد".
import express from "express";
import { pool } from "../db.js";
import { requireAuth } from "../auth.js";
import { isOwner, isAdmin, inMyScopeSync, loadScopeContext } from "../scope.js";
import { sendEquipmentReplacementPdf } from "../jobNotifications.js";
import { generateEquipmentReplacementPdfBuffer } from "../jobPdf.js";
import { writePublicFile } from "../storage.js";

const router = express.Router();

// رابط PDF عام (job-reports bucket) لسجل استبدال معدة — نفس فكرة /jobs/:id/completion-pdf-url بجوبأكشنز.js:
// بديل عن "نزّل الملف وأرفقه يدويًا" لما Web Share API بملفات غير مدعومة بمتصفح/جهاز المستخدم عند زر
// "مشاركة واتساب" اليدوي بالواجهة. equipment_replacements سجل عام بمستوى المؤسسة بدون قيد نطاق (نفس
// سياسة قراءته بـpolicies.js) — فيكفي تسجيل الدخول فقط، بدون فحص نطاق إضافي.
router.get("/equipment-replacements/:id/pdf-url", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const [[er]] = await pool.query("SELECT id FROM equipment_replacements WHERE id = ?", [id]);
    if (!er) return res.status(404).json({ success: false, error: "not_found" });
    const buffer = await generateEquipmentReplacementPdfBuffer(er.id);
    const filename = `equipment-replacement-${er.id}.pdf`;
    const url = writePublicFile("job-reports", filename, buffer);
    res.json({ success: true, url, filename });
  } catch (err) {
    console.error("er-pdf-url error:", err);
    res.status(500).json({ success: false, error: String(err.message || err) });
  }
});

router.post("/equipment-replacements/:id/send", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const [[er]] = await pool.query("SELECT * FROM equipment_replacements WHERE id = ?", [id]);
    if (!er) return res.status(404).json({ success: false, error: "not_found" });
    if (!er.linked_job_id) return res.json({ success: true, sent: 0 }); // بدون ربط بمهمة = ما فيه وجهة إرسال أصلاً

    const [[job]] = await pool.query("SELECT * FROM scheduled_jobs WHERE id = ?", [er.linked_job_id]);
    if (!job) return res.json({ success: true, sent: 0 });

    const authUser = { sub: req.authUserId, role: req.authRole, employee_id: req.authEmployeeId };
    const scopeCtx = await loadScopeContext(pool);
    const allowed =
      isOwner(authUser) ||
      (isAdmin(authUser) && inMyScopeSync(scopeCtx, authUser, job.warehouse_id, job.section_id)) ||
      er.created_by === authUser.sub;
    if (!allowed) return res.status(403).json({ success: false, error: "forbidden" });

    const sent = await sendEquipmentReplacementPdf(er, job);
    res.json({ success: true, sent });
  } catch (err) {
    console.error("send equipment-replacement error:", err);
    res.status(500).json({ success: false, error: String(err.message || err) });
  }
});

export default router;
