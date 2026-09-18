// المهام المجدولة — تحل محل pg_cron + الدوال المستقلة (check-overdue-jobs, daily-backup, report-*).
// جداول pg_cron الفعلية بالتجريبي وقت الاستخراج (2026-08-28)، كل الأوقات UTC:
//   check-overdue-jobs-daily  "0 5 * * *"   ✅ ثابتة (ما فيها إعداد ديناميكي بالواجهة أصلاً)
//   daily-backup-job          "0 2 * * *"   ✅ ثابتة (نفس الشي)
//   report-daily/weekly/monthly ✅ ديناميكية — تُقرأ من جدول report_schedules عند إقلاع السيرفر
//     (تمامًا متل reschedule_report_internal الأصلية: تحويل الساعة من توقيت السعودية (المخزّن بالجدول)
//     إلى UTC، ثم تُعاد جدولتها حيّة عبر rescheduleReportCron() لما المالك يغيّر الوقت من الواجهة)
import cron from "node-cron";
import webpush from "web-push";
import * as XLSX from "xlsx";
import { pool } from "./db.js";
import { sendDailyReport, sendPeriodicReport } from "./reportEmails.js";
import { notifyJobDelayed, notifyJobDueToday } from "./jobNotifications.js";
import { sendWebPushToSubs } from "./pushSend.js";
import { getWhatsAppLiveStatus, startWhatsAppSession, isWhatsAppConfigured } from "./whatsapp.js";
import { recordHealthCheck } from "./systemHealth.js";
import { todayKsaISO } from "./ksaTime.js";
import { OWNER_EMPLOYEE_ID } from "./scope.js";
import "dotenv/config";

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT || "mailto:mo7.alomran@gmail.com",
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// ── check-overdue-jobs: منقولة بالحرف — منطق أبسط من in_my_scope العام (مستودع/دائرة فقط، بدون مستوى قسم فرعي،
// لأن scheduled_jobs ما فيها section_id إطلاقًا بالأساس) ──
async function getResponsibleAdminIds(warehouseId, assignments, users, warehouses) {
  const assignedUserIds = new Set(assignments.map((a) => a.user_id));
  const openAdmins = () => users.filter((u) => ["admin", "section_head", "manager", "operator"].includes(u.role) && !assignedUserIds.has(u.id)).map((u) => u.id);
  if (!warehouseId) return openAdmins();
  const division = warehouses.find((w) => w.id === warehouseId)?.division_id ?? null;
  const warehouseAssignments = assignments.filter((a) => a.warehouse_id === warehouseId && !a.section_id && !a.division_id);
  const divisionAssignments = assignments.filter((a) => a.division_id && a.division_id === division);
  // أولوية للأخص — مستودع محدد يطغى على مدير الدائرة الكاملة (نفس إصلاح resolveResponsibleAdminPhones
  // بـjobNotifications.js يوم 2026-09-11، انظر تعليقها فيه للتفصيل الكامل). لو التخصيص الدقيق موجود لكن
  // ما طابق أي مشرف حقيقي (تخصيص خاطئ لموظف عادي مثلاً) نتصعّد بدل ما نرجّع فاضي بصمت — نفس الإصلاح.
  const adminRoleIds = new Set(users.filter((u) => ["admin", "section_head", "manager", "operator"].includes(u.role)).map((u) => u.id));
  const warehouseIds = [...new Set(warehouseAssignments.map((a) => a.user_id))].filter((id) => adminRoleIds.has(id));
  if (warehouseIds.length > 0) return warehouseIds;
  const divisionIds = [...new Set(divisionAssignments.map((a) => a.user_id))].filter((id) => adminRoleIds.has(id));
  if (divisionIds.length > 0) return divisionIds;
  return openAdmins();
}

