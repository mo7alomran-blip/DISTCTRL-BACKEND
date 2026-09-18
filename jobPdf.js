// توليد PDF لتقرير عمل مجدول بالسيرفر — يعادل زر "تصدير PDF" اليدوي بشاشة تفاصيل العمل (buildJobPdf بـApp.jsx)،
// لكن عبر Puppeteer (كروميوم حقيقي) بدل html2canvas/jsPDF بالمتصفح. ميزة هذا الأسلوب: الكروميوم يرسم
// العربي RTL صح بشكل أصلي عبر CSS مباشرة، فما نحتاج حيلة arabicImgTag (تحويل كل نص لصورة) اللي
// يستخدمها الفرونت أصلاً بسبب قصور html2canvas مع تشكيل الحروف العربية.
import { pool } from "./db.js";
import { fmtKsaDateTime } from "./ksaTime.js";

const fmtDateTime = fmtKsaDateTime; // بتوقيت السعودية دايمًا — انظر تعليق ksaTime.js
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function imgsBlock(urls) {
  if (!urls || !urls.length) return "";
  return `<div class="imgs">${urls.map((u) => `<img src="${esc(u)}"/>`).join("")}</div>`;
}
function timelineRow(label, time, images) {
  if (!time) return "";
  return `<tr><td>${esc(label)}</td><td class="t">${fmtDateTime(time)}</td></tr>${images?.length ? `<tr><td colspan="2">${imgsBlock(images)}</td></tr>` : ""}`;
}

let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    browserPromise = import("puppeteer").then((m) =>
      m.default.launch({ headless: "new", args: ["--no-sandbox", "--disable-setuid-sandbox"] })
    );
  }
  return browserPromise;
}

