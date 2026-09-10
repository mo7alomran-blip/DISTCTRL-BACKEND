// نقل بيانات حقيقي، مرة واحدة: من Postgres (Supabase) الحيّة إلى MySQL المحلية الجديدة.
// الاستخدام: SOURCE_DATABASE_URL=postgres://... node migrate-data.js [--temp-password=xxxx]
//   SOURCE_DATABASE_URL: رابط اتصال Postgres مباشر (Settings → Database → Connection string، الوضع "Session"
//     أو "Direct connection" مو "Transaction pooler" — نحتاج نفس الاتصال لعمليات قراءة تسلسلية بسيطة)
//   وجهة MySQL تُقرأ من .env بنفس متغيرات server/db.js (DB_HOST, DB_USER, ...) — لازم schema.sql +
//   seed-report-schedules.sql يكونوا اشتغلوا على القاعدة الفارغة قبل تشغيل هذا الملف.
//
// قرارات محسومة من المستخدم (راجع خطة الهجرة المعتمدة):
//   - كل كلمات المرور تُعاد تعيينها لكلمة مرور موحّدة مؤقتة (ما نقدر ننقل تشفير Supabase Auth الأصلي) —
//     تُطبع بالنهاية بوضوح، والمالك يوزّعها ويطلب من الجميع تغييرها فور الدخول (زر "تغيير كلمة المرور" موجود أصلاً)
//   - push_subscriptions: ما تُنقل (توكنات مرتبطة بمفاتيح VAPID/service worker قديمة، غير صالحة بعد الهجرة أصلاً —
//     كل مستخدم يفعّل الإشعارات من جديد بضغطة زر واحدة)
//   - login_attempts: ما تُنقل (سجل حماية معدل محاولات قديم، بلا قيمة، والبدء بجدول فاضي أأمن)
//   - report_schedules / report_settings: ما تُنقل هنا — مزروعة مسبقًا عبر seed-report-schedules.sql
//     (قيم حقيقية استُخرجت من كل بيئة لحالها، تُطابق فعليًا كل بيئة، أدق من نسخها هنا)
import pg from "pg";
import { pool as mysqlPool } from "./db.js";
import { hashPassword } from "./auth.js";
import "dotenv/config";

const SOURCE_URL = process.env.SOURCE_DATABASE_URL;
if (!SOURCE_URL) {
  console.error("SOURCE_DATABASE_URL غير معرّف — مرره كمتغير بيئة (رابط اتصال Postgres مباشر)");
  process.exit(1);
}

const tempPasswordArg = process.argv.find((a) => a.startsWith("--temp-password="));
const TEMP_PASSWORD = tempPasswordArg ? tempPasswordArg.split("=")[1] : Math.random().toString(36).slice(2, 10);

// ترتيب الجداول يحترم تبعيات المفاتيح الأجنبية (نفس ترتيب schema.sql بالضبط)
// كل جدول: { table, cols, bool: [...], json: [...] } — bool/json تحدد أعمدة تحتاج تحويل صريح
const TABLES = [
  { table: "divisions", bool: ["is_active"] },
  { table: "departments", bool: ["is_active"] },
  { table: "warehouses", bool: ["is_active"] },
  { table: "sections", bool: ["is_active"] },
  { table: "storage_locations", bool: ["is_active"] },
  { table: "users", bool: ["is_active", "jobs_only"], usersSpecial: true },
  { table: "user_scopes" },
  { table: "warehouse_assignments" },
  { table: "contractors", bool: ["is_active"] },
  { table: "feeders", bool: ["is_active"] },
  { table: "job_types", bool: ["is_active"] },
  { table: "products", bool: ["is_active"] },
  { table: "job_type_items" },
  {
    table: "scheduled_jobs", bool: ["contractor_ready"],
    json: ["arrived_images", "contacted_operator_images", "operator_arrived_images", "sub_items",
      "closing_contacted_operator_images", "closing_operator_arrived_images", "power_restored_images"],
  },
  { table: "job_images" },
  { table: "job_materials", bool: ["used"] },
  { table: "job_contractor_checks", bool: ["ready"], json: ["image_urls"] },
  { table: "job_isolation_notes", json: ["image_urls"] },
  { table: "equipment_replacements", bool: ["is_emergency"] },
  { table: "equipment_replacement_images" },
  { table: "orders", json: ["items"] },
  { table: "transfers", bool: ["is_cross_branch"], json: ["items"] },
  { table: "report_recipients" },
  // push_subscriptions, login_attempts, report_schedules, report_settings: مستثناة عمدًا (شرح أعلاه)
];

function convertRow(row, cfg) {
  const out = { ...row };
  for (const col of cfg.bool || []) {
    if (out[col] !== null && out[col] !== undefined) out[col] = out[col] ? 1 : 0;
  }
  for (const col of cfg.json || []) {
    if (out[col] !== null && out[col] !== undefined) out[col] = JSON.stringify(out[col]);
  }
  return out;
}

async function migrateTable(pgClient, cfg, tempPasswordHash) {
  const { rows } = await pgClient.query(`SELECT * FROM ${cfg.table}`);
  if (!rows.length) {
    console.log(`  ${cfg.table}: 0 صف (تخطّي)`);
    return { table: cfg.table, count: 0 };
  }

  let inserted = 0;
  for (const rawRow of rows) {
    let row = convertRow(rawRow, cfg);
    if (cfg.usersSpecial) {
      // auth_user_id عمود قديم غير مستخدم بالنظام الجديد؛ password_hash موحّد مؤقت للجميع (شرح أعلى الملف)
      delete row.auth_user_id;
      row.password_hash = tempPasswordHash;
    }
    const cols = Object.keys(row);
    const placeholders = cols.map(() => "?").join(",");
    const values = cols.map((c) => row[c]);
    try {
      await mysqlPool.query(
        `INSERT INTO \`${cfg.table}\` (${cols.map((c) => `\`${c}\``).join(",")}) VALUES (${placeholders})`,
        values
      );
      inserted++;
    } catch (err) {
      console.error(`  ❌ ${cfg.table} id=${row.id ?? "?"}: ${err.message}`);
    }
  }
  console.log(`  ${cfg.table}: ${inserted}/${rows.length} صف منقول`);
  return { table: cfg.table, count: inserted };
}

async function main() {
  console.log(`بدء النقل — كلمة المرور المؤقتة الموحّدة لكل المستخدمين: "${TEMP_PASSWORD}" (احتفظ فيها، تُطبع مرة وحدة بالنهاية أيضًا)\n`);

  const pgClient = new pg.Client({ connectionString: SOURCE_URL, ssl: { rejectUnauthorized: false } });
  await pgClient.connect();

  const tempPasswordHash = await hashPassword(TEMP_PASSWORD);

  const results = [];
  try {
    for (const cfg of TABLES) {
      const r = await migrateTable(pgClient, cfg, tempPasswordHash);
      results.push(r);
    }
  } finally {
    await pgClient.end();
  }

  console.log("\n✅ انتهى النقل. ملخص:");
  for (const r of results) console.log(`  ${r.table}: ${r.count}`);
  console.log(`\n🔑 كلمة المرور المؤقتة الموحّدة للجميع: ${TEMP_PASSWORD}`);
  console.log("وزّعها على الجميع، واطلب من كل واحد يغيّرها فور أول دخول (شاشة الإعدادات → تغيير كلمة المرور).");

  await mysqlPool.end();
}

main().catch((err) => {
  console.error("فشل النقل:", err);
  process.exit(1);
});
