// راوت CRUD عام — يقابل كل استدعاءات supabase.from(table)... الـ١١٨ بـApp.jsx.
// هذا هو بديل RLS الفعلي: يفلتر كل صف عبر policies.js بدل ما تفلتر قاعدة البيانات نفسها.
//
// عقد الاتصال مع طبقة التوافق بالفرونت (src/supabase.js الجديد):
//   GET    /api/table/:table?select=...&eq[col]=val&is[col]=null&order=col&dir=asc|desc&limit=n
//   POST   /api/table/:table                body: { row } أو { rows: [...] } أو { row, upsert: true, onConflict: "col" }
//   PATCH  /api/table/:table?eq[col]=val&is[col]=null     body: { patch }
//   DELETE /api/table/:table?eq[col]=val&is[col]=null
//
// أعمدة حساسة (password_hash) مرفوضة هنا بشكل صريح دائمًا بالكتابة، وتُحذف من أي قراءة أيضًا —
// التعديل عليها فقط عبر routes/users-admin.js المخصص (يقابل هذا منع أي مسار عام غير مخصص من لمس كلمة المرور).
//
// حالة خاصة بجدول users فقط (توافقًا مع App.jsx بدون أي تعديل عليه):
//   - فلتر eq[auth_user_id]=X يُعاد كتابته كـ eq[id]=X (بالنظام الجديد users.id نفسه هو JWT subject،
//     ما فيه عمود Auth منفصل زي Supabase auth.users.id القديم)
//   - بالاستجابة، حقل auth_user_id يُعاد توليده: يساوي row.id لو عنده password_hash (عنده حساب دخول فعلي)، وإلا null —
//     نفس الشكل truthy/falsy اللي كود الواجهة يعتمد عليه (u.auth_user_id ? "عنده دخول" : "بدون")، بدون تغيير App.jsx
import express from "express";
import { pool, genId } from "../db.js";
import { requireAuth } from "../auth.js";
import { policies, JOB_CHILD_TABLES } from "../policies.js";
import { loadScopeContext, resolveDivisionForSection, OWNER_EMPLOYEE_ID } from "../scope.js";
import { broadcastChange, REALTIME_TABLES } from "../realtime.js";
import { notifyJobCreated, notifyJobStageChange, notifyJobChildEvent, notifyJobCompletionReport, sendJobCompletionPdf } from "../jobNotifications.js";
import { linkOperationToJob, notifyOperationsSupervisors } from "../operationsWhatsapp.js";
import { notifyUsersInApp } from "../appNotify.js";

const router = express.Router();

const FORBIDDEN_COLUMNS = new Set(["password_hash"]);

// ── إصلاح أمني (فحص أمني 2026-09-18): كل أسماء الأعمدة بهذا الملف (فلاتر eq/is/in، order، أعمدة INSERT
// من مفاتيح body، أعمدة PATCH SET من مفاتيح patch) كانت تُدخَل مباشرة بالاستعلام بين backticks بدون أي
// تحقق أنها فعلاً أعمدة حقيقية بالجدول — أي مستخدم مسجّل دخول (بأي دور) يقدر يمرر اسم "عمود" فيه backtick
// يكسر الاقتباس ويحقن SQL كامل (مثال مؤكَّد: ?order=id%60%2C(SELECT%20SLEEP(5))--%20-  ينتج
// ORDER BY `id`,(SELECT SLEEP(5))-- -` ASC صالح ويُنفَّذ). الحل: قائمة بيضاء فعلية بأعمدة كل جدول من
// information_schema، تُرفض أي عملية فيها اسم عمود غير موجود فعلاً قبل ما يدخل أي استعلام.
const columnCache = new Map();
async function getTableColumns(table) {
  if (columnCache.has(table)) return columnCache.get(table);
  const [rows] = await pool.query(
    "SELECT COLUMN_NAME AS name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ?",
    [table]
  );
  const cols = new Set(rows.map((r) => r.name));
  columnCache.set(table, cols);
  return cols;
}
class InvalidColumnError extends Error {
  constructor(name) {
    super(`invalid_column: ${name}`);
    this.statusCode = 400;
  }
}
function assertValidColumns(validCols, names) {
  for (const n of names) if (!validCols.has(n)) throw new InvalidColumnError(n);
}

