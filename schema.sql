-- ============================================================================
-- DistOps — هيكلة قاعدة بيانات MySQL (منقولة من Postgres/Supabase)
-- ============================================================================
-- مصدر الحقيقة الأصلي كان قاعدة Postgres حية بدون أي ملفات SQL محفوظة —
-- هذا الملف استُخرج عبر information_schema من قاعدة التجريبي (nihwbmeszujfaugesjzk)
-- بتاريخ 2026-08-28، ثم تُرجم لـMySQL يدويًا. قواعد الترجمة المستخدمة:
--   uuid            -> CHAR(36)     (يُولَّد بالتطبيق عبر crypto.randomUUID(), ما فيه DEFAULT بقاعدة البيانات)
--   text (بدون فهرسة) -> TEXT       (بدون DEFAULT حرفي، القيمة الافتراضية تُطبَّق بطبقة server/)
--   text (يُفهرس/فريد/قيمة قصيرة) -> VARCHAR(191)  (191 حرف = آمن لفهرسة utf8mb4 حتى بدون innodb_large_prefix)
--   boolean         -> TINYINT(1)
--   timestamptz     -> DATETIME(3) (يُخزَّن دائمًا UTC من طبقة التطبيق، بدون تحويل توقيت بقاعدة البيانات)
--   date            -> DATE
--   double precision -> DOUBLE
--   integer/bigint  -> INT / BIGINT
--   jsonb           -> JSON
--   text[] (مصفوفة) -> JSON        (مصفوفة روابط صور مخزَّنة كـJSON array)
--   بدائل تسلسل Postgres (nextval) -> AUTO_INCREMENT
--
-- ملاحظة عن users.ordinal_position: فيه فجوة تاريخية بين employee_id (3) و role (5)
-- بقاعدة Postgres الأصلية — عمود قديم انحذف زمان (DROP COLUMN ما يعيد ترقيم البواقي).
-- لا يوجد عمود حقيقي هناك الآن، فما تُرجم هنا شيء — تأكدنا منه بالاستعلام المباشر.
--
-- الترتيب بالأسفل يحترم تبعيات المفاتيح الأجنبية (الجداول المرجعية أولًا).
--
-- بعد تشغيل هذا الملف، شغّل seed-report-schedules.sql (بيانات إعداد حقيقية مختلفة بين البيئتين،
-- مو هيكلة، فمقصود إنها بملف منفصل) — بدونه cron.js ما يقدر يجدول أي تقرير عند الإقلاع.
-- ============================================================================

-- ملاحظة: ترميز الاتصال (utf8mb4) يُضبط من طبقة server/db.js (connection charset)
-- بدل SET NAMES هنا، حتى يشتغل الملف بأي عميل MySQL بدون افتراض إعدادات جلسة معينة.
SET FOREIGN_KEY_CHECKS = 0;

