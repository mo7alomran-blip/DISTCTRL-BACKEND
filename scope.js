// طبقة الصلاحيات (تحل محل RLS + الدوال المساعدة is_owner/is_admin/in_my_scope اللي كانت بـPostgres)
// منقولة سطر-بسطر عن منطق الدوال الحقيقية (استُخرجت عبر pg_get_functiondef بتاريخ 2026-08-28) —
// مو إعادة بناء تخمينية. الفرق الوحيد: هنا نستقبل بيانات المستخدم من JWT بدل auth.uid()،
// فما نحتاج نستعلم عن current_app_user_id() من جدول users في كل مرة.
import { pool } from "./db.js";

export const OWNER_EMPLOYEE_ID = "90507"; // نفس OWNER_ID بـsrc/lib/constants.js

export function isOwner(authUser) {
  return authUser?.employee_id === OWNER_EMPLOYEE_ID;
}

export function isAdmin(authUser) {
  return authUser?.role === "admin";
}

// يطابق is_admin_or_viewer() الأصلية: صلاحية اطّلاع بنطاق (بدون تعديل) لمشرف/مدير/مشغل
export function isAdminOrViewer(authUser) {
  return ["admin", "manager", "operator"].includes(authUser?.role);
}

// يطابق منطق in_my_scope(p_warehouse_id, p_section_id) الأصلي بالضبط —
// ثلاثة مستويات مستقلة (section/warehouse/division)، كل واحد يُفحص لحاله بـOR، وفتح تلقائي لو ما فيه أي تخصيص إطلاقًا.
// storageLocationId (اختياري، بآخر البارامترات حتى ما نكسر أي استدعاء قديم بـ4 معطيات): فحص إضافي
// OR بالهيكل التنظيمي الجديد (مستودع حقيقي storage_locations + دائرة مُشتقة من قسم/مجموعة عبر
// resolveDivisionForSection) — يزيد فرص القبول فقط، بدون أي تعديل على المتغيرات/المنطق الأصلي أعلاه.
export async function inMyScope(authUser, warehouseId, sectionId, conn = pool, storageLocationId = null) {
  if (isOwner(authUser)) return true;
  const userId = authUser.sub;

  let divisionId = null;
  if (warehouseId) {
    const [[wh]] = await conn.query("SELECT division_id FROM warehouses WHERE id = ?", [warehouseId]);
    divisionId = wh?.division_id || null;
  }

  const [[{ sectionCount }]] = await conn.query(
    "SELECT COUNT(*) AS sectionCount FROM warehouse_assignments WHERE section_id IS NOT NULL AND section_id = ?",
    [sectionId]
  );
  let sectionHit = false;
  if (sectionCount > 0) {
    const [[{ hit }]] = await conn.query(
      "SELECT EXISTS(SELECT 1 FROM warehouse_assignments WHERE section_id = ? AND user_id = ?) AS hit",
      [sectionId, userId]
    );
    sectionHit = !!hit;
  }

  const [[{ warehouseCount }]] = await conn.query(
    "SELECT COUNT(*) AS warehouseCount FROM warehouse_assignments WHERE warehouse_id = ? AND section_id IS NULL AND division_id IS NULL",
    [warehouseId]
  );
  let warehouseHit = false;
  if (warehouseCount > 0) {
    const [[{ hit }]] = await conn.query(
      "SELECT EXISTS(SELECT 1 FROM warehouse_assignments WHERE warehouse_id = ? AND section_id IS NULL AND division_id IS NULL AND user_id = ?) AS hit",
      [warehouseId, userId]
    );
    warehouseHit = !!hit;
  }

  const [[{ divisionCount }]] = await conn.query(
    "SELECT COUNT(*) AS divisionCount FROM warehouse_assignments WHERE division_id IS NOT NULL AND division_id = ?",
    [divisionId]
  );
  let divisionHit = false;
  if (divisionCount > 0) {
    const [[{ hit }]] = await conn.query(
      "SELECT EXISTS(SELECT 1 FROM warehouse_assignments WHERE division_id = ? AND user_id = ?) AS hit",
      [divisionId, userId]
    );
    divisionHit = !!hit;
  }

  // ── إضافي (هيكل جديد): دائرة مُشتقة من قسم/مجموعة sectionId (تمشي فوق لو "مجموعة" تابعة لقسم) ──
  let newDivisionHit = false;
  if (sectionId) {
    const newDivisionId = await resolveDivisionForSection(sectionId, conn);
    if (newDivisionId && newDivisionId !== divisionId) {
      const [[{ hit }]] = await conn.query(
        "SELECT EXISTS(SELECT 1 FROM warehouse_assignments WHERE division_id = ? AND user_id = ?) AS hit",
        [newDivisionId, userId]
      );
      newDivisionHit = !!hit;
    }
  }

  // ── إضافي (هيكل جديد): تخصيص مباشر على مستوى المستودع الحقيقي (storage_locations) ──
  let storageLocationHit = false;
  if (storageLocationId) {
    const [[{ hit }]] = await conn.query(
      "SELECT EXISTS(SELECT 1 FROM warehouse_assignments WHERE storage_location_id = ? AND user_id = ?) AS hit",
      [storageLocationId, userId]
    );
    storageLocationHit = !!hit;
  }

  if (sectionHit || warehouseHit || divisionHit || newDivisionHit || storageLocationHit) return true;

  // لا يوجد أي تخصيص إطلاقًا على هذا الطلب (لا قسم فرعي، لا مستودع، لا دائرة) بالمنطق القديم:
  // أي مشرف بدون أي تخصيص بأي مكان يقدر يتصرف (فتح تلقائي) — يطابق سلوك RLS الأصلي بالحرف.
  // (هذا الشرط ما تغيّر إطلاقًا — لسه يعتمد على معدّات القديم فقط، عمدًا، حتى ما يتغيّر سلوك
  // أي حالة ماهيش مرتبطة بالهيكل الجديد)
  if (sectionCount === 0 && warehouseCount === 0 && divisionCount === 0) {
    const [[{ myTotal }]] = await conn.query(
      "SELECT COUNT(*) AS myTotal FROM warehouse_assignments WHERE user_id = ?",
      [userId]
    );
    return myTotal === 0;
  }

  return false;
}