function stripForbidden(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const clean = { ...obj };
  for (const col of FORBIDDEN_COLUMNS) delete clean[col];
  return clean;
}

// الفرونت يرسل تواريخ/أوقات كـ new Date().toISOString() (مثال: 2026-09-03T12:29:05.246Z) — هذا الشكل
// يطابق ISO 8601 لكن MySQL يرفضه كقيمة DATETIME حرفيًا (ER_TRUNCATED_WRONG_VALUE) لأنه يتوقع
// "YYYY-MM-DD HH:MM:SS[.ffffff]" بدون حرفي T/Z. نحوّله هنا بدل ما نغيّر الفرونت (App.jsx بدون تعديل).
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?$/;
function toMySQLValue(val) {
  if (typeof val === "string" && ISO_DATETIME_RE.test(val)) {
    return val.replace("T", " ").replace("Z", "");
  }
  if (val !== null && typeof val === "object") return JSON.stringify(val);
  return val;
}

// يطبّق حالة users الخاصة على صفوف القراءة: يشيل password_hash نهائيًا، ويحوّل auth_user_id لعلامة truthy/falsy
function postProcessUsersRows(table, rows) {
  if (table !== "users") return rows;
  return rows.map((r) => {
    const { password_hash, ...rest } = r;
    return { ...rest, auth_user_id: password_hash ? r.id : null };
  });
}

// أي فلتر .eq(col, true/false) بالفرونت يوصل هنا كنص "true"/"false" حرفي (query string دائمًا نصوص) —
// MySQL يقارن نص غير رقمي بعمود TINYINT بتحويله لـ0 (حتى النص "true")، فـ`is_active = 'true'` تتطابق
// فعليًا مع is_active=0 بدل 1! خلل حقيقي أثّر على كل استعلام بالتطبيق يفلتر بحقل boolean (is_active وغيره) —
// نحوّل الصيغة النصية لـ1/0 صريحة قبل ما تدخل الاستعلام.
function coerceBoolString(val) {
  if (val === "true") return 1;
  if (val === "false") return 0;
  return val;
}

function parseFilters(query, table) {
  const eq = Object.entries(query.eq || {}).map(([col, val]) => ({ op: "eq", col, val: coerceBoolString(val) }));
  const is = Object.entries(query.is || {}).map(([col]) => ({ op: "is", col })); // بكودنا دايمًا .is(col, null)
  // in[col]=v1,v2,v3 — يقابل .in(col, [...]) بالفرونت (مثال: تحديد عدة إشعارات كمقروءة دفعة وحدة)
  const inOp = Object.entries(query.in || {}).map(([col, val]) => ({ op: "in", col, vals: String(val).split(",").filter(Boolean) }));
  // حالة users الخاصة: auth_user_id بالفلتر يعني id فعليًا (شرح أعلاه)
  if (table === "users") {
    for (const f of eq) if (f.col === "auth_user_id") f.col = "id";
  }
  return [...eq, ...is, ...inOp];
}

function buildWhere(filters) {
  if (!filters.length) return { sql: "", params: [] };
  const parts = [];
  const params = [];
  for (const f of filters) {
    if (f.op === "is") {
      parts.push(`\`${f.col}\` IS NULL`); // بكودنا .is() دايمًا مع null — ما فيه حاجة لدعم IS NOT NULL
    } else if (f.op === "in") {
      if (!f.vals.length) { parts.push("1=0"); continue; } // قائمة فاضية = ما فيه أي صف مطابق
      parts.push(`\`${f.col}\` IN (${f.vals.map(() => "?").join(",")})`);
      params.push(...f.vals);
    } else {
      parts.push(`\`${f.col}\` = ?`);
      params.push(f.val);
    }
  }
  return { sql: "WHERE " + parts.join(" AND "), params };
}

