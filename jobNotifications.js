// إشعارات واتساب لخط سير العمل المجدول (يقابل مراحل المخطط: جدولة → وصول وتحضير → عزل → استلام وإغلاق
// → اكتمال، وفرع الإلغاء + تنبيه التأخير). وجهتان مختلفتان حسب الحدث:
//   1) "لك عمل مسند" — يوصل رقم الموظف نفسه (users.phone) — notifyEmployeeAssigned
//   2) كل تحديثات الخط الزمني/المراحل — توصل المشرف المسؤول عن نطاق العمل (نفس منطق getResponsibleAdminIds
//      بـcron.js: تخصيص مستودع/دائرة محدد، وإلا كل الإداريين المفتوحين بدون تخصيص)، بالإضافة لأي رقم مراقبة
//      ثابت اختياري (WHATSAPP_JOB_WATCH_NUMBERS) — انظر resolveResponsibleAdminPhones + broadcast.
// فشل الإرسال هنا لا يوقف ولا يغيّر نتيجة عملية التحديث/الإدراج الأساسية أبدًا (كل نداء محاط بـ.catch بالمستدعي).
import "dotenv/config";
import { pool } from "./db.js";
import { sendWhatsAppText, sendWhatsAppMediaUrl, isWhatsAppConfigured, sendViaBackupBot, sendMediaViaBackupBot } from "./whatsapp.js";
import { generateJobPdfBuffer, generateJobQualityPdfBuffer, generateEquipmentReplacementPdfBuffer } from "./jobPdf.js";
import { writePublicFile } from "./storage.js";
import { resolveDivisionForSection, OWNER_EMPLOYEE_ID } from "./scope.js";
import { fmtKsaDateTime } from "./ksaTime.js";

const fmt = fmtKsaDateTime; // بتوقيت السعودية دايمًا — انظر تعليق ksaTime.js (خلل حقيقي كان يعرض توقيت UTC الخام)
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
  // المالك (OWNER_EMPLOYEE_ID) مستثنى دائمًا من مجموعة "الإداريين" هنا — عنده صف users عادي بدور admin
  // ورقم جوال، فكان يُحسَب ضمن "المفتوحين بدون تخصيص" (openAdmins) ويستلم أي إشعار غير مطابق لأي تخصيص
  // بالنظام كامل بصمت، رغم إنه المالك لا مشرف عادي. بلاغ حقيقي من المالك 2026-09-13: "اسند مهام ليه جاو
  // لي الرسائل على رقمي الخاص؟" — جذر المشكلة إنه ما له أي صف تخصيص (warehouse_assignments) إطلاقًا.
  const [admins] = await pool.query(
    "SELECT id, phone FROM users WHERE role IN ('admin','section_head','manager','operator') AND phone IS NOT NULL AND phone <> '' AND employee_id <> ?",
    [OWNER_EMPLOYEE_ID]
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

  // أولوية للأخص أولاً — مستودع/قسم محدد يطغى على مدير الدائرة الكاملة، بدل ما يستلمون كل واحد كل رسالة معًا.
  // مدير الدائرة يوصله بس لو محد مخصص بالتحديد على هذا المستودع/القسم (تصعيد ضمني)، مو مع كل رسالة روتينية
  // حتى لو فيه رئيس قسم مخصص أصلاً — اكتُشف كـبلاغ مستخدم حقيقي يوم 2026-09-11 (مدير الدائرة يستلم كل شي)
  // لو التخصيص الدقيق موجود لكن ما طابق أي مشرف حقيقي (شخص غير إداري بالغلط، أو إداري بلا رقم مسجَّل) —
  // نتصعّد لمدير الدائرة ثم المفتوحين بدل ما نرجّع قائمة فاضية بصمت (بلاغ حقيقي ثانٍ بنفس اليوم: تخصيص
  // خاطئ لموظف عادي على قسم MCE كان يمنع وصول أي رسالة لسعد الخميس/محمد صلاح كمديرَي الدائرة كاملةً)
  const narrowIds = new Set([...whAssignments, ...secAssignments].map((a) => a.user_id));
  if (narrowIds.size > 0) {
    const narrowAdmins = admins.filter((u) => narrowIds.has(u.id)).map((u) => u.phone);
    if (narrowAdmins.length > 0) return narrowAdmins;
  }
  const divIds = new Set(divAssignments.map((a) => a.user_id));
  if (divIds.size > 0) {
    const divAdmins = admins.filter((u) => divIds.has(u.id)).map((u) => u.phone);
    if (divAdmins.length > 0) return divAdmins;
  }
  return openAdmins();
}

