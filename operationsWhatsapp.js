// وحدة "التشغيل" — بناء نص رسالة واتساب لسجل تشغيل + إرسالها لقروب القسم المسؤول، بنفس فلسفة
// sendEquipmentReplacementPdf بـjobNotifications.js (قروب فقط، بدون تعقيد resolveJobTargets العام —
// عمدًا لتقليل مخاطر كسر مسار الإشعارات الحالي للأعمال العادية أثناء إضافة وحدة جديدة).
import { pool, genId } from "./db.js";
import { sendViaBackupBot, sendWhatsAppText } from "./whatsapp.js";

// DD.MM.YYYY بنقاط (مو شرطات مائلة) — يطابق حرفيًا شكل التاريخ بالرسالة الحقيقية اللي قدّمها المستخدم
// كمثال ("16.09.2026")، ونفس شكل عمود التاريخ بملف الإكسل المصدر نفسه
function fmtDMY(isoDate) {
  if (!isoDate) return "";
  const [y, mo, d] = String(isoDate).split("-");
  if (!y || !mo || !d) return isoDate;
  return `${d}.${mo}.${y}`;
}

// نص الرسالة يطابق حرفيًا الشكل الحقيقي الذي يرسله المستخدم فعليًا للقروب (مثال حي قدّمه بنفسه) —
// وليس الصياغة التقريبية الأولى؛ ثابت بالعربي دائمًا بغض النظر عن لغة الواجهة (يُرسل لجهة خارجية).
export function buildOperationMessage(op) {
  const names = Array.isArray(op.operator_names) ? op.operator_names.filter(Boolean) : [];
  const lines = [
    "*اسم المشغل* :",
    ...(names.length ? names : [""]),
    "",
    "*رقم الإشعار* :",
    op.notification_number || "",
    "",
    `*تاريخ الإشعار* ${fmtDMY(op.notification_date)}`,
    `*بداية الوقت* : ${op.start_time || ""}`,
    `*نهاية الوقت* : ${op.end_time || ""}`,
    `*الجهة المعنية*: ${op.client_entity || ""}`,
    "",
    `*موقع* : ${op.work_location || ""}`,
    `*عدد المشتركين* ${op.subscribers_count ?? ""}`,
    op.work_description || "",
  ];
  return lines.join("\n");
}

// المستهدف: قروب واتساب القسم فقط (sections.whatsapp_group_id) — بدون أي تعقيد إضافي (مو نفس
// resolveJobGroupId العام اللي يحمل ربطًا بجدول whatsapp_groups/أنواع محتوى غير ذات صلة بهذي الوحدة)
export async function resolveOperationGroupId(sectionId) {
  if (!sectionId) return null;
  const [[sec]] = await pool.query("SELECT whatsapp_group_id FROM sections WHERE id = ?", [sectionId]);
  return sec?.whatsapp_group_id || null;
}

// مشرفو قسم/دائرة التشغيل المسؤولون عن سجل تشغيل معيّن — تخصيص مباشر على القسم (section_id) أولًا،
// وإلا تخصيص على الدائرة كاملة (division_id) — نفس أولوية "الأخص أولاً" المستخدمة بباقي النظام
async function resolveOperationsSupervisors(op) {
  const [rows] = await pool.query(
    `SELECT DISTINCT u.id, u.phone FROM warehouse_assignments wa
     JOIN users u ON u.id = wa.user_id
     WHERE (wa.section_id = ? OR (wa.division_id = ? AND wa.section_id IS NULL))
       AND u.role IN ('admin','section_head','manager','operator') AND u.is_active = 1`,
    [op.section_id, op.division_id]
  );
  return rows;
}