// حالة خاصة وحيدة بكل الكود: warehouse_assignments مع select="*, users(name, employee_id), warehouses(name)"
async function selectWarehouseAssignmentsWithJoins(conn) {
  const [rows] = await conn.query(
    `SELECT wa.*,
            u.name AS \`users.name\`, u.employee_id AS \`users.employee_id\`,
            w.name AS \`warehouses.name\`
     FROM warehouse_assignments wa
     LEFT JOIN users u ON u.id = wa.user_id
     LEFT JOIN warehouses w ON w.id = wa.warehouse_id`
  );
  return rows.map((r) => {
    const { "users.name": userName, "users.employee_id": userEmpId, "warehouses.name": whName, ...base } = r;
    return {
      ...base,
      users: userName != null || userEmpId != null ? { name: userName, employee_id: userEmpId } : null,
      warehouses: whName != null ? { name: whName } : null,
    };
  });
}

// يجلب صفوف scheduled_jobs المرتبطة بمجموعة صفوف جدول تابع (job_id column)، بأقل عدد استعلامات ممكن
async function loadRelatedJobs(conn, rows) {
  const jobIds = [...new Set(rows.map((r) => r.job_id).filter(Boolean))];
  if (!jobIds.length) return new Map();
  const [jobs] = await conn.query(`SELECT * FROM scheduled_jobs WHERE id IN (${jobIds.map(() => "?").join(",")})`, jobIds);
  return new Map(jobs.map((j) => [j.id, j]));
}