// تفضيلات إشعارات مخصّصة لكل قسم/مشروع (job_notification_prefs) — تحديد صريح لكل شخص أي نوع محتوى يستلمه.
// إضافي بالكامل: قسم بدون أي صف هنا يرجّع null (يعني "غير مهيّأ")، فيستمر resolveJobTargets بالسلوك القديم
// تمامًا كما كان. قسم مهيّأ فعليًا (ولو بشخص واحد) يرجّع القائمة الدقيقة (وقد تكون [] لو محد مفعّل هذا النوع
// بالذات — قرار المالك الصريح يُحترم ولا نرجع للسلوك الافتراضي بالخطأ).
const NOTIFICATION_CONTENT_TYPES = new Set([
  "stage_updates", "job_created", "job_received", "job_cancelled",
  "final_report", "completion_pdf", "quality_execution_pdf", "quality_attachment_pdf", "material_request", "escalation",
  "equipment_replacement",
]);
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

// تفضيلات صريحة مضبوطة على أي قسم "أعلى" (سلسلة parent_section_id) من قسم العمل نفسه — تُضاف دائمًا
// إضافيًا (بجانب أي مسار: تفضيل القسم نفسه أو الخوارزمية الديناميكية)، بلا استثناء أو إلغاء لأي مسار
// تاني. طلب صريح من المالك 2026-09-13: رئيس قسم "انشاءات شرق الاحساء" (عبدالله الدغيش) ضبط تفضيلاته
// بمستوى قسمه العام، وتوقّع تلقائيًا يستلم نفس النوع من كل عمل تحت أي مجموعة فرعية منه (زي "مشاريع
// الإيصال")، لا بس أعمال مسجّلة على قسمه بالضبط — "أبي المسارات احترافية عالمية خالية من الأخطاء".
// مهم: عمدًا لا نلمس منطق getSectionContentRecipients نفسه (تفضيل القسم بالضبط يبقى بنفس سلوكه القديم
// الحصري) — هذي دالة منفصلة تمامًا، إضافية فقط، لتفادي أي أثر جانبي على سلوك موجود مُختبر.
async function resolveAncestorPrefPhones(sectionId, contentType) {
  if (!sectionId || !NOTIFICATION_CONTENT_TYPES.has(contentType)) return [];
  const phones = [];
  const [[row]] = await pool.query("SELECT parent_section_id FROM sections WHERE id = ?", [sectionId]);
  let current = row?.parent_section_id || null;
  for (let i = 0; i < 5 && current; i++) {
    const [rows] = await pool.query(
      `SELECT jnp.${contentType} AS enabled, u.phone FROM job_notification_prefs jnp
       JOIN users u ON u.id = jnp.user_id WHERE jnp.section_id = ?`,
      [current]
    );
    rows.filter((r) => r.enabled && r.phone).forEach((r) => phones.push(r.phone));
    const [[parentRow]] = await pool.query("SELECT parent_section_id FROM sections WHERE id = ?", [current]);
    current = parentRow?.parent_section_id || null;
  }
  return phones;
}

