// تقارير البريد (يومي/أسبوعي/شهري) — منقولة بالحرف عن daily-reportsupabase (283 سطر) وperiodic-report (536 سطر)
// الأصليتين. الفرق الوحيد: مصدر البيانات pool.query (MySQL) بدل supabase.from() (Postgres)، والباقي
// (كل HTML، كل حساب، كل نص) نفسه حرفيًا.
import { pool } from "./db.js";
import "dotenv/config";
import { sendWhatsAppText, isWhatsAppConfigured } from "./whatsapp.js";

const OVERDUE_DAYS = 2;

function fmtDate(d) {
  if (!d) return "—";
  const dt = new Date(d);
  const day = String(dt.getDate()).padStart(2, "0");
  const mon = String(dt.getMonth() + 1).padStart(2, "0");
  const year = dt.getFullYear();
  const hr = String(dt.getHours()).padStart(2, "0");
  const min = String(dt.getMinutes()).padStart(2, "0");
  return `${day}/${mon}/${year} - ${hr}:${min}`;
}
function fmtDateShort(d) {
  if (!d) return "—";
  const dt = new Date(d);
  return `${String(dt.getDate()).padStart(2, "0")}/${String(dt.getMonth() + 1).padStart(2, "0")}/${dt.getFullYear()}`;
}
function todayShort() {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
}
function orderRef(o) {
  return o?.order_no ? `#${o.order_no}` : "—";
}
function parseItems(o) {
  if (!o.items) return [];
  return typeof o.items === "string" ? JSON.parse(o.items) : o.items;
}

async function sendEmail({ to, subject, html, attachments }) {
  // مجموعة مستلمين ممكن تصير إيميلاتها فاضية بعد إضافة phone (مستلم واتساب بس بدون إيميل) — Resend يرفض "to" فاضية
  if (!to?.length) return { skipped: true, reason: "no_email_recipients" };
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: "تقرير المستودعات <onboarding@resend.dev>", to, subject, html, ...(attachments ? { attachments } : {}) }),
  });
  return res.json();
}

async function loadRecipientGroups(reportType, onlyScopeType, onlyScopeId) {
  const [rows] = await pool.query(
    "SELECT email, phone, scope_type, scope_id FROM report_recipients WHERE report_type = ?",
    [reportType]
  );
  const scopeGroups = {};
  for (const r of rows) {
    const key = `${r.scope_type}:${r.scope_id || ""}`;
    if (!scopeGroups[key]) scopeGroups[key] = { scope_type: r.scope_type, scope_id: r.scope_id, emails: [], phones: [] };
    if (r.email) scopeGroups[key].emails.push(r.email);
    if (r.phone) scopeGroups[key].phones.push(r.phone);
  }
  let groups = Object.values(scopeGroups);
  if (onlyScopeType) groups = groups.filter((g) => g.scope_type === onlyScopeType && (g.scope_id || null) === onlyScopeId);
  return groups;
}

// نسخة نصية مختصرة من التقرير — بديل عملي عن الـHTML الكامل (واتساب ما يعرض HTML)، تُرسل بالتوازي
// مع الإيميل لأي رقم مسجّل بنفس مجموعة المستلمين. فشل هذا الإرسال لا يوقف ولا يغيّر نتيجة الإيميل الأساسي.
//
// موقوفة مؤقتًا بطلب صريح (2026-09-03) — تحتاج تفعيل صريح عبر WHATSAPP_REPORTS_ENABLED=true بـ.env
// (بقية ميزات واتساب — الإشعارات وبيانات الدخول — غير متأثرة، تشتغل بمجرد ما WHATSAPP_* الأساسية تُضبط).
function isWhatsAppReportsEnabled() {
  return process.env.WHATSAPP_REPORTS_ENABLED === "true";
}
async function sendWhatsAppDigest(group, text) {
  if (!isWhatsAppReportsEnabled() || !isWhatsAppConfigured() || !group.phones?.length) return [];
  const results = await Promise.allSettled(group.phones.map((p) => sendWhatsAppText(p, text)));
  return results;
}

