// طبقة الصلاحيات بديلة RLS — منقولة سياسة-بسياسة عن pg_policies الحقيقية
// (استُخرجت عبر SELECT * FROM pg_policies WHERE schemaname='public' بتاريخ 2026-08-28، 26 جدول، 74 سياسة).
//
// كل جدول عنده {select, insert, update, delete} — أي عملية غير موجودة هنا معناها القاعدة الأصلية
// ما كانت تسمح فيها إطلاقًا (RLS تمنع افتراضيًا أي عملية بدون سياسة صريحة لها)، فراوت الجدول العام
// (routes/table.js) يرفض تلقائيًا أي عملية ماهيش معرّفة بالجدول المقابل هنا.
//
// توقيع كل دالة:
//   select(authUser, scopeCtx, row)            -> هل يقدر يشوف هذا الصف؟
//   insert(authUser, scopeCtx, newRow)          -> هل يقدر يدرج هذا الصف؟ (يقابل with_check)
//   update(authUser, scopeCtx, oldRow, newRow)  -> يقابل USING(oldRow) + WITH CHECK(newRow) معًا
//   delete(authUser, scopeCtx, row)             -> يقابل USING بالحذف
//
// جداول ما فيها RLS إطلاقًا (وبالتالي غير موجودة هنا): login_attempts — يوصلها فقط login.js
// بصلاحية داخلية (يقابل استخدام service role key بالنسخة الأصلية)، مو عبر routes/table.js العام.
import { isOwner, isAdmin, isAdminOrViewer, inMyScopeSync } from "./scope.js";

const authed = (authUser) => !!authUser?.sub; // auth.uid() IS NOT NULL

// ── مساعد مشترك للجداول التابعة لعمل مجدول (job_images/job_materials/job_contractor_checks/job_isolation_notes) ──
// يحتاج صف scheduled_jobs المرتبط (job) جالب مسبقًا بالـroute قبل استدعاء هذي الدوال
// job.section_id يُمرَّر الآن كمان (كان null دايمًا سابقًا) — إضافي بحت: يفتح فرصة قبول جديدة عبر
// inMyScopeSync (مشرف مخصص فعليًا على قسم/مجموعة العمل، بدون warehouse_id) بدون ما يغيّر أي حالة قبول قديمة
function canWriteJobChild(authUser, scopeCtx, job) {
  if (!job) return false;
  return (
    isOwner(authUser) ||
    (isAdmin(authUser) && inMyScopeSync(scopeCtx, authUser, job.warehouse_id, job.section_id)) ||
    (job.employee_id === authUser.sub && job.status === "in_progress")
  );
}
function canSelectJobChild(authUser, scopeCtx, job) {
  if (!job) return false;
  return (
    isOwner(authUser) ||
    (isAdminOrViewer(authUser) && inMyScopeSync(scopeCtx, authUser, job.warehouse_id, job.section_id)) ||
    job.employee_id === authUser.sub
  );
}
export { canWriteJobChild, canSelectJobChild };