// أرقام/قروب وجهة رسائل الخط الزمني لعمل معيّن:
//   - قروب واتساب (sections.whatsapp_group_id فالأخص، وإلا warehouses.whatsapp_group_id) يُضاف *دايمًا*
//     لو مضبوط — بجانب أي مسار تحت، مو بديل عنه (تعديل 2026-09-11: قبل كذا كان تفعيل تفضيل مخصص يلغي
//     القروب بالكامل؛ المالك أكّد صراحة يبيه دايمًا مع رئيس القسم/المشرف المحدد، بالإضافة له لا بدلًا عنه)
//   - الأفراد: تفضيلات القسم المخصّصة (job_notification_prefs) لو مهيّأة فعليًا لهذا القسم تطغى على
//     الخوارزمية الديناميكية تحتها؛ وإلا المشرف المسؤول عن النطاق فرديًا (نفس منطق getResponsibleAdminIds بـcron.js)
// + رقم المراقبة الثابت الاختياري (WHATSAPP_JOB_WATCH_NUMBERS) يُضاف بكل الحالات
// contentType: نوع المحتوى (لتفضيلات القسم فقط) — افتراضيًا "stage_updates" لتحديثات الخط الزمني العادية
// مؤقت (طلب صريح من المالك يوم 2026-09-11، أثناء اختبار "Work Flow" المستودعات الثلاثة): ما نرسل لأي
// مشرف فردي بهالمستودعات لحد ما يحدد بنفسه بالضبط مين يستلم (عبر job_notification_prefs) — بس القروب
// المرتبط يستمر يستلم عادي. احذف هذا الاستثناء لما يهيّئ التفضيلات الفعلية لهذي الأقسام.
// "قسم الإنشاءات" أُزيل من هذا الاستثناء 2026-09-13 — صار فيه أشخاص حقيقيون معيّنون فعليًا على أقسامه
// الفرعية (أحمد الفضل على مشاريع الإيصال، طلال العيسى على مشاريع التحسين، سلمان الصقر...)، فكان الاستثناء
// المؤقت يمنع وصولهم أي رسالة فردية بصمت رغم تخصيصهم الصحيح (بلاغ حقيقي: أحمد الفضل ما توصله رسائل
// قسمه رغم تخصيصه الظاهر بالتطبيق — خطأ كنت أكّدت خطأً إنه بيوصله قبل التحقق الفعلي من الكود).
const TEMP_NO_INDIVIDUAL_NOTIFY_WAREHOUSES = new Set([
  "b98f92b0-0d55-4786-921c-593b33c32b51", // قسم المنيزلة
  "dad2c603-b71d-4bb8-899c-3bc651e1917a", // قسم الشبكة (الهفوف)
]);

// تغطية إضافية للموظف المنفّذ نفسه — منفصلة تمامًا عن قسم/دائرة العمل نفسه. أولوية لقروب/قروبات صريحة
// يختارها المالك/المشرف من بطاقة الموظف (employee_notification_groups — طلب صريح من المالك 2026-09-13:
// "أقدر أحدد من بطاقة الموظف إذا بيها خاص أو على قروب محدد")؛ لو ما فيه أي تحديد صريح، نرجع للسلوك
// الافتراضي القديم (مسؤول دائرة الموظف نفسه — users.warehouse_id) اللي أُضيف أصلًا لأقسام "تنفيذية عابرة
// للدوائر" زي PDC (DESINTECK/MCE): موظفوها ينفّذون أعمال دوائر تانية كاملة (طلب المالك 2026-09-12: "رئيس
// قسم PDC يوصله كل عمل لأي موظف PDC أينما كان"). يرجع [] لو نفس قسم العمل أصلًا (تفادي استعلام مكرر بلا فائدة).
async function resolveEmployeeOwnAdminPhones(employeeId, jobWarehouseId) {
  if (!employeeId) return [];
  const [groups] = await pool.query("SELECT whatsapp_group_id FROM employee_notification_groups WHERE user_id = ?", [employeeId]);
  if (groups.length) return groups.map((g) => g.whatsapp_group_id);
  const [[emp]] = await pool.query("SELECT warehouse_id FROM users WHERE id = ?", [employeeId]);
  if (!emp?.warehouse_id || emp.warehouse_id === jobWarehouseId) return [];
  return resolveResponsibleAdminPhones(emp.warehouse_id, null);
}

