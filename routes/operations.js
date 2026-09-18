// وحدة "التشغيل" — إرسال/إعادة إرسال رسالة واتساب لسجل تشغيل، بنفس شكل routes/equipmentReplacements.js
import express from "express";
import { pool } from "../db.js";
import { requireAuth } from "../auth.js";
import { isOwner, isAdmin, inMyScopeSync, loadScopeContext } from "../scope.js";
import { sendOperationMessage } from "../operationsWhatsapp.js";

const router = express.Router();

router.post("/operations/:id/send", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const [[op]] = await pool.query("SELECT * FROM operations WHERE id = ?", [id]);
    if (!op) return res.status(404).json({ success: false, error: "not_found" });

    const authUser = { sub: req.authUserId, role: req.authRole, employee_id: req.authEmployeeId };
    const scopeCtx = await loadScopeContext(pool);
    const allowed =
      isOwner(authUser) || (isAdmin(authUser) && inMyScopeSync(scopeCtx, authUser, null, op.section_id));
    if (!allowed) return res.status(403).json({ success: false, error: "forbidden" });

    const result = await sendOperationMessage(op, req.authUserId);
    res.json({ success: !!result.success, error: result.success ? undefined : result.error });
  } catch (err) {
    console.error("send operation message error:", err);
    res.status(500).json({ success: false, error: String(err.message || err) });
  }
});

export default router;
