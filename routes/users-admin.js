// إدارة المستخدمين الإدارية — يحل محل 4 Edge Functions بالحرف:
// admin-create-user, admin-update-user, admin-set-password, admin-grant-login
// الفرق الوحيد عن الأصل: ما فيه Supabase Auth منفصل — كلمة المرور تُخزَّن مباشرة كـpassword_hash
// بجدول users نفسه (بدل حساب auth.users منفصل مربوط بـauth_user_id). auth_user_id بقي بالجدول
// كعمود قديم غير مستخدَم الآن (لتوافق أي مرجع قديم له فقط)، الهوية الفعلية = users.id.
import express from "express";
import { pool, genId } from "../db.js";
import { requireAuth } from "../auth.js";
import { hashPassword } from "../auth.js";
import { sendWhatsAppText, isWhatsAppConfigured } from "../whatsapp.js";

const router = express.Router();
const OWNER_EMPLOYEE_ID = "90507";

// نفس "allowedDepartments" المكرر بالأربع دوال الأصلية بالحرف — القسم/المستودع اللي يقدر المشرف الحالي (غير المالك) يتصرف فيها
async function allowedWarehouseIds(callerId) {
  const [myAssignments] = await pool.query("SELECT * FROM warehouse_assignments WHERE user_id = ?", [callerId]);
  if (!myAssignments.length) return null; // بلا قيود (فتح تلقائي لمشرف بلا أي تخصيص)
  const allowed = new Set();
  for (const a of myAssignments) {
    if (a.division_id) {
      const [divWarehouses] = await pool.query("SELECT id FROM warehouses WHERE division_id = ?", [a.division_id]);
      divWarehouses.forEach((w) => allowed.add(w.id));
    } else if (a.section_id) {
      const [[sec]] = await pool.query("SELECT warehouse_id FROM sections WHERE id = ?", [a.section_id]);
      if (sec?.warehouse_id) allowed.add(sec.warehouse_id);
    } else if (a.warehouse_id) {
      allowed.add(a.warehouse_id);
    }
  }
  return allowed;
}

// إرسال بيانات دخول جديدة عبر واتساب — ثانوي بالكامل: أي فشل هنا (رقم ناقص، الخدمة غير مفعّلة)
// ما يوقف عملية تعيين كلمة المرور نفسها (اللي خلصت فعلاً قبل ما تُستدعى هذي الدالة)
async function tryNotifyCredentialsViaWhatsApp(userId, plainPassword) {
  if (!isWhatsAppConfigured()) return { sent: false, reason: "not_configured" };
  const [[u]] = await pool.query("SELECT name, employee_id, phone FROM users WHERE id = ?", [userId]);
  if (!u?.phone) return { sent: false, reason: "no_phone" };
  const text = `مرحبًا ${u.name} 👋\nتم تحديث بيانات دخولك بنظام DistCtrl:\n\n` +
    `🔢 الرقم الوظيفي: ${u.employee_id}\n🔑 كلمة المرور: ${plainPassword}\n\n` +
    `يُفضّل تغييرها من داخل التطبيق بعد أول دخول (القفل 🔒 أعلى الشاشة).`;
  const result = await sendWhatsAppText(u.phone, text);
  return { sent: !!result.success, reason: result.success ? undefined : result.error };
}

async function requireActiveAdmin(req, res) {
  const [[caller]] = await pool.query(
    "SELECT id, role, is_active, employee_id FROM users WHERE id = ?",
    [req.authUserId]
  );
  if (!caller || caller.role !== "admin" || !caller.is_active) {
    res.status(403).json({ success: false, error: "forbidden" });
    return null;
  }
  return caller;
}