// نفس منطق resolveResponsibleAdminIds بـroutes/jobActions.js بالحرف — مكرر عمدًا هنا بدل استيراده لأن
// تلك الدالة غير مصدَّرة أصلاً (نفس القرار الموثّق هناك). مطلوب لإشعار طلب جديد "يحتاج موافقتك" بشكل
// موثوق من الباك اند مباشرة بدل sendPushNotification بالفرونت (بلاغ المالك 2026-09-18: إشعارات لا توصل
// خارج التطبيق لأنها تعتمد على بقاء متصفح مُقدِّم الطلب نفسه مفتوحًا لحظة الحفظ).
async function resolveResponsibleAdminIds(warehouseId, sectionId) {
  const [assignments] = await pool.query("SELECT * FROM warehouse_assignments");
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

router.get("/table/:table", requireAuth, async (req, res) => {
  const { table } = req.params;
  const tablePolicy = policies[table];
  if (!tablePolicy || !tablePolicy.select) return res.status(403).json({ error: "forbidden_table" });

  const authUser = { sub: req.authUserId, role: req.authRole, employee_id: req.authEmployeeId };
  const conn = pool;

  try {
    if (table === "warehouse_assignments" && String(req.query.select || "").includes("users(")) {
      const scopeCtx = await loadScopeContext(conn);
      const rows = await selectWarehouseAssignmentsWithJoins(conn);
      const visible = rows.filter((r) => tablePolicy.select(authUser, scopeCtx));
      return res.json({ data: visible, error: null });
    }

    const filters = parseFilters(req.query, table);
    const validCols = await getTableColumns(table);
    assertValidColumns(validCols, filters.map((f) => f.col));
    const { sql: whereSql, params } = buildWhere(filters);
    let orderSql = "";
    if (req.query.order) {
      assertValidColumns(validCols, [req.query.order]);
      const dir = String(req.query.dir || "asc").toLowerCase() === "desc" ? "DESC" : "ASC";
      orderSql = ` ORDER BY \`${req.query.order}\` ${dir}`;
    }
    let limitSql = "";
    if (req.query.limit) limitSql = ` LIMIT ${Number(req.query.limit) || 100}`;

    const [rows] = await conn.query(`SELECT * FROM \`${table}\` ${whereSql}${orderSql}${limitSql}`, params);

    let visible;
    if (JOB_CHILD_TABLES.has(table)) {
      const scopeCtx = await loadScopeContext(conn);
      const jobsById = await loadRelatedJobs(conn, rows);
      visible = rows.filter((r) => tablePolicy.select(authUser, scopeCtx, r, jobsById.get(r.job_id)));
    } else {
      const scopeCtx = await loadScopeContext(conn);
      visible = rows.filter((r) => tablePolicy.select(authUser, scopeCtx, r));
    }

    res.json({ data: postProcessUsersRows(table, visible), error: null });
  } catch (err) {
    if (err.statusCode === 400) return res.status(400).json({ data: null, error: err.message });
    console.error(`GET /table/${table} error:`, err);
    res.status(500).json({ data: null, error: String(err.message || err) });
  }
});

router.post("/table/:table", requireAuth, async (req, res) => {
  const { table } = req.params;
  const tablePolicy = policies[table];
  if (!tablePolicy || !tablePolicy.insert) return res.status(403).json({ error: "forbidden_table" });

  const authUser = { sub: req.authUserId, role: req.authRole, employee_id: req.authEmployeeId };
  const rowsIn = (req.body?.rows || (req.body?.row ? [req.body.row] : [])).map(stripForbidden);
  if (!rowsIn.length) return res.status(400).json({ error: "no_rows" });

  try {
    const scopeCtx = await loadScopeContext(pool);
    let jobsById = new Map();
    if (JOB_CHILD_TABLES.has(table)) {
      jobsById = await loadRelatedJobs(pool, rowsIn);
    }

    for (const row of rowsIn) {
      const allowed = JOB_CHILD_TABLES.has(table)
        ? tablePolicy.insert(authUser, scopeCtx, row, jobsById.get(row.job_id))
        : tablePolicy.insert(authUser, scopeCtx, row);
      if (!allowed) return res.status(403).json({ error: "forbidden" });
    }

    const isUpsert = !!req.body?.upsert;
    const onConflict = req.body?.onConflict; // اسم العمود صاحب UNIQUE constraint (يقابل .upsert(row, {onConflict}))
    const validCols = await getTableColumns(table);
    if (onConflict) assertValidColumns(validCols, [onConflict]);

    const inserted = [];
    for (const row of rowsIn) {
      const withId = row.id ? row : { id: genId(), ...row };
      const cols = Object.keys(withId);
      assertValidColumns(validCols, cols);
      const placeholders = cols.map(() => "?").join(",");
      const values = cols.map((c) => toMySQLValue(withId[c]));
      let sql = `INSERT INTO \`${table}\` (${cols.map((c) => `\`${c}\``).join(",")}) VALUES (${placeholders})`;
      if (isUpsert) {
        // ON DUPLICATE KEY UPDATE يعتمد على أي UNIQUE constraint موجود فعليًا بالجدول (مو بالضرورة onConflict نفسه لو id تصادف موجود)
        const updateCols = cols.filter((c) => c !== "id");
        sql += ` ON DUPLICATE KEY UPDATE ${updateCols.map((c) => `\`${c}\` = VALUES(\`${c}\`)`).join(",")}`;
      }
      await pool.query(sql, values);
      const lookupCol = isUpsert && onConflict ? onConflict : "id";
      const lookupVal = isUpsert && onConflict ? withId[onConflict] : withId.id;
      const [[fresh]] = await pool.query(`SELECT * FROM \`${table}\` WHERE \`${lookupCol}\` = ?`, [lookupVal]);
      inserted.push(fresh || withId);
    }
    if (REALTIME_TABLES.has(table)) for (const row of inserted) broadcastChange(table, "INSERT", row);
    if (table === "scheduled_jobs") for (const row of inserted) {
      notifyJobCreated(row, req.authUserId).catch((e) => console.error("notifyJobCreated error:", e.message || e));
      linkOperationToJob(row).catch((e) => console.error("linkOperationToJob error:", e.message || e));
      // Push موثوق من الباك اند مباشرة — بعكس sendPushNotification بالفرونت اللي يعتمد على بقاء متصفح
      // صاحب الإسناد نفسه مفتوحًا لحظة الحفظ (بلاغ المالك 2026-09-18: إشعارات الأعمال ما توصل خارج التطبيق)
      if (row.employee_id) {
        notifyUsersInApp([row.employee_id], {
          title: "مهمة جديدة انسندت لك", body: row.title || "عمل مجدول جديد",
          tag: `job-${row.id}`, target_screen: "job_detail", target_id: row.id,
        }).catch((e) => console.error("notifyUsersInApp (job created) error:", e.message || e));
      }
    }
    if (table === "job_contractor_checks" || table === "job_isolation_notes") {
      for (const row of inserted) notifyJobChildEvent(table, row, jobsById.get(row.job_id)).catch((e) => console.error("notifyJobChildEvent error:", e.message || e));
    }
    if (table === "orders") for (const row of inserted) {
      resolveResponsibleAdminIds(row.warehouse_id, row.section_id).then((ids) => {
        const targets = ids.filter((id) => id !== req.authUserId);
        if (!targets.length) return;
        return notifyUsersInApp(targets, {
          title: "طلب جديد يحتاج موافقتك", body: `من ${row.emp_name || ""}`,
          tag: `new-order-${row.id}`, target_screen: "admin_order_detail", target_id: row.id,
        });
      }).catch((e) => console.error("notifyUsersInApp (new order) error:", e.message || e));
    }
    res.json({ data: postProcessUsersRows(table, inserted), error: null });
  } catch (err) {
    if (err.statusCode === 400) return res.status(400).json({ data: null, error: err.message });
    console.error(`POST /table/${table} error:`, err);
    res.status(500).json({ data: null, error: String(err.message || err) });
  }
});

