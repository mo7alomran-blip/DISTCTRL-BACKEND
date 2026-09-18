// نقطة الدخول — سيرفر Express يحل محل Supabase بالكامل (Auth + RLS + Storage + Realtime + RPC + Cron)
// حالة الإنجاز الحالية (تُحدَّث مع كل مرحلة من خطة الهجرة):
//   ✅ Auth (login/refresh)          — routes/login.js
//   ✅ الصلاحيات (RLS البديل)        — scope.js + policies.js (74 سياسة منقولة من pg_policies الحقيقية)
//   ✅ الـ٦ عمليات مخزون ذرية         — rpc/stock.js
//   ✅ راوت CRUD عام لكل الجداول      — routes/table.js (يقابل الـ١١٨ استدعاء supabase.from() بـApp.jsx)
//   ✅ إدارة مستخدمين إدارية          — routes/users-admin.js (admin-create/update-user, admin-set-password, admin-grant-login)
//   ✅ Storage (رفع ملفات محلي)      — storage.js (job-photos/product-images عامة، backups موثّقة)
//   ✅ Realtime (WebSocket)          — realtime.js (يقابل قناتي orders-realtime-admin وscheduled-jobs-realtime)
//   🟡 Cron (جزئي)                   — cron.js: check-overdue-jobs + daily-backup ✅، تقارير يومي/أسبوعي/شهري ⏳ (HTML كبير مؤجّل)
//   ✅ send-push                     — routes/push.js
//   ⏳ نقل البيانات من Postgres      — migrate-data.js لسه ما بدأ
//   ⚠️ اكتشاف مهم: App.jsx فيه ~12 نداء fetch() مباشر لروابط Supabase Edge Functions (login, admin-*, send-push,
//      daily-backup, reschedule-report, daily-report/periodic-report) بمعزل عن كائن supabase — طبقة التوافق
//      (src/supabase.js) ما تقدر تعترضها لأنها مو عبر .from()/.auth/.rpc(). لازم تعديل صريح (تبديل رابط فقط)
//      بكل موضع من الـ١٢ هذول — عكس افتراض الخطة الأصلية "App.jsx ما يتغيّر أبدًا". لسه ما تم.
import express from "express";
import cors from "cors";
import "dotenv/config";

import loginRouter from "./routes/login.js";
import passwordResetRouter from "./routes/passwordReset.js";
import tableRouter from "./routes/table.js";
import usersAdminRouter from "./routes/users-admin.js";
import reportsRouter from "./routes/reports.js";
import pushRouter from "./routes/push.js";
import jobActionsRouter from "./routes/jobActions.js";
import equipmentReplacementsRouter from "./routes/equipmentReplacements.js";
import violationActionsRouter from "./routes/violationActions.js";
import operationsRouter from "./routes/operations.js";
import { router as storageRouter, mountPublicBuckets } from "./storage.js";
import { initRealtime } from "./realtime.js";
import { startCronJobs } from "./cron.js";
import { requireAuth } from "./auth.js";
import * as stock from "./rpc/stock.js";

const app = express();

// FRONTEND_ORIGIN يقبل قيمة وحيدة أو عدة قيم مفصولة بفواصل (مهم لما يكون عندنا أكثر من دومين
// يشاور لنفس الباك اند — مثلاً رابط Vercel + الدومين المخصص + www)
// إصلاح أمني (فحص أمني 2026-09-18): كان .env ناقص/فاضي لهذا المتغيّر يفتح CORS لأي أصل بصمت تام —
// طبقة حماية إضافية تختفي بدون أي تنبيه. الآن يظهر تحذير صريح بالسجلات (بدون إيقاف السيرفر — احتياطًا
// لأي بيئة اختبار قديمة تعتمد على السلوك الافتراضي عمدًا) حتى ما يفوت هذا الإعداد على أحد.
if (!process.env.FRONTEND_ORIGIN) {
  console.warn("⚠️  FRONTEND_ORIGIN غير مضبوط بـ.env — CORS مفتوح لأي أصل (*). اضبطه بدومين الفرونت اند الحقيقي.");
}
const allowedOrigins = (process.env.FRONTEND_ORIGIN || "*").split(",").map((o) => o.trim()).filter(Boolean);
app.use(cors({
  origin: allowedOrigins.includes("*") ? "*" : allowedOrigins,
  // Content-Disposition مو من الهيدرز المفضوحة تلقائيًا بـCORS — بدون هذا، fetch() بالفرونت (مشاركة PDF
  // كملف حقيقي عبر Web Share API) ما يقدر يقرأ اسم الملف من الرد فيرجع لاسم عام دايمًا رغم وصول الهيدر فعليًا
  exposedHeaders: ["Content-Disposition"],
}));
app.use(express.json({ limit: "2mb" }));

app.get("/api/health", (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.use("/api", loginRouter);
app.use("/api", passwordResetRouter);
app.use("/api", tableRouter);
app.use("/api", usersAdminRouter);
app.use("/api", storageRouter);
app.use("/api", reportsRouter);
app.use("/api", pushRouter);
app.use("/api", jobActionsRouter);
app.use("/api", equipmentReplacementsRouter);
app.use("/api", violationActionsRouter);
app.use("/api", operationsRouter);
mountPublicBuckets(app);

// يقابل supabase.rpc(name, params) — نفس أسماء الدوال الست بالضبط، حتى طبقة التوافق بالفرونت
// تقدر تمرر الاسم مباشرة بدون أي خريطة تحويل أسماء
const RPC_HANDLERS = {
  reserve_job_materials_stock: (authUser, p) => stock.reserveJobMaterialsStock(authUser, p.p_items),
  restore_unused_job_materials: (authUser, p) => stock.restoreUnusedJobMaterials(authUser, p.p_job_id),
  dispense_order_stock: (authUser, p) => stock.dispenseOrderStock(authUser, p.p_order_id),
  reserve_transfer_stock: (authUser, p) => stock.reserveTransferStock(authUser, p.p_items, p.p_from_warehouse_id),
  receive_transfer_stock: (authUser, p) => stock.receiveTransferStock(authUser, p.p_transfer_id),
  restore_transfer_stock: (authUser, p) => stock.restoreTransferStock(authUser, p.p_transfer_id),
};

app.post("/api/rpc/:name", requireAuth, async (req, res) => {
  const handler = RPC_HANDLERS[req.params.name];
  if (!handler) return res.status(404).json({ error: "unknown_rpc" });
  try {
    const authUser = { sub: req.authUserId, role: req.authRole, employee_id: req.authEmployeeId };
    const result = await handler(authUser, req.body || {});
    res.json(result);
  } catch (err) {
    const code = err.code || String(err.message || err);
    const status = code === "forbidden" ? 403 : code.startsWith("insufficient_stock") || code.endsWith("_not_found") ? 400 : 500;
    res.status(status).json({ error: code });
  }
});

// TODO (المرحلة ٢ القادمة): ترجمة daily-reportsupabase + periodic-report (تقارير HTML يومي/أسبوعي/شهري) داخل cron.js
// TODO: migrate-data.js (نقل بيانات التجريبي الفعلية من Postgres لـMySQL محلي — المرحلة ٤)
// TODO: src/supabase.js — طبقة التوافق بالفرونت (المرحلة ٣) — هذا الباك اند كامل بانتظارها لأي اختبار حقيقي من طرف لطرف

const PORT = process.env.PORT || 3001;
const server = app.listen(PORT, () => console.log(`DistOps server listening on :${PORT}`));
initRealtime(server); // WebSocket على نفس المنفذ، مسار /api/realtime
startCronJobs();