export async function generateJobPdfBuffer(jobId) {
  const [[job]] = await pool.query("SELECT * FROM scheduled_jobs WHERE id = ?", [jobId]);
  if (!job) throw new Error("job_not_found");
  const [[emp]] = await pool.query("SELECT name FROM users WHERE id = ?", [job.employee_id]);
  const wh = job.warehouse_id ? (await pool.query("SELECT name FROM warehouses WHERE id = ?", [job.warehouse_id]))[0][0] : null;
  const [checks] = await pool.query("SELECT * FROM job_contractor_checks WHERE job_id = ? ORDER BY checked_at", [jobId]);
  const [notes] = await pool.query("SELECT * FROM job_isolation_notes WHERE job_id = ? ORDER BY created_at", [jobId]);
  const [images] = await pool.query("SELECT * FROM job_images WHERE job_id = ?", [jobId]);
  const before = images.filter((i) => i.image_type === "before").map((i) => i.image_url);
  const after = images.filter((i) => i.image_type === "after").map((i) => i.image_url);
  const closingNoteImages = images.filter((i) => i.image_type === "closing_note").map((i) => i.image_url);

  const checksRows = checks.map((c) => `
    <tr><td class="${c.ready ? "ok" : "bad"}">${c.ready ? "المقاول جاهز ✅" : "المقاول غير جاهز ❌"}</td><td class="notes">${esc(c.notes || "")}</td><td class="t">${fmtDateTime(c.checked_at)}</td></tr>
    ${c.image_urls?.length ? `<tr><td colspan="3">${imgsBlock(c.image_urls)}</td></tr>` : ""}
  `).join("");
  const notesRows = notes.map((n) => `
    <tr><td>جاري العزل / ملاحظة</td><td class="notes">${esc(n.note)}</td><td class="t">${fmtDateTime(n.created_at)}</td></tr>
    ${n.image_urls?.length ? `<tr><td colspan="3">${imgsBlock(n.image_urls)}</td></tr>` : ""}
  `).join("");
  const cancelRow = job.status === "cancelled"
    ? `<tr><td class="bad">تم إلغاء العمل</td><td class="notes">${esc(job.cancel_reason || "")}</td><td class="t">${fmtDateTime(job.cancelled_at)}</td></tr>`
    : "";

  const html = `<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Cairo:wght@400;700;800&display=swap');
    * { box-sizing: border-box; }
    body { font-family: 'Cairo', sans-serif; direction: rtl; text-align: right; color: #0f172a; padding: 8px 32px; }
    h1 { text-align:center; font-size:20px; color:#1e3a5f; margin:0; }
    .sub { text-align:center; font-size:13px; color:#64748b; margin-top:4px; }
    .hdr { border-bottom:2px solid #1e3a5f; padding-bottom:14px; margin-bottom:18px; }
    table { width:100%; border-collapse:collapse; font-size:13px; margin-bottom:16px; }
    .info td { padding:7px; }
    .info tr:nth-child(even) { background:#f8fafc; }
    .info td:first-child { width:130px; font-weight:700; color:#475569; }
    .section-title { font-size:14px; font-weight:800; color:#1e3a5f; margin:0 0 8px; }
    .timeline { border:1px solid #e2e8f0; border-radius:8px; overflow:hidden; }
    .timeline td { padding:6px 8px; }
    .timeline .t { color:#64748b; text-align:left; white-space:nowrap; }
    .timeline .notes { color:#64748b; font-size:12px; }
    .timeline .ok { color:#16a34a; font-weight:700; }
    .timeline .bad { color:#dc2626; font-weight:700; }
    .imgs { display:flex; flex-wrap:wrap; gap:6px; padding:6px 0; }
    .imgs img { width:150px; height:150px; object-fit:cover; border-radius:6px; border:1px solid #e2e8f0; }
    .photo-title { font-size:13px; font-weight:700; color:#475569; margin:10px 0 6px; }
    .photo-grid img { width:100%; max-width:400px; border-radius:8px; border:1px solid #e2e8f0; margin-bottom:10px; display:block; }
    .empty { color:#94a3b8; font-size:13px; }
    .alert-note { background:#fef2f2; border:1.5px solid #fecaca; border-radius:8px; padding:10px 14px; margin-bottom:16px; color:#991b1b; font-size:13px; font-weight:700; }
    .closing-note { background:#eff6ff; border:1.5px solid #bfdbfe; border-radius:8px; padding:10px 14px; margin:16px 0; color:#1e3a8a; font-size:13px; }
    .closing-note b { display:block; margin-bottom:4px; }
  </style></head><body>
    <div class="hdr">
      <h1>تقرير عمل مجدول</h1>
      <div class="sub">DistCtrl – نظام إدارة الأعمال والمواد</div>
    </div>
    ${job.schedule_note ? `<div class="alert-note">⚠️ ${esc(job.schedule_note)}</div>` : ""}
    <table class="info">
      <tr><td>عنوان العمل</td><td>${esc(job.title)}</td></tr>
      <tr><td>القسم</td><td>${esc(wh?.name || "—")}</td></tr>
      <tr><td>الموظف</td><td>${esc(emp?.name || "—")}</td></tr>
      ${job.feeder_no ? `<tr><td>رقم المغذي</td><td>${esc(job.feeder_no)}</td></tr>` : ""}
      ${job.notification_no ? `<tr><td>رقم الإشعار</td><td>${esc(job.notification_no)}</td></tr>` : ""}
      ${job.equipment_no ? `<tr><td>رقم المعدة</td><td>${esc(job.equipment_no)}</td></tr>` : ""}
      ${job.contractor_name ? `<tr><td>المقاول</td><td>${esc(job.contractor_name)}</td></tr>` : ""}
      ${job.location ? `<tr><td>الموقع</td><td>${esc(job.location)}</td></tr>` : ""}
      <tr><td>وقت البدء</td><td>${fmtDateTime(job.created_at)}</td></tr>
      <tr><td>وقت الانتهاء</td><td>${job.completed_at ? fmtDateTime(job.completed_at) : "—"}</td></tr>
      ${job.description ? `<tr><td>الوصف</td><td>${esc(job.description)}</td></tr>` : ""}
    </table>
    <div class="section-title">سجل الوصول والاستلام</div>
    <table class="timeline">
      ${timelineRow("وصل الموقع", job.arrived_at, job.arrived_images)}
      ${checksRows}
      ${timelineRow("تم التواصل مع المشغل", job.contacted_operator_at, job.contacted_operator_images)}
      ${timelineRow("وصل المشغل", job.operator_arrived_at, job.operator_arrived_images)}
      ${notesRows}
      ${timelineRow("تم استلام العمل", job.job_received_at)}
      ${timelineRow("تم التواصل مع المشغل", job.closing_contacted_operator_at, job.closing_contacted_operator_images)}
      ${timelineRow("وصل المشغل", job.closing_operator_arrived_at, job.closing_operator_arrived_images)}
      ${timelineRow("تم إرجاع التيار", job.power_restored_at, job.power_restored_images)}
      ${cancelRow}
    </table>
    ${job.closing_note ? `
    <div class="closing-note"><b>📝 ملاحظة الإقفال</b>${esc(job.closing_note)}</div>
    ${closingNoteImages.length ? `<div class="photo-grid">${closingNoteImages.map((u) => `<img src="${esc(u)}"/>`).join("")}</div>` : ""}
    ` : ""}
    ${(before.length || after.length) ? `
    <div class="photo-title">صور قبل العمل</div>
    <div class="photo-grid">${before.map((u) => `<img src="${esc(u)}"/>`).join("") || '<div class="empty">لا توجد صور</div>'}</div>
    <div class="photo-title">صور بعد العمل</div>
    <div class="photo-grid">${after.map((u) => `<img src="${esc(u)}"/>`).join("") || '<div class="empty">لا توجد صور</div>'}</div>
    ` : ""}
  </body></html>`;

  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 30000 });
    // Buffer.from(...) إلزامي: page.pdf() ترجّع Uint8Array خام (مو Buffer حقيقي) — res.send() بالراوت
    // اللي يصدّر الملف مباشرة (jobActions.js) يتحقق بـBuffer.isBuffer() قبل ما يرسل البايتات الخام؛
    // Uint8Array عادي يفشل هالفحص فيرمّزه JSON بدل ما يرسله كملف ("{\"0\":37,\"1\":80,...}")، فيوصل العميل
    // ملف "PDF" تالف تمامًا (شاشة سودة عند الفتح) بدون أي خطأ ظاهر — المسارات اللي تكتب لملف مباشر
    // (writePublicFile عبر fs.writeFileSync) ما تتأثر لأن fs لا يفرّق بين Buffer وUint8Array، فهذا الخلل
    // كان يصيب فقط تصدير/تنزيل الملف مباشرة من التطبيق (مو تقارير الواتساب التلقائية).
    return Buffer.from(await page.pdf({ format: "A4", printBackground: true, margin: { top: "20px", bottom: "20px", left: "20px", right: "20px" } }));
  } finally {
    await page.close();
  }
}