// ── admin-create-user ──
router.post("/admin/users", requireAuth, async (req, res) => {
  try {
    const caller = await requireActiveAdmin(req, res);
    if (!caller) return;

    const { name, employee_id, password, role, warehouse_id, phone } = req.body || {};
    if (!name || !employee_id || !password || password.length < 4) {
      return res.status(400).json({ success: false, error: "invalid_input" });
    }
    if (employee_id === OWNER_EMPLOYEE_ID) return res.status(400).json({ success: false, error: "reserved_id" });

    const isOwner = caller.employee_id === OWNER_EMPLOYEE_ID;
    const finalRole = ["admin", "manager", "operator"].includes(role) ? role : "user";

    let finalWarehouseId = null;
    let adminAssignmentWarehouseId = null;

    if (finalRole === "user") {
      if (isOwner) {
        finalWarehouseId = warehouse_id || null;
      } else {
        const allowed = await allowedWarehouseIds(caller.id);
        if (allowed && (!warehouse_id || !allowed.has(warehouse_id))) {
          return res.status(403).json({ success: false, error: "warehouse_out_of_scope" });
        }
        finalWarehouseId = warehouse_id || null;
      }
    } else if (!isOwner) {
      const allowed = await allowedWarehouseIds(caller.id);
      if (allowed && (!warehouse_id || !allowed.has(warehouse_id))) {
        return res.status(403).json({ success: false, error: "warehouse_out_of_scope" });
      }
      adminAssignmentWarehouseId = warehouse_id || null;
    }

    const [[dup]] = await pool.query("SELECT id FROM users WHERE employee_id = ?", [employee_id]);
    if (dup) return res.status(400).json({ success: false, error: "employee_id_taken" });

    const passwordHash = await hashPassword(password);
    const newId = genId();
    await pool.query(
      "INSERT INTO users (id, name, employee_id, role, is_active, warehouse_id, password_hash, phone) VALUES (?, ?, ?, ?, 1, ?, ?, ?)",
      [newId, name, employee_id, finalRole, finalWarehouseId, passwordHash, phone?.trim() || null]
    );

    if (adminAssignmentWarehouseId) {
      await pool.query(
        "INSERT INTO warehouse_assignments (id, user_id, warehouse_id, section_id, division_id) VALUES (?, ?, ?, NULL, NULL)",
        [genId(), newId, adminAssignmentWarehouseId]
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error("admin/users create error:", err);
    res.status(500).json({ success: false, error: String(err.message || err) });
  }
});

// ── admin-update-user ──
router.patch("/admin/users/:id", requireAuth, async (req, res) => {
  try {
    const caller = await requireActiveAdmin(req, res);
    if (!caller) return;

    const { id: user_id } = req.params;
    const { name, employee_id, phone } = req.body || {};
    if (!user_id || !name || !employee_id) return res.status(400).json({ success: false, error: "invalid_input" });
    if (employee_id === OWNER_EMPLOYEE_ID) return res.status(400).json({ success: false, error: "reserved_id" });

    const [[target]] = await pool.query(
      "SELECT id, role, employee_id, warehouse_id FROM users WHERE id = ?",
      [user_id]
    );
    if (!target) return res.status(404).json({ success: false, error: "not_found" });
    if (target.employee_id === OWNER_EMPLOYEE_ID) return res.status(403).json({ success: false, error: "forbidden" });

    const isOwner = caller.employee_id === OWNER_EMPLOYEE_ID;
    if (!isOwner) {
      if (target.role !== "user") return res.status(403).json({ success: false, error: "forbidden" });
      const allowed = await allowedWarehouseIds(caller.id);
      if (allowed && (!target.warehouse_id || !allowed.has(target.warehouse_id))) {
        return res.status(403).json({ success: false, error: "out_of_scope" });
      }
    }

    if (employee_id !== target.employee_id) {
      const [[dup]] = await pool.query("SELECT id FROM users WHERE employee_id = ? AND id != ?", [employee_id, user_id]);
      if (dup) return res.status(400).json({ success: false, error: "employee_id_taken" });
    }

    // COALESCE على phone — لو الطلب ما بعت رقم جوال (null)، نبقي القديم كما هو بدل ما نمسحه بالغلط
    await pool.query("UPDATE users SET name = ?, employee_id = ?, phone = COALESCE(?, phone) WHERE id = ?", [name, employee_id, phone?.trim() || null, user_id]);
    res.json({ success: true });
  } catch (err) {
    console.error("admin/users update error:", err);
    res.status(500).json({ success: false, error: String(err.message || err) });
  }
});

// ── admin-set-password ──
router.post("/admin/set-password", requireAuth, async (req, res) => {
  try {
    const caller = await requireActiveAdmin(req, res);
    if (!caller) return;

    const { target_employee_id, new_password, send_whatsapp } = req.body || {};
    if (!target_employee_id || !new_password || new_password.length < 4) {
      return res.status(400).json({ success: false, error: "invalid_input" });
    }
    if (target_employee_id === OWNER_EMPLOYEE_ID) return res.status(403).json({ success: false, error: "forbidden" });

    const [[target]] = await pool.query(
      "SELECT id, role, employee_id, warehouse_id, password_hash FROM users WHERE employee_id = ?",
      [target_employee_id]
    );
    if (!target?.password_hash) return res.status(404).json({ success: false, error: "target_not_found" });

    const isOwner = caller.employee_id === OWNER_EMPLOYEE_ID;
    if (!isOwner) {
      if (target.role !== "user") return res.status(403).json({ success: false, error: "forbidden" });
      const allowed = await allowedWarehouseIds(caller.id);
      if (allowed && (!target.warehouse_id || !allowed.has(target.warehouse_id))) {
        return res.status(403).json({ success: false, error: "out_of_scope" });
      }
    }

    const passwordHash = await hashPassword(new_password);
    await pool.query("UPDATE users SET password_hash = ? WHERE id = ?", [passwordHash, target.id]);
    const whatsapp = send_whatsapp ? await tryNotifyCredentialsViaWhatsApp(target.id, new_password) : undefined;
    res.json({ success: true, whatsapp });
  } catch (err) {
    console.error("admin/set-password error:", err);
    res.status(500).json({ success: false, error: String(err.message || err) });
  }
});

// ── admin-grant-login (يمنح حساب دخول لموظف/مستشار موجود بدون كلمة مرور — مستوردين من إكسل مثلاً) ──
router.post("/admin/grant-login", requireAuth, async (req, res) => {
  try {
    const caller = await requireActiveAdmin(req, res);
    if (!caller) return;

    const { target_employee_id, password, send_whatsapp } = req.body || {};
    if (!target_employee_id || !password || password.length < 4) {
      return res.status(400).json({ success: false, error: "invalid_input" });
    }

    const [[target]] = await pool.query(
      "SELECT id, name, employee_id, warehouse_id, password_hash FROM users WHERE employee_id = ?",
      [target_employee_id]
    );
    if (!target) return res.status(404).json({ success: false, error: "target_not_found" });
    if (target.password_hash) return res.status(400).json({ success: false, error: "already_has_login" });

    const isOwner = caller.employee_id === OWNER_EMPLOYEE_ID;
    if (!isOwner) {
      const allowed = await allowedWarehouseIds(caller.id);
      if (allowed && (!target.warehouse_id || !allowed.has(target.warehouse_id))) {
        return res.status(403).json({ success: false, error: "forbidden" });
      }
    }

    const passwordHash = await hashPassword(password);
    await pool.query("UPDATE users SET password_hash = ? WHERE id = ?", [passwordHash, target.id]);
    const whatsapp = send_whatsapp ? await tryNotifyCredentialsViaWhatsApp(target.id, password) : undefined;
    res.json({ success: true, whatsapp });
  } catch (err) {
    console.error("admin/grant-login error:", err);
    res.status(500).json({ success: false, error: String(err.message || err) });
  }
});

// ── إرسال بيانات دخول جماعي عبر واتساب (المالك فقط) — يستخدم لتوزيع كلمة مرور مؤقتة مشتركة على كل
// من عنده رقم هاتف مسجّل الآن؛ يتوسّع تلقائيًا كل ما انضاف رقم جديد بدون أي كود إضافي ──
router.post("/admin/broadcast-password-whatsapp", requireAuth, async (req, res) => {
  try {
    const caller = await requireActiveAdmin(req, res);
    if (!caller) return;
    if (caller.employee_id !== OWNER_EMPLOYEE_ID) return res.status(403).json({ success: false, error: "owner_only" });

    const { password } = req.body || {};
    if (!password || password.length < 4) return res.status(400).json({ success: false, error: "invalid_input" });
    if (!isWhatsAppConfigured()) return res.status(400).json({ success: false, error: "whatsapp_not_configured" });

    const [targets] = await pool.query(
      "SELECT id, name FROM users WHERE is_active = 1 AND employee_id != ? AND phone IS NOT NULL AND phone <> ''",
      [OWNER_EMPLOYEE_ID]
    );
    const results = await Promise.allSettled(targets.map((t) => tryNotifyCredentialsViaWhatsApp(t.id, password)));
    const sent = results.filter((r) => r.status === "fulfilled" && r.value?.sent).length;
    res.json({ success: true, attempted: targets.length, sent });
  } catch (err) {
    console.error("admin/broadcast-password-whatsapp error:", err);
    res.status(500).json({ success: false, error: String(err.message || err) });
  }
});

export default router;
