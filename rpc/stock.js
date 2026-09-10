// إعادة تنفيذ الـ٦ دوال RPC الذرية للمخزون (كانت PL/pgSQL بـPostgres) كـtransactions حقيقية بـMySQL.
// منقولة سطر-بسطر عن المنطق الحقيقي (استُخرج عبر pg_get_functiondef بتاريخ 2026-08-28) — مو تخمين.
//
// آلية الذرية: نفس أسلوب النسخة الأصلية بالضبط — عبارة UPDATE واحدة بشرط "WHERE quantity >= ?"
// جوّا transaction، ثم فحص عدد الصفوف المتأثرة (affectedRows بدل GET DIAGNOSTICS row_count).
// InnoDB يقفل الصف تلقائيًا أثناء UPDATE ضمن transaction، فما فيه سباق ممكن بين عمليتين متزامنتين
// على نفس المنتج — تمامًا متل قفل الصف الضمني اللي كان يوفره Postgres بنفس الصياغة.
import { pool, withTransaction, genId } from "../db.js";
import { isOwner, isAdmin, inMyScope } from "../scope.js";

class RpcError extends Error {
  constructor(code) { super(code); this.code = code; }
}

async function decrementOrThrow(conn, productId, qty, extraWhere = "", extraParams = []) {
  const [result] = await conn.query(
    `UPDATE products SET quantity = quantity - ? WHERE id = ? AND quantity >= ? ${extraWhere}`,
    [qty, productId, qty, ...extraParams]
  );
  if (result.affectedRows === 0) throw new RpcError(`insufficient_stock: ${productId}`);
}

// reserve_job_materials_stock(p_items jsonb) — items: [{product_id, quantity}]
export async function reserveJobMaterialsStock(authUser, items) {
  return withTransaction(async (conn) => {
    for (const item of items) {
      const qty = Number(item.quantity) || 0;
      if (qty <= 0) continue;
      const [[product]] = await conn.query(
        "SELECT warehouse_id, section_id FROM products WHERE id = ?",
        [item.product_id]
      );
      const allowed = isOwner(authUser) || (isAdmin(authUser) && await inMyScope(authUser, product?.warehouse_id, product?.section_id, conn));
      if (!allowed) throw new RpcError("forbidden");
      await decrementOrThrow(conn, item.product_id, qty);
    }
    return { success: true };
  });
}

// restore_unused_job_materials(p_job_id uuid)
export async function restoreUnusedJobMaterials(authUser, jobId) {
  return withTransaction(async (conn) => {
    const [[job]] = await conn.query("SELECT * FROM scheduled_jobs WHERE id = ?", [jobId]);
    if (!job) throw new RpcError("job_not_found");

    const allowed =
      isOwner(authUser) ||
      (isAdmin(authUser) && await inMyScope(authUser, job.warehouse_id, null, conn)) ||
      job.employee_id === authUser.sub;
    if (!allowed) throw new RpcError("forbidden");

    const [materials] = await conn.query(
      "SELECT * FROM job_materials WHERE job_id = ? AND used = 0",
      [jobId]
    );
    for (const mat of materials) {
      await conn.query("UPDATE products SET quantity = quantity + ? WHERE id = ?", [mat.quantity, mat.product_id]);
    }
    return { success: true };
  });
}

// dispense_order_stock(p_order_id uuid)
export async function dispenseOrderStock(authUser, orderId) {
  return withTransaction(async (conn) => {
    const [[order]] = await conn.query("SELECT * FROM orders WHERE id = ?", [orderId]);
    if (!order) throw new RpcError("order_not_found");

    const allowed = isOwner(authUser) || (isAdmin(authUser) && await inMyScope(authUser, order.warehouse_id, order.section_id, conn));
    if (!allowed) throw new RpcError("forbidden");

    const items = typeof order.items === "string" ? JSON.parse(order.items) : (order.items || []);
    for (const item of items) {
      const qty = Number(item.requested) || 0;
      if (qty <= 0) continue;
      await decrementOrThrow(conn, item.id, qty);
    }
    return { success: true };
  });
}

// reserve_transfer_stock(p_items jsonb, p_from_warehouse_id uuid)
export async function reserveTransferStock(authUser, items, fromWarehouseId) {
  return withTransaction(async (conn) => {
    const allowed = isOwner(authUser) || (isAdmin(authUser) && await inMyScope(authUser, fromWarehouseId, null, conn));
    if (!allowed) throw new RpcError("forbidden");

    for (const item of items) {
      const qty = Number(item.quantity) || 0;
      if (qty <= 0) continue;
      await decrementOrThrow(conn, item.product_id, qty, "AND warehouse_id = ?", [fromWarehouseId]);
    }
    return { success: true };
  });
}

// receive_transfer_stock(p_transfer_id uuid)
export async function receiveTransferStock(authUser, transferId) {
  return withTransaction(async (conn) => {
    const [[tr]] = await conn.query("SELECT * FROM transfers WHERE id = ?", [transferId]);
    if (!tr) throw new RpcError("transfer_not_found");

    const allowed = isOwner(authUser) || (isAdmin(authUser) && await inMyScope(authUser, tr.to_warehouse_id, null, conn));
    if (!allowed) throw new RpcError("forbidden");

    const items = typeof tr.items === "string" ? JSON.parse(tr.items) : (tr.items || []);
    for (const item of items) {
      const sku = item.sku || null;
      let existingId = null;
      if (sku) {
        const [[existing]] = await conn.query(
          "SELECT id FROM products WHERE warehouse_id = ? AND sku = ? LIMIT 1",
          [tr.to_warehouse_id, sku]
        );
        existingId = existing?.id || null;
      }
      if (existingId) {
        await conn.query("UPDATE products SET quantity = quantity + ? WHERE id = ?", [Number(item.quantity) || 0, existingId]);
      } else {
        await conn.query(
          `INSERT INTO products (id, name, sku, unit, quantity, min_stock, shelf, section_id, storage_location_id, warehouse_id)
           VALUES (?, ?, ?, ?, ?, 0, '', NULL, NULL, ?)`,
          [genId(), item.name, sku || "", item.unit || "قطعة", Number(item.quantity) || 0, tr.to_warehouse_id]
        );
      }
    }
    return { success: true };
  });
}

// restore_transfer_stock(p_transfer_id uuid)
export async function restoreTransferStock(authUser, transferId) {
  return withTransaction(async (conn) => {
    const [[tr]] = await conn.query("SELECT * FROM transfers WHERE id = ?", [transferId]);
    if (!tr) throw new RpcError("transfer_not_found");

    const allowed =
      isOwner(authUser) ||
      (isAdmin(authUser) && ((await inMyScope(authUser, tr.from_warehouse_id, null, conn)) || (await inMyScope(authUser, tr.to_warehouse_id, null, conn)))) ||
      tr.requested_by === authUser.sub;
    if (!allowed) throw new RpcError("forbidden");

    const items = typeof tr.items === "string" ? JSON.parse(tr.items) : (tr.items || []);
    for (const item of items) {
      await conn.query("UPDATE products SET quantity = quantity + ? WHERE id = ?", [Number(item.quantity) || 0, item.product_id]);
    }
    return { success: true };
  });
}

export { RpcError };