// PDF مستقل يحتوي فقط ألبوم صور "جودة التنفيذ" أو "جودة الإرفاق" لعمل مجدول — بزر يدوي منفصل عن تقرير
// الإغلاق الكامل (buildJobPdf/generateJobPdfBuffer أعلاه)، عشان القسم يقدر يرسل هالنوع بالذات لمن يحتاجه فقط
const QUALITY_KIND_LABELS = { execution: "جودة التنفيذ", attachment: "جودة الإرفاق" };
export async function generateJobQualityPdfBuffer(jobId, kind) {
  const imageType = kind === "execution" ? "quality_execution" : "quality_attachment";
  const label = QUALITY_KIND_LABELS[kind] || "صور العمل";
  const [[job]] = await pool.query("SELECT * FROM scheduled_jobs WHERE id = ?", [jobId]);
  if (!job) throw new Error("job_not_found");
  const [[emp]] = await pool.query("SELECT name FROM users WHERE id = ?", [job.employee_id]);
  const [images] = await pool.query("SELECT image_url FROM job_images WHERE job_id = ? AND image_type = ? ORDER BY created_at", [jobId, imageType]);
  const urls = images.map((i) => i.image_url);

  const html = `<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Cairo:wght@400;700;800&display=swap');
    * { box-sizing: border-box; }
    body { font-family: 'Cairo', sans-serif; direction: rtl; text-align: right; color: #0f172a; padding: 8px 32px; }
    h1 { text-align:center; font-size:20px; color:#1e3a5f; margin:0; }
    .sub { text-align:center; font-size:13px; color:#64748b; margin-top:4px; }
    .hdr { border-bottom:2px solid #1e3a5f; padding-bottom:14px; margin-bottom:18px; }
    table.info { width:100%; border-collapse:collapse; font-size:13px; margin-bottom:18px; }
    table.info td { padding:7px; }
    table.info tr:nth-child(even) { background:#f8fafc; }
    table.info td:first-child { width:130px; font-weight:700; color:#475569; }
    .photo-grid img { width:100%; max-width:400px; border-radius:8px; border:1px solid #e2e8f0; margin-bottom:10px; display:block; }
    .empty { color:#94a3b8; font-size:13px; }
    .alert-note { background:#fef2f2; border:1.5px solid #fecaca; border-radius:8px; padding:10px 14px; margin-bottom:16px; color:#991b1b; font-size:13px; font-weight:700; }
  </style></head><body>
    <div class="hdr">
      <h1>${esc(label)}</h1>
      <div class="sub">DistCtrl – نظام إدارة الأعمال والمواد</div>
    </div>
    ${job.schedule_note ? `<div class="alert-note">⚠️ ${esc(job.schedule_note)}</div>` : ""}
    <table class="info">
      <tr><td>عنوان العمل</td><td>${esc(job.title)}</td></tr>
      ${emp?.name ? `<tr><td>الموظف</td><td>${esc(emp.name)}</td></tr>` : ""}
      ${job.description ? `<tr><td>الوصف</td><td>${esc(job.description)}</td></tr>` : ""}
      ${job.feeder_no ? `<tr><td>رقم المغذي</td><td>${esc(job.feeder_no)}</td></tr>` : ""}
      ${job.notification_no ? `<tr><td>رقم الإشعار</td><td>${esc(job.notification_no)}</td></tr>` : ""}
      ${job.project_no ? `<tr><td>رقم المشروع</td><td>${esc(job.project_no)}</td></tr>` : ""}
      ${job.equipment_no ? `<tr><td>رقم المعدة</td><td>${esc(job.equipment_no)}</td></tr>` : ""}
      ${job.contractor_name ? `<tr><td>المقاول</td><td>${esc(job.contractor_name)}</td></tr>` : ""}
      ${job.location ? `<tr><td>الموقع</td><td>${esc(job.location)}</td></tr>` : ""}
      ${job.scheduled_date ? `<tr><td>تاريخ العمل</td><td>${esc(job.scheduled_date)}</td></tr>` : ""}
      <tr><td>عدد الصور</td><td>${urls.length}</td></tr>
    </table>
    <div class="photo-grid">${urls.map((u) => `<img src="${esc(u)}"/>`).join("") || '<div class="empty">لا توجد صور</div>'}</div>
  </body></html>`;

  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 30000 });
    // Buffer.from(...) إلزامي: page.pdf() ترجّع Uint8Array خام (مو Buffer حقيقي) — res.send() بالراوت
    // اللي يصدّر الملف مباشرة (jobActions.js) يتحقق بـBuffer.isBuffer() قبل ما يرسل البايتات الخام؛
    // Uint8Array عادي يفشل هالفحص فيرمّزه JSON بدل ما يرسله كملف ("{\"0\":37,\"1\":80,...}")، فيوصل العميل
    // ملف "PDF" تالف تمامًا (شاشة سودة عند الفتح) بدون أي خطأ ظاهر — المسارات اللي تكتب لملف مباشر
    // (writePublicFile عبر fs.writeFileSync) ما تتأثر لأن fs لا يفرّق بين Buffer وUint8Array، فهذا الخلل
    // كان يصيب فقط تصدير/تنزيل الملف مباشرة من التطبيق (مو تقارير الواتساب التلقائية).
    return Buffer.from(await page.pdf({ format: "A4", printBackground: true, margin: { top: "20px", bottom: "20px", left: "20px", right: "20px" } }));
  } finally {
    await page.close();
  }
}

