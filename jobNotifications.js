// إشعارات واتساب لخط سير العمل المجدول (يقابل مراحل المخطط: جدولة → وصول وتحضير → عزل → استلام وإغلاق
// → اكتمال، وفرع الإلغاء + تنبيه التأخير). وجهتان مختلفتان حسب الحدث:
//   1) "لك عمل مسند" — يوصل رقم الموظف نفسه (users.phone) — notifyEmployeeAssigned
//   2) كل تحديثات الخط الزمني/المراحل — توصل المشرف المسؤول عن نطاق العمل (نفس منطق getResponsibleAdminIds
//      بـcron.js: تخصيص مستودع/دائرة محدد، وإلا كل الإداريين المفتوحين بدون تخصيص)، بالإضافة لأي رقم مراقبة
//      ثابت اختياري (WHATSAPP_JOB_WATCH_NUMBERS) — انظر resolveResponsibleAdminPhones + broadcast.
// فشل الإرسال هنا لا يوقف ولا يغيّر نتيجة عملية التحديث/الإدراج الأساسية أبدًا (كل نداء محاط بـ.catch بالمستدعي).
import "dotenv/config";
import { pool } from "./db.js";
import { sendWhatsAppText, sendWhatsAppMediaUrl, isWhatsAppConfigured } from "./whatsapp.js";
import { generateJobPdfBuffer, generateJobQualityPdfBuffer } from "./jobPdf.js";
import { writePublicFile } from "./storage.js";
import { resolveDivisionForSection } from "./scope.js";

