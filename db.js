// اتصال MySQL + مساعد transactions — يحل محل عميل postgres الداخلي لـSupabase
import mysql from "mysql2/promise";
import "dotenv/config";

export const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  charset: "utf8mb4",
  waitForConnections: true,
  connectionLimit: 10,
  // أعمدة DATE (scheduled_date, work_date...) ترجع كنص "YYYY-MM-DD" مباشرة بدل كائن Date —
  // فرق هذا مهم لأن الفرونت يقارنها حرفيًا بنص (j.scheduled_date === todayStr) وبدونها ترجع
  // كـDate ثم تُسلسَل بـres.json() لصيغة ISO كاملة (توقيت+منطقة) فتفشل كل المقارنات وتظهر بالواجهة كتاريخ خام.
  // أعمدة DATETIME/TIMESTAMP (arrived_at...) تبقى كائنات Date عادية — تسلسلها لـISO كامل هو الشكل الصحيح المتوقع بالفرونت.
  dateStrings: ["DATE"],
  namedPlaceholders: true,
});

// دالة مساعدة: تشغيل عدة استعلامات ضمن transaction واحدة (تُستخدم بعمليات المخزون الذرية بـrpc/stock.js
// بدل RPC PL/pgSQL — القفل هنا يكون عبر SELECT ... FOR UPDATE على نفس الاتصال المخصص للـtransaction)
export async function withTransaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// يولّد UUID متوافق مع شكل uuid v4 التقليدي (نفس شكل معرفات Postgres القديمة) —
// يُستخدم بدل gen_random_uuid() اللي كان بقاعدة البيانات، الآن التطبيق هو اللي يولّد المعرف قبل كل insert
export function genId() {
  return crypto.randomUUID();
}