export async function checkOverdueJobs() {
  const today = todayKsaISO(); // بتوقيت السعودية — UTC كان يعطي تاريخ يوم سابق بين 00:00-03:00 محليًا
  const [jobs] = await pool.query(
    `SELECT id, title, warehouse_id, scheduled_date FROM scheduled_jobs
     WHERE status = 'in_progress' AND job_received_at IS NULL
       AND (scheduled_date IS NULL OR scheduled_date < ?)`,
    [today]
  );
  if (!jobs.length) return { success: true, checked: 0, sent: 0 };

  const [[assignments], [users], [warehouses], [subs]] = await Promise.all([
    pool.query("SELECT * FROM warehouse_assignments"),
    // المالك مستثنى دائمًا — نفس إصلاح resolveResponsibleAdminPhones بـjobNotifications.js 2026-09-13
    pool.query("SELECT id, role FROM users WHERE employee_id <> ?", [OWNER_EMPLOYEE_ID]),
    pool.query("SELECT id, division_id FROM warehouses"),
    pool.query("SELECT id, user_id, endpoint, p256dh, auth_key FROM push_subscriptions"),
  ]);

  const subsByUser = {};
  subs.forEach((s) => { (subsByUser[s.user_id] ||= []).push(s); });

  let sent = 0;
  for (const job of jobs) {
    const recipientIds = await getResponsibleAdminIds(job.warehouse_id, assignments, users, warehouses);
    const jobSubs = recipientIds.flatMap((uid) => subsByUser[uid] || []);
    const payload = JSON.stringify({ title: "عمل متأخر بحاجة لإعادة جدولة", body: job.title || "", url: "/", tag: `job-overdue-${job.id}` });
    // sendWebPushToSubs (pushSend.js) ينظّف الاشتراكات المنتهية ويسجّل أي خطأ منهجي حقيقي بـsystemHealth.js
    const { sent: s } = await sendWebPushToSubs(jobSubs, payload);
    sent += s;
  }
  return { success: true, checked: jobs.length, sent };
}

// ── checkDelayedJobs: تنبيه واتساب "عمل متأخر" — عمل استُلم (job_received_at) من أكثر من N ساعة
// (WHATSAPP_OVERDUE_HOURS، افتراضي 5) بدون ما يوصل حالة "مكتمل". مرة وحدة بالضبط لكل عمل — overdue_alert_sent_at
// يمنع التكرار. جدول جديد كليًا (لا علاقة له بـcheck-overdue-jobs الأصلية اللي تخص أعمال ما استُلمت أصلاً) ──
export async function checkDelayedJobs() {
  const hours = Number(process.env.WHATSAPP_OVERDUE_HOURS || 5);
  const [jobs] = await pool.query(
    `SELECT * FROM scheduled_jobs
     WHERE job_received_at IS NOT NULL AND status = 'in_progress' AND overdue_alert_sent_at IS NULL
       AND job_received_at <= DATE_SUB(NOW(), INTERVAL ? HOUR)`,
    [hours]
  );
  for (const job of jobs) {
    const hoursElapsed = Math.floor((Date.now() - new Date(job.job_received_at).getTime()) / 3600000);
    try {
      await notifyJobDelayed(job, hoursElapsed);
      await pool.query("UPDATE scheduled_jobs SET overdue_alert_sent_at = NOW() WHERE id = ?", [job.id]);
    } catch (e) {
      console.error("checkDelayedJobs notify failed for", job.id, ":", e.message || e);
    }
  }
  return { success: true, checked: jobs.length };
}

// ── checkTodayJobs: تذكير صباحي بكل عمل مجدول لنفس اليوم (طلب صريح من المالك 2026-09-11) — يوصل الموظف
// المسند إليه العمل مباشرة + المشرف المسؤول عن النطاق معًا، لكل عمل لسه شغّال (مو مكتمل/ملغى). كل عمل
// يُذكَّر به مرة وحدة بالضبط (يوم scheduled_date نفسه فقط — ما يتكرر باليوم اللي بعده حتى لو لسه مو مكتمل) ──
export async function checkTodayJobs() {
  const today = todayKsaISO();
  const [jobs] = await pool.query(
    "SELECT * FROM scheduled_jobs WHERE scheduled_date = ? AND status NOT IN ('completed','cancelled')",
    [today]
  );
  for (const job of jobs) {
    try {
      await notifyJobDueToday(job);
    } catch (e) {
      console.error("checkTodayJobs notify failed for", job.id, ":", e.message || e);
    }
  }
  return { success: true, checked: jobs.length };
}

