// إجراءات يدوية على عمل مجدول لا تُعبَّر كتحديث صف عادي عبر /api/table (فعل فوري: توليد ملف + إرساله/تنزيله) —
// حاليًا: PDF مستقل لألبوم "جودة التنفيذ"/"جودة الإرفاق" — POST يرسله واتساب مباشرة (jobNotifications.sendQualityPdf)،
// GET يرجّع بايتات الملف نفسه عشان الواجهة تصدّره/تشاركه بأي طريقة ثانية (مو شرط واتساب — Web Share API أو تنزيل مباشر).
import express from "express";
import crypto from "crypto";
import { pool } from "../db.js";
import { requireAuth } from "../auth.js";
import { isOwner, isAdmin, inMyScopeSync, loadScopeContext } from "../scope.js";
import { sendQualityPdf } from "../jobNotifications.js";
import { generateJobQualityPdfBuffer, generateJobPermitsPdfBuffer, generateJobPdfBuffer } from "../jobPdf.js";
import { contentDispositionInline } from "../contentDisposition.js";
import { sendWebPushToSubs } from "../pushSend.js";
import { resolveDivisionForSection, OWNER_EMPLOYEE_ID } from "../scope.js";
import { writePublicFile } from "../storage.js";

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

// رابط PDF عام (job-reports bucket) لتقرير العمل المكتمل — يُستخدم فقط لما تعذّر Web Share API بملفات
// (متصفح/جهاز ما يدعمها)، فبدل ما نطلب من المستخدم يحمّل الملف يدويًا ويرفقه بمحادثة واتساب، نحط رابط
// حقيقي بنص الرسالة يقدر أي طرف يفتحه مباشرة. نفس PDF المُستخدم أصلاً بالإرسال التلقائي من السيرفر
// (generateJobPdfBuffer) — نفس صلاحيات send-quality-pdf فوق بالضبط (صاحب العمل أو مشرف بنطاقه أو المالك).
router.get("/jobs/:id/completion-pdf-url", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const [[job]] = await pool.query("SELECT * FROM scheduled_jobs WHERE id = ?", [id]);
    if (!job) return res.status(404).json({ success: false, error: "job_not_found" });
    const authUser = { sub: req.authUserId, role: req.authRole, employee_id: req.authEmployeeId };
    const scopeCtx = await loadScopeContext(pool);
    if (!canSendQualityPdf(authUser, scopeCtx, job)) return res.status(403).json({ success: false, error: "forbidden" });
    const buffer = await generateJobPdfBuffer(job.id);
    const filename = `job-report-${job.id}.pdf`;
    const url = writePublicFile("job-reports", filename, buffer);
    res.json({ success: true, url, filename });
  } catch (err) {
    console.error("completion-pdf-url error:", err);
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

// نفس منطق resolveResponsibleAdminPhones بـjobNotifications.js بالحرف، بس يرجّع user_id بدل رقم جوال
// (مطلوب لإشعار Push، مو واتساب) — مكرر عمدًا هنا بدل استيراده لأن تلك الدالة غير مصدَّرة أصلاً
async function resolveResponsibleAdminIds(warehouseId, sectionId) {
  const [assignments] = await pool.query("SELECT * FROM warehouse_assignments");
  // المالك مستثنى دائمًا — نفس إصلاح resolveResponsibleAdminPhones بـjobNotifications.js 2026-09-13
  const [admins] = await pool.query("SELECT id FROM users WHERE role IN ('admin','section_head','manager','operator') AND employee_id <> ?", [OWNER_EMPLOYEE_ID]);
  if (!admins.length) return [];
  const assignedIds = new Set(assignments.map((a) => a.user_id));
  const openAdmins = () => admins.filter((u) => !assignedIds.has(u.id)).map((u) => u.id);
  if (!warehouseId && !sectionId) return openAdmins();

  let division = null;
  if (warehouseId) {
    const [[wh]] = await pool.query("SELECT division_id FROM warehouses WHERE id = ?", [warehouseId]);
    division = wh?.division_id ?? null;
  }
  const newDivision = sectionId ? await resolveDivisionForSection(sectionId) : null;

  const whAssignments = warehouseId ? assignments.filter((a) => a.warehouse_id === warehouseId && !a.section_id && !a.division_id) : [];
  const secAssignments = sectionId ? assignments.filter((a) => a.section_id === sectionId) : [];
  const divAssignments = assignments.filter((a) => a.division_id && (a.division_id === division || a.division_id === newDivision));

  // أولوية للأخص — مستودع/قسم محدد يطغى على مدير الدائرة الكاملة (نفس إصلاح resolveResponsibleAdminPhones
  // بـjobNotifications.js يوم 2026-09-11، انظر تعليقها فيه للتفصيل الكامل). لو التخصيص الدقيق موجود لكن
  // ما طابق أي مشرف حقيقي نتصعّد بدل ما نرجّع فاضي بصمت — نفس الإصلاح.
  const narrowIds = new Set([...whAssignments, ...secAssignments].map((a) => a.user_id));
  if (narrowIds.size > 0) {
    const narrowAdmins = admins.filter((u) => narrowIds.has(u.id)).map((u) => u.id);
    if (narrowAdmins.length > 0) return narrowAdmins;
  }
  const divIds = new Set(divAssignments.map((a) => a.user_id));
  if (divIds.size > 0) {
    const divAdmins = admins.filter((u) => divIds.has(u.id)).map((u) => u.id);
    if (divAdmins.length > 0) return divAdmins;
  }
  return openAdmins();
}

// طلب مواد من داخل عمل — الموظف المسند له العمل (أو مشرف بنطاقه) يبحث بكامل دليل material_catalog، مو
// مقيّد بمخزون مستودع العمل فقط. لكل مادة: نلقى صف products مطابق بنفس المستودع لو موجود (رصيده الحقيقي
// الحالي)، وإلا نُنشئه برصيد ابتدائي صفر — نفس الغرض الموثّق لـmaterial_catalog أصلاً ("اقتراح تلقائي عند
// إضافة مادة لمستودع"، انظر schema.sql). العملية هنا سيرفر بالكامل (تتجاوز سياسة products.insert
// العادية المقيّدة بالإداريين فقط) لأن الموظف المسند مصرَّح له بالضبط بهذا الإجراء (نفس صلاحية
// canSendQualityPdf فوق)، مو صلاحية إدارة مخزون عامة. ينتج عنها صف orders عادي (job_id مربوط) يمر بنفس
// مسار موافقة الطلبات الحالي بالضبط (بما فيها خصم الرصيد الفعلي عند "تم الصرف" — dispense_order_stock
// يعتمد على item.id الحقيقي، لذا لازم منتج حقيقي مو مجرد اسم من الكتالوج).
router.post("/jobs/:id/material-request", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { items } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ success: false, error: "invalid_input" });

    const [[job]] = await pool.query("SELECT * FROM scheduled_jobs WHERE id = ?", [id]);
    if (!job) return res.status(404).json({ success: false, error: "job_not_found" });
    const authUser = { sub: req.authUserId, role: req.authRole, employee_id: req.authEmployeeId };
    const scopeCtx = await loadScopeContext(pool);
    if (!canSendQualityPdf(authUser, scopeCtx, job)) return res.status(403).json({ success: false, error: "forbidden" });

    const orderItems = [];
    for (const it of items) {
      const name = String(it?.name || "").trim();
      const requested = Number(it?.requested) || 0;
      if (!name || requested <= 0) continue;
      let [[prod]] = await pool.query(
        "SELECT * FROM products WHERE warehouse_id <=> ? AND name = ? LIMIT 1",
        [job.warehouse_id || null, name]
      );
      if (!prod) {
        const prodId = crypto.randomUUID();
        await pool.query(
          "INSERT INTO products (id, name, unit, sku, warehouse_id, section_id, quantity) VALUES (?, ?, ?, ?, ?, ?, 0)",
          [prodId, name, it.unit || "قطعة", it.code || null, job.warehouse_id || null, job.section_id || null]
        );
        [[prod]] = await pool.query("SELECT * FROM products WHERE id = ?", [prodId]);
      }
      orderItems.push({ ...prod, requested });
    }
    if (!orderItems.length) return res.status(400).json({ success: false, error: "invalid_input" });

    const [[requester]] = await pool.query("SELECT name, employee_id FROM users WHERE id = ?", [authUser.sub]);
    const orderId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO orders (id, emp_name, emp_id, emp_no, user_id, warehouse_id, section_id, job_id, status, items, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'قيد المراجعة', ?, NOW(3))`,
      [orderId, requester?.name || null, authUser.sub, requester?.employee_id || null, authUser.sub, job.warehouse_id || null, job.section_id || null, job.id, JSON.stringify(orderItems)]
    );

    // مؤقت (طلب صريح من المالك يوم 2026-09-11، أثناء اختبار "Work Flow" المستودعات الثلاثة) — نفس استثناء
    // resolveJobTargets بـjobNotifications.js بالحرف، انظر تعليقها فيه للسبب الكامل
    const TEMP_NO_INDIVIDUAL_NOTIFY_WAREHOUSES = new Set([
      "ff1d0554-b4a0-4621-ae52-d1eef7ff9f93", "b98f92b0-0d55-4786-921c-593b33c32b51", "dad2c603-b71d-4bb8-899c-3bc651e1917a",
    ]);
    // تفضيل مخصص لهذي المجموعة تحديدًا لنوع "طلب مواد" (job_notification_prefs.material_request) يطغى بالكامل
    // على كل شي تحت — نفس مبدأ getSectionContentRecipients بـjobNotifications.js بالحرف (2026-09-11)
    let adminIds;
    const [prefRows] = job.section_id
      ? await pool.query("SELECT user_id, material_request FROM job_notification_prefs WHERE section_id = ?", [job.section_id])
      : [[]];
    if (prefRows.length) {
      adminIds = prefRows.filter((r) => r.material_request).map((r) => r.user_id).filter((uid) => uid !== authUser.sub);
    } else {
      const suppressIndividual = job.warehouse_id && TEMP_NO_INDIVIDUAL_NOTIFY_WAREHOUSES.has(job.warehouse_id);
      adminIds = suppressIndividual ? [] : (await resolveResponsibleAdminIds(job.warehouse_id, job.section_id)).filter((uid) => uid !== authUser.sub);
    }
    if (adminIds.length) {
      const [subs] = await pool.query(
        `SELECT id, endpoint, p256dh, auth_key FROM push_subscriptions WHERE user_id IN (${adminIds.map(() => "?").join(",")})`,
        adminIds
      );
      const payload = JSON.stringify({
        title: "طلب مواد جديد يحتاج موافقتك", body: `من ${requester?.name || ""}`,
        url: "/", tag: "new-order", target_screen: "admin_order_detail", target_id: orderId,
      });
      await sendWebPushToSubs(subs, payload);
    }

    res.json({ success: true, orderId });
  } catch (err) {
    console.error("material-request error:", err);
    res.status(500).json({ success: false, error: String(err.message || err) });
  }
});

export default router;