export const policies = {
  // ── contractors: contractors_insert_authenticated / contractors_select_authenticated (بدون update/delete) ──
  contractors: {
    select: () => true,
    insert: (authUser) => authed(authUser),
  },

  // ── departments: insert/update owner فقط، select لأي مستخدم مسجّل (بدون delete — soft delete عبر is_active) ──
  departments: {
    select: () => true,
    insert: (authUser) => isOwner(authUser),
    update: (authUser) => isOwner(authUser),
  },

  // ── divisions: نفس نمط departments ──
  divisions: {
    select: (authUser) => authed(authUser),
    insert: (authUser) => isOwner(authUser),
    update: (authUser) => isOwner(authUser),
  },

  // ── equipment_replacement_images: أي مستخدم مسجّل (بدون قيد نطاق) ──
  equipment_replacement_images: {
    select: (authUser) => authed(authUser),
    insert: (authUser) => authed(authUser),
    delete: (authUser) => authed(authUser),
  },

  // ── equipment_replacements: أي مستخدم مسجّل، بدون قيد نطاق (سجل عام بمستوى المؤسسة) ──
  equipment_replacements: {
    select: (authUser) => authed(authUser),
    insert: (authUser) => authed(authUser),
    update: (authUser) => authed(authUser),
    delete: (authUser) => authed(authUser),
  },

  // ── feeders: نفس نمط contractors لكن مع update ──
  feeders: {
    select: () => true,
    insert: (authUser) => authed(authUser),
    update: (authUser) => authed(authUser),
  },

  // ── job_contractor_checks: يحتاج job المرتبط (بدون update/delete) ──
  job_contractor_checks: {
    select: (authUser, scopeCtx, row, job) => canSelectJobChild(authUser, scopeCtx, job),
    insert: (authUser, scopeCtx, row, job) => canWriteJobChild(authUser, scopeCtx, job),
  },

  // ── job_images: يحتاج job المرتبط (بدون update) ──
  job_images: {
    select: (authUser, scopeCtx, row, job) => canSelectJobChild(authUser, scopeCtx, job),
    insert: (authUser, scopeCtx, row, job) => canWriteJobChild(authUser, scopeCtx, job),
    delete: (authUser, scopeCtx, row, job) => canWriteJobChild(authUser, scopeCtx, job),
  },

  // ── job_isolation_notes: يحتاج job المرتبط (بدون update/delete) ──
  job_isolation_notes: {
    select: (authUser, scopeCtx, row, job) => canSelectJobChild(authUser, scopeCtx, job),
    insert: (authUser, scopeCtx, row, job) => canWriteJobChild(authUser, scopeCtx, job),
  },

  // ── job_materials: يحتاج job المرتبط (بدون delete) ──
  job_materials: {
    select: (authUser, scopeCtx, row, job) => canSelectJobChild(authUser, scopeCtx, job),
    insert: (authUser, scopeCtx, row, job) => canWriteJobChild(authUser, scopeCtx, job),
    update: (authUser, scopeCtx, oldRow, newRow, job) => canWriteJobChild(authUser, scopeCtx, job),
  },

  // ── job_type_items: إداري فقط للكتابة، اطّلاع عام (فيها delete خلافًا لـjob_types) ──
  job_type_items: {
    select: () => true,
    insert: (authUser) => isOwner(authUser) || isAdmin(authUser),
    update: (authUser) => isOwner(authUser) || isAdmin(authUser),
    delete: (authUser) => isOwner(authUser) || isAdmin(authUser),
  },

  // ── job_types: إداري فقط للكتابة، بدون delete (soft delete عبر is_active) ──
  job_types: {
    select: () => true,
    insert: (authUser) => isOwner(authUser) || isAdmin(authUser),
    update: (authUser) => isOwner(authUser) || isAdmin(authUser),
  },

  // ── material_catalog: دليل مواد مرجعي (اقتراح تلقائي بالاسم/رقم التخزين عند إضافة مادة) —
  // بدون كمية/مستودع، جدول ثابت مو مرتبط بأي مستودع. القراءة لأي مستخدم مسجّل، التعديل owner فقط ──
  material_catalog: {
    select: () => true,
    insert: (authUser) => isOwner(authUser),
    update: (authUser) => isOwner(authUser),
    delete: (authUser) => isOwner(authUser),
  },

  // ── orders: أعقد سياسة بالنظام — insert يتحقق من user_id بالصف الجديد، select/update/delete بنطاق ──
  orders: {
    select: (authUser, scopeCtx, row) =>
      isOwner(authUser) ||
      (isAdminOrViewer(authUser) && inMyScopeSync(scopeCtx, authUser, row.warehouse_id, row.section_id)) ||
      row.user_id === authUser.sub,
    insert: (authUser, scopeCtx, newRow) => newRow.user_id === authUser.sub,
    update: (authUser, scopeCtx, oldRow, newRow) => {
      const scoped = (r) =>
        isOwner(authUser) ||
        (isAdmin(authUser) && inMyScopeSync(scopeCtx, authUser, r.warehouse_id, r.section_id)) ||
        (r.user_id === authUser.sub && ["قيد المراجعة", "في الانتظار"].includes(r.status));
      return scoped(oldRow) && scoped(newRow);
    },
    delete: (authUser, scopeCtx, row) =>
      isOwner(authUser) || (isAdmin(authUser) && inMyScopeSync(scopeCtx, authUser, row.warehouse_id, row.section_id)),
  },

  // ── products: إداري بنطاق للكتابة، اطّلاع عام لأي مسجّل دخول (بدون delete — soft delete عبر is_active) ──
  products: {
    select: (authUser) => authed(authUser),
    // storage_location_id مضاف بآخر البارامترات — يفعّل تخصيص صلاحية على مستوى المستودع الحقيقي
    // الجديد (بجانب القديم section_id/warehouse_id) بدون تغيير سلوك أي تخصيص قديم شغّال
    insert: (authUser, scopeCtx, newRow) =>
      isOwner(authUser) || (isAdmin(authUser) && inMyScopeSync(scopeCtx, authUser, newRow.warehouse_id, newRow.section_id, newRow.storage_location_id)),
    update: (authUser, scopeCtx, oldRow, newRow) =>
      isOwner(authUser) || (isAdmin(authUser) && inMyScopeSync(scopeCtx, authUser, oldRow.warehouse_id, oldRow.section_id, oldRow.storage_location_id)),
  },

  // ── push_subscriptions: أي مستخدم مسجّل (التطبيق نفسه يقيّد بـuser_id عند الاستعلام) ──
  push_subscriptions: {
    select: (authUser) => authed(authUser),
    insert: (authUser) => authed(authUser),
    update: (authUser) => authed(authUser),
    delete: (authUser) => authed(authUser),
  },

  // ── notifications: مركز الإشعارات — جدول جديد بعد استخراج الـRLS الأصلية (بدون مصدر Postgres مقابل).
  // نفس نمط push_subscriptions: أي مستخدم مسجّل، والفرونت نفسه يقيّد القراءة بـuser_id عند الاستعلام،
  // والإدراج لازم يكون مفتوح لأن sendPushNotification يكتب صفوف لمستخدمين آخرين (المُرسِل ≠ المُستقبِل) ──
  notifications: {
    select: (authUser) => authed(authUser),
    insert: (authUser) => authed(authUser),
    update: (authUser) => authed(authUser),
  },

  // ── report_recipients: مالك فقط (بدون update) ──
  report_recipients: {
    select: (authUser) => isOwner(authUser),
    insert: (authUser) => isOwner(authUser),
    delete: (authUser) => isOwner(authUser),
  },

  // ── report_schedules: مالك فقط، صفوف مزروعة مسبقًا (بدون insert/delete) ──
  report_schedules: {
    select: (authUser) => isOwner(authUser),
    update: (authUser) => isOwner(authUser),
  },

  // ── report_settings: مالك فقط، صف وحيد مزروع مسبقًا (بدون insert/delete) ──
  report_settings: {
    select: (authUser) => isOwner(authUser),
    update: (authUser) => isOwner(authUser),
  },

  // ── scheduled_jobs: insert يسمح بذاتي فقط، select/update بنطاق (بدون delete — إلغاء عبر status) ──
  scheduled_jobs: {
    select: (authUser, scopeCtx, row) =>
      isOwner(authUser) ||
      (isAdminOrViewer(authUser) && inMyScopeSync(scopeCtx, authUser, row.warehouse_id, null)) ||
      row.employee_id === authUser.sub,
    insert: (authUser, scopeCtx, newRow) =>
      isOwner(authUser) || isAdmin(authUser) || newRow.employee_id === authUser.sub,
    update: (authUser, scopeCtx, oldRow, newRow) => {
      // section_id يُمرَّر الآن كمان (كان null دايمًا سابقًا) — إضافي بحت، يفتح قبول جديد لمشرف مخصص
      // فعليًا على قسم/مجموعة العمل (بدون warehouse_id)، بدون ما يغيّر أي حالة قبول قديمة
      const usingOld =
        isOwner(authUser) ||
        (isAdmin(authUser) && inMyScopeSync(scopeCtx, authUser, oldRow.warehouse_id, oldRow.section_id)) ||
        (oldRow.employee_id === authUser.sub && oldRow.status === "in_progress");
      const checkNew =
        isOwner(authUser) ||
        (isAdmin(authUser) && inMyScopeSync(scopeCtx, authUser, newRow.warehouse_id, newRow.section_id)) ||
        (newRow.employee_id === authUser.sub && ["in_progress", "completed", "cancelled"].includes(newRow.status));
      return usingOld && checkNew;
    },
  },

  // ── sections: إداري للكتابة، اطّلاع عام (بدون delete) ──
  sections: {
    select: () => true,
    insert: (authUser) => isOwner(authUser) || isAdmin(authUser),
    update: (authUser) => isOwner(authUser) || isAdmin(authUser),
  },

  // ── storage_locations: نفس نمط sections ──
  storage_locations: {
    select: () => true,
    insert: (authUser) => isOwner(authUser) || isAdmin(authUser),
    update: (authUser) => isOwner(authUser) || isAdmin(authUser),
  },

  // ── transfers: بدون delete (إلغاء عبر status/cancelled_at) ──
  transfers: {
    select: (authUser, scopeCtx, row) =>
      isOwner(authUser) ||
      (isAdmin(authUser) && (inMyScopeSync(scopeCtx, authUser, row.from_warehouse_id, null) || inMyScopeSync(scopeCtx, authUser, row.to_warehouse_id, null))) ||
      row.requested_by === authUser.sub,
    insert: (authUser, scopeCtx, newRow) =>
      isOwner(authUser) || (isAdmin(authUser) && inMyScopeSync(scopeCtx, authUser, newRow.from_warehouse_id, null)),
    update: (authUser, scopeCtx, oldRow, newRow) => {
      const scoped = (r) =>
        isOwner(authUser) ||
        (isAdmin(authUser) && (inMyScopeSync(scopeCtx, authUser, r.from_warehouse_id, null) || inMyScopeSync(scopeCtx, authUser, r.to_warehouse_id, null)));
      return scoped(oldRow) && scoped(newRow);
    },
  },

  // ── user_scopes: إداري فقط للكتابة (insert/delete)، اطّلاع عام (بدون update) ──
  user_scopes: {
    select: () => true,
    insert: (authUser) => isOwner(authUser) || isAdmin(authUser),
    delete: (authUser) => isOwner(authUser) || isAdmin(authUser),
  },

  // ── users: insert إداري فقط، select/update لنفسه أو إداري (بدون delete — soft delete عبر is_active) ──
  // ملاحظة هجرة: auth_user_id ألغيت (كانت تربط بمستخدم Supabase Auth منفصل) — بالنظام الجديد users.id
  // نفسه هو JWT subject، فـ"self" هنا = row.id === authUser.sub مباشرة بدل auth_user_id === auth.uid()
  users: {
    select: (authUser, scopeCtx, row) => row.id === authUser.sub || isOwner(authUser) || isAdminOrViewer(authUser),
    insert: (authUser) => isOwner(authUser) || isAdmin(authUser),
    update: (authUser, scopeCtx, oldRow, newRow) => {
      const usingOld = oldRow.id === authUser.sub || isOwner(authUser) || isAdmin(authUser);
      if (!usingOld) return false;
      if (isOwner(authUser) || isAdmin(authUser)) return true;
      // تعديل ذاتي: ممنوع تغيير role أو is_active بنفسك (يمنع تصعيد صلاحياتك بنفسك)
      return newRow.role === oldRow.role && !!newRow.is_active === !!oldRow.is_active;
    },
  },

  // ── warehouse_assignments: insert/delete لِلمالك فقط (ليس حتى الإداري العادي)، select إداري/مالك ──
  warehouse_assignments: {
    select: (authUser) => isOwner(authUser) || isAdminOrViewer(authUser),
    insert: (authUser) => isOwner(authUser),
    delete: (authUser) => isOwner(authUser),
  },

  // ── warehouses: إداري للكتابة، اطّلاع عام (بدون delete) ──
  warehouses: {
    select: (authUser) => authed(authUser),
    insert: (authUser) => isOwner(authUser) || isAdmin(authUser),
    update: (authUser) => isOwner(authUser) || isAdmin(authUser),
  },

  // ── tech_issue_reports: بلاغ "مشكلة تقنية" — أي مستخدم مسجّل يبلّغ عن نفسه، المالك يشوف الكل ويحلّ ──
  // مو مرتبطة بواتساب إطلاقًا (تخزين مباشر بقاعدة البيانات) — عشان تضمن وصول البلاغ حتى لو فشلت بوابة واتساب
  tech_issue_reports: {
    select: (authUser, scopeCtx, row) => isOwner(authUser) || row.reporter_id === authUser.sub,
    insert: (authUser, scopeCtx, newRow) => authed(authUser) && newRow.reporter_id === authUser.sub,
    update: (authUser) => isOwner(authUser), // تعليم "تم الحل" فقط من المالك
  },

  // ── job_notification_prefs: تخصيص "مين يستلم شنو" لكل قسم/مشروع — إدارة المالك فقط (انظر jobNotifications.js) ──
  job_notification_prefs: {
    select: (authUser) => isOwner(authUser) || isAdmin(authUser),
    insert: (authUser) => isOwner(authUser),
    update: (authUser) => isOwner(authUser),
    delete: (authUser) => isOwner(authUser),
  },

  // ── global_job_watchers: متابعون عامون يستلمون كل تحديث لأي عمل بكل النظام — إدارة المالك فقط ──
  global_job_watchers: {
    select: (authUser) => isOwner(authUser) || isAdmin(authUser),
    insert: (authUser) => isOwner(authUser),
    delete: (authUser) => isOwner(authUser),
  },

  // ── violation_reports: نماذج رصد مخالفات المقاولين — مشرف/مالك فقط (رصد ميداني إداري، ليس للموظف العادي) ──
  violation_reports: {
    select: (authUser) => isOwner(authUser) || isAdminOrViewer(authUser),
    insert: (authUser) => isOwner(authUser) || isAdmin(authUser),
    update: (authUser) => isOwner(authUser) || isAdmin(authUser),
    delete: (authUser) => isOwner(authUser),
  },
};

// الجداول اللي تحتاج جلب صف scheduled_jobs المرتبط قبل فحص الصلاحية (عمود job_id بكل واحد منها)
export const JOB_CHILD_TABLES = new Set(["job_contractor_checks", "job_images", "job_isolation_notes", "job_materials"]);