router.patch("/table/:table", requireAuth, async (req, res) => {
  const { table } = req.params;
  const tablePolicy = policies[table];
  if (!tablePolicy || !tablePolicy.update) return res.status(403).json({ error: "forbidden_table" });

  const authUser = { sub: req.authUserId, role: req.authRole, employee_id: req.authEmployeeId };
  const patch = stripForbidden(req.body?.patch || {});
  const filters = parseFilters(req.query, table);
  const { sql: whereSql, params } = buildWhere(filters);

  try {
    const validCols = await getTableColumns(table);
    assertValidColumns(validCols, filters.map((f) => f.col));
    assertValidColumns(validCols, Object.keys(patch));

    const [oldRows] = await pool.query(`SELECT * FROM \`${table}\` ${whereSql}`, params);
    if (!oldRows.length) return res.json({ data: [], error: null });

    const scopeCtx = await loadScopeContext(pool);
    let jobsById = new Map();
    if (JOB_CHILD_TABLES.has(table)) jobsById = await loadRelatedJobs(pool, oldRows);

    const updated = [];
    for (const oldRow of oldRows) {
      const newRow = { ...oldRow, ...patch };
      const allowed = JOB_CHILD_TABLES.has(table)
        ? tablePolicy.update(authUser, scopeCtx, oldRow, newRow, jobsById.get(oldRow.job_id))
        : tablePolicy.update(authUser, scopeCtx, oldRow, newRow);
      if (!allowed) continue; // نفس سلوك RLS: صف غير مسموح يُترك بدون تعديل، بلا خطأ عام

      const cols = Object.keys(patch);
      if (cols.length) {
        const setSql = cols.map((c) => `\`${c}\` = ?`).join(",");
        const values = cols.map((c) => toMySQLValue(patch[c]));
        await pool.query(`UPDATE \`${table}\` SET ${setSql} WHERE id = ?`, [...values, oldRow.id]);
      }
      const [[fresh]] = await pool.query(`SELECT * FROM \`${table}\` WHERE id = ?`, [oldRow.id]);
      updated.push(fresh);
      if (table === "scheduled_jobs") {
        notifyJobStageChange(oldRow, fresh, req.authUserId).catch((e) => console.error("notifyJobStageChange error:", e.message || e));
        if (oldRow.status !== "completed" && fresh.status === "completed") {
          notifyJobCompletionReport(fresh).catch((e) => console.error("notifyJobCompletionReport error:", e.message || e));
          sendJobCompletionPdf(fresh).catch((e) => console.error("sendJobCompletionPdf error:", e.message || e));
        }
        if (oldRow.employee_id !== fresh.employee_id && fresh.employee_id) {
          notifyUsersInApp([fresh.employee_id], {
            title: "مهمة جديدة انسندت لك", body: fresh.title || "عمل مجدول جديد",
            tag: `job-${fresh.id}`, target_screen: "job_detail", target_id: fresh.id,
          }).catch((e) => console.error("notifyUsersInApp (job reassigned) error:", e.message || e));
        }
      }
      if (table === "orders" && oldRow.status !== fresh.status && fresh.user_id && fresh.user_id !== req.authUserId) {
        notifyUsersInApp([fresh.user_id], {
          title: "تغيرت حالة طلبك", body: fresh.status || "",
          tag: `order-${fresh.id}`, target_screen: "admin_order_detail", target_id: fresh.id,
        }).catch((e) => console.error("notifyUsersInApp (order status) error:", e.message || e));
      }
      if (table === "operations" && oldRow.status !== fresh.status) {
        notifyOperationsSupervisors(fresh, "status_changed", { from: oldRow.status, to: fresh.status }).catch((e) => console.error("notifyOperationsSupervisors error:", e.message || e));
      }
    }
    if (REALTIME_TABLES.has(table)) for (const row of updated) broadcastChange(table, "UPDATE", row);
    res.json({ data: postProcessUsersRows(table, updated), error: null });
  } catch (err) {
    if (err.statusCode === 400) return res.status(400).json({ data: null, error: err.message });
    console.error(`PATCH /table/${table} error:`, err);
    res.status(500).json({ data: null, error: String(err.message || err) });
  }
});