// أولوية للأخص — قروب مجموعة العمل (sections.whatsapp_group_id) لو مضبوط يطغى على قروب القسم كامل
// (warehouses.whatsapp_group_id)، بدل ما تضطر كل مجموعات القسم تشترك بقروب واحد عام (طلب صريح من
// المالك 2026-09-11: قروب واتساب حقيقي مخصص لمجموعة "الخطوط الهوائية" وحدها، منفصل عن قروب قسم المنيزلة)
// contentType (اختياري): لو مضبوط، يتحقق من تفضيلات القروب نفسه (whatsapp_groups) لهذا النوع بالذات —
// طلب صريح من المالك 2026-09-13: "ابي تعديل انه حتى القروب أحدد وش يوصل له من الرسائل". أعمدة الجدول
// كلها DEFAULT 1 (تستلم كل شي)، فقروب غير مسجَّل بالسجل المرجعي أصلاً (نادر) أو بدون أي تعديل يستمر
// بالسلوك القديم كاملاً؛ القمع صريح بس لو الشخص عطّل هذا النوع بالذات لهذا القروب تحديدًا.
async function resolveJobGroupId(warehouseId, sectionId, contentType = null) {
  let jid = null;
  if (sectionId) {
    const [[sec]] = await pool.query("SELECT whatsapp_group_id FROM sections WHERE id = ?", [sectionId]);
    if (sec?.whatsapp_group_id) jid = sec.whatsapp_group_id;
  }
  if (!jid && warehouseId) {
    const [[wh]] = await pool.query("SELECT whatsapp_group_id FROM warehouses WHERE id = ?", [warehouseId]);
    if (wh?.whatsapp_group_id) jid = wh.whatsapp_group_id;
  }
  if (!jid) return null;
  if (contentType && NOTIFICATION_CONTENT_TYPES.has(contentType)) {
    const [[g]] = await pool.query(`SELECT ${contentType} AS allowed FROM whatsapp_groups WHERE jid = ?`, [jid]);
    if (g && !g.allowed) return null;
  }
  return jid;
}

async function resolveJobTargets(warehouseId, sectionId = null, contentType = "stage_updates", employeeId = null) {
  const watchers = await watchNumbers();
  const employeeOwnAdmins = await resolveEmployeeOwnAdminPhones(employeeId, warehouseId);
  const groupId = await resolveJobGroupId(warehouseId, sectionId, contentType);
  // تفضيلات أي قسم "أعلى" بسلسلة parent_section_id (رئيس قسم مجموعة عامة ضبط تفضيلاته على مستوى قسمه
  // الكامل) — تُضاف دائمًا إضافيًا لأي مسار تحت، بلا استثناء (انظر resolveAncestorPrefPhones فوق).
  const ancestorPrefPhones = await resolveAncestorPrefPhones(sectionId, contentType);
  // القروب يُضاف دايمًا بجانب أي مسار — حتى مسار التفضيل المخصص (job_notification_prefs) — تعديل صريح
  // من المالك 2026-09-11: "بالإضافة إلى الرسائل اللي توصل لرئيس القسم" — قبل هذا كان تفعيل تفضيل مخصص
  // لقسم/مجموعة يستبعد قروبها بالكامل (استبدال، مو إضافة)؛ الآن القروب دايمًا مع القائمة المحددة، مو بديل عنها.
  const prefPhones = await getSectionContentRecipients(sectionId, contentType);
  if (prefPhones !== null) return [...new Set([...(groupId ? [groupId] : []), ...prefPhones, ...employeeOwnAdmins, ...ancestorPrefPhones, ...watchers])];

  const suppressIndividual = warehouseId && TEMP_NO_INDIVIDUAL_NOTIFY_WAREHOUSES.has(warehouseId);
  const dynamic = suppressIndividual ? [] : await resolveResponsibleAdminPhones(warehouseId || null, sectionId || null);
  return [...new Set([...(groupId ? [groupId] : []), ...dynamic, ...employeeOwnAdmins, ...ancestorPrefPhones, ...watchers])];
}

// معرّف قروب واتساب (Baileys/Hermosa) شكله دايمًا "<أرقام>@g.us" — التمييز بين قروب وفرد لتوجيه القناة الصح
function isGroupJid(target) {
  return typeof target === "string" && target.endsWith("@g.us");
}