// اختصار شائع بكل الـroutes: "مالك أو (مشرف ونطاقه يشمل هذا المستودع/القسم)"
export async function canActInScope(authUser, warehouseId, sectionId, conn = pool) {
  if (isOwner(authUser)) return true;
  if (!isAdmin(authUser)) return false;
  return inMyScope(authUser, warehouseId, sectionId, conn);
}

// ── نسخة "دفعة واحدة" من in_my_scope لفلترة قوائم (SELECT على عدة صفوف) بدون استعلام DB لكل صف ──
// جدول warehouse_assignments وwarehouses تنظيمية صغيرة (مو بيانات معاملات)، فتحميلها كاملة مرة
// وحدة بالطلب رخيص جدًا، ويطابق نتيجة in_my_scope الأصلية صفًا-بصف بالضبط.
export async function loadScopeContext(conn = pool) {
  const [assignments] = await conn.query(
    "SELECT user_id, warehouse_id, section_id, division_id, storage_location_id FROM warehouse_assignments"
  );
  const [warehouses] = await conn.query("SELECT id, division_id FROM warehouses");
  const [allSections] = await conn.query("SELECT id, division_id, parent_section_id FROM sections");

  const warehouseDivision = new Map(warehouses.map((w) => [w.id, w.division_id]));
  const sectionAssignees = new Map();   // section_id -> Set(user_id) — يخدم "قسم" و"مجموعة" الجديدين معًا (نفس الجدول)
  const warehouseAssignees = new Map(); // warehouse_id -> Set(user_id) — تخصيص "مستودع كامل" فقط (بدون قسم/دائرة على نفس الصف)
  const divisionAssignees = new Map();  // division_id -> Set(user_id)
  const storageLocationAssignees = new Map(); // storage_location_id -> Set(user_id) — مستودع حقيقي بالهيكل الجديد
  const userAssignmentCount = new Map(); // user_id -> عدد كل تخصيصاته أيًا كان مستواها

  for (const a of assignments) {
    userAssignmentCount.set(a.user_id, (userAssignmentCount.get(a.user_id) || 0) + 1);
    if (a.section_id) {
      if (!sectionAssignees.has(a.section_id)) sectionAssignees.set(a.section_id, new Set());
      sectionAssignees.get(a.section_id).add(a.user_id);
    } else if (a.warehouse_id && !a.division_id) {
      if (!warehouseAssignees.has(a.warehouse_id)) warehouseAssignees.set(a.warehouse_id, new Set());
      warehouseAssignees.get(a.warehouse_id).add(a.user_id);
    }
    // ملاحظة: هذا الشرط منفصل ومستقل عمدًا (مو else) — نفس استعلام v_division_count الأصلي
    // يفحص division_id بغض النظر عن باقي أعمدة نفس الصف
    if (a.division_id) {
      if (!divisionAssignees.has(a.division_id)) divisionAssignees.set(a.division_id, new Set());
      divisionAssignees.get(a.division_id).add(a.user_id);
    }
    if (a.storage_location_id) {
      if (!storageLocationAssignees.has(a.storage_location_id)) storageLocationAssignees.set(a.storage_location_id, new Set());
      storageLocationAssignees.get(a.storage_location_id).add(a.user_id);
    }
  }

  // (هيكل جديد) لكل قسم/مجموعة، نحسب مسبقًا دائرته الفعلية — يمشي فوق تلقائيًا عبر parent_section_id
  // لو كان "مجموعة" تابعة لقسم، حتى يوصل لصف عنده division_id مباشرة. حد أقصى 5 قفزات يمنع أي حلقة.
  const sectionById = new Map(allSections.map((s) => [s.id, s]));
  const sectionDivisionResolved = new Map(); // section_id -> division_id المُشتقة (أو null)
  for (const s of allSections) {
    let current = s;
    let divisionId = null;
    for (let i = 0; i < 5 && current; i++) {
      if (current.division_id) { divisionId = current.division_id; break; }
      current = current.parent_section_id ? sectionById.get(current.parent_section_id) : null;
    }
    sectionDivisionResolved.set(s.id, divisionId);
  }

  return {
    warehouseDivision, sectionAssignees, warehouseAssignees, divisionAssignees,
    storageLocationAssignees, sectionDivisionResolved, userAssignmentCount,
  };
}