// ── checkWhatsAppHealth: اكتُشف يوم 2026-09-10 أن جلسة واتساب انقطعت 4 أيام كاملة بدون أي تنبيه —
// GET /api/sessions/:id (getWhatsAppSessionStatus) يرجّع "ready" مخزّن/متأخر حتى لو الجلسة فعليًا منقطعة؛
// getWhatsAppLiveStatus (عبر /qr) هي الحالة الحقيقية اللحظية. لو منقطعة: يحاول إعادة تشغيلها تلقائيًا أول
// (نفس اللي رجّعها يدويًا بدون QR جديد ذاك اليوم) قبل ما يعتبرها "down" فعليًا ويبلّغ المالك.
export async function checkWhatsAppHealth() {
  if (!isWhatsAppConfigured()) return { success: true, skipped: "not_configured" };
  let live = await getWhatsAppLiveStatus();
  if (live.live !== "ready") {
    await startWhatsAppSession().catch(() => {});
    await new Promise((r) => setTimeout(r, 5000));
    live = await getWhatsAppLiveStatus();
  }
  const ok = live.live === "ready";
  await recordHealthCheck("whatsapp", ok, ok ? null : `status: ${live.live}`);
  return { success: true, ok, status: live.live };
}

// ── daily-backup: منقولة بالحرف (نفس الجداول والأعمدة)، الرفع لملف محلي بدل Supabase Storage ──
import fs from "fs";
import path from "path";

const BACKUP_TABLES = [
  { name: "المستخدمون", table: "users", cols: "id,name,employee_id,role,warehouse_id,is_active,created_at" },
  { name: "الدوائر", table: "divisions", cols: "*" },
  { name: "الأقسام_التجميعية", table: "departments", cols: "*" },
  { name: "المستودعات", table: "warehouses", cols: "*" },
  { name: "مجموعات_العمل", table: "sections", cols: "*" },
  { name: "المواد", table: "products", cols: "*" },
  { name: "الطلبات", table: "orders", cols: "*" },
  { name: "تخصيصات_المشرفين", table: "warehouse_assignments", cols: "*" },
  { name: "نطاق_الموظفين", table: "user_scopes", cols: "*" },
  { name: "مستلمو_التقارير", table: "report_recipients", cols: "*" },
  { name: "جدولة_التقارير", table: "report_schedules", cols: "*" },
];

function flattenForSheet(rows) {
  return rows.map((row) => {
    const flat = {};
    for (const [k, v] of Object.entries(row)) {
      flat[k] = v !== null && typeof v === "object" ? JSON.stringify(v) : v;
    }
    return flat;
  });
}