// إرسال مرفق (PDF) لقائمة أهداف مختلطة (أفراد + قروبات) — نفس تفرقة broadcastToJob تحت لكن للوسائط:
// قروبات عبر البوت الاحتياطي (sendMediaViaBackupBot)، أفراد عبر Hermosa (sendWhatsAppMediaUrl) كالمعتاد.
// إصلاح خلل حقيقي كان قائمًا سابقًا: sendWhatsAppMediaUrl تُستدعى لكل الأهداف بلا تفرقة، فأي مرفق موجَّه
// لقروب كان يفشل بصمت (رقم Hermosa مو عضو بقروبات العمل الفعلية) — نفس المنطق اللي طُبِّق على الرسائل
// النصية بـbroadcastToJob من قبل، الآن يشمل المرفقات كمان.
async function sendPdfToTargets(targets, url, caption, filename) {
  await Promise.allSettled(
    targets.map((t) => (isGroupJid(t) ? sendMediaViaBackupBot(t, url, caption, filename) : sendWhatsAppMediaUrl(t, url, caption)))
  );
}

async function broadcastToJob(text, job, contentType = "stage_updates") {
  if (!isWhatsAppConfigured()) return;
  const targets = await resolveJobTargets(job?.warehouse_id, job?.section_id, contentType, job?.employee_id);
  if (!targets.length) return;
  // القروبات تُرسَل عبر البوت الاحتياطي (Baileys) — رقم Hermosa الرئيسي مو عضو فيها فعليًا؛ الأفراد يستمرون
  // على Hermosa كالمعتاد. انظر تعليق sendViaBackupBot بـwhatsapp.js للتفاصيل الكاملة.
  await Promise.allSettled(targets.map((t) => (isGroupJid(t) ? sendViaBackupBot(t, text) : sendWhatsAppText(t, text))));
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

const ROLE_LABELS = { admin: "مشرف", section_head: "رئيس القسم", manager: "مدير", operator: "مشغل" };
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

// أسطر تفاصيل إضافية لأي رسالة عمل — رقم الإشعار/المقاول/الموقع/رقم المغذي/رقم المشروع، كل واحد يظهر
// بس لو معبّى فعليًا بالعمل (project_no تحديدًا خاص بقسم الإنشاءات، فارغ لغيره — يختفي تلقائيًا).
// طلب صريح من المالك 2026-09-12: رسائل الجدولة/الاستلام/الإلغاء/التذكير كانت مختصرة بالعنوان بس، بدون
// أي من هذي التفاصيل — بعكس رسالة تقرير الإغلاق (notifyJobCompletionReport) اللي كانت غنية بها أصلًا.
function jobDetailsLines(job) {
  return [
    job.notification_no ? `🔢 رقم الإشعار: ${job.notification_no}` : null,
    job.contractor_name ? `👷 المقاول: ${job.contractor_name}` : null,
    job.location ? `📍 الموقع: ${job.location}` : null,
    job.feeder_no ? `🔌 رقم المغذي: ${job.feeder_no}` : null,
    job.project_no ? `📁 رقم المشروع: ${job.project_no}` : null,
  ].filter(Boolean);
}

// اسم كل حقل توقيت بجدول scheduled_jobs → نص الإشعار المقابل له بنفس ترتيب المخطط. job_received_at مستثنى
// عمدًا من هذا الجدول (يُعامَل بمسار مستقل تمامًا بنوع محتوى "job_received" خاص به — انظر notifyJobStageChange)
const STAGE_LABELS = {
  arrived_at: "📍 وصل الموظف للموقع",
  contacted_operator_at: "☎️ تم التواصل مع المشغل",
  operator_arrived_at: "🚶 وصل المشغل للموقع",
  closing_contacted_operator_at: "☎️ تواصل مع المشغل (إغلاق)",
  closing_operator_arrived_at: "🚶 وصل المشغل (إغلاق)",
  power_restored_at: "⚡ تم إرجاع التيار",
};

// actorUserId: صاحب طلب الإنشاء الحالي (req.authUserId) — يظهر بإشعار "لك عمل مسند" كـ"أسندها: فلان"
// contentType "job_created" مستقل عن "stage_updates" العامة (طلب صريح من المالك 2026-09-11: رئيس القسم
// يبي يتحكم بإشعار "عمل جديد" لحاله، منفصل عن باقي تحديثات المراحل) — انظر NOTIFICATION_CONTENT_TYPES فوق
export async function notifyJobCreated(job, actorUserId) {
  if (!isWhatsAppConfigured()) return;
  const title = (job?.title || "عمل مجدول").slice(0, 60);
  const empName = await employeeName(job.employee_id);
  const notePrefix = job.schedule_note ? `⚠️ *${job.schedule_note}*\n\n` : "";
  const detailsSuffix = jobDetailsLines(job).map((l) => `\n${l}`).join("");
  await Promise.allSettled([
    broadcastToJob(`🆕 جدولة عمل جديد\n\n${notePrefix}📋 ${title}${empName ? `\n👤 ${empName}` : ""}${detailsSuffix}`, job, "job_created"),
    notifyEmployeeAssigned(job, actorUserId),
  ]);
}

// "استلام العمل" و"إلغاء العمل" يُرسَلان كل واحد برسالة مستقلة بنوع محتوى خاص فيه ("job_received"/"job_cancelled")
// — طلب صريح من المالك 2026-09-11 (رئيس القسم يبي يستلم هذي الأحداث بالذات بدون باقي ضجيج تحديثات المراحل).
// باقي التحديثات (وصول، تواصل مع المشغل، اكتمال، إعادة إسناد...) تستمر مجمَّعة برسالة واحدة "stage_updates" عامة
// كما كانت — لو أكثر من حدث بنفس التحديث (نادر) يوصل كل واحد برسالته المستقلة بدل دمجهم بسطر واحد.
export async function notifyJobStageChange(oldRow, newRow, actorUserId) {
  if (!isWhatsAppConfigured()) return;
  const title = (newRow.title || "عمل مجدول").slice(0, 60);
  const empName = await employeeName(newRow.employee_id);
  const detailsSuffix = jobDetailsLines(newRow).map((l) => `\n${l}`).join("");
  const footer = `\n\n📋 ${title}${empName ? `\n👤 ${empName}` : ""}${detailsSuffix}`;
  const lines = [];
  const tasks = [];

  for (const [field, label] of Object.entries(STAGE_LABELS)) {
    if (!oldRow[field] && newRow[field]) {
      // مرحلة "وصل الموظف" بالذات تحتاج اسمه الحقيقي بالسطر نفسه، مو بس بالتذييل — هو محور الحدث هنا
      lines.push(field === "arrived_at" && empName ? `📍 وصل ${empName} للموقع` : label);
    }
  }
  if (!oldRow.job_received_at && newRow.job_received_at) {
    tasks.push(broadcastToJob(`✅ تم استلام العمل${footer}`, newRow, "job_received"));
  }
  if (oldRow.status !== newRow.status) {
    if (newRow.status === "completed") lines.push("🏁 اكتمل العمل");
    if (newRow.status === "cancelled") {
      tasks.push(broadcastToJob(`❌ تم إلغاء العمل${newRow.cancel_reason ? " — *" + newRow.cancel_reason + "*" : ""}${footer}`, newRow, "job_cancelled"));
    }
  }
  if (oldRow.employee_id !== newRow.employee_id) lines.push(`🔁 أُعيد إسناد العمل${empName ? " إلى " + empName : ""}`);

  if (lines.length) tasks.push(broadcastToJob(`${lines.join("\n")}${footer}`, newRow));
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
  const nums = await resolveJobTargets(job.warehouse_id, job.section_id, "completion_pdf", job.employee_id);
  if (!nums.length) return;
  const buffer = await generateJobPdfBuffer(job.id);
  const filename = buildCompletionPdfFilename(job);
  const url = writePublicFile("job-reports", filename, buffer);
  await sendPdfToTargets(nums, url, "📄 تقرير العمل المكتمل", filename);
}

// PDF مستقل لألبوم "جودة التنفيذ" أو "جودة الإرفاق" — بزر يدوي من شاشة العمل (مو تلقائي عند الاكتمال).
// المستلمون: نفس منطق resolveJobTargets العادي (تفضيلات القسم لو مهيّأة لهذا النوع بالذات، وإلا المشرف
// المسؤول عن النطاق كالمعتاد) — يرجّع عدد الأرقام اللي أُرسل لها فعليًا، عشان الواجهة تعرف لو محد استلم شي.
export async function sendQualityPdf(job, kind) {
  if (!isWhatsAppConfigured()) return 0;
  const contentType = kind === "execution" ? "quality_execution_pdf" : "quality_attachment_pdf";
  const nums = await resolveJobTargets(job.warehouse_id, job.section_id, contentType, job.employee_id);
  if (!nums.length) return 0;
  const buffer = await generateJobQualityPdfBuffer(job.id, kind);
  const label = kind === "execution" ? "جودة التنفيذ" : "جودة الإرفاق";
  const notif = job.notification_no ? ` - ${sanitizeFilenamePart(job.notification_no)}` : "";
  const filename = `${(sanitizeFilenamePart(job.title) || "تقرير عمل")}${notif} - ${label}`.slice(0, 200) + ".pdf";
  const url = writePublicFile("job-reports", filename, buffer);
  await sendPdfToTargets(nums, url, `📄 ${label}`, filename);
  return nums.length;
}

// نص واتساب لسجل استبدال معدة — يطابق حرفيًا القالب اللي يستخدمه المستخدم فعليًا بالواقع (نفس
// buildErWhatsAppText بالفرونت)، بقيم حيّة من السجل نفسه دائمًا. ثابت بالعربي دائمًا بغض النظر عن لغة
// الواجهة (يُرسل لجهة خارجية ولازم يطابق الشكل المعتاد تمامًا).
function fmtDMY(isoDate) {
  if (!isoDate) return "";
  const [y, mo, d] = String(isoDate).split("-");
  if (!y || !mo || !d) return isoDate;
  return `${parseInt(d, 10)}/${parseInt(mo, 10)}/${y}`;
}
async function buildEquipmentReplacementText(er) {
  let whName = null;
  if (er.issuing_warehouse_id) {
    const [[wh]] = await pool.query("SELECT name FROM warehouses WHERE id = ?", [er.issuing_warehouse_id]);
    whName = wh?.name || null;
  }
  return [
    "♦️معلومات تغيير المعدات♦️",
    `▪️ رقم المعده :${er.equipment_no || ""}`,
    `▪️تاريخ العمل :${fmtDMY(er.work_date)}`,
    `▪️المقاول : ${er.contractor_name || ""}`,
    `▪️الموقع :  ${er.location || ""}`,
    `▪️ نوع المعدة :${er.equipment_type || ""}`,
    `▪️السبب :  ${er.reason || ""}`,
    `▪️الاشعار/المهمة : `,
    er.notification_no || "",
    `▪️رقم التاق : ${er.tag_no || ""}`,
    `▪️الاستشاري :  ${er.consultant_text || ""}`,
    `▪️الرقم التسلسلي القديم:`,
    er.old_serial_no || "",
    `▪️الرقم التسلسلي الجديد:`,
    er.new_serial_no || "",
    `▪️سنه الصنع  :${er.manufacture_year || ""}`,
    `▪️اسم الشركه المصنعه :  `,
    er.manufacturer_name || "",
    `▪️ جهة صرف المعدة : `,
    whName || "",
    `▪️جهد المعدة :  `,
    er.voltage_rating || "",
    // KVA/LV يظهران بس لمحولات PMT (نفس شرط ظهورهما بنموذج الإدخال) — طلب صريح من المالك 2026-09-13:
    // "لم يذكر الجهد LV" بعد ما لاحظ غيابه برسالة حقيقية، رغم وجوده أصلاً بملف الـPDF المرفق.
    ...(er.kva_rating ? [`▪️KVA :  `, er.kva_rating] : []),
    ...(er.lv_rating ? [`▪️LV :  `, er.lv_rating] : []),
  ].join("\n");
}

// إرسال تلقائي (نص + PDF) لسجل "استبدال معدة" مربوط بمهمة مجدولة — لقروب واتساب العمل نفسه (+ أي مستلمين
// مهيّئين ديناميكيًا لنطاقه)، فور حفظ السجل بالتطبيق، بدون أي زر مشاركة يدوي. طلب صريح من المالك 2026-09-13:
// "ابي اذا صار ربط مع مهمة عمل تربط كذلك في القروب المخصص للعمل نفسه بحيث ترسل المعلومات وملف PDF
// دايركت بدون تدخل احد". يُستدعى من routes/equipmentReplacements.js فور كل حفظ (إنشاء أو تعديل) للسجل
// طالما مربوط بمهمة — يعيد الإرسال بمعلومات محدّثة لو عدّل المستخدم شيء بعد الحفظ الأول، عمدًا (بدل تتبع
// "أول ربط فقط" بتعقيد إضافي بلا داعٍ حقيقي).
// المستلم هنا القروب المرتبط بمهمة العمل فقط — بلا أي إضافة (مو نفس resolveJobTargets العادي اللي يضيف
// مسؤول دائرة الموظف نفسه/المشرفين الديناميكيين). طلب صريح من المالك 2026-09-13 بعد ما لاحظ وصول معلومات
// استبدال المحول لرئيسَي دائرة PDC كمان (لأن الموظف المنفّذ تابعهم) — "المفروض تروح للقروب المحدد فقط".
export async function sendEquipmentReplacementPdf(er, job) {
  if (!isWhatsAppConfigured()) return 0;
  const groupId = await resolveJobGroupId(job.warehouse_id, job.section_id, "equipment_replacement");
  if (!groupId) return 0;
  const nums = [groupId];
  const [text, buffer] = await Promise.all([buildEquipmentReplacementText(er), generateEquipmentReplacementPdfBuffer(er.id)]);
  const filename = ([sanitizeFilenamePart("استبدال_معدة"), er.equipment_no, er.equipment_type, er.new_serial_no]
    .filter(Boolean).join("_").slice(0, 200) || "تقرير") + ".pdf";
  const url = writePublicFile("job-reports", filename, buffer);
  await Promise.allSettled(nums.map((n) => (isGroupJid(n) ? sendViaBackupBot(n, text) : sendWhatsAppText(n, text))));
  await sendPdfToTargets(nums, url, "📄 معلومات تغيير المعدات", filename);
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
    ...jobDetailsLines(job),
    `مضى عليه ${hoursElapsed} ساعة من الاستلام بدون اكتمال`,
    `استُلم: ${fmt(job.job_received_at)}`,
  ].filter(Boolean);
  await broadcastToJob(lines.join("\n"), job, "escalation");
}

