// تخزين ملفات محلي على قرص الـVPS — يحل محل الـ٣ buckets بـSupabase Storage
// (job-photos, product-images: عامة يُشار لها مباشرة بـ<img src>؛ backups: خاصة، وصول عبر مسار موثّق فقط)
//
// عقد الاتصال مع طبقة التوافق بالفرونت (يقابل supabase.storage.from(bucket)...):
//   PUT    /api/storage/:bucket/*path   body: raw binary  -> يقابل upload(path, blob, opts)
//   DELETE /api/storage/:bucket         body: { paths: [] } -> يقابل remove([path])
//   GET    /api/storage/:bucket/list    ?prefix=&sortColumn=&sortOrder= -> يقابل list(prefix, opts)
//   GET    /api/storage/:bucket/download/*path -> يقابل download(path) (Blob)
// getPublicUrl لا يحتاج طلب شبكة أصلاً بالنسخة الأصلية (متزامن، مجرد تركيب رابط) — نفس الشي هنا:
// الشِم بالفرونت يبنيه محليًا كـ`${API_BASE}/uploads/${bucket}/${path}` بدون المرور بهذا الملف إطلاقًا.
import express from "express";
import fs from "fs";
import path from "path";
import { requireAuth } from "./auth.js";

const UPLOADS_DIR = path.resolve(process.env.UPLOADS_DIR || "./uploads");
// job-reports: PDF تقارير إغلاق العمل المولّدة تلقائيًا (jobPdf.js) — تُكتب مباشرة من السيرفر (بدون
// مرور بمسار PUT الموثّق أعلاه، ما فيه عميل خارجي يرفع لها) وتُخدَّم عامة عشان واتساب يقدر يجيبها برابط
// issue-reports: صور مرفقة ببلاغات "مشكلة تقنية" (شاشة استقبال البلاغات الخاصة بالمالك) — عامة زي job-photos
const PUBLIC_BUCKETS = new Set(["job-photos", "product-images", "job-reports", "issue-reports"]); // تُخدَّم مباشرة عبر /uploads (متل bucket عام بـSupabase)
const KNOWN_BUCKETS = new Set(["job-photos", "product-images", "backups", "job-reports", "issue-reports"]);

// يكتب ملف مباشرة ببucket عام — للاستخدام الداخلي بالسيرفر بس (cron.js, jobNotifications.js)، بدون طلب HTTP
export function writePublicFile(bucket, filename, buffer) {
  if (!PUBLIC_BUCKETS.has(bucket)) throw new Error("not_a_public_bucket");
  const dest = safeJoin(bucketDir(bucket), filename);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buffer);
  // الاسم الفعلي على القرص يبقى نصًا عاديًا (يدعم مسافات/عربي) — بس بالرابط لازم يترمّز (encodeURIComponent)،
  // وإلا مسافات/أحرف عربية بأسماء ملفات وصفية (زي تقرير عمل مكتمل) تنتج رابط غير صالح تفشل بوابة الواتساب
  // تنزيله. express.static يفكّ الترميز تلقائيًا وقت التقديم، فما يحتاج أي تغيير بجهة القراءة.
  return `${process.env.PUBLIC_API_URL || "https://api.distctrl.com"}/uploads/${bucket}/${encodeURIComponent(filename)}`;
}

function bucketDir(bucket) {
  return path.join(UPLOADS_DIR, bucket);
}

// يمنع الخروج عن مجلد الـbucket عبر "../" بالمسار المُرسَل من العميل
function safeJoin(base, userPath) {
  const resolved = path.resolve(base, userPath);
  if (!resolved.startsWith(path.resolve(base))) throw new Error("invalid_path");
  return resolved;
}

export const router = express.Router();

router.put("/storage/:bucket/*", requireAuth, express.raw({ type: "*/*", limit: "15mb" }), async (req, res) => {
  const { bucket } = req.params;
  const filePath = req.params[0];
  if (!KNOWN_BUCKETS.has(bucket)) return res.status(404).json({ data: null, error: "unknown_bucket" });
  try {
    const dest = safeJoin(bucketDir(bucket), filePath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, req.body);
    res.json({ data: { path: filePath, id: filePath, fullPath: `${bucket}/${filePath}` }, error: null });
  } catch (err) {
    res.status(500).json({ data: null, error: String(err.message || err) });
  }
});

router.delete("/storage/:bucket", requireAuth, express.json(), async (req, res) => {
  const { bucket } = req.params;
  const { paths } = req.body || {};
  if (!KNOWN_BUCKETS.has(bucket)) return res.status(404).json({ data: null, error: "unknown_bucket" });
  try {
    for (const p of paths || []) {
      try {
        const target = safeJoin(bucketDir(bucket), p);
        if (fs.existsSync(target)) fs.unlinkSync(target);
      } catch { /* تجاهل مسار غير صالح/غير موجود بمصفوفة الحذف — نفس تسامح Supabase remove() */ }
    }
    res.json({ data: paths, error: null });
  } catch (err) {
    res.status(500).json({ data: null, error: String(err.message || err) });
  }
});

router.get("/storage/:bucket/list", requireAuth, async (req, res) => {
  const { bucket } = req.params;
  const prefix = req.query.prefix || "";
  if (!KNOWN_BUCKETS.has(bucket)) return res.status(404).json({ data: null, error: "unknown_bucket" });
  try {
    const dir = safeJoin(bucketDir(bucket), prefix);
    if (!fs.existsSync(dir)) return res.json({ data: [], error: null });
    let entries = fs.readdirSync(dir).map((name) => {
      const stat = fs.statSync(path.join(dir, name));
      return { name, id: name, updated_at: stat.mtime.toISOString(), created_at: stat.birthtime.toISOString(), metadata: { size: stat.size } };
    });
    const sortCol = req.query.sortColumn || "name";
    const desc = (req.query.sortOrder || "asc") === "desc";
    entries.sort((a, b) => (a[sortCol] > b[sortCol] ? 1 : -1) * (desc ? -1 : 1));
    res.json({ data: entries, error: null });
  } catch (err) {
    res.status(500).json({ data: null, error: String(err.message || err) });
  }
});

router.get("/storage/:bucket/download/*", requireAuth, async (req, res) => {
  const { bucket } = req.params;
  const filePath = req.params[0];
  if (!KNOWN_BUCKETS.has(bucket)) return res.status(404).end();
  try {
    const target = safeJoin(bucketDir(bucket), filePath);
    if (!fs.existsSync(target)) return res.status(404).json({ error: "not_found" });
    res.sendFile(target);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// تقديم static لـbuckets العامة فقط (job-photos, product-images) — نفس سلوك bucket عام بـSupabase Storage.
// backups مقصود استبعاده هنا عمدًا — وصوله فقط عبر /download الموثّق أعلاه (يحتاج توكن صالح)
export function mountPublicBuckets(app) {
  for (const bucket of PUBLIC_BUCKETS) {
    app.use(`/uploads/${bucket}`, express.static(bucketDir(bucket)));
  }
}

export { UPLOADS_DIR };