router.delete("/table/:table", requireAuth, async (req, res) => {
  const { table } = req.params;
  const tablePolicy = policies[table];
  if (!tablePolicy || !tablePolicy.delete) return res.status(403).json({ error: "forbidden_table" });

  const authUser = { sub: req.authUserId, role: req.authRole, employee_id: req.authEmployeeId };
  const filters = parseFilters(req.query, table);
  const { sql: whereSql, params } = buildWhere(filters);

  try {
    const validCols = await getTableColumns(table);
    assertValidColumns(validCols, filters.map((f) => f.col));

    const [rows] = await pool.query(`SELECT * FROM \`${table}\` ${whereSql}`, params);
    if (!rows.length) return res.json({ data: [], error: null });

    const scopeCtx = await loadScopeContext(pool);
    let jobsById = new Map();
    if (JOB_CHILD_TABLES.has(table)) jobsById = await loadRelatedJobs(pool, rows);

    const deleted = [];
    for (const row of rows) {
      const allowed = JOB_CHILD_TABLES.has(table)
        ? tablePolicy.delete(authUser, scopeCtx, row, jobsById.get(row.job_id))
        : tablePolicy.delete(authUser, scopeCtx, row);
      if (!allowed) continue;
      await pool.query(`DELETE FROM \`${table}\` WHERE id = ?`, [row.id]);
      deleted.push(row);
    }
    if (REALTIME_TABLES.has(table)) for (const row of deleted) broadcastChange(table, "DELETE", row);
    res.json({ data: deleted, error: null });
  } catch (err) {
    if (err.statusCode === 400) return res.status(400).json({ data: null, error: err.message });
    console.error(`DELETE /table/${table} error:`, err);
    res.status(500).json({ data: null, error: String(err.message || err) });
  }
});

export default router;