// إشعار مشرفي القسم — داخل التطبيق (جدول notifications) + واتساب (قروب مخصّص للمشرف عبر
// employee_notification_groups لو مضبوط، وإلا رقمه الشخصي مباشرة). يُستدعى عند كل تغيير حالة
// (التايم لاين) وعند فشل إرسال رسالة التشغيل للمشغل تحديدًا — بند صريح من المالك.
export async function notifyOperationsSupervisors(op, event, details = {}) {
  const supervisors = await resolveOperationsSupervisors(op);
  if (!supervisors.length) return;

  const names = Array.isArray(op.operator_names) ? op.operator_names.join("، ") : "";
  let title, body;
  if (event === "status_changed") {
    title = "🔄 تحديث حالة تشغيل";
    body = `${names || op.notification_number}\nرقم الإشعار: ${op.notification_number}\nالحالة الجديدة: ${details.to || op.status}`;
  } else if (event === "message_failed") {
    title = "⚠️ فشل إرسال رسالة تشغيل";
    body = `${names || op.notification_number}\nرقم الإشعار: ${op.notification_number}\nالسبب: ${details.error || "غير معروف"}`;
  } else {
    return;
  }

  for (const sup of supervisors) {
    await pool.query(
      "INSERT INTO notifications (id, user_id, title, body, target_screen, target_id) VALUES (?, ?, ?, ?, 'operation_detail', ?)",
      [genId(), sup.id, title, body, op.id]
    );
    const [groups] = await pool.query("SELECT whatsapp_group_id FROM employee_notification_groups WHERE user_id = ?", [sup.id]);
    const waText = `*${title}*\n${body}`;
    if (groups.length) {
      await Promise.allSettled(groups.map((g) => sendViaBackupBot(g.whatsapp_group_id, waText)));
    } else if (sup.phone) {
      await sendWhatsAppText(sup.phone, waText);
    }
  }
}

export async function logOperationAction(operationId, action, details, performedBy) {
  await pool.query(
    "INSERT INTO operations_audit_log (id, operation_id, action, details, performed_by) VALUES (?, ?, ?, ?, ?)",
    [genId(), operationId, action, details ? JSON.stringify(details) : null, performedBy || null]
  );
}

// إرسال (أو إعادة إرسال) رسالة تشغيل لقروب القسم — يحدّث حالة الإرسال + يسجّل تدقيق بكل الحالات
// (نجاح/فشل/بدون قروب مضبوط)، حتى لا يُفقد أي سجل تشغيل بسبب فشل الإرسال (طلب صريح: "لا تفقد سجل التشغيل")
export async function sendOperationMessage(op, performedBy) {
  const groupId = await resolveOperationGroupId(op.section_id);
  if (!groupId) {
    await pool.query("UPDATE operations SET message_status = 'failed', message_error = ? WHERE id = ?", [
      "لا يوجد قروب واتساب مضبوط لهذا القسم",
      op.id,
    ]);
    await logOperationAction(op.id, "message_failed", { error: "no_group_configured" }, performedBy);
    await notifyOperationsSupervisors(op, "message_failed", { error: "لا يوجد قروب واتساب مضبوط لهذا القسم" }).catch(() => {});
    return { success: false, error: "no_group_configured" };
  }

  const text = buildOperationMessage(op);
  const result = await sendViaBackupBot(groupId, text);
  if (result.success) {
    await pool.query(
      "UPDATE operations SET message_text = ?, message_status = 'sent', message_sent_at = CURRENT_TIMESTAMP(3), message_error = NULL, whatsapp_group_id_used = ? WHERE id = ?",
      [text, groupId, op.id]
    );
    await logOperationAction(op.id, "message_sent", { group_id: groupId }, performedBy);
  } else {
    await pool.query("UPDATE operations SET message_text = ?, message_status = 'failed', message_error = ? WHERE id = ?", [
      text,
      result.error || "unknown_error",
      op.id,
    ]);
    await logOperationAction(op.id, "message_failed", { error: result.error }, performedBy);
    await notifyOperationsSupervisors(op, "message_failed", { error: result.error }).catch(() => {});
  }
  return result;
}

// ربط تلقائي بالاتجاه العكسي (بند 9 من الطلب): عمل مجدول جديد يُنشأ بنفس رقم إشعار سجل تشغيل غير
// مرتبط سابقًا — يُستدعى من routes/table.js فور إدراج scheduled_jobs جديد. فشل هنا لا يوقف إنشاء
// العمل أبدًا (المستدعي يستدعيها بـ.catch منفصل، نفس فلسفة notifyJobCreated).
export async function linkOperationToJob(job) {
  if (!job?.notification_no) return;
  const [rows] = await pool.query(
    "SELECT id FROM operations WHERE notification_number = ? AND linked_job_id IS NULL",
    [job.notification_no]
  );
  for (const row of rows) {
    await pool.query("UPDATE operations SET linked_job_id = ? WHERE id = ?", [job.id, row.id]);
    await logOperationAction(row.id, "linked", { job_id: job.id, direction: "job_created_after" }, null);
  }
}