// PDF مستقل لألبوم "تصاريح العمل" (صور فقط — أي تصريح PDF أصلًا مرفق كملف مستقل قابل للفتح مباشرة من رابطه،
// ما يُضمَّن هنا لأن تضمين PDF داخل PDF غير ممكن كصورة). بزر يدوي بشاشة العمل.
export async function generateJobPermitsPdfBuffer(jobId) {
  const [[job]] = await pool.query("SELECT * FROM scheduled_jobs WHERE id = ?", [jobId]);
  if (!job) throw new Error("job_not_found");
  const [images] = await pool.query("SELECT image_url FROM job_images WHERE job_id = ? AND image_type = 'work_permit' ORDER BY created_at", [jobId]);
  const urls = images.map((i) => i.image_url).filter((u) => !/\.pdf(\?|$)/i.test(u));

  const html = `<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Cairo:wght@400;700;800&display=swap');
    * { box-sizing: border-box; }
    body { font-family: 'Cairo', sans-serif; direction: rtl; text-align: right; color: #0f172a; padding: 8px 32px; }
    h1 { text-align:center; font-size:20px; color:#1e3a5f; margin:0; }
    .sub { text-align:center; font-size:13px; color:#64748b; margin-top:4px; }
    .hdr { border-bottom:2px solid #1e3a5f; padding-bottom:14px; margin-bottom:18px; }
    table.info { width:100%; border-collapse:collapse; font-size:13px; margin-bottom:18px; }
    table.info td { padding:7px; }
    table.info tr:nth-child(even) { background:#f8fafc; }
    table.info td:first-child { width:130px; font-weight:700; color:#475569; }
    .photo-grid img { width:100%; max-width:400px; border-radius:8px; border:1px solid #e2e8f0; margin-bottom:10px; display:block; }
    .empty { color:#94a3b8; font-size:13px; }
  </style></head><body>
    <div class="hdr">
      <h1>تصاريح العمل</h1>
      <div class="sub">DistCtrl – نظام إدارة الأعمال والمواد</div>
    </div>
    <table class="info">
      <tr><td>عنوان العمل</td><td>${esc(job.title)}</td></tr>
      ${job.notification_no ? `<tr><td>رقم الإشعار</td><td>${esc(job.notification_no)}</td></tr>` : ""}
      <tr><td>عدد الصور</td><td>${urls.length}</td></tr>
    </table>
    <div class="photo-grid">${urls.map((u) => `<img src="${esc(u)}"/>`).join("") || '<div class="empty">لا توجد صور</div>'}</div>
  </body></html>`;

  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 30000 });
    return Buffer.from(await page.pdf({ format: "A4", printBackground: true, margin: { top: "20px", bottom: "20px", left: "20px", right: "20px" } }));
  } finally {
    await page.close();
  }
}