// يرجّع division_id الفعلي لقسم أو مجموعة معيّن (نسخة غير محمّلة مسبقًا، بستعلام حي) — تُستخدم من
// inMyScope (async) وأي كود ثاني محتاج الفحص خارج سياق loadScopeContext المحمّل مسبقًا للقوائم.
export async function resolveDivisionForSection(sectionId, conn = pool) {
  let current = sectionId;
  for (let i = 0; i < 5 && current; i++) {
    const [[row]] = await conn.query("SELECT division_id, parent_section_id FROM sections WHERE id = ?", [current]);
    if (!row) return null;
    if (row.division_id) return row.division_id;
    current = row.parent_section_id;
  }
  return null;
}

// نسخة sync من in_my_scope تعمل على scopeCtx محمّل مسبقًا (loadScopeContext) — نفس المنطق الأصلي حرفيًا،
// مع إضافتين OR بالهيكل الجديد (storageLocationId + دائرة مُشتقة من sectionId عبر sectionDivisionResolved)
// لا تغيّر أي متغير أو شرط بالمنطق الأصلي — فقط تزيد فرص القبول (return true) قبل الوصول له.
export function inMyScopeSync(scopeCtx, authUser, warehouseId, sectionId, storageLocationId = null) {
  if (isOwner(authUser)) return true;
  const userId = authUser.sub;
  const divisionId = warehouseId ? scopeCtx.warehouseDivision.get(warehouseId) : null;

  const sectionSet = sectionId ? scopeCtx.sectionAssignees.get(sectionId) : undefined;
  const sectionCount = sectionSet ? sectionSet.size : 0;
  const sectionHit = sectionCount > 0 && sectionSet.has(userId);

  const warehouseSet = warehouseId ? scopeCtx.warehouseAssignees.get(warehouseId) : undefined;
  const warehouseCount = warehouseSet ? warehouseSet.size : 0;
  const warehouseHit = warehouseCount > 0 && warehouseSet.has(userId);

  const divisionSet = divisionId ? scopeCtx.divisionAssignees.get(divisionId) : undefined;
  const divisionCount = divisionSet ? divisionSet.size : 0;
  const divisionHit = divisionCount > 0 && divisionSet.has(userId);

  // ── إضافي (هيكل جديد): دائرة مُشتقة من قسم/مجموعة sectionId (تمشي فوق لو "مجموعة" تابعة لقسم) ──
  let newDivisionHit = false;
  if (sectionId) {
    const newDivisionId = scopeCtx.sectionDivisionResolved?.get(sectionId);
    if (newDivisionId && newDivisionId !== divisionId) {
      const set = scopeCtx.divisionAssignees.get(newDivisionId);
      newDivisionHit = !!(set && set.has(userId));
    }
  }

  // ── إضافي (هيكل جديد): تخصيص مباشر على مستوى المستودع الحقيقي (storage_locations) ──
  let storageLocationHit = false;
  if (storageLocationId) {
    const set = scopeCtx.storageLocationAssignees?.get(storageLocationId);
    storageLocationHit = !!(set && set.has(userId));
  }

  if (sectionHit || warehouseHit || divisionHit || newDivisionHit || storageLocationHit) return true;

  // لا يوجد أي تخصيص إطلاقًا على هذا المورد المحدد بالمنطق القديم: فتح تلقائي فقط لمشرف بلا أي تخصيص
  // بأي مكان. (هذا الشرط بدون أي تغيير — يعتمد فقط على معدّات القديم عمدًا)
  if (sectionCount === 0 && warehouseCount === 0 && divisionCount === 0) {
    return !(scopeCtx.userAssignmentCount.get(userId) > 0);
  }
  return false;
}
