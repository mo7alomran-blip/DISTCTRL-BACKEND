-- ============================================================================
-- وحدة "التشغيل" (Operations) — Migration جديد وآمن للتطبيق فوق قاعدة بيانات حية
-- ============================================================================
-- يُشغَّل يدويًا (مثال: mysql -u USER -p DB_NAME < server/migrations/2026-09-17-operations-module.sql)
-- على السيرفر الحي (api.distctrl.com) بعد نسخ ملفات الباك اند الجديدة/المعدَّلة.
--
-- آمن للتشغيل أكثر من مرة (idempotent بالكامل):
--   - أسطر INSERT ... SELECT ... WHERE NOT EXISTS لا تكرر صفوف الهيكلة الإدارية لو شُغّل مرتين.
--   - CREATE TABLE IF NOT EXISTS لا يفشل لو الجدول موجود مسبقًا.
--
-- لا يلمس أي جدول/صف موجود مسبقًا إطلاقًا — إضافة بحتة، يطابق طلب "لا تحذف بيانات حالية".
-- ============================================================================

-- ------------------------------------------------------------------
-- 1) الهيكلة الإدارية: دائرة الدعم ← قسم التشغيل القرى / قسم التشغيل الهفوف
--    (صفوف عادية بجدولي divisions/sections الموجودين — بدون أي تعديل جوهري على قاعدة البيانات،
--    فيسمح بإضافة أقسام تشغيل أخرى مستقبلاً بمجرد إدراج صف جديد، بدون أي تعديل بالكود)
-- ------------------------------------------------------------------
INSERT INTO divisions (id, name, is_active)
SELECT UUID(), 'دائرة الدعم', 1
WHERE NOT EXISTS (SELECT 1 FROM divisions WHERE name = 'دائرة الدعم');

INSERT INTO sections (id, name, division_id, is_active)
SELECT UUID(), 'قسم التشغيل القرى', d.id, 1
FROM divisions d WHERE d.name = 'دائرة الدعم'
  AND NOT EXISTS (SELECT 1 FROM sections WHERE name = 'قسم التشغيل القرى');

INSERT INTO sections (id, name, division_id, is_active)
SELECT UUID(), 'قسم التشغيل الهفوف', d.id, 1
FROM divisions d WHERE d.name = 'دائرة الدعم'
  AND NOT EXISTS (SELECT 1 FROM sections WHERE name = 'قسم التشغيل الهفوف');

-- ------------------------------------------------------------------
-- 2) operations — سجل تشغيل واحد لكل إشعار (مستورد من Excel أو مُدخل يدويًا)
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS operations (
  id                     CHAR(36) NOT NULL PRIMARY KEY,
  division_id            CHAR(36) NULL,
  section_id             CHAR(36) NULL,
  -- operator_names: مصفوفة أسماء (JSON) — إشعار واحد قد يكون له أكثر من مشغل معًا
  operator_names         JSON NULL,
  -- بدون UNIQUE قسري عمدًا — التكرار (نفس رقم الإشعار مرتين) يُعالَج بواجهة الاستيراد
  -- (تجاهل/تحديث السجل الحالي/سجل جديد)، مو برفض قسري على مستوى القاعدة
  notification_number    VARCHAR(64) NULL,
  notification_date      DATE NULL,
  start_time             VARCHAR(20) NULL,
  end_time               VARCHAR(20) NULL,
  client_entity          VARCHAR(255) NULL,
  work_location          VARCHAR(255) NULL,
  subscribers_count      INT NULL,
  work_description       TEXT NULL,
  -- status: scheduled/notified/in_progress/completed/cancelled/postponed (قيم إنجليزية داخلية،
  -- تُعرض بالعربي بواجهة الفرونت عبر T() كبقية النظام)
  status                 VARCHAR(30) NOT NULL DEFAULT 'scheduled',
  linked_job_id          CHAR(36) NULL,
  message_text           TEXT NULL,
  message_status         VARCHAR(20) NOT NULL DEFAULT 'not_sent',
  message_sent_at        DATETIME(3) NULL,
  message_error          TEXT NULL,
  whatsapp_group_id_used VARCHAR(64) NULL,
  source                 VARCHAR(20) NOT NULL DEFAULT 'excel_import',
  import_batch_id        CHAR(36) NULL,
  created_by             CHAR(36) NULL,
  created_at             DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at             DATETIME(3) NULL,
  FOREIGN KEY (division_id) REFERENCES divisions(id),
  FOREIGN KEY (section_id) REFERENCES sections(id),
  FOREIGN KEY (linked_job_id) REFERENCES scheduled_jobs(id),
  FOREIGN KEY (created_by) REFERENCES users(id),
  INDEX idx_operations_notification_number (notification_number),
  INDEX idx_operations_section (section_id),
  INDEX idx_operations_linked_job (linked_job_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- 3) operations_audit_log — سجل تدقيق عام لكل سجل تشغيل (استيراد/ربط/تغيير حالة/إرسال/إعادة إرسال/تعديل)
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS operations_audit_log (
  id           CHAR(36) NOT NULL PRIMARY KEY,
  operation_id CHAR(36) NOT NULL,
  -- action: imported / linked / status_changed / message_sent / message_failed / message_resent / edited
  action       VARCHAR(40) NOT NULL,
  details      JSON NULL,
  performed_by CHAR(36) NULL,
  performed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (operation_id) REFERENCES operations(id),
  FOREIGN KEY (performed_by) REFERENCES users(id),
  INDEX idx_oal_operation (operation_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- 4) operations_location_rules — قواعد ربط الموقع/الوصف بالقسم، قابلة للتعديل من لوحة الإدارة
--    (بدل كتابة "الهفوف"/"القرى" ثابتة بالكود — كل قاعدة صف عادي يقدر المشرف يضيف/يعدّل/يحذفه)
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS operations_location_rules (
  id         CHAR(36) NOT NULL PRIMARY KEY,
  section_id CHAR(36) NOT NULL,
  keyword    VARCHAR(100) NOT NULL,
  is_active  TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (section_id) REFERENCES sections(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- قاعدتان افتراضيتان مبدئيتان (قابلتان للتعديل/الحذف لاحقًا من لوحة الإدارة) — تطابق مثال الطلب حرفيًا
INSERT INTO operations_location_rules (id, section_id, keyword, is_active)
SELECT UUID(), s.id, 'الهفوف', 1
FROM sections s WHERE s.name = 'قسم التشغيل الهفوف'
  AND NOT EXISTS (SELECT 1 FROM operations_location_rules WHERE keyword = 'الهفوف');

INSERT INTO operations_location_rules (id, section_id, keyword, is_active)
SELECT UUID(), s.id, 'القرى', 1
FROM sections s WHERE s.name = 'قسم التشغيل القرى'
  AND NOT EXISTS (SELECT 1 FROM operations_location_rules WHERE keyword = 'القرى');