// PDF لسجل "استبدال معدة" (PMT/RMU) — يقابل تمامًا buildErPdf بالفرونت (html2canvas/jsPDF)، لكن عبر
// Puppeteer بدون حيلة arabicImgTag (نفس سبب باقي دوال هذا الملف). يُستدعى تلقائيًا فور حفظ السجل لو
// مربوط بمهمة مجدولة — انظر sendEquipmentReplacementPdf بـjobNotifications.js وroutes/equipmentReplacements.js.
function fmtDMY(isoDate) {
  if (!isoDate) return "";
  const [y, mo, d] = String(isoDate).split("-");
  if (!y || !mo || !d) return isoDate;
  return `${parseInt(d, 10)}/${parseInt(mo, 10)}/${y}`;
}
export async function generateEquipmentReplacementPdfBuffer(erId) {
  const [[er]] = await pool.query("SELECT * FROM equipment_replacements WHERE id = ?", [erId]);
  if (!er) throw new Error("er_not_found");
  const wh = er.issuing_warehouse_id ? (await pool.query("SELECT name FROM warehouses WHERE id = ?", [er.issuing_warehouse_id]))[0][0] : null;
  const linkedJob = er.linked_job_id ? (await pool.query("SELECT title, notification_no FROM scheduled_jobs WHERE id = ?", [er.linked_job_id]))[0][0] : null;
  const [images] = await pool.query("SELECT * FROM equipment_replacement_images WHERE equipment_replacement_id = ?", [erId]);
  const before = images.filter((i) => i.image_type === "before").map((i) => i.image_url);
  const after = images.filter((i) => i.image_type === "after").map((i) => i.image_url);
  const row = (label, value) => (value ? `<tr><td>${esc(label)}</td><td>${esc(value)}</td></tr>` : "");

  const html = `<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Cairo:wght@400;700;800&display=swap');
    * { box-sizing: border-box; }
    body { font-family: 'Cairo', sans-serif; direction: rtl; text-align: right; color: #0f172a; padding: 8px 32px; }
    h1 { text-align:center; font-size:20px; color:#1e3a5f; margin:0; }
    .sub { text-align:center; font-size:13px; color:#64748b; margin-top:4px; }
    .hdr { border-bottom:2px solid #1e3a5f; padding-bottom:14px; margin-bottom:18px; }
    table.info { width:100%; border-collapse:collapse; font-size:13px; margin-bottom:18px; }
    table.info td { padding:7px; }
    table.info tr:nth-child(even) { background:#f8fafc; }
    table.info td:first-child { width:150px; font-weight:700; color:#475569; }
    .photo-title { font-size:13px; font-weight:700; color:#475569; margin:10px 0 6px; }
    .photo-grid img { width:100%; max-width:400px; border-radius:8px; border:1px solid #e2e8f0; margin-bottom:10px; display:block; }
    .empty { color:#94a3b8; font-size:13px; }
  </style></head><body>
    <div class="hdr">
      <h1>معلومات تغيير المعدات</h1>
      <div class="sub">DistCtrl – نظام إدارة الأعمال والمواد</div>
    </div>
    <table class="info">
      ${row("رقم المعدة", er.equipment_no)}
      ${row("تاريخ العمل", fmtDMY(er.work_date))}
      ${row("المقاول", er.contractor_name)}
      ${row("الموقع", er.location)}
      ${row("نوع المعدة", er.equipment_type)}
      ${row("السبب", er.reason)}
      ${row("الإشعار/المهمة", er.notification_no)}
      ${row("رقم التاق", er.tag_no)}
      ${row("الاستشاري", er.consultant_text)}
      ${row("الرقم التسلسلي القديم", er.old_serial_no)}
      ${row("الرقم التسلسلي الجديد", er.new_serial_no)}
      ${row("سنة الصنع", er.manufacture_year)}
      ${row("اسم الشركة المصنعة", er.manufacturer_name)}
      ${row("جهة صرف المعدة", wh?.name)}
      ${row("KVA", er.kva_rating)}
      ${row("HV", er.voltage_rating)}
      ${row("LV", er.lv_rating)}
      ${row("طارئ؟", er.is_emergency ? "نعم" : "لا")}
      ${linkedJob ? row("مرتبطة بمهمة", linkedJob.notification_no || linkedJob.title) : ""}
    </table>
    <div class="photo-title">صورة لوحة المعلومات — قبل</div>
    <div class="photo-grid">${before.map((u) => `<img src="${esc(u)}"/>`).join("") || '<div class="empty">لا توجد صور</div>'}</div>
    <div class="photo-title">صورة لوحة المعلومات — بعد</div>
    <div class="photo-grid">${after.map((u) => `<img src="${esc(u)}"/>`).join("") || '<div class="empty">لا توجد صور</div>'}</div>
  </body></html>`;

  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 30000 });
    return Buffer.from(await page.pdf({ format: "A4", printBackground: true, margin: { top: "20px", bottom: "20px", left: "20px", right: "20px" } }));
  } finally {
    await page.close();
  }
}