export async function dailyBackup() {
  const workbook = XLSX.utils.book_new();
  for (const t of BACKUP_TABLES) {
    const cols = t.cols === "*" ? "*" : t.cols.split(",").map((c) => `\`${c}\``).join(",");
    const [rows] = await pool.query(`SELECT ${cols} FROM \`${t.table}\``);
    const sheet = XLSX.utils.json_to_sheet(flattenForSheet(rows));
    XLSX.utils.book_append_sheet(workbook, sheet, t.name.slice(0, 31));
  }

  const todayShort = todayKsaISO(); // بتوقيت السعودية — نفس سبب checkOverdueJobs فوق
  const fileName = `backup-${todayShort}.xlsx`;
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

  const backupsDir = path.resolve(process.env.UPLOADS_DIR || "./uploads", "backups");
  fs.mkdirSync(backupsDir, { recursive: true });
  fs.writeFileSync(path.join(backupsDir, fileName), buffer);

  // تنظيف النسخ الأقدم من أسبوع — نفس منطق الأصل بالحرف
  let deletedCount = 0;
  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);
    const files = fs.readdirSync(backupsDir);
    for (const f of files) {
      const m = f.match(/^backup-(\d{4}-\d{2}-\d{2})\.xlsx$/);
      if (m && new Date(`${m[1]}T00:00:00Z`) < cutoff) {
        fs.unlinkSync(path.join(backupsDir, f));
        deletedCount++;
      }
    }
  } catch { /* تجاهل فشل التنظيف — النسخة الأساسية أهم وتم حفظها بنجاح بالفعل */ }

  const [[recipientRow]] = await pool.query(
    "SELECT email FROM report_recipients WHERE scope_type = 'org' AND report_type = 'daily' LIMIT 1"
  );
  const ownerEmail = recipientRow?.email;

  let emailed = false;
  if (ownerEmail && process.env.RESEND_API_KEY) {
    const base64Content = buffer.toString("base64");
    const emailRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "نسخ احتياطية <onboarding@resend.dev>",
        to: [ownerEmail],
        subject: `💾 نسخة احتياطية يومية — ${todayShort}`,
        html: `<div style="font-family:Arial,sans-serif;direction:rtl;">
          <p>مرفق ملف النسخة الاحتياطية الكاملة لبيانات نظام المستودعات ليوم ${todayShort}.</p>
          <p style="color:#94a3b8;font-size:12px;">رسالة تلقائية — لا حاجة للرد عليها.</p>
        </div>`,
        attachments: [{ filename: fileName, content: base64Content }],
      }),
    });
    emailed = emailRes.ok;
  }

  return { success: true, fileName, uploaded: true, emailed, ownerEmail: ownerEmail || null, deletedOldBackups: deletedCount };
}

// ── جدولة ديناميكية للتقارير — يطابق منطق reschedule_report_internal الأصلي بالحرف ──
// (تحويل الساعة من توقيت السعودية UTC+3 المخزَّن بـreport_schedules إلى UTC اللي يشتغل عليه cron)
const REPORT_SENDERS = {
  daily: () => sendDailyReport(),
  weekly: () => sendPeriodicReport("weekly"),
  monthly: () => sendPeriodicReport("monthly"),
};
const activeReportTasks = new Map(); // report_type -> node-cron ScheduledTask الحالية

function ksaHourMinuteToUtcCron(type, hour, minute, dayOfWeek, dayOfMonth) {
  const KSA_OFFSET = 3;
  const utcHour = ((hour - KSA_OFFSET) + 24) % 24;
  const dayShifted = (hour - KSA_OFFSET) < 0;
  if (type === "daily") return `${minute} ${utcHour} * * *`;
  if (type === "weekly") {
    const dow = dayShifted ? (((dayOfWeek ?? 0) - 1 + 7) % 7) : (dayOfWeek ?? 0);
    return `${minute} ${utcHour} * * ${dow}`;
  }
  // monthly
  const dom = dayShifted ? Math.max(1, (dayOfMonth ?? 1) - 1) : (dayOfMonth ?? 1);
  return `${minute} ${utcHour} ${dom} * *`;
}

function scheduleReportTask(type, cronExpr) {
  const existing = activeReportTasks.get(type);
  if (existing) existing.stop();
  const task = cron.schedule(cronExpr, () => {
    REPORT_SENDERS[type]().catch((e) => console.error(`report-${type} failed:`, e));
  }, { timezone: "UTC" });
  activeReportTasks.set(type, task);
  console.log(`report-${type} scheduled: ${cronExpr} UTC`);
}