function fmt(d) {
  if (!d) return "—";
  const dt = new Date(d);
  const day = String(dt.getDate()).padStart(2, "0");
  const mon = String(dt.getMonth() + 1).padStart(2, "0");
  return `${day}/${mon}/${dt.getFullYear()} - ${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`;
}
// متابعون عامون لكل الأعمال (بلا استثناء قسم/نوع محتوى) — يُدارون من شاشة "متابعة عامة لكل الأعمال" بالتطبيق
// (جدول global_job_watchers)، بالإضافة لأي رقم ثابت اختياري بـ.env (توافقًا مع الإعداد القديم لو استُخدم لاحقًا)
async function watchNumbers() {
  const envNums = (process.env.WHATSAPP_JOB_WATCH_NUMBERS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const [rows] = await pool.query(
    `SELECT u.phone FROM global_job_watchers gw JOIN users u ON u.id = gw.user_id WHERE u.phone IS NOT NULL AND u.phone <> ''`
  );
  return [...new Set([...envNums, ...rows.map((r) => r.phone)])];
}

// نفس منطق getResponsibleAdminIds بـcron.js بالحرف (تخصيص مستودع/دائرة محدد وإلا كل إداري بلا تخصيص)،
// بس يرجّع أرقام هواتف بدل IDs — ويتجاهل أي إداري بدون رقم مسجّل بدل ما يفشل.
// sectionId (هيكل جديد، اختياري): يفحص تخصيص إشراف مباشر على القسم/المجموعة نفسها + على الدائرة
// المُشتقة منها (resolveDivisionForSection، يمشي فوق تلقائيًا لو "مجموعة" تابعة لقسم) — إضافي بجانب
// فحص المستودع/الدائرة القديم فوق، بدون ما يغيّر سلوكه لو الطلب ما فيه sectionId إطلاقًا.
async function resolveResponsibleAdminPhones(warehouseId, sectionId = null) {
  const [assignments] = await pool.query("SELECT * FROM warehouse_assignments");
  const [admins] = await pool.query(
    "SELECT id, phone FROM users WHERE role IN ('admin','manager','operator') AND phone IS NOT NULL AND phone <> ''"
  );
  if (!admins.length) return [];
  const assignedIds = new Set(assignments.map((a) => a.user_id));
  const openAdmins = () => admins.filter((u) => !assignedIds.has(u.id)).map((u) => u.phone);
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

  const specificIds = new Set([...whAssignments, ...secAssignments, ...divAssignments].map((a) => a.user_id));
  const specific = admins.filter((u) => specificIds.has(u.id)).map((u) => u.phone);
  return specific.length > 0 ? specific : openAdmins();
}

// تفضيلات إشعارات مخصّصة لكل قسم/مشروع (job_notification_prefs) — تحديد صريح لكل شخص أي نوع محتوى يستلمه.
// إضافي بالكامل: قسم بدون أي صف هنا يرجّع null (يعني "غير مهيّأ")، فيستمر resolveJobTargets بالسلوك القديم
// تمامًا كما كان. قسم مهيّأ فعليًا (ولو بشخص واحد) يرجّع القائمة الدقيقة (وقد تكون [] لو محد مفعّل هذا النوع
// بالذات — قرار المالك الصريح يُحترم ولا نرجع للسلوك الافتراضي بالخطأ).
const NOTIFICATION_CONTENT_TYPES = new Set(["stage_updates", "final_report", "completion_pdf", "quality_execution_pdf", "quality_attachment_pdf"]);
async function getSectionContentRecipients(sectionId, contentType) {
  if (!sectionId || !NOTIFICATION_CONTENT_TYPES.has(contentType)) return null;
  const [rows] = await pool.query(
    `SELECT jnp.${contentType} AS enabled, u.phone FROM job_notification_prefs jnp
     JOIN users u ON u.id = jnp.user_id WHERE jnp.section_id = ?`,
    [sectionId]
  );
  if (!rows.length) return null; // القسم بلا أي تخصيص إطلاقًا → السلوك القديم
  return rows.filter((r) => r.enabled && r.phone).map((r) => r.phone);
}

// أرقام/قروب وجهة رسائل الخط الزمني لعمل معيّن — بالأولوية:
//   1) تفضيلات القسم المخصّصة (job_notification_prefs) لو مهيّأة فعليًا لهذا القسم — تطغى على كل شي تحت
//   2) قروب واتساب مخصّص للمستودع (warehouses.whatsapp_group_id) لو مضبوط — يستبدل أرقام المشرفين الفردية
//      (القروب أصلاً كل المشرفين المعنيين فيه، فإرسال فردي لهم كمان يكرر الرسالة بلا داعي)
//   3) وإلا: المشرف المسؤول عن النطاق فرديًا (نفس منطق getResponsibleAdminIds بـcron.js)
// + رقم المراقبة الثابت الاختياري (WHATSAPP_JOB_WATCH_NUMBERS) يُضاف بكل الحالات
// contentType: نوع المحتوى (لتفضيلات القسم فقط) — افتراضيًا "stage_updates" لتحديثات الخط الزمني العادية
async function resolveJobTargets(warehouseId, sectionId = null, contentType = "stage_updates") {
  const watchers = await watchNumbers();
  const prefPhones = await getSectionContentRecipients(sectionId, contentType);
  if (prefPhones !== null) return [...new Set([...prefPhones, ...watchers])];
  if (warehouseId) {
    const [[wh]] = await pool.query("SELECT whatsapp_group_id FROM warehouses WHERE id = ?", [warehouseId]);
    if (wh?.whatsapp_group_id) return [...new Set([wh.whatsapp_group_id, ...watchers])];
  }
  const dynamic = await resolveResponsibleAdminPhones(warehouseId || null, sectionId || null);
  return [...new Set([...dynamic, ...watchers])];
}

async function broadcastToJob(text, job, contentType = "stage_updates") {
  if (!isWhatsAppConfigured()) return;
  const nums = await resolveJobTargets(job?.warehouse_id, job?.section_id, contentType);
  if (!nums.length) return;
  await Promise.allSettled(nums.map((n) => sendWhatsAppText(n, text)));
}

async function employeeName(employeeId) {
  if (!employeeId) return null;
  const [[u]] = await pool.query("SELECT name FROM users WHERE id = ?", [employeeId]);
  return u?.name || null;
}

async function employeePhone(employeeId) {
  if (!employeeId) return null;
  const [[u]] = await pool.query("SELECT phone FROM users WHERE id = ?", [employeeId]);
  return u?.phone || null;
}

// اسم المستودع/القسم + اسم الدائرة اللي يتبعها — للعرض بإشعار "لك عمل مسند" (الموظف يحتاج يعرف تبع أي نطاق)
async function warehouseInfo(warehouseId) {
  if (!warehouseId) return { warehouseName: null, divisionName: null };
  const [[wh]] = await pool.query("SELECT name, division_id FROM warehouses WHERE id = ?", [warehouseId]);
  if (!wh) return { warehouseName: null, divisionName: null };
  let divisionName = null;
  if (wh.division_id) {
    const [[div]] = await pool.query("SELECT name FROM divisions WHERE id = ?", [wh.division_id]);
    divisionName = div?.name || null;
  }
  return { warehouseName: wh.name, divisionName };
}

const ROLE_LABELS = { admin: "مشرف", manager: "مدير", operator: "مشغل" };
async function actorLabel(actorUserId) {
  if (!actorUserId) return null;
  const [[u]] = await pool.query("SELECT name, role FROM users WHERE id = ?", [actorUserId]);
  if (!u) return null;
  return `${u.name}${ROLE_LABELS[u.role] ? ` (${ROLE_LABELS[u.role]})` : ""}`;
}

// "لك عمل مسند" — يوصل الموظف نفسه على رقمه الشخصي (users.phone)، مستقل تمامًا عن رسائل المشرف.
// actorUserId: المستخدم اللي نفّذ عملية الإسناد فعليًا (المصادَق عليه بالطلب نفسه، req.authUserId بـtable.js) —
// مو عمود مخزَّن بالجدول، لأن "مين أسند العمل" هو ببساطة صاحب طلب POST/PATCH الحالي، ما يحتاج تتبع دائم.
export async function notifyEmployeeAssigned(job, actorUserId) {
  if (!isWhatsAppConfigured()) return;
  const phone = await employeePhone(job.employee_id);
  if (!phone) return;
  const [{ warehouseName, divisionName }, assignedBy] = await Promise.all([
    warehouseInfo(job.warehouse_id),
    actorLabel(actorUserId),
  ]);
  const lines = [
    `📌 *لديك عمل مسند إليك*`,
    ``,
    job.schedule_note ? `⚠️ *${job.schedule_note}*` : null,
    `📋 ${(job.title || "").slice(0, 80)}`,
    job.description ? `📝 ${job.description.slice(0, 150)}` : null,
    divisionName ? `🏢 الدائرة: ${divisionName}` : null,
    warehouseName ? `🏬 القسم: ${warehouseName}` : null,
    assignedBy ? `👤 أسندها: ${assignedBy}` : null,
    job.location ? `📍 ${job.location}` : null,
    job.scheduled_date ? `📅 تاريخ العمل: ${job.scheduled_date}` : null,
    job.start_time ? `⏰ الوقت: ${job.start_time}${job.end_time ? " - " + job.end_time : ""}` : null,
  ].filter(Boolean);
  await sendWhatsAppText(phone, lines.join("\n"));
}

// اسم كل حقل توقيت بجدول scheduled_jobs → نص الإشعار المقابل له بنفس ترتيب المخطط
const STAGE_LABELS = {
  arrived_at: "📍 وصل الموظف للموقع",
  contacted_operator_at: "☎️ تم التواصل مع المشغل",
  operator_arrived_at: "🚶 وصل المشغل للموقع",
  job_received_at: "✅ تم استلام العمل",
  closing_contacted_operator_at: "☎️ تواصل مع المشغل (إغلاق)",
  closing_operator_arrived_at: "🚶 وصل المشغل (إغلاق)",
  power_restored_at: "⚡ تم إرجاع التيار",
};

// actorUserId: صاحب طلب الإنشاء الحالي (req.authUserId) — يظهر بإشعار "لك عمل مسند" كـ"أسندها: فلان"
export async function notifyJobCreated(job, actorUserId) {
  if (!isWhatsAppConfigured()) return;
  const title = (job?.title || "عمل مجدول").slice(0, 60);
  const empName = await employeeName(job.employee_id);
  const notePrefix = job.schedule_note ? `⚠️ *${job.schedule_note}*\n\n` : "";
  await Promise.allSettled([
    broadcastToJob(`🆕 جدولة عمل جديد\n\n${notePrefix}📋 ${title}${empName ? `\n👤 ${empName}` : ""}`, job),
    notifyEmployeeAssigned(job, actorUserId),
  ]);
}

export async function notifyJobStageChange(oldRow, newRow, actorUserId) {
  if (!isWhatsAppConfigured()) return;
  const title = (newRow.title || "عمل مجدول").slice(0, 60);
  const empName = await employeeName(newRow.employee_id);
  const lines = [];

  for (const [field, label] of Object.entries(STAGE_LABELS)) {
    if (!oldRow[field] && newRow[field]) {
      // مرحلة "وصل الموظف" بالذات تحتاج اسمه الحقيقي بالسطر نفسه، مو بس بالتذييل — هو محور الحدث هنا
      lines.push(field === "arrived_at" && empName ? `📍 وصل ${empName} للموقع` : label);
    }
  }
  if (oldRow.status !== newRow.status) {
    if (newRow.status === "completed") lines.push("🏁 اكتمل العمل");
    if (newRow.status === "cancelled") lines.push(`❌ تم إلغاء العمل${newRow.cancel_reason ? " — *" + newRow.cancel_reason + "*" : ""}`);
  }
  if (oldRow.employee_id !== newRow.employee_id) lines.push(`🔁 أُعيد إسناد العمل${empName ? " إلى " + empName : ""}`);

  const tasks = [];
  if (lines.length) tasks.push(broadcastToJob(`${lines.join("\n")}\n\n📋 ${title}${empName ? `\n👤 ${empName}` : ""}`, newRow));
  // إعادة إسناد لموظف مختلف = يستاهل "لك عمل مسند" جديدة لصاحب الرقم الجديد، بالضبط متل الإنشاء
  if (oldRow.employee_id !== newRow.employee_id) tasks.push(notifyEmployeeAssigned(newRow, actorUserId));
  await Promise.allSettled(tasks);
}

// رسالة مختصرة بعد "🏁 اكتمل العمل" — معلومات العمل الأساسية بس، بدون تفاصيل مراحل الخط
// (تلك موجودة كاملة بملف الـPDF المرفق منفصل — انظر sendJobCompletionPdf)
export async function notifyJobCompletionReport(job) {
  if (!isWhatsAppConfigured()) return;
  if (job.status !== "completed") return;

  const empName = await employeeName(job.employee_id);
  const lines = [
    `📄 *تقرير إغلاق العمل*`,
    ``,
    `📋 ${(job.title || "").slice(0, 80)}`,
    empName ? `👤 ${empName}` : null,
    job.location ? `📍 ${job.location}` : null,
    job.feeder_no ? `🔌 المغذي: ${job.feeder_no}` : null,
    job.notification_no ? `🔢 رقم الإشعار: ${job.notification_no}` : null,
    job.equipment_no ? `⚙️ رقم المعدة: ${job.equipment_no}` : null,
    job.contractor_name ? `👷 المقاول: ${job.contractor_name}` : null,
    job.scheduled_date ? `📅 تاريخ العمل: ${job.scheduled_date}` : null,
    `⏱️ اكتمل: ${fmt(job.completed_at)}`,
    job.closing_note ? `📝 ملاحظة الإقفال: ${job.closing_note.slice(0, 150)}` : null,
  ].filter(Boolean);

  await broadcastToJob(lines.join("\n"), job, "final_report");
}

// يولّد ملف PDF كامل (نفس محتوى زر "تصدير PDF" اليدوي بالتطبيق) ويرسله كمرفق واتساب — يُستدعى مرة
// وحدة عند الاكتمال، بعد notifyJobCompletionReport (الرسالة النصية المختصرة).
// نستضيف الملف على uploads/job-reports العام ونرسل رابطه (mediaUrl) بدل base64 مباشر — بوابة واتساب
// (Hermosa) فشلت فعليًا بفك ترميز base64 لملفات كبيرة (خطأ atob داخل whatsapp-web.js نفسه، جهة السيرفر
// المقابل، مو عندنا) — الرابط أثبت نجاحه لأنه يقابل تمامًا مثال "Send media from URL" بتوثيقهم.
// اسم الملف = عنوان العمل كامل (نفس السطر "📋" بالتقرير المختصر، بدون قص الـ80 حرف المستخدم بنص
// الرسالة نفسها) + رقم الإشعار لو موجود (تمييز إضافي، مو تكرار) — بدل معرّف العمل (UUID) غير المفيد سابقًا.
// نشيل الأحرف الممنوعة بأسماء الملفات فقط، وحد أقصى 200 حرف كسقف أمان لمهام متعددة العناصر بعنوان طويل جدًا.
function sanitizeFilenamePart(s) {
  return String(s || "").replace(/[/\\:*?"<>|]/g, "").replace(/\s+/g, " ").trim();
}
function buildCompletionPdfFilename(job) {
  const title = sanitizeFilenamePart(job.title) || "تقرير عمل";
  const notif = job.notification_no ? ` - ${sanitizeFilenamePart(job.notification_no)}` : "";
  return `${(title + notif).slice(0, 200)}.pdf`;
}

export async function sendJobCompletionPdf(job) {
  if (!isWhatsAppConfigured()) return;
  if (job.status !== "completed") return;
  const nums = await resolveJobTargets(job.warehouse_id, job.section_id, "completion_pdf");
  if (!nums.length) return;
  const buffer = await generateJobPdfBuffer(job.id);
  const filename = buildCompletionPdfFilename(job);
  const url = writePublicFile("job-reports", filename, buffer);
  await Promise.allSettled(nums.map((n) => sendWhatsAppMediaUrl(n, url, "📄 تقرير العمل المكتمل")));
}

// PDF مستقل لألبوم "جودة التنفيذ" أو "جودة الإرفاق" — بزر يدوي من شاشة العمل (مو تلقائي عند الاكتمال).
// المستلمون: نفس منطق resolveJobTargets العادي (تفضيلات القسم لو مهيّأة لهذا النوع بالذات، وإلا المشرف
// المسؤول عن النطاق كالمعتاد) — يرجّع عدد الأرقام اللي أُرسل لها فعليًا، عشان الواجهة تعرف لو محد استلم شي.
export async function sendQualityPdf(job, kind) {
  if (!isWhatsAppConfigured()) return 0;
  const contentType = kind === "execution" ? "quality_execution_pdf" : "quality_attachment_pdf";
  const nums = await resolveJobTargets(job.warehouse_id, job.section_id, contentType);
  if (!nums.length) return 0;
  const buffer = await generateJobQualityPdfBuffer(job.id, kind);
  const label = kind === "execution" ? "جودة التنفيذ" : "جودة الإرفاق";
  const notif = job.notification_no ? ` - ${sanitizeFilenamePart(job.notification_no)}` : "";
  const filename = `${(sanitizeFilenamePart(job.title) || "تقرير عمل")}${notif} - ${label}`.slice(0, 200) + ".pdf";
  const url = writePublicFile("job-reports", filename, buffer);
  await Promise.allSettled(nums.map((n) => sendWhatsAppMediaUrl(n, url, `📄 ${label}`)));
  return nums.length;
}

export async function notifyJobChildEvent(table, row, job) {
  if (!isWhatsAppConfigured()) return;
  const title = (job?.title || "عمل مجدول").slice(0, 60);
  const empName = await employeeName(job?.employee_id);
  let line = null;
  if (table === "job_contractor_checks") {
    line = `🔧 فحص جاهزية المقاول: ${row.ready ? "جاهز ✅" : "غير جاهز ❌"}`;
    if (row.notes) line += `\n📝 *${row.notes.slice(0, 100)}*`;
  } else if (table === "job_isolation_notes") {
    line = `📝 ملاحظة عزل: *${(row.note || "").slice(0, 100)}*`;
  }
  if (!line) return;
  await broadcastToJob(`${line}\n\n📋 ${title}${empName ? `\n👤 ${empName}` : ""}`, job);
}

// تنبيه "العمل تأخر" — يُستدعى من cron.js (checkDelayedJobs) لكل عمل استُلم (job_received_at) من أكثر
// من N ساعة (WHATSAPP_OVERDUE_HOURS، افتراضي 5) بدون ما يوصل "مكتمل" بعد. مرة وحدة لكل عمل — cron.js هو
// اللي يسجّل overdue_alert_sent_at بعد نجاح هذا الاستدعاء عشان ما يتكرر التنبيه.
export async function notifyJobDelayed(job, hoursElapsed) {
  if (!isWhatsAppConfigured()) return;
  const empName = await employeeName(job.employee_id);
  const lines = [
    `⏰ *تنبيه: عمل متأخر*`,
    ``,
    `📋 ${(job.title || "").slice(0, 80)}`,
    empName ? `👤 ${empName}` : null,
    job.location ? `📍 ${job.location}` : null,
    `مضى عليه ${hoursElapsed} ساعة من الاستلام بدون اكتمال`,
    `استُلم: ${fmt(job.job_received_at)}`,
  ].filter(Boolean);
  await broadcastToJob(lines.join("\n"), job);
}