// ============================================================
// daily-reportsupabase — تقرير يومي شامل
// ============================================================
export async function sendDailyReport({ scope_type = null, scope_id = null, override_recipients = null } = {}) {
  const groups = override_recipients
    ? [{ scope_type: "org", scope_id: null, emails: override_recipients }]
    : await loadRecipientGroups("daily", scope_type, scope_id);
  if (!groups.length) return { success: false, error: "لا يوجد مستلمون" };

  const [[orders], [products], [sections], [warehouses]] = await Promise.all([
    pool.query("SELECT * FROM orders ORDER BY created_at DESC"),
    pool.query("SELECT * FROM products WHERE is_active = 1 ORDER BY name"),
    pool.query("SELECT * FROM sections WHERE is_active = 1 ORDER BY name"),
    pool.query("SELECT * FROM warehouses WHERE is_active = 1"),
  ]);

  const warehousesById = {}; warehouses.forEach((w) => { warehousesById[w.id] = w.name; });
  const sectionsById = {}; sections.forEach((s) => { sectionsById[s.id] = s.name; });

  const orderItemsHtml = (items) => {
    if (!items?.length) return `<div style="color:#64748b;font-size:11px;margin-top:4px;">لا توجد مواد</div>`;
    return `<div style="margin-top:6px;border-top:1px solid #cbd5e1;padding-top:6px;">
      ${items.map((it) => `
        <div style="display:flex;justify-content:space-between;font-size:12px;color:#1e293b;padding:2px 0;">
          <span>${it.name || "—"} <span style="color:#64748b;font-size:10px;">(${it.sku || ""})</span></span>
          <span style="font-weight:700;color:#1e293b;">${it.requested ?? it.quantity ?? "—"} ${it.unit || ""}</span>
        </div>`).join("")}
    </div>`;
  };
  const rowsHtml = (items, emptyMsg) => {
    if (!items.length) return `<p style="color:#64748b;font-size:13px;margin:4px 0;">${emptyMsg}</p>`;
    return items.map((o) => `
      <div style="background:#f8fafc;border-radius:10px;padding:10px 14px;margin-bottom:6px;font-size:13px;">
        <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:4px;">
          <span><b style="color:#1e293b;">${o.emp_name || "—"}</b>${o.emp_no ? ` <span style="color:#475569;font-size:11px;">(${o.emp_no})</span>` : ""} <span style="color:#2563eb;font-weight:700;">${orderRef(o)}</span></span>
          <span style="color:#64748b;font-size:11px;">${fmtDate(o.submitted_at || o.created_at)}</span>
        </div>
        ${o.approved_by_name ? `<div style="font-size:11px;color:#16a34a;margin-top:4px;">✅ وافق: ${o.approved_by_name} (${o.approved_by_no || ""}) — ${fmtDate(o.approved_at)}</div>` : ""}
        ${orderItemsHtml(parseItems(o))}
      </div>`).join("");
  };
  const stockRowsHtml = (items, color, emptyMsg) => {
    if (!items.length) return `<p style="color:#64748b;font-size:13px;margin:4px 0;">${emptyMsg}</p>`;
    return items.map((p) => `
      <div style="background:#f8fafc;border-radius:10px;padding:8px 14px;margin-bottom:5px;font-size:13px;display:flex;justify-content:space-between;">
        <span><b style="color:#1e293b;">${p.name}</b> <span style="color:#64748b;font-size:10px;">(${p.sku})</span></span>
        <span style="color:${color};font-weight:700;">${p.quantity} ${p.unit}</span>
      </div>`).join("");
  };
  const inventoryTableHtml = (items) => {
    if (!items.length) return `<p style="color:#64748b;font-size:13px;">لا توجد مواد</p>`;
    const rows = items.map((p, i) => `
      <tr style="background:${i % 2 === 0 ? "#f8fafc" : "#ffffff"};">
        <td style="padding:6px 8px;font-size:12px;color:#1e3a5f;font-weight:600;text-align:right;">${p.name}</td>
        <td style="padding:6px 8px;font-size:11px;color:#475569;text-align:center;direction:ltr;">${p.sku || "—"}</td>
        <td style="padding:6px 8px;font-size:12px;font-weight:700;color:${p.quantity === 0 ? "#dc2626" : p.quantity <= (p.min_stock || 0) && p.min_stock ? "#d97706" : "#16a34a"};text-align:left;">${p.quantity} ${p.unit || ""}</td>
      </tr>`).join("");
    return `<table style="width:100%;border-collapse:collapse;">
      <thead><tr style="background:#1e3a5f;">
        <th style="padding:7px 8px;font-size:11px;color:#fff;text-align:right;">اسم المادة</th>
        <th style="padding:7px 8px;font-size:11px;color:#fff;text-align:center;">رقم التخزين</th>
        <th style="padding:7px 8px;font-size:11px;color:#fff;text-align:left;">المتبقي</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  };
  const inventoryBySectionHtml = (scopedProducts) => {
    const bySection = {};
    scopedProducts.forEach((p) => { const key = p.section_id || "__none__"; (bySection[key] ||= []).push(p); });
    const groupsArr = Object.keys(bySection)
      .map((key) => ({ name: sectionsById[key] || "بدون قسم", items: bySection[key] }))
      .sort((a, b) => a.name.localeCompare("ar"));
    return groupsArr.length === 0
      ? `<p style="color:#94a3b8;font-size:13px;">لا توجد مواد</p>`
      : groupsArr.map((g) => `
        <div style="margin-bottom:12px;">
          <div style="font-size:12px;font-weight:800;color:#2563eb;background:#eff6ff;padding:6px 10px;border-radius:8px;margin-bottom:6px;">📂 ${g.name} (${g.items.length})</div>
          ${inventoryTableHtml(g.items)}
        </div>`).join("");
  };

  const scopeFilter = (group) => {
    if (group.scope_type === "warehouse") {
      return { label: warehousesById[group.scope_id] || "قسم محذوف", orders: orders.filter((o) => o.warehouse_id === group.scope_id), products: products.filter((p) => p.warehouse_id === group.scope_id) };
    }
    if (group.scope_type === "section") {
      return { label: sectionsById[group.scope_id] || "مجموعة محذوفة", orders: orders.filter((o) => o.section_id === group.scope_id), products: products.filter((p) => p.section_id === group.scope_id) };
    }
    return { label: "المؤسسة بالكامل", orders, products };
  };

  const buildHtml = (scopeLabel, scopedOrders, scopedProducts) => {
    const pendingOrders = scopedOrders.filter((o) => o.status === "قيد المراجعة");
    const waitingOrders = scopedOrders.filter((o) => o.status === "في الانتظار");
    const processingOrders = scopedOrders.filter((o) => o.status === "جاري التجهيز");
    const outOfStock = scopedProducts.filter((p) => p.quantity === 0);
    const lowStock = scopedProducts.filter((p) => p.quantity > 0 && p.quantity <= (p.min_stock || 0));
    const td = todayShort();
    return `
    <div style="font-family:Arial,sans-serif;direction:rtl;max-width:600px;margin:0 auto;background:#f6f8fb;padding:20px;">
      <div style="background:linear-gradient(135deg,#1e3a5f,#2563eb);color:#fff;border-radius:16px;padding:20px;text-align:center;margin-bottom:18px;">
        <h2 style="margin:0;font-size:20px;">📊 التقرير اليومي</h2>
        <p style="margin:4px 0 0;opacity:.85;font-size:13px;">${scopeLabel} — ${td}</p>
      </div>
      <div style="display:flex;gap:8px;margin-bottom:16px;">
        <div style="flex:1;background:#fef9e7;border-radius:12px;padding:12px;text-align:center;">
          <div style="font-size:20px;font-weight:800;color:#b45309;">${pendingOrders.length}</div>
          <div style="font-size:11px;color:#64748b;">قيد المراجعة</div>
        </div>
        <div style="flex:1;background:#eff6ff;border-radius:12px;padding:12px;text-align:center;">
          <div style="font-size:20px;font-weight:800;color:#1d4ed8;">${waitingOrders.length}</div>
          <div style="font-size:11px;color:#64748b;">في الانتظار</div>
        </div>
        <div style="flex:1;background:#f5f3ff;border-radius:12px;padding:12px;text-align:center;">
          <div style="font-size:20px;font-weight:800;color:#6d28d9;">${processingOrders.length}</div>
          <div style="font-size:11px;color:#64748b;">جاري التجهيز</div>
        </div>
        <div style="flex:1;background:#fef2f2;border-radius:12px;padding:12px;text-align:center;">
          <div style="font-size:20px;font-weight:800;color:#dc2626;">${outOfStock.length}</div>
          <div style="font-size:11px;color:#64748b;">مواد نفدت</div>
        </div>
      </div>
      <div style="background:#fff;border-radius:14px;padding:14px;margin-bottom:12px;">
        <h3 style="margin:0 0 10px;font-size:14px;color:#1e3a5f;">📋 طلبات قيد المراجعة</h3>
        ${rowsHtml(pendingOrders, "لا توجد طلبات قيد المراجعة")}
      </div>
      <div style="background:#fff;border-radius:14px;padding:14px;margin-bottom:12px;">
        <h3 style="margin:0 0 10px;font-size:14px;color:#1d4ed8;">⏳ طلبات في الانتظار</h3>
        ${rowsHtml(waitingOrders, "لا توجد طلبات في الانتظار")}
      </div>
      <div style="background:#fff;border-radius:14px;padding:14px;margin-bottom:12px;">
        <h3 style="margin:0 0 10px;font-size:14px;color:#dc2626;">⚠️ مواد نفدت تماماً (${outOfStock.length})</h3>
        ${stockRowsHtml(outOfStock, "#dc2626", "لا توجد مواد نافدة ✅")}
      </div>
      <div style="background:#fff;border-radius:14px;padding:14px;margin-bottom:12px;">
        <h3 style="margin:0 0 10px;font-size:14px;color:#d97706;">🔶 مواد قاربت على النفاد (${lowStock.length})</h3>
        ${stockRowsHtml(lowStock, "#d97706", "لا توجد مواد قاربت على النفاد ✅")}
      </div>
      <div style="background:#fff;border-radius:14px;padding:14px;margin-bottom:12px;">
        <h3 style="margin:0 0 10px;font-size:14px;color:#1e3a5f;">📦 جرد كامل بالمخزون حسب القسم (${scopedProducts.length} مادة)</h3>
        ${inventoryBySectionHtml(scopedProducts)}
      </div>
      <p style="text-align:center;color:#94a3b8;font-size:11px;margin-top:16px;">تقرير تلقائي يومي — ${scopeLabel}</p>
    </div>`;
  };

  const sendResults = [];
  for (const group of groups) {
    const { label, orders: scopedOrders, products: scopedProducts } = scopeFilter(group);
    const html = buildHtml(label, scopedOrders, scopedProducts);
    const result = await sendEmail({ to: group.emails, subject: `📊 التقرير اليومي — ${label} — ${todayShort()}`, html });

    const pendingN = scopedOrders.filter((o) => o.status === "قيد المراجعة").length;
    const waitingN = scopedOrders.filter((o) => o.status === "في الانتظار").length;
    const processingN = scopedOrders.filter((o) => o.status === "جاري التجهيز").length;
    const outOfStockN = scopedProducts.filter((p) => p.quantity === 0).length;
    const lowStockN = scopedProducts.filter((p) => p.quantity > 0 && p.quantity <= (p.min_stock || 0)).length;
    const waText = `📊 *التقرير اليومي* — ${label} — ${todayShort()}\n\n` +
      `📋 قيد المراجعة: ${pendingN}\n⏳ في الانتظار: ${waitingN}\n🔧 جاري التجهيز: ${processingN}\n` +
      `⚠️ مواد نفدت: ${outOfStockN}\n🔶 قاربت على النفاد: ${lowStockN}`;
    await sendWhatsAppDigest(group, waText);

    sendResults.push({ scope_type: group.scope_type, scope_id: group.scope_id, label, recipients: group.emails, result });
  }
  return { success: true, sent: sendResults };
}

// ============================================================
// periodic-report — أسبوعي/شهري
// ============================================================
export async function sendPeriodicReport(type = "weekly", { scope_type = null, scope_id = null } = {}) {
  const isMonthly = type === "monthly";
  const groups = await loadRecipientGroups(type, scope_type, scope_id);
  if (!groups.length) return { success: false, error: "لا يوجد مستلمون" };

  const [[products], [warehouses], [sections]] = await Promise.all([
    pool.query("SELECT * FROM products WHERE is_active = 1 ORDER BY name"),
    pool.query("SELECT * FROM warehouses WHERE is_active = 1"),
    pool.query("SELECT * FROM sections WHERE is_active = 1"),
  ]);
  const warehousesById = {}; warehouses.forEach((w) => { warehousesById[w.id] = w.name; });
  const sectionsById = {}; sections.forEach((s) => { sectionsById[s.id] = s.name; });

  const scopeLabel = (group) => {
    if (group.scope_type === "warehouse") return warehousesById[group.scope_id] || "قسم محذوف";
    if (group.scope_type === "section") return sectionsById[group.scope_id] || "مجموعة محذوفة";
    return "المؤسسة بالكامل";
  };
  const scopeProducts = (group) => {
    if (group.scope_type === "warehouse") return products.filter((p) => p.warehouse_id === group.scope_id);
    if (group.scope_type === "section") return products.filter((p) => p.section_id === group.scope_id);
    return products;
  };
  const scopeOrdersFilter = (group) => (o) => {
    if (group.scope_type === "warehouse") return o.warehouse_id === group.scope_id;
    if (group.scope_type === "section") return o.section_id === group.scope_id;
    return true;
  };

  // ═══════════ الأسبوعي (بسيط، مؤسسة كاملة) ═══════════
  if (!isMonthly) {
    const now = new Date();
    const from = new Date(now);
    from.setDate(now.getDate() - 7);
    from.setHours(0, 0, 0, 0);

    const [orders] = await pool.query("SELECT * FROM orders WHERE created_at >= ? ORDER BY created_at DESC", [from]);

    const dispatchedOrders = orders.filter((o) => o.status === "تم الصرف");
    const rejectedOrders = orders.filter((o) => o.status === "مرفوض");
    const pendingOrders = orders.filter((o) => o.status === "قيد المراجعة");
    const periodLabel = `الأسبوع ${fmtDateShort(from)} — ${fmtDateShort(now)}`;
    const outOfStock = products.filter((p) => p.quantity === 0);
    const lowStock = products.filter((p) => p.quantity > 0 && p.quantity <= (p.min_stock || 0));

    const itemCount = {};
    orders.forEach((o) => parseItems(o).forEach((it) => {
      if (!itemCount[it.name]) itemCount[it.name] = { name: it.name, sku: it.sku, unit: it.unit, total: 0 };
      itemCount[it.name].total += it.requested || 0;
    }));
    const topItems = Object.values(itemCount).sort((a, b) => b.total - a.total).slice(0, 10);

    const orderRowsHtml = (items) => {
      if (!items.length) return `<p style="color:#94a3b8;font-size:12px;">لا توجد طلبات</p>`;
      return items.slice(0, 15).map((o) => `
        <div style="background:#f8fafc;border-radius:8px;padding:8px 12px;margin-bottom:5px;font-size:12px;">
          <div style="display:flex;justify-content:space-between;">
            <span><b>${o.emp_name || "—"}</b>${o.emp_no ? ` (${o.emp_no})` : ""} — طلب #${o.order_no || "—"}</span>
            <span style="color:#94a3b8;">${fmtDateShort(o.submitted_at || o.created_at)}</span>
          </div>
          ${o.approved_by_name ? `<div style="font-size:11px;color:#16a34a;margin-top:3px;">✅ وافق: ${o.approved_by_name}${o.approved_by_no ? ` (${o.approved_by_no})` : ""}</div>` : ""}
        </div>`).join("") + (items.length > 15 ? `<p style="color:#94a3b8;font-size:11px;text-align:center;">... و${items.length - 15} طلب إضافي</p>` : "");
    };
    const inventoryHtml = (items) => {
      if (!items.length) return `<p style="color:#94a3b8;font-size:12px;margin:4px 0;">لا توجد مواد</p>`;
      return items.map((p) => `
        <div style="background:#f8fafc;border-radius:8px;padding:7px 12px;margin-bottom:4px;font-size:12px;display:flex;justify-content:space-between;">
          <span><b>${p.name}</b> <span style="color:#94a3b8;font-size:10px;">(${p.sku})</span></span>
          <span style="font-weight:700;color:${p.quantity === 0 ? "#dc2626" : "#d97706"}">${p.quantity} ${p.unit}</span>
        </div>`).join("");
    };
    const topItemsHtml = topItems.length === 0
      ? `<p style="color:#94a3b8;font-size:12px;">لا توجد بيانات</p>`
      : topItems.map((it, i) => `
        <div style="background:#f8fafc;border-radius:8px;padding:7px 12px;margin-bottom:4px;font-size:12px;display:flex;justify-content:space-between;align-items:center;">
          <span><span style="color:#94a3b8;font-weight:700;margin-left:8px;">${i + 1}</span> <b>${it.name}</b> <span style="color:#94a3b8;font-size:10px;">(${it.sku || ""})</span></span>
          <span style="font-weight:800;color:#1e3a5f;">${it.total} ${it.unit || ""}</span>
        </div>`).join("");

    const html = `
    <div style="font-family:Arial,sans-serif;direction:rtl;max-width:600px;margin:0 auto;background:#f6f8fb;padding:20px;">
      <div style="background:linear-gradient(135deg,#0e7490,#0891b2);color:#fff;border-radius:16px;padding:20px;text-align:center;margin-bottom:18px;">
        <h2 style="margin:0;font-size:20px;">📆 التقرير الأسبوعي</h2>
        <p style="margin:4px 0 0;opacity:.85;font-size:13px;">${periodLabel}</p>
      </div>
      <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;">
        <div style="flex:1;min-width:100px;background:#eff6ff;border-radius:12px;padding:12px;text-align:center;">
          <div style="font-size:22px;font-weight:800;color:#2563eb;">${orders.length}</div>
          <div style="font-size:11px;color:#64748b;">إجمالي الطلبات</div>
        </div>
        <div style="flex:1;min-width:100px;background:#f0fdf4;border-radius:12px;padding:12px;text-align:center;">
          <div style="font-size:22px;font-weight:800;color:#16a34a;">${dispatchedOrders.length}</div>
          <div style="font-size:11px;color:#64748b;">تم صرفها</div>
        </div>
        <div style="flex:1;min-width:100px;background:#fef9e7;border-radius:12px;padding:12px;text-align:center;">
          <div style="font-size:22px;font-weight:800;color:#b45309;">${pendingOrders.length}</div>
          <div style="font-size:11px;color:#64748b;">قيد المراجعة</div>
        </div>
        <div style="flex:1;min-width:100px;background:#fef2f2;border-radius:12px;padding:12px;text-align:center;">
          <div style="font-size:22px;font-weight:800;color:#dc2626;">${rejectedOrders.length}</div>
          <div style="font-size:11px;color:#64748b;">مرفوضة</div>
        </div>
      </div>
      <div style="background:#fff;border-radius:14px;padding:14px;margin-bottom:12px;">
        <h3 style="margin:0 0 10px;font-size:14px;color:#1e3a5f;">🔥 أكثر المواد طلباً في الفترة</h3>
        ${topItemsHtml}
      </div>
      <div style="background:#fff;border-radius:14px;padding:14px;margin-bottom:12px;">
        <h3 style="margin:0 0 10px;font-size:14px;color:#16a34a;">✅ طلبات تم صرفها (${dispatchedOrders.length})</h3>
        ${orderRowsHtml(dispatchedOrders)}
      </div>
      <div style="background:#fff;border-radius:14px;padding:14px;margin-bottom:12px;">
        <h3 style="margin:0 0 10px;font-size:14px;color:#dc2626;">❌ طلبات مرفوضة (${rejectedOrders.length})</h3>
        ${orderRowsHtml(rejectedOrders)}
      </div>
      <div style="background:#fff;border-radius:14px;padding:14px;margin-bottom:12px;">
        <h3 style="margin:0 0 10px;font-size:14px;color:#dc2626;">⚠️ مواد نفدت (${outOfStock.length})</h3>
        ${inventoryHtml(outOfStock)}
        ${outOfStock.length === 0 ? '<p style="color:#16a34a;font-size:12px;">✅ لا توجد مواد نافدة</p>' : ""}
      </div>
      ${lowStock.length > 0 ? `
      <div style="background:#fff;border-radius:14px;padding:14px;margin-bottom:12px;">
        <h3 style="margin:0 0 10px;font-size:14px;color:#d97706;">🔶 مواد قاربت على النفاد (${lowStock.length})</h3>
        ${inventoryHtml(lowStock)}
      </div>` : ""}
      <p style="text-align:center;color:#94a3b8;font-size:11px;margin-top:16px;">التقرير الأسبوعي التلقائي — نظام إدارة المواد والطلبات</p>
    </div>`;

    const result = await sendEmail({ to: groups[0].emails, subject: `📆 التقرير الأسبوعي — ${periodLabel}`, html });

    const waText = `📆 *التقرير الأسبوعي* — ${periodLabel}\n\n` +
      `📦 إجمالي الطلبات: ${orders.length}\n✅ تم صرفها: ${dispatchedOrders.length}\n` +
      `📋 قيد المراجعة: ${pendingOrders.length}\n❌ مرفوضة: ${rejectedOrders.length}\n` +
      `⚠️ مواد نفدت: ${outOfStock.length}\n🔶 قاربت على النفاد: ${lowStock.length}`;
    await sendWhatsAppDigest(groups[0], waText);

    return { success: true, type, period: periodLabel, result };
  }

  // ═══════════ الشهري (لوحة مؤشرات) ═══════════
  const now = new Date();
  const firstOfThisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = firstOfThisMonth;
  const from = new Date(Date.UTC(firstOfThisMonth.getUTCFullYear(), firstOfThisMonth.getUTCMonth() - 1, 1));
  const prevFrom = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() - 1, 1));

  const [rangeOrders] = await pool.query(
    "SELECT * FROM orders WHERE created_at >= ? AND created_at < ? ORDER BY created_at DESC",
    [prevFrom, to]
  );
  const periodLabel = `${fmtDateShort(from)} — ${fmtDateShort(new Date(to.getTime() - 86400000))}`;

  const genNow = new Date();
  const startOfToday = new Date(Date.UTC(genNow.getUTCFullYear(), genNow.getUTCMonth(), genNow.getUTCDate()));
  const sevenDaysAgo = new Date(genNow.getTime() - 7 * 86400000);
  const [recentOrders] = await pool.query(
    "SELECT id, created_at, warehouse_id, section_id FROM orders WHERE created_at >= ?",
    [sevenDaysAgo]
  );

  const fmtDuration = (ms) => {
    if (ms == null) return "—";
    const hrs = ms / 3600000;
    if (hrs < 1) return `${Math.max(1, Math.round(ms / 60000))} دقيقة`;
    if (hrs < 24) return `${hrs.toFixed(1)} ساعة`;
    return `${(hrs / 24).toFixed(1)} يوم`;
  };
  const pctChange = (curVal, prevVal, higherIsBetter = true, neutral = false) => {
    if (!prevVal) return `<span style="font-size:11px;color:#94a3b8;">لا توجد بيانات سابقة للمقارنة</span>`;
    const diff = ((curVal - prevVal) / prevVal) * 100;
    const up = diff >= 0;
    const arrow = diff === 0 ? "→" : up ? "▲" : "▼";
    let color = "#94a3b8";
    if (!neutral && diff !== 0) { const good = higherIsBetter ? up : !up; color = good ? "#16a34a" : "#dc2626"; }
    else if (neutral && diff !== 0) { color = up ? "#2563eb" : "#64748b"; }
    return `<span style="font-size:11px;color:${color};font-weight:700;">${arrow} ${Math.abs(diff).toFixed(0)}% عن الشهر السابق</span>`;
  };
  const kpiCard = (icon, label, value, changeHtml, bg, color) => `
    <div style="flex:1;min-width:150px;background:${bg};border-radius:12px;padding:14px;text-align:center;">
      <div style="font-size:20px;font-weight:800;color:${color};">${icon} ${value}</div>
      <div style="font-size:11px;color:#64748b;margin-top:2px;">${label}</div>
      <div style="margin-top:6px;">${changeHtml}</div>
    </div>`;

  const computeStats = (periodOrders) => {
    const total = periodOrders.length;
    const dispatched = periodOrders.filter((o) => o.status === "تم الصرف");
    const rejected = periodOrders.filter((o) => o.status === "مرفوض");
    const pending = periodOrders.filter((o) => !["تم الصرف", "مرفوض"].includes(o.status));
    const dispatchRate = total ? (dispatched.length / total) * 100 : 0;
    const rejectionRate = total ? (rejected.length / total) * 100 : 0;
    const approvalDurations = periodOrders.filter((o) => o.approved_at && o.submitted_at)
      .map((o) => new Date(o.approved_at).getTime() - new Date(o.submitted_at).getTime());
    const avgApproval = approvalDurations.length ? approvalDurations.reduce((a, b) => a + b, 0) / approvalDurations.length : null;
    const dispatchDurations = dispatched.filter((o) => o.approved_at && o.updated_at)
      .map((o) => new Date(o.updated_at).getTime() - new Date(o.approved_at).getTime());
    const avgDispatch = dispatchDurations.length ? dispatchDurations.reduce((a, b) => a + b, 0) / dispatchDurations.length : null;
    return { total, dispatched, rejected, pending, dispatchRate, rejectionRate, avgApproval, avgDispatch };
  };

  const buildMonthlyHtml = (label, scopedRangeOrders, scopedProducts, scopedRecentOrders) => {
    const curOrders = scopedRangeOrders.filter((o) => { const t = new Date(o.created_at); return t >= from && t < to; });
    const prevOrders = scopedRangeOrders.filter((o) => { const t = new Date(o.created_at); return t >= prevFrom && t < from; });
    const cur = computeStats(curOrders);
    const prev = computeStats(prevOrders);

    const outOfStock = scopedProducts.filter((p) => p.quantity === 0);
    const lowStock = scopedProducts.filter((p) => p.quantity > 0 && p.quantity <= (p.min_stock || 0));
    const criticalMaterials = outOfStock.length + lowStock.length;
    const totalItems = scopedProducts.length;
    const available = scopedProducts.filter((p) => p.quantity > 0).length;
    const availabilityPct = totalItems ? (available / totalItems) * 100 : 0;

    const overdueOrders = cur.pending.filter((o) => Date.now() - new Date(o.submitted_at || o.created_at).getTime() > OVERDUE_DAYS * 86400000);
    const awaitingDispatch = curOrders.filter((o) => o.status === "جاري التجهيز");
    const todayCount = scopedRecentOrders.filter((o) => new Date(o.created_at) >= startOfToday).length;
    const weekCount = scopedRecentOrders.length;

    const itemCount = {};
    curOrders.forEach((o) => parseItems(o).forEach((it) => {
      if (!itemCount[it.name]) itemCount[it.name] = { name: it.name, sku: it.sku, unit: it.unit, total: 0 };
      itemCount[it.name].total += it.requested || 0;
    }));
    const topItems = Object.values(itemCount).sort((a, b) => b.total - a.total).slice(0, 8);
    const topItemsMax = Math.max(1, ...topItems.map((i) => i.total));
    const topItemsBarHtml = topItems.length === 0
      ? `<p style="color:#94a3b8;font-size:12px;">لا توجد بيانات</p>`
      : topItems.map((it) => {
        const pct = (it.total / topItemsMax) * 100;
        return `
        <div style="margin-bottom:10px;">
          <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px;">
            <span><b>${it.name}</b> <span style="color:#94a3b8;font-size:10px;">(${it.sku || ""})</span></span>
            <span style="font-weight:800;color:#1e3a5f;">${it.total} ${it.unit || ""}</span>
          </div>
          <div style="background:#f1f5f9;border-radius:6px;height:10px;overflow:hidden;">
            <div style="width:${pct}%;background:linear-gradient(90deg,#7c3aed,#a855f7);height:100%;"></div>
          </div>
        </div>`;
      }).join("");

    const statusBarHtml = (() => {
      const total = cur.total;
      if (!total) return `<p style="color:#94a3b8;font-size:12px;">لا توجد طلبات بهذي الفترة</p>`;
      const dPct = (cur.dispatched.length / total) * 100;
      const pPct = (cur.pending.length / total) * 100;
      const rPct = (cur.rejected.length / total) * 100;
      return `
        <div style="display:flex;height:22px;border-radius:8px;overflow:hidden;margin-bottom:10px;">
          ${dPct > 0 ? `<div style="width:${dPct}%;background:#16a34a;"></div>` : ""}
          ${pPct > 0 ? `<div style="width:${pPct}%;background:#d97706;"></div>` : ""}
          ${rPct > 0 ? `<div style="width:${rPct}%;background:#dc2626;"></div>` : ""}
        </div>
        <div style="display:flex;gap:14px;flex-wrap:wrap;font-size:11px;color:#475569;">
          <span><span style="display:inline-block;width:9px;height:9px;background:#16a34a;border-radius:2px;margin-left:4px;"></span>تم الصرف ${dPct.toFixed(0)}%</span>
          <span><span style="display:inline-block;width:9px;height:9px;background:#d97706;border-radius:2px;margin-left:4px;"></span>قيد المعالجة ${pPct.toFixed(0)}%</span>
          <span><span style="display:inline-block;width:9px;height:9px;background:#dc2626;border-radius:2px;margin-left:4px;"></span>مرفوضة ${rPct.toFixed(0)}%</span>
        </div>`;
    })();

    const trendChartHtml = (() => {
      const days = [];
      const cursor = new Date(from);
      while (cursor < to) { days.push(new Date(cursor)); cursor.setUTCDate(cursor.getUTCDate() + 1); }
      const counts = days.map((d) => {
        const dayStr = d.toISOString().slice(0, 10);
        return curOrders.filter((o) => String(o.submitted_at || o.created_at || "").slice(0, 10) === dayStr).length;
      });
      const max = Math.max(1, ...counts);
      const cells = days.map((d, i) => {
        const h = Math.max(2, Math.round((counts[i] / max) * 60));
        return `<td style="text-align:center;vertical-align:bottom;padding:0 1px;">
          <div style="height:60px;display:flex;align-items:flex-end;justify-content:center;">
            <div style="width:5px;height:${h}px;background:#2563eb;border-radius:2px;"></div>
          </div>
          <div style="font-size:7px;color:#94a3b8;margin-top:2px;">${d.getUTCDate()}</div>
        </td>`;
      }).join("");
      return `<table style="width:100%;border-collapse:collapse;"><tr>${cells}</tr></table>`;
    })();

    const alerts = [];
    if (outOfStock.length) alerts.push(`⚠️ يوجد ${outOfStock.length} مادة نافدة تماماً`);
    if (lowStock.length) alerts.push(`🔶 يوجد ${lowStock.length} مادة قاربت على النفاد`);
    if (overdueOrders.length) alerts.push(`⏰ يوجد ${overdueOrders.length} طلب متأخر (أكثر من ${OVERDUE_DAYS} يوم بدون معالجة)`);
    if (awaitingDispatch.length) alerts.push(`📦 يوجد ${awaitingDispatch.length} طلب بانتظار الصرف`);
    const alertsHtml = alerts.length === 0
      ? `<p style="color:#16a34a;font-size:13px;font-weight:700;">✅ لا توجد تنبيهات، كل شي تمام</p>`
      : alerts.map((a) => `<div style="background:#fef2f2;border-radius:8px;padding:10px 14px;margin-bottom:6px;font-size:13px;color:#7f1d1d;font-weight:600;">${a}</div>`).join("");

    const dispatchDurTotals = cur.dispatched.filter((o) => o.submitted_at && o.updated_at)
      .map((o) => ({ o, ms: new Date(o.updated_at).getTime() - new Date(o.submitted_at).getTime() }))
      .sort((a, b) => a.ms - b.ms);
    const fastest = dispatchDurTotals[0];
    const slowest = dispatchDurTotals[dispatchDurTotals.length - 1];
    const oldestPending = [...cur.pending].sort((a, b) => new Date(a.submitted_at || a.created_at).getTime() - new Date(b.submitted_at || b.created_at).getTime())[0];

    const html = `
    <div style="font-family:Arial,sans-serif;direction:rtl;max-width:600px;margin:0 auto;background:#f6f8fb;padding:20px;">
      <div style="background:linear-gradient(135deg,#7c3aed,#a855f7);color:#fff;border-radius:16px;padding:20px;text-align:center;margin-bottom:18px;">
        <h2 style="margin:0;font-size:20px;">📅 التقرير الشهري</h2>
        <p style="margin:4px 0 0;opacity:.85;font-size:13px;">${label} — ${periodLabel}</p>
      </div>
      <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;">
        ${kpiCard("📦", "إجمالي الطلبات", cur.total, pctChange(cur.total, prev.total, true, true), "#eff6ff", "#2563eb")}
        ${kpiCard("✅", "نسبة الصرف", `${cur.dispatchRate.toFixed(0)}%`, pctChange(cur.dispatchRate, prev.dispatchRate, true), "#f0fdf4", "#16a34a")}
        ${kpiCard("❌", "نسبة الرفض", `${cur.rejectionRate.toFixed(0)}%`, pctChange(cur.rejectionRate, prev.rejectionRate, false), "#fef2f2", "#dc2626")}
      </div>
      <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;">
        ${kpiCard("⏳", "متوسط مدة الاعتماد", fmtDuration(cur.avgApproval), pctChange(cur.avgApproval || 0, prev.avgApproval || 0, false), "#fef9e7", "#b45309")}
        ${kpiCard("⏱️", "متوسط مدة الصرف", fmtDuration(cur.avgDispatch), pctChange(cur.avgDispatch || 0, prev.avgDispatch || 0, false), "#f5f3ff", "#6d28d9")}
        ${kpiCard("🚨", "مواد حرجة", criticalMaterials, "", "#fff1f2", "#e11d48")}
      </div>
      <div style="background:#fff;border-radius:14px;padding:14px;margin-bottom:12px;display:flex;gap:8px;">
        <div style="flex:1;text-align:center;"><div style="font-size:18px;font-weight:800;color:#1e3a5f;">${todayCount}</div><div style="font-size:10px;color:#94a3b8;">طلبات اليوم</div></div>
        <div style="flex:1;text-align:center;border-right:1px solid #e2e8f0;border-left:1px solid #e2e8f0;"><div style="font-size:18px;font-weight:800;color:#1e3a5f;">${weekCount}</div><div style="font-size:10px;color:#94a3b8;">طلبات آخر أسبوع</div></div>
        <div style="flex:1;text-align:center;"><div style="font-size:18px;font-weight:800;color:#1e3a5f;">${cur.total}</div><div style="font-size:10px;color:#94a3b8;">طلبات الشهر</div></div>
      </div>
      <div style="background:#fff;border-radius:14px;padding:14px;margin-bottom:12px;">
        <h3 style="margin:0 0 10px;font-size:14px;color:#1e3a5f;">📊 توزيع حالات الطلبات</h3>
        ${statusBarHtml}
      </div>
      <div style="background:#fff;border-radius:14px;padding:14px;margin-bottom:12px;">
        <h3 style="margin:0 0 10px;font-size:14px;color:#1e3a5f;">🔥 أكثر المواد طلباً</h3>
        ${topItemsBarHtml}
      </div>
      <div style="background:#fff;border-radius:14px;padding:14px;margin-bottom:12px;">
        <h3 style="margin:0 0 10px;font-size:14px;color:#1e3a5f;">📦 مؤشرات المخزون</h3>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <div style="flex:1;min-width:100px;text-align:center;"><div style="font-size:16px;font-weight:800;color:#1e3a5f;">${totalItems}</div><div style="font-size:10px;color:#94a3b8;">إجمالي الأصناف</div></div>
          <div style="flex:1;min-width:100px;text-align:center;"><div style="font-size:16px;font-weight:800;color:#16a34a;">${available}</div><div style="font-size:10px;color:#94a3b8;">متوفرة</div></div>
          <div style="flex:1;min-width:100px;text-align:center;"><div style="font-size:16px;font-weight:800;color:#d97706;">${lowStock.length}</div><div style="font-size:10px;color:#94a3b8;">قليلة المخزون</div></div>
          <div style="flex:1;min-width:100px;text-align:center;"><div style="font-size:16px;font-weight:800;color:#dc2626;">${outOfStock.length}</div><div style="font-size:10px;color:#94a3b8;">نافدة</div></div>
          <div style="flex:1;min-width:100px;text-align:center;"><div style="font-size:16px;font-weight:800;color:#2563eb;">${availabilityPct.toFixed(0)}%</div><div style="font-size:10px;color:#94a3b8;">نسبة التوفر</div></div>
        </div>
      </div>
      <div style="background:#fff;border-radius:14px;padding:14px;margin-bottom:12px;">
        <h3 style="margin:0 0 10px;font-size:14px;color:#1e3a5f;">⏱️ مؤشرات الأداء الزمنية</h3>
        <div style="font-size:12px;color:#475569;line-height:2;">
          <div>متوسط مدة اعتماد الطلب: <b>${fmtDuration(cur.avgApproval)}</b></div>
          <div>متوسط مدة الصرف: <b>${fmtDuration(cur.avgDispatch)}</b></div>
          <div>أسرع طلب تم صرفه: <b>${fastest ? `#${fastest.o.order_no || "—"} — ${fmtDuration(fastest.ms)}` : "—"}</b></div>
          <div>أبطأ طلب تم صرفه: <b>${slowest ? `#${slowest.o.order_no || "—"} — ${fmtDuration(slowest.ms)}` : "—"}</b></div>
          <div>أقدم طلب ما زال قيد المعالجة: <b>${oldestPending ? `#${oldestPending.order_no || "—"} — منذ ${fmtDuration(Date.now() - new Date(oldestPending.submitted_at || oldestPending.created_at).getTime())}` : "لا يوجد"}</b></div>
        </div>
      </div>
      <div style="background:#fff;border-radius:14px;padding:14px;margin-bottom:12px;">
        <h3 style="margin:0 0 10px;font-size:14px;color:#1e3a5f;">📈 اتجاه الطلبات خلال الشهر</h3>
        ${trendChartHtml}
      </div>
      <div style="background:#fff;border-radius:14px;padding:14px;margin-bottom:12px;">
        <h3 style="margin:0 0 10px;font-size:14px;color:#dc2626;">🔔 التنبيهات</h3>
        ${alertsHtml}
      </div>
      <p style="text-align:center;color:#94a3b8;font-size:11px;margin-top:16px;">التقرير الشهري التلقائي — ${label}</p>
    </div>`;
    const waText = `📅 *التقرير الشهري* — ${label} — ${periodLabel}\n\n` +
      `📦 إجمالي الطلبات: ${cur.total}\n✅ تم صرفها: ${cur.dispatched.length} (${cur.dispatchRate.toFixed(0)}%)\n` +
      `❌ مرفوضة: ${cur.rejected.length} (${cur.rejectionRate.toFixed(0)}%)\n⏳ قيد المتابعة: ${cur.pending.length}\n` +
      `⚠️ مواد حرجة (نفدت/قاربت): ${criticalMaterials}\n📊 توفر المخزون: ${availabilityPct.toFixed(0)}%`;
    return { html, waText };
  };

  const sendResults = [];
  for (const group of groups) {
    const label = scopeLabel(group);
    const filterFn = scopeOrdersFilter(group);
    const scopedRangeOrders = rangeOrders.filter(filterFn);
    const scopedProducts = scopeProducts(group);
    const scopedRecentOrders = recentOrders.filter(filterFn);
    const { html, waText } = buildMonthlyHtml(label, scopedRangeOrders, scopedProducts, scopedRecentOrders);
    const result = await sendEmail({ to: group.emails, subject: `📅 التقرير الشهري — ${label} — ${periodLabel}`, html });
    await sendWhatsAppDigest(group, waText);
    sendResults.push({ scope_type: group.scope_type, scope_id: group.scope_id, label, recipients: group.emails, result });
  }
  return { success: true, type, period: periodLabel, sent: sendResults };
}