// يُستدعى من routes/reports.js لما المالك يغيّر وقت تقرير من الواجهة — يعيد الجدولة الحيّة + يحدّث الجدول
export async function rescheduleReportCron(type, hour, minute, dayOfWeek, dayOfMonth) {
  const cronExpr = ksaHourMinuteToUtcCron(type, hour, minute, dayOfWeek, dayOfMonth);
  scheduleReportTask(type, cronExpr);
  await pool.query(
    "UPDATE report_schedules SET hour = ?, minute = ?, day_of_week = ?, day_of_month = ?, updated_at = NOW() WHERE report_type = ?",
    [hour, minute, type === "weekly" ? (dayOfWeek ?? 0) : null, type === "monthly" ? (dayOfMonth ?? 1) : null, type]
  );
}

async function loadReportSchedulesAndStart() {
  const [rows] = await pool.query("SELECT report_type, hour, minute, day_of_week, day_of_month, enabled FROM report_schedules");
  for (const r of rows) {
    if (!r.enabled) continue;
    const cronExpr = ksaHourMinuteToUtcCron(r.report_type, r.hour, r.minute, r.day_of_week, r.day_of_month);
    scheduleReportTask(r.report_type, cronExpr);
  }
}

// وحدة "التشغيل" — إرسال رسائل التشغيل المجدولة (المشرف يختار وقت إرسال لاحق وقت الاستيراد من إكسل،
// بدل الإرسال الفوري). نمسح scheduled_send_at فورًا قبل محاولة الإرسال (نجاح أو فشل) حتى ما تُعاد
// المحاولة كل دقيقة للأبد لو فشلت — نفس مبدأ "لا تفقد سجل التشغيل" (فشل الإرسال مسجَّل بحاله وقابل لإعادة الإرسال يدويًا)
async function checkScheduledOperationMessages() {
  const [rows] = await pool.query(
    "SELECT * FROM operations WHERE scheduled_send_at IS NOT NULL AND scheduled_send_at <= UTC_TIMESTAMP(3) AND message_status != 'sent'"
  );
  if (!rows.length) return { success: true, checked: 0 };
  const { sendOperationMessage } = await import("./operationsWhatsapp.js");
  for (const op of rows) {
    await pool.query("UPDATE operations SET scheduled_send_at = NULL WHERE id = ?", [op.id]);
    await sendOperationMessage(op, null).catch((e) => console.error("scheduled sendOperationMessage failed:", e.message || e));
  }
  return { success: true, checked: rows.length };
}

export function startCronJobs() {
  cron.schedule("0 5 * * *", () => checkOverdueJobs().catch((e) => console.error("checkOverdueJobs failed:", e)), { timezone: "UTC" });
  cron.schedule("0 2 * * *", () => dailyBackup().catch((e) => console.error("dailyBackup failed:", e)), { timezone: "UTC" });
  cron.schedule("*/15 * * * *", () => checkDelayedJobs().catch((e) => console.error("checkDelayedJobs failed:", e)), { timezone: "UTC" });
  cron.schedule("*/15 * * * *", () => checkWhatsAppHealth().catch((e) => console.error("checkWhatsAppHealth failed:", e)), { timezone: "UTC" });
  cron.schedule("0 3 * * *", () => checkTodayJobs().catch((e) => console.error("checkTodayJobs failed:", e)), { timezone: "UTC" }); // 06:00 بتوقيت السعودية
  cron.schedule("* * * * *", () => checkScheduledOperationMessages().catch((e) => console.error("checkScheduledOperationMessages failed:", e)), { timezone: "UTC" });
  loadReportSchedulesAndStart().catch((e) => console.error("loadReportSchedulesAndStart failed:", e));
  console.log("Cron jobs started: check-overdue-jobs (05:00 UTC), daily-backup (02:00 UTC), check-delayed-jobs (كل 15 دقيقة), check-whatsapp-health (كل 15 دقيقة), check-today-jobs (03:00 UTC = 06:00 السعودية), check-scheduled-operation-messages (كل دقيقة), report-* (من report_schedules)");
}
