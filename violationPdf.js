// توليد PDF لنموذج رصد مخالفات مقاول — نسخة إلكترونية من "النموذج الميداني لرصد المخالفات لأعمال المقاولين
// للعقد الموحد 2026"، تُصدَّر بنفس ترتيب النموذج الورقي الأصلي (بيانات الزيارة، ثم كل مخالفة مُسجَّلة مع
// صورها، ثم التوقيعات) — نفس أسلوب jobPdf.js بالضبط (Puppeteer، بدون حيلة arabicImgTag).
import { pool } from "./db.js";
import { VIOLATION_TYPES } from "./violationTypes.js";

function fmtDate(d) {
  if (!d) return "—";
  const dt = new Date(d);
  return `${String(dt.getDate()).padStart(2, "0")}/${String(dt.getMonth() + 1).padStart(2, "0")}/${dt.getFullYear()}`;
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    browserPromise = import("puppeteer").then((m) =>
      m.default.launch({ headless: "new", args: ["--no-sandbox", "--disable-setuid-sandbox"] })
    );
  }
  return browserPromise;
}

export async function generateViolationReportPdfBuffer(reportId) {
  const [[report]] = await pool.query("SELECT * FROM violation_reports WHERE id = ?", [reportId]);
  if (!report) throw new Error("report_not_found");
  const items = Array.isArray(report.items) ? report.items : JSON.parse(report.items || "[]");
  const checkedItems = items.filter((it) => it.checked);

  const violationRows = checkedItems.map((it) => {
    const meta = VIOLATION_TYPES.find((v) => v.code === it.code);
    const desc = it.desc || meta?.desc || "";
    const injuryLabel = it.has_injury === true ? "نعم" : it.has_injury === false ? "لا" : "غير محدد";
    const imgs = it.image_urls || [];
    return `
      <div class="violation">
        <div class="v-head">
          <span class="v-code">${esc(it.code)}</span>
          <span class="v-injury">وجود إصابة: <b>${injuryLabel}</b></span>
        </div>
        <div class="v-desc">${esc(desc)}</div>
        ${it.note ? `<div class="v-note">📝 ${esc(it.note)}</div>` : ""}
        ${imgs.length ? `<div class="photo-grid">${imgs.map((u) => `<img src="${esc(u)}"/>`).join("")}</div>` : ""}
      </div>
    `;
  }).join("");

  const html = `<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Cairo:wght@400;700;800&display=swap');
    * { box-sizing: border-box; }
    body { font-family: 'Cairo', sans-serif; direction: rtl; text-align: right; color: #0f172a; padding: 8px 32px; }
    h1 { text-align:center; font-size:19px; color:#1e3a5f; margin:0; }
    .sub { text-align:center; font-size:12px; color:#64748b; margin-top:4px; }
    .hdr { border-bottom:2px solid #1e3a5f; padding-bottom:12px; margin-bottom:16px; }
    table.info { width:100%; border-collapse:collapse; font-size:12.5px; margin-bottom:18px; }
    table.info td { padding:6px 8px; border:1px solid #e2e8f0; }
    table.info td.label { width:110px; font-weight:700; color:#475569; background:#f8fafc; }
    .section-title { font-size:14px; font-weight:800; color:#1e3a5f; margin:0 0 10px; }
    .violation { border:1px solid #fecaca; background:#fef2f2; border-radius:8px; padding:10px 12px; margin-bottom:10px; page-break-inside: avoid; }
    .v-head { display:flex; justify-content:space-between; align-items:center; margin-bottom:4px; }
    .v-code { font-weight:800; color:#991b1b; font-size:13.5px; }
    .v-injury { font-size:12.5px; color:#991b1b; }
    .v-desc { font-size:14px; color:#334155; margin-bottom:8px; }
    .v-note { font-size:13.5px; color:#334155; background:#fff; border-radius:6px; padding:6px 8px; margin-bottom:8px; }
    .photo-grid { display:flex; flex-wrap:wrap; gap:10px; }
    .photo-grid img { width:100%; max-width:480px; height:auto; object-fit:contain; border-radius:8px; border:1px solid #fecaca; page-break-inside: avoid; }
    .empty { color:#94a3b8; font-size:13px; text-align:center; padding:14px 0; }
    .sign-table { width:100%; border-collapse:collapse; font-size:12.5px; margin-top:18px; }
    .sign-table td { border:1px solid #e2e8f0; padding:14px 8px; text-align:center; }
    .sign-table td.label { font-weight:700; color:#475569; background:#f8fafc; }
  </style></head><body>
    <div class="hdr">
      <h1>النموذج الميداني لرصد المخالفات لأعمال المقاولين</h1>
      <div class="sub">DistCtrl – نظام إدارة الأعمال والمواد</div>
    </div>
    <table class="info">
      <tr><td class="label">الإدارة</td><td>${esc(report.department_name) || "—"}</td><td class="label">الدائرة</td><td>${esc(report.division_name) || "—"}</td></tr>
      <tr><td class="label">الموقع</td><td>${esc(report.location) || "—"}</td><td class="label">التاريخ</td><td>${fmtDate(report.report_date)}${report.report_time ? " - " + esc(report.report_time) : ""}</td></tr>
      <tr><td class="label">المقاول</td><td colspan="3">${esc(report.contractor_name)}</td></tr>
      <tr><td class="label">وصف العمل</td><td colspan="3">${esc(report.work_description) || "—"}</td></tr>
      <tr><td class="label">رقم المشروع</td><td colspan="3">${esc(report.project_no) || "—"}</td></tr>
    </table>
    <div class="section-title">المخالفات المرصودة (${checkedItems.length})</div>
    ${checkedItems.length ? violationRows : '<div class="empty">لا توجد مخالفات مسجّلة بهذا النموذج</div>'}
    ${report.notes ? `<div class="section-title" style="margin-top:16px;">ملاحظات</div><div style="font-size:12.5px; color:#334155;">${esc(report.notes)}</div>` : ""}
    <table class="sign-table">
      <tr>
        <td class="label">الراصد</td>
        <td class="label">الرقم الوظيفي</td>
        <td class="label">مشرف المقاول</td>
        <td class="label">رقم البطاقة/الإقامة</td>
      </tr>
      <tr>
        <td>${esc(report.observer_name) || "—"}</td>
        <td>${esc(report.observer_employee_id) || "—"}</td>
        <td>${esc(report.contractor_rep_name) || "—"}</td>
        <td>${esc(report.contractor_rep_id) || "—"}</td>
      </tr>
    </table>
  </body></html>`;

  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 30000 });
    // Buffer.from(...) إلزامي — page.pdf() ترجّع Uint8Array خام؛ res.send() بالراوت المصدِّر يتحقق بـBuffer.isBuffer()
    // فيرمّز Uint8Array العادي JSON بدل إرسال البايتات الخام، فيوصل ملف "PDF" تالف (شاشة سودة عند الفتح)
    return Buffer.from(await page.pdf({ format: "A4", printBackground: true, margin: { top: "20px", bottom: "20px", left: "20px", right: "20px" } }));
  } finally {
    await page.close();
  }
}
