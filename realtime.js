// WebSocket بسيط — يحل محل قناتي Supabase Realtime المستخدمتين فعليًا بـApp.jsx:
//   "orders-realtime-admin"     -> INSERT على orders (يحتاج الصف الجديد نفسه: warehouse_id/section_id/emp_name)
//   "scheduled-jobs-realtime"   -> أي تغيير (INSERT/UPDATE/DELETE) على ٦ جداول، الفرونت يتجاهل التفاصيل وبس يعيد loadData()
//
// البث هنا عام لكل المتصلين المسجّلين (بدون تصفية صلاحيات على مستوى الحدث نفسه) — نفس أثر النسخة الأصلية عمليًا،
// لأن أي استدعاء loadData() ناتج عن الحدث يعيد الجلب عبر routes/table.js اللي أصلاً مفلتر بالكامل عبر policies.js،
// فأي عميل غير مخوّل ببيانات معيّنة ما راح يشوفها حتى لو وصلته إشعارة "تغيّر شي" عامة.
import { WebSocketServer } from "ws";
import { verifyAccessToken } from "./auth.js";

const clients = new Set();

export function initRealtime(server) {
  const wss = new WebSocketServer({ server, path: "/api/realtime" });
  wss.on("connection", (ws, req) => {
    const url = new URL(req.url, "http://localhost");
    const token = url.searchParams.get("token");
    try {
      verifyAccessToken(token);
    } catch {
      ws.close(4401, "unauthorized");
      return;
    }
    clients.add(ws);
    ws.on("close", () => clients.delete(ws));
    ws.on("error", () => clients.delete(ws));
  });
  return wss;
}

// يُستدعى من routes/table.js بعد أي insert/update/delete ناجح على جدول له مستمعون بالفرونت
export function broadcastChange(table, event, row) {
  if (!clients.size) return;
  const payload = JSON.stringify({ table, event, new: row || null });
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

// الجداول اللي فعليًا لها مستمع Realtime بالفرونت — البث لغيرها بلا فائدة (ما فيه حد يستمع أصلاً)
export const REALTIME_TABLES = new Set([
  "orders", "scheduled_jobs", "job_images", "job_materials", "job_contractor_checks", "job_isolation_notes", "transfers", "tech_issue_reports",
]);