// تذكير يوم العمل الفعلي — يُستدعى من cron.js (checkTodayJobs) صباح كل يوم لكل عمل مجدول لنفس اليوم
// (scheduled_date) وما زال شغّال (مو مكتمل/ملغى). طلب صريح من المالك 2026-09-11: يوصل الطرفين معًا —
// الموظف/الاستشاري المسند إليه العمل مباشرة (رسالة منفصلة على رقمه الشخصي، بغض النظر عن أي تفضيل)،
// والمشرف المسؤول عن النطاق (نفس مسار "job_created" — يخضع لنفس تفضيل "إسناد/جدولة عمل جديد" لو مفعّل)
export async function notifyJobDueToday(job) {
  if (!isWhatsAppConfigured()) return;
  const title = (job.title || "عمل مجدول").slice(0, 60);
  const empName = await employeeName(job.employee_id);
  const empPhone = await employeePhone(job.employee_id);
  const employeeLines = [
    `📅 *تذكير: لديك عمل مجدول اليوم*`,
    ``,
    `📋 ${title}`,
    ...jobDetailsLines(job),
    job.start_time ? `⏰ الوقت: ${job.start_time}${job.end_time ? " - " + job.end_time : ""}` : null,
  ].filter(Boolean);
  const detailsSuffix = jobDetailsLines(job).map((l) => `\n${l}`).join("");
  const tasks = [];
  if (empPhone) tasks.push(sendWhatsAppText(empPhone, employeeLines.join("\n")));
  tasks.push(broadcastToJob(`📅 *تذكير: عمل مجدول اليوم*\n\n📋 ${title}${empName ? `\n👤 ${empName}` : ""}${detailsSuffix}`, job, "job_created"));
  await Promise.allSettled(tasks);
}