-- ------------------------------------------------------------------
-- 1) divisions — الدوائر
-- ------------------------------------------------------------------
CREATE TABLE divisions (
  id         CHAR(36) NOT NULL PRIMARY KEY,
  name       TEXT NOT NULL,
  is_active  TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  -- department_id: أُضيف لقلب الهيكل التنظيمي (إدارة ← دائرة ← قسم ← مستودع اختياري) —
  -- nullable مؤقتًا أثناء الانتقال، الدائرة تصير تابعة لإدارة بدل العكس (departments.division_id القديم)
  department_id CHAR(36) NULL,
  FOREIGN KEY (department_id) REFERENCES departments(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- 2) departments — الإدارات
-- ------------------------------------------------------------------
CREATE TABLE departments (
  id          CHAR(36) NOT NULL PRIMARY KEY,
  name        TEXT NOT NULL,
  -- division_id: كان NOT NULL بالهيكل القديم (الإدارة تتبع دائرة). صار nullable بعد قلب الهيكل —
  -- "الإدارة" الآن أعلى مستوى (ما فوقها شي)، فالسجلات الجديدة (الإدارات الحقيقية) تُنشأ بدون division_id.
  -- السجلات القديمة (الأقسام التجميعية القديمة) تبقى محتفظة بـdivision_id كما هو.
  division_id CHAR(36) NULL,
  is_active   TINYINT(1) NOT NULL DEFAULT 1,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (division_id) REFERENCES divisions(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- 3) warehouses — المستودعات
-- ------------------------------------------------------------------
CREATE TABLE warehouses (
  id            CHAR(36) NOT NULL PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT NULL,
  is_active     TINYINT(1) NOT NULL DEFAULT 1,
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  division_id   CHAR(36) NULL,
  department_id CHAR(36) NULL,
  -- whatsapp_group_id: أُضيف بعد ربط واتساب (بدون مصدر Postgres) — معرّف قروب واتساب (JID) اختياري
  -- لهذا المستودع؛ لو مضبوط، رسائل خط سير أعماله توصل للقروب بدل أرقام المشرفين الفردية (jobNotifications.js)
  whatsapp_group_id VARCHAR(191) NULL,
  -- section_id: أُضيف لقلب الهيكل التنظيمي — المستودع يصير ورقة اختيارية تابعة لقسم
  -- (بدل sections.warehouse_id القديم)؛ nullable لأن المستودع ممكن ما يحتاج قسم أصلًا
  section_id    CHAR(36) NULL,
  FOREIGN KEY (division_id) REFERENCES divisions(id),
  FOREIGN KEY (department_id) REFERENCES departments(id),
  FOREIGN KEY (section_id) REFERENCES sections(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- 4) sections — الأقسام
-- ------------------------------------------------------------------
CREATE TABLE sections (
  id           CHAR(36) NOT NULL PRIMARY KEY,
  name         TEXT NOT NULL,
  warehouse_id CHAR(36) NULL,
  image_url    TEXT NULL,
  icon         TEXT NULL,
  is_active    TINYINT(1) NOT NULL DEFAULT 1,
  created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  -- division_id: أُضيف لقلب الهيكل التنظيمي — القسم يصير تابع لدائرة مباشرة
  -- (بدل التبعية لمستودع عبر warehouse_id القديم)؛ nullable أثناء الانتقال
  division_id  CHAR(36) NULL,
  -- parent_section_id: تبيّن أثناء إعادة الربط الفعلية إن الهيكل أعمق من المخطط الأصلي —
  -- فيه مستوى "مجموعة" رابع تحت "قسم" (إدارة←دائرة←قسم←مجموعة←مستودع اختياري). بدل جدول جديد،
  -- استخدمنا self-reference بنفس جدول sections: قسم = division_id IS NOT NULL (تابع دائرة مباشرة)،
  -- مجموعة = parent_section_id IS NOT NULL (تابعة لقسم أب). warehouses.section_id يشير لأي منهما.
  parent_section_id CHAR(36) NULL,
  -- whatsapp_group_id: قروب واتساب مخصص لهذي المجموعة بالذات (أدق من warehouses.whatsapp_group_id) —
  -- أُضيف 2026-09-11 (طلب صريح من المالك: قروب حقيقي لمجموعة "الخطوط الهوائية" وحدها، منفصل عن قروب
  -- قسمها الأوسع). resolveJobTargets بـjobNotifications.js يفحصه أولًا قبل قروب القسم — الأخص يطغى.
  whatsapp_group_id VARCHAR(64) NULL,
  FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
  FOREIGN KEY (division_id) REFERENCES divisions(id),
  FOREIGN KEY (parent_section_id) REFERENCES sections(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- 5) storage_locations — مواقع التخزين
-- ------------------------------------------------------------------
CREATE TABLE storage_locations (
  id           CHAR(36) NOT NULL PRIMARY KEY,
  name         TEXT NOT NULL,
  warehouse_id CHAR(36) NOT NULL,
  is_active    TINYINT(1) NOT NULL DEFAULT 1,
  created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  latitude     DOUBLE NULL,
  longitude    DOUBLE NULL,
  -- section_id: تبيّن عمليًا إن "المستودعات" الحقيقية اللي يقصدها المستخدم بالهيكل الجديد
  -- (الورقة الأخيرة، مستودع فعلي بموقع/إحداثيات) هي هذا الجدول (storage_locations)، مو جدول
  -- warehouses — لأن جدول warehouses القديم فعليًا كان يُستخدم ليمثّل "قسم" (زي "قسم المنيزلة").
  -- هذا العمود يربط موقع التخزين مباشرة بالقسم/المجموعة الجديدة بدل الاعتماد على warehouses.section_id.
  section_id   CHAR(36) NULL,
  FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
  FOREIGN KEY (section_id) REFERENCES sections(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- 6) users — المستخدمون (Auth مخصص بطبقة server/auth.js، مو Supabase Auth)
-- ------------------------------------------------------------------
CREATE TABLE users (
  id            CHAR(36) NOT NULL PRIMARY KEY,
  name          TEXT NOT NULL,
  employee_id   VARCHAR(191) NOT NULL,
  role          VARCHAR(50) NOT NULL DEFAULT 'user',
  warehouse_id  CHAR(36) NULL,
  is_active     TINYINT(1) NOT NULL DEFAULT 1,
  auth_user_id  CHAR(36) NULL,
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  jobs_only     TINYINT(1) NOT NULL DEFAULT 0,
  phone         VARCHAR(50) NULL,
  password_hash VARCHAR(255) NULL COMMENT 'bcrypt — يحل محل Supabase Auth؛ يُملأ عند إعادة تعيين كلمات المرور',
  -- section_id: القسم/المجموعة الرئيسية للموظف بالهيكل التنظيمي الجديد (يوازي warehouse_id القديم)
  section_id    CHAR(36) NULL,
  UNIQUE KEY uq_users_employee_id (employee_id),
  FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
  FOREIGN KEY (section_id) REFERENCES sections(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- 7) user_scopes — نطاق صلاحيات إضافي لكل مستخدم
-- ------------------------------------------------------------------
CREATE TABLE user_scopes (
  id           CHAR(36) NOT NULL PRIMARY KEY,
  user_id      CHAR(36) NOT NULL,
  warehouse_id CHAR(36) NULL,
  section_id   CHAR(36) NULL,
  created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  -- storage_location_id: نطاق تصفح موظف عادي على مستوى "المستودع الحقيقي" بالهيكل الجديد،
  -- بنفس فلسفة warehouse_assignments.storage_location_id (انظر تعليقها هناك)
  storage_location_id CHAR(36) NULL,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
  FOREIGN KEY (section_id) REFERENCES sections(id),
  FOREIGN KEY (storage_location_id) REFERENCES storage_locations(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- 8) warehouse_assignments — إسناد مشرف/مدير لمستودع أو قسم أو دائرة
-- ------------------------------------------------------------------
CREATE TABLE warehouse_assignments (
  id           CHAR(36) NOT NULL PRIMARY KEY,
  user_id      CHAR(36) NULL,
  warehouse_id CHAR(36) NULL,
  section_id   CHAR(36) NULL,
  created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  division_id  CHAR(36) NULL,
  -- storage_location_id: تخصيص على مستوى "المستودع الحقيقي" بالهيكل الجديد (اكتشفنا إن storage_locations
  -- هو المستودع الفعلي، مو warehouses القديم). section_id هنا يخدم مستويي "قسم" و"مجموعة" الجديدين معًا
  -- (كلاهما صفوف بنفس جدول sections، مفرّقة بـsections.parent_section_id) — ما احتجنا عمود جديد لهما.
  storage_location_id CHAR(36) NULL,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
  FOREIGN KEY (section_id) REFERENCES sections(id),
  FOREIGN KEY (division_id) REFERENCES divisions(id),
  FOREIGN KEY (storage_location_id) REFERENCES storage_locations(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- 9) contractors — المقاولون/الاستشاريون
-- ------------------------------------------------------------------
CREATE TABLE contractors (
  id         CHAR(36) NOT NULL PRIMARY KEY,
  name       VARCHAR(191) NOT NULL,
  is_active  TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_contractors_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- 10) feeders — المغذيات
-- ------------------------------------------------------------------
CREATE TABLE feeders (
  id         CHAR(36) NOT NULL PRIMARY KEY,
  feeder_no  VARCHAR(191) NOT NULL,
  location   TEXT NOT NULL,
  is_active  TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_feeders_feeder_no (feeder_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- 11) job_types — أنواع الأعمال (قوالب)
-- ------------------------------------------------------------------
CREATE TABLE job_types (
  id           CHAR(36) NOT NULL PRIMARY KEY,
  name         TEXT NOT NULL,
  warehouse_id CHAR(36) NOT NULL,
  is_active    TINYINT(1) NOT NULL DEFAULT 1,
  created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (warehouse_id) REFERENCES warehouses(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- 12) products — منتجات/مواد المخزون
-- ------------------------------------------------------------------
CREATE TABLE products (
  id                  CHAR(36) NOT NULL PRIMARY KEY,
  name                TEXT NOT NULL,
  sku                 VARCHAR(191) NULL,
  unit                VARCHAR(50) NULL DEFAULT 'قطعة',
  quantity            INT NOT NULL DEFAULT 0,
  min_stock           INT NULL DEFAULT 0,
  shelf               TEXT NULL,
  section_id          CHAR(36) NULL,
  warehouse_id        CHAR(36) NULL,
  image_url           TEXT NULL,
  is_active           TINYINT(1) NOT NULL DEFAULT 1,
  created_at          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  storage_location_id CHAR(36) NULL,
  FOREIGN KEY (section_id) REFERENCES sections(id),
  FOREIGN KEY (storage_location_id) REFERENCES storage_locations(id),
  FOREIGN KEY (warehouse_id) REFERENCES warehouses(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- material_catalog — دليل مواد مرجعي (اقتراح تلقائي بالبحث بالاسم أو رقم التخزين عند إضافة مادة لمستودع)
-- ------------------------------------------------------------------
-- ثابت، بدون كمية/مستودع — مجرد قائمة أسماء+أرقام تخزين معروفة تُقترح على الموظف بدل ما يكتبها يدويًا،
-- اختياره من الاقتراح يملأ حقلي name/sku بنموذج إضافة مادة (products) تلقائيًا. مصدر البيانات: ملف
-- Excel من المستخدم (Mat.Description) — 966 مادة عبر 43 تصنيف.
CREATE TABLE material_catalog (
  id         CHAR(36) NOT NULL PRIMARY KEY,
  code       VARCHAR(50) NOT NULL COMMENT 'رقم التخزين (Mat code)',
  name       TEXT NOT NULL COMMENT 'Mat.Description',
  unit       VARCHAR(50) NULL,
  category   VARCHAR(191) NULL COMMENT 'CLASSIFICATION OF GROUPS',
  is_active  TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  -- name_ar: ترجمة عربية لـname الإنجليزي الأصلي (تُملأ مرة وحدة بسكربت دفعي عبر MyMemory) — تسهّل البحث
  -- بشاشة "طلب مواد" (الموظف يكتب عربي، النظام يطابق الاسم الإنجليزي التقني الأصلي). أُضيف لاحقًا (2026-09-10).
  name_ar    TEXT NULL,
  UNIQUE KEY uq_material_catalog_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- 13) job_type_items — المواد الافتراضية لكل نوع عمل
-- ------------------------------------------------------------------
CREATE TABLE job_type_items (
  id          CHAR(36) NOT NULL PRIMARY KEY,
  job_type_id CHAR(36) NOT NULL,
  product_id  CHAR(36) NOT NULL,
  quantity    INT NOT NULL DEFAULT 1,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (job_type_id) REFERENCES job_types(id),
  FOREIGN KEY (product_id) REFERENCES products(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- 14) scheduled_jobs — الأعمال المجدولة (أكبر جدول بالنظام)
-- ------------------------------------------------------------------
CREATE TABLE scheduled_jobs (
  id                                CHAR(36) NOT NULL PRIMARY KEY,
  employee_id                       CHAR(36) NOT NULL,
  warehouse_id                      CHAR(36) NULL,
  -- section_id: قسم/مجموعة العمل بالهيكل التنظيمي الجديد (يوازي warehouse_id القديم) — أُضيف
  -- لاحقًا، انظر تعليق users.section_id لنفس السبب
  section_id                        CHAR(36) NULL,
  title                             TEXT NOT NULL,
  description                       TEXT NULL,
  status                            VARCHAR(50) NOT NULL DEFAULT 'in_progress',
  created_at                        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at                      DATETIME(3) NULL,
  feeder_no                         VARCHAR(191) NULL,
  notification_no                   VARCHAR(191) NULL,
  equipment_no                      VARCHAR(191) NULL,
  -- project_no: رقم مشروع خاص بأعمال قسم الانشاءات فقط (عمود "PROJECT NO" بملف إكسل الانشاءات،
  -- مستقل عن notification_no) — أُضيف لاحقًا، فارغ لأي عمل مو من الانشاءات
  project_no                        VARCHAR(191) NULL,
  -- schedule_note: ملاحظة/تنبيه عام لُقط من خانة حمراء مدموجة بشبكة أيام قالب الانشاءات بالإكسل (زي تغيير
  -- جهد محول أو تقوية عداد) بدل علامة "S.D" العادية — أُضيف لاحقًا (2026-09-07)، يظهر بشكل مميز بالتطبيق/
  -- الواتساب/PDF التقرير بدل ما يُفقد بصمت. فارغ لأي عمل بدون هالنوع من الملاحظات.
  schedule_note                     TEXT NULL,
  -- closing_note: ملاحظة اختيارية يكتبها المنفّذ قبل إقفال العمل مباشرة (مو تلقائية من الإكسل زي
  -- schedule_note فوق) — لو موجودة يقدر يرفق لها صورة (job_images بـimage_type='closing_note').
  -- أُضيف لاحقًا (2026-09-07).
  closing_note                      TEXT NULL,
  -- closing_note_resolved_at: يُملأ لما يضغط مشرف/مالك "تمت المتابعة ✅" على ملاحظة إقفال بعد معالجتها —
  -- يخفي العمل من قائمة "عليها ملاحظات" بجوال الأعمال بدون حذف نص/صور الملاحظة (تبقى ظاهرة بتفاصيل العمل).
  -- NULL = لسه ما تابعها أحد (تظهر بالقائمة). أُضيف لاحقًا (2026-09-10).
  closing_note_resolved_at          DATETIME(3) NULL,
  arrived_at                        DATETIME(3) NULL,
  contractor_ready                  TINYINT(1) NULL,
  contractor_notes                  TEXT NULL,
  contacted_operator_at             DATETIME(3) NULL,
  operator_arrived_at               DATETIME(3) NULL,
  job_received_at                   DATETIME(3) NULL,
  cancelled_at                      DATETIME(3) NULL,
  cancel_reason                     TEXT NULL,
  arrived_images                    JSON NOT NULL DEFAULT ('[]'),
  contacted_operator_images         JSON NOT NULL DEFAULT ('[]'),
  operator_arrived_images           JSON NOT NULL DEFAULT ('[]'),
  equipment_lat                     DOUBLE NULL,
  equipment_lng                     DOUBLE NULL,
  sub_items                         JSON NULL,
  isolation_points                  TEXT NULL,
  closing_contacted_operator_at     DATETIME(3) NULL,
  closing_contacted_operator_images JSON NULL,
  closing_operator_arrived_at       DATETIME(3) NULL,
  closing_operator_arrived_images   JSON NULL,
  power_restored_at                 DATETIME(3) NULL,
  power_restored_images             JSON NULL,
  -- ملاحظة: بـPostgres كان الافتراضي (now() AT TIME ZONE 'Asia/Riyadh')::date —
  -- بـMySQL يُحسب هذا التاريخ بطبقة server/ عند الإنشاء (بتوقيت الرياض) بدل DEFAULT بقاعدة البيانات
  scheduled_date                    DATE NULL,
  contractor_name                   TEXT NULL,
  start_time                        VARCHAR(20) NULL,
  end_time                          VARCHAR(20) NULL,
  location                          TEXT NULL,
  consultant_employee_id            CHAR(36) NULL,
  escalated_at                      DATETIME(3) NULL,
  -- overdue_alert_sent_at: أُضيف بعد الترحيل (بدون مصدر Postgres) — يمنع تكرار تنبيه "العمل تأخر" كل
  -- ما يمر cron.js على نفس العمل (checkDelayedJobs بـcron.js، 5 ساعات من job_received_at بدون اكتمال)
  overdue_alert_sent_at              DATETIME(3) NULL,
  FOREIGN KEY (employee_id) REFERENCES users(id),
  FOREIGN KEY (consultant_employee_id) REFERENCES users(id),
  FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
  FOREIGN KEY (section_id) REFERENCES sections(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- 15) job_images — صور العمل
-- ------------------------------------------------------------------
CREATE TABLE job_images (
  id         CHAR(36) NOT NULL PRIMARY KEY,
  job_id     CHAR(36) NOT NULL,
  image_url  TEXT NOT NULL,
  image_type VARCHAR(50) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  item_label TEXT NULL,
  FOREIGN KEY (job_id) REFERENCES scheduled_jobs(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- 16) job_materials — المواد المصروفة/المحجوزة لعمل
-- ------------------------------------------------------------------
CREATE TABLE job_materials (
  id         CHAR(36) NOT NULL PRIMARY KEY,
  job_id     CHAR(36) NOT NULL,
  product_id CHAR(36) NOT NULL,
  quantity   INT NOT NULL DEFAULT 1,
  used       TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (job_id) REFERENCES scheduled_jobs(id),
  FOREIGN KEY (product_id) REFERENCES products(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- 17) job_contractor_checks — تأكيد جاهزية المقاول
-- ------------------------------------------------------------------
CREATE TABLE job_contractor_checks (
  id         CHAR(36) NOT NULL PRIMARY KEY,
  job_id     CHAR(36) NOT NULL,
  ready      TINYINT(1) NOT NULL,
  notes      TEXT NULL,
  checked_by CHAR(36) NULL,
  checked_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  image_urls JSON NOT NULL DEFAULT ('[]'),
  FOREIGN KEY (job_id) REFERENCES scheduled_jobs(id),
  FOREIGN KEY (checked_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- 18) job_isolation_notes — ملاحظات نقاط العزل
-- ------------------------------------------------------------------
CREATE TABLE job_isolation_notes (
  id         CHAR(36) NOT NULL PRIMARY KEY,
  job_id     CHAR(36) NOT NULL,
  note       TEXT NOT NULL,
  created_by CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  image_urls JSON NOT NULL DEFAULT ('[]'),
  FOREIGN KEY (job_id) REFERENCES scheduled_jobs(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- 19) equipment_replacements — سجل استبدال المعدات (PMT/RMU/...)
-- ------------------------------------------------------------------
CREATE TABLE equipment_replacements (
  id                   CHAR(36) NOT NULL PRIMARY KEY,
  equipment_no         VARCHAR(191) NULL,
  work_date            DATE NULL,
  contractor_name      TEXT NULL,
  location             TEXT NULL,
  equipment_type       VARCHAR(50) NULL,
  reason               TEXT NULL,
  notification_no      VARCHAR(191) NULL,
  tag_no               VARCHAR(191) NULL,
  consultant_text      TEXT NULL,
  old_serial_no        VARCHAR(191) NULL,
  new_serial_no        VARCHAR(191) NULL,
  manufacture_year     VARCHAR(20) NULL,
  manufacturer_name    TEXT NULL,
  issuing_warehouse_id CHAR(36) NULL,
  voltage_rating       VARCHAR(50) NULL,
  is_emergency         TINYINT(1) NOT NULL DEFAULT 0,
  linked_job_id        CHAR(36) NULL,
  created_by           CHAR(36) NULL,
  created_at           DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  lv_rating            VARCHAR(50) NULL,
  kva_rating           VARCHAR(50) NULL,
  FOREIGN KEY (created_by) REFERENCES users(id),
  FOREIGN KEY (linked_job_id) REFERENCES scheduled_jobs(id),
  FOREIGN KEY (issuing_warehouse_id) REFERENCES warehouses(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- 20) equipment_replacement_images — صور استبدال المعدات
-- ------------------------------------------------------------------
CREATE TABLE equipment_replacement_images (
  id                        CHAR(36) NOT NULL PRIMARY KEY,
  equipment_replacement_id CHAR(36) NOT NULL,
  image_type                VARCHAR(50) NOT NULL,
  image_url                 TEXT NOT NULL,
  created_at                 DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (equipment_replacement_id) REFERENCES equipment_replacements(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- 21) orders — طلبات المواد
-- ------------------------------------------------------------------
CREATE TABLE orders (
  id                CHAR(36) NOT NULL PRIMARY KEY,
  emp_name          TEXT NULL,
  emp_id            CHAR(36) NULL,
  emp_no            VARCHAR(191) NULL,
  user_id           CHAR(36) NULL,
  warehouse_id      CHAR(36) NULL,
  section_id        CHAR(36) NULL,
  status            VARCHAR(50) NOT NULL DEFAULT 'قيد المراجعة',
  items             JSON NOT NULL DEFAULT ('[]'),
  order_no          INT NOT NULL AUTO_INCREMENT,
  submitted_at      DATETIME(3) NULL,
  approved_by_name  TEXT NULL,
  approved_by_no    VARCHAR(191) NULL,
  approved_at       DATETIME(3) NULL,
  rejection_reason  TEXT NULL,
  signature         LONGTEXT NULL,
  updated_at        DATETIME(3) NULL,
  created_at        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  equipment_no      VARCHAR(191) NULL,
  notification_no   VARCHAR(191) NULL,
  work_type         VARCHAR(191) NULL,
  -- job_id: طلب مواد مُنشأ من داخل عمل مجدول (زر "طلب مواد" بتفاصيل العمل) — الموظف يبحث بقائمة
  -- material_catalog الكاملة (مو مقيّد بمخزون المستودع الفعلي)، ويصل الطلب لنفس شاشة موافقة الطلبات
  -- العادية. NULL لأي طلب عادي (من شاشة "طلب مواد" المستقلة، مو مرتبط بعمل). أُضيف لاحقًا (2026-09-10).
  job_id            CHAR(36) NULL,
  UNIQUE KEY uq_orders_order_no (order_no),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
  FOREIGN KEY (section_id) REFERENCES sections(id),
  FOREIGN KEY (job_id) REFERENCES scheduled_jobs(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- 22) transfers — تحويلات بين المستودعات
-- ------------------------------------------------------------------
CREATE TABLE transfers (
  id                     CHAR(36) NOT NULL PRIMARY KEY,
  created_at             DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  requested_by           CHAR(36) NULL,
  requested_by_name      TEXT NULL,
  requested_by_no        VARCHAR(191) NULL,
  from_warehouse_id      CHAR(36) NOT NULL,
  to_warehouse_id        CHAR(36) NOT NULL,
  from_division_id       CHAR(36) NULL,
  to_division_id         CHAR(36) NULL,
  is_cross_branch        TINYINT(1) NOT NULL DEFAULT 0,
  items                  JSON NOT NULL,
  notes                  TEXT NULL,
  status                 VARCHAR(50) NOT NULL DEFAULT 'pending_dest',
  step1_approved_by      CHAR(36) NULL,
  step1_approved_by_name TEXT NULL,
  step1_approved_at      DATETIME(3) NULL,
  step2_approved_by      CHAR(36) NULL,
  step2_approved_by_name TEXT NULL,
  step2_approved_at      DATETIME(3) NULL,
  rejected_by            CHAR(36) NULL,
  rejected_by_name       TEXT NULL,
  rejected_at            DATETIME(3) NULL,
  reject_reason          TEXT NULL,
  cancelled_at           DATETIME(3) NULL,
  FOREIGN KEY (from_warehouse_id) REFERENCES warehouses(id),
  FOREIGN KEY (to_warehouse_id) REFERENCES warehouses(id),
  FOREIGN KEY (from_division_id) REFERENCES divisions(id),
  FOREIGN KEY (to_division_id) REFERENCES divisions(id),
  FOREIGN KEY (requested_by) REFERENCES users(id),
  FOREIGN KEY (step1_approved_by) REFERENCES users(id),
  FOREIGN KEY (step2_approved_by) REFERENCES users(id),
  FOREIGN KEY (rejected_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- 23) report_recipients — مستلمو التقارير الدورية بالبريد
-- ------------------------------------------------------------------
CREATE TABLE report_recipients (
  id          CHAR(36) NOT NULL PRIMARY KEY,
  email       VARCHAR(255) NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  report_type VARCHAR(20) NOT NULL DEFAULT 'daily',
  scope_type  VARCHAR(20) NOT NULL DEFAULT 'org',
  scope_id    CHAR(36) NULL,
  -- phone: أُضيف بعد ربط واتساب — لا مصدر Postgres مقابل له. email صار NULL-able لأن مستلم ممكن
  -- يكون واتساب بس بدون إيميل (كان NOT NULL بالأصل قبل هذي الإضافة)
  phone       VARCHAR(50) NULL
  -- ملاحظة: بـPostgres ما فيه FOREIGN KEY فعلي على scope_id (يشير لجدول مختلف حسب scope_type) — نفس الشي هنا
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- 24) report_schedules — جدولة إرسال التقارير (يومي/أسبوعي/شهري)
-- ------------------------------------------------------------------
CREATE TABLE report_schedules (
  report_type  VARCHAR(20) NOT NULL PRIMARY KEY,
  hour         INT NOT NULL,
  minute       INT NOT NULL,
  day_of_week  INT NULL,
  day_of_month INT NULL,
  enabled      TINYINT(1) NOT NULL DEFAULT 1,
  updated_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- 25) report_settings — إعداد قديم (صف واحد) لوقت إرسال التقرير — سابق لـreport_schedules
-- ------------------------------------------------------------------
CREATE TABLE report_settings (
  id          INT NOT NULL PRIMARY KEY DEFAULT 1,
  send_hour   INT NOT NULL DEFAULT 6,
  send_minute INT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- 26) push_subscriptions — اشتراكات Web Push
-- ------------------------------------------------------------------
CREATE TABLE push_subscriptions (
  id         CHAR(36) NOT NULL PRIMARY KEY,
  user_id    CHAR(36) NOT NULL,
  endpoint   VARCHAR(767) NOT NULL,
  p256dh     TEXT NOT NULL,
  auth_key   TEXT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_push_subscriptions_endpoint (endpoint),
  FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- 26.1) notifications — مركز الإشعارات داخل التطبيق (أُضيفت بعد استخراج سياسات Postgres الأصلية
-- بتاريخ 2026-08-28، فما كانت موجودة بـ74 سياسة RLS المنقولة — هذا الجدول جديد كليًا بلا مصدر Postgres مقابل)
-- ------------------------------------------------------------------
CREATE TABLE notifications (
  id            CHAR(36) NOT NULL PRIMARY KEY,
  user_id       CHAR(36) NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT NULL,
  target_screen VARCHAR(100) NULL,
  target_id     CHAR(36) NULL,
  is_read       TINYINT(1) NOT NULL DEFAULT 0,
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_notifications_user_id (user_id),
  FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- 27) login_attempts — محاولات تسجيل الدخول (لحماية معدل المحاولات)
-- ------------------------------------------------------------------
CREATE TABLE login_attempts (
  id          BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  employee_id VARCHAR(191) NOT NULL,
  success     TINYINT(1) NOT NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  ip_address  VARCHAR(64) NULL,
  KEY idx_login_attempts_employee_id (employee_id),
  KEY idx_login_attempts_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- password_resets — استعادة كلمة المرور عبر رمز تحقق (OTP) بالواتساب
-- ------------------------------------------------------------------
-- تدفق الاستخدام: 1) /api/password-reset/request يولّد رمز 6 أرقام، يخزن هاشه فقط (bcrypt)، يرسله بالواتساب
--   2) /api/password-reset/verify يتحقق من الرمز، يعلّم الصف "مُستخدم" (used_at) ويصدر reset_token (JWT قصير العمر)
--   3) /api/password-reset/confirm يتحقق من reset_token ومن إن الصف مُستخدم وغير مؤكَّد قبل، يحدّث كلمة المرور
--      ويعلّم الصف "مؤكَّد" (confirmed_at) — يمنع إعادة استخدام نفس reset_token مرتين.
CREATE TABLE password_resets (
  id           CHAR(36) NOT NULL PRIMARY KEY,
  user_id      CHAR(36) NOT NULL,
  code_hash    VARCHAR(255) NOT NULL,
  expires_at   DATETIME(3) NOT NULL,
  attempts     INT NOT NULL DEFAULT 0,
  used_at      DATETIME(3) NULL,
  confirmed_at DATETIME(3) NULL,
  ip_address   VARCHAR(64) NULL,
  created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_password_resets_user_id (user_id),
  KEY idx_password_resets_created_at (created_at),
  FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- tech_issue_reports: بلاغ "مشكلة تقنية" من أي مستخدم (وصف + صورة اختيارية) — تخزين مباشر بقاعدة البيانات
-- بدون اعتماد على واتساب إطلاقًا، عشان يضمن وصول البلاغ للمالك حتى لو فشلت بوابة واتساب. أُضيف لاحقًا
-- (2026-09-06) بعد ملاحظة إن رسائل واتساب (خصوصًا الوسائط/الصور) ممكن تفشل بصمت أحيانًا.
CREATE TABLE tech_issue_reports (
  id          CHAR(36) NOT NULL PRIMARY KEY,
  reporter_id CHAR(36) NOT NULL,
  description TEXT NOT NULL,
  image_url   TEXT NULL,
  status      VARCHAR(20) NOT NULL DEFAULT 'open',
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  resolved_at DATETIME(3) NULL,
  resolved_by CHAR(36) NULL,
  KEY idx_tech_issue_reports_status (status),
  FOREIGN KEY (reporter_id) REFERENCES users(id),
  FOREIGN KEY (resolved_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- job_notification_prefs: تخصيص "مين يستلم شنو" لكل قسم/مشروع — صف لكل (قسم، شخص)، كل نوع محتوى TINYINT
-- مستقل (تحديث مراحل / تقرير نهائي نصي / PDF كامل / PDF جودة تنفيذ / PDF جودة إرفاق / طلب مواد / تصعيد تأخير).
-- قسم بلا أي صف هنا يستمر بالسلوك القديم (المشرف المسؤول عن النطاق تلقائيًا) — انظر resolveJobTargets
-- بـjobNotifications.js. أُضيف لاحقًا (2026-09-07) ضمن تطوير المهام المسندة لصيانة والإنشاءات.
-- material_request/escalation أُضيفا (2026-09-11) — واجهة ذاتية الخدمة تتيح لكل مشرف/رئيس قسم يفعّل نفسه
-- لأي نوع رسالة يبيها بنفسه بدل ما يعدَّل الجدول يدويًا بالسيرفر. تنبيه مهم: أول صف يُنشأ لأي قسم يبدّل
-- ذاك القسم بالكامل لكل الأنواع من الخوارزمية الديناميكية لقائمة صريحة — نوع بلا أي شخص مفعَّل له
-- بأي صف = محد يستلمه إطلاقًا (بدون أي تراجع تلقائي)، حتى لو صفوف ثانية بنفس القسم مفعّلة لأنواع غيره.
-- job_created/job_received/job_cancelled أُضيفا (2026-09-11 أيضًا) — كانت الثلاثة مجمَّعة قبل داخل
-- stage_updates بالحرف؛ فُصلت لطلب صريح من المالك (رئيس القسم يبي يتحكم بكل وحدة منها براسها، مثلاً
-- يستلم "استلام العمل" بس بدون ضجيج باقي تحديثات المراحل). أي صف قديم كان stage_updates=1 قبل الفصل
-- انضبط تلقائيًا بالثلاثة الجداد=1 وقت الترحيل عشان ما ينكسر سلوكه القائم.
CREATE TABLE job_notification_prefs (
  id                     CHAR(36) NOT NULL PRIMARY KEY,
  section_id             CHAR(36) NOT NULL,
  user_id                CHAR(36) NOT NULL,
  stage_updates          TINYINT(1) NOT NULL DEFAULT 0, -- كان DEFAULT 1 (بقايا التصميم القديم قبل فصل job_created/received/cancelled) —
  -- سبّب خلل حقيقي 2026-09-11: تفعيل "إسناد عمل جديد" بس كان يخلي "تحديث المراحل" يتفعّل تلقائيًا معه بصمت لأي صف جديد
  job_created            TINYINT(1) NOT NULL DEFAULT 0,
  job_received           TINYINT(1) NOT NULL DEFAULT 0,
  job_cancelled          TINYINT(1) NOT NULL DEFAULT 0,
  final_report           TINYINT(1) NOT NULL DEFAULT 0,
  completion_pdf         TINYINT(1) NOT NULL DEFAULT 0,
  quality_execution_pdf  TINYINT(1) NOT NULL DEFAULT 0,
  quality_attachment_pdf TINYINT(1) NOT NULL DEFAULT 0,
  material_request       TINYINT(1) NOT NULL DEFAULT 0,
  escalation             TINYINT(1) NOT NULL DEFAULT 0,
  created_at             DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_section_user (section_id, user_id),
  FOREIGN KEY (section_id) REFERENCES sections(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- global_job_watchers: أشخاص يستلمون كل تحديث لأي عمل بكل النظام، بغض النظر عن القسم/المشروع أو نوع
-- المحتوى — يحل محل إعداد WHATSAPP_JOB_WATCH_NUMBERS الثابت بـ.env بواجهة مُدارة من التطبيق (شاشة
-- "متابعة عامة لكل الأعمال"، المالك فقط). أُضيف لاحقًا (2026-09-07).
CREATE TABLE global_job_watchers (
  id         CHAR(36) NOT NULL PRIMARY KEY,
  user_id    CHAR(36) NOT NULL UNIQUE,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- employee_notification_groups: قروبات واتساب إضافية يختارها المالك/المشرف لموظف معيّن من بطاقته (تعديل
-- بيانات الموظف) — لو فيها صفوف لموظف، تحل محل التغطية الافتراضية (مسؤول دائرة الموظف نفسه) بجوبNotifications.js
-- resolveEmployeeOwnAdminPhones، فتوصل رسائل أعماله لهذي القروبات دائمًا بدل التنبيه الفردي. أُضيف 2026-09-13.
CREATE TABLE employee_notification_groups (
  id                CHAR(36) NOT NULL PRIMARY KEY,
  user_id           CHAR(36) NOT NULL,
  whatsapp_group_id VARCHAR(64) NOT NULL,
  created_at        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_user_group (user_id, whatsapp_group_id),
  FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- violation_reports: نسخة إلكترونية من "النموذج الميداني لرصد المخالفات لأعمال المقاولين للعقد الموحد 2026"
-- (36 بند مخالفة ثابت، انظر src/lib/violationTypes.js). عمود items JSON بدل جدول فرعي منفصل — نفس أسلوب
-- scheduled_jobs.sub_items بالضبط: كل عنصر {code, checked, has_injury, note, image_urls:[]}. أُضيف لاحقًا (2026-09-09).
CREATE TABLE violation_reports (
  id                    CHAR(36) NOT NULL PRIMARY KEY,
  department_name       VARCHAR(255) NULL,
  division_name         VARCHAR(255) NULL,
  location              VARCHAR(255) NULL,
  report_date           DATE NOT NULL,
  report_time           VARCHAR(20) NULL,
  contractor_name       VARCHAR(255) NULL,
  work_description      TEXT NULL,
  project_no            VARCHAR(191) NULL,
  items                 JSON NOT NULL DEFAULT ('[]'),
  notes                 TEXT NULL,
  observer_name         VARCHAR(255) NULL,
  observer_employee_id  VARCHAR(50) NULL,
  contractor_rep_name   VARCHAR(255) NULL,
  contractor_rep_id     VARCHAR(100) NULL,
  created_by            CHAR(36) NULL,
  created_at            DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- 33) system_health — تتبّع صحة الخدمات الخارجية (واتساب/Push) لتنبيه المالك عند أي عطل حقيقي
-- بدل ما يفضل صامت (اكتُشف انقطاع واتساب صامت لـ4 أيام يوم 2026-09-10 بدون أي تنبيه — systemHealth.js)
-- ------------------------------------------------------------------
CREATE TABLE system_health (
  check_name      VARCHAR(50) NOT NULL PRIMARY KEY,   -- 'whatsapp' | 'push' ...
  status          VARCHAR(20) NOT NULL,               -- 'ok' | 'down'
  last_checked_at DATETIME(3) NOT NULL,
  detail          TEXT NULL,
  updated_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 1;

-- بيانات ابتدائية لجدول الإعداد القديم أحادي الصف
INSERT INTO report_settings (id, send_hour, send_minute) VALUES (1, 6, 0);
