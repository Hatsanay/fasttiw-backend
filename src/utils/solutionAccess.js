const pool = require("../config/db");

// ใครเห็นเฉลยของข้อไหนได้ (2026-10-02) — ใช้กับทุกจุดที่เปิดเฉลยข้อที่ "เคยทำไปแล้ว" (ข้อที่ต้องทบทวน, bookmark)
//
// กติกา: **ต้องเคยมีสิทธิ์ชุดนั้น และสิทธิ์ไม่ถูกยกเลิก** — ซื้อแล้วหมดอายุยังทบทวนข้อที่เคยทำได้ (จ่ายเงินมาแล้วจริง)
// แต่ถูกยกเลิก (คืนเงิน/แชร์บัญชี) หรือไม่เคยซื้อเลย = ไม่เห็นเฉลย
//
// เหตุที่ต้องมี: เดิมสองจุดนี้ไม่เช็คสิทธิ์เลย —
//   - bookmark รับรหัสข้ออะไรก็ได้ แล้วหน้า bookmark เปิดเฉลยเต็ม (รหัสข้อเป็นเลขเรียง เดาได้ = ไล่เปิดเฉลยทั้งคลังได้)
//   - กลุ่มสอบกระดาษ (CLAUDE.md ข้อ 6.9.1) ให้สมาชิกที่ไม่ได้ซื้อตรวจกระดาษได้ ข้อที่ตอบผิดจะเข้า "ข้อที่ต้องทบทวน"
//     พร้อมเฉลยเต็ม = ซื้อ 1 คนแจกเฉลยทั้งกลุ่ม
// SQL ใช้ใน WHERE ของ query ที่มีคอลัมน์ลูกค้า/ชุดอยู่แล้ว (เช่น mistakeEventsSql) — ไม่มี parameter เพิ่ม

/** เงื่อนไข SQL: ลูกค้า (customerExpr) เคยมีสิทธิ์ชุด (productExpr) ที่ไม่ถูกยกเลิก */
function everEntitledSql(customerExpr, productExpr) {
    return `EXISTS (SELECT 1 FROM tb_entitlements se
                    WHERE se.ent_customer_id = ${customerExpr} AND se.ent_product_id = ${productExpr} AND se.ent_status <> 'revoked')`;
}

async function hasEverEntitled(customerId, productId) {
    const [rows] = await pool.query(
        "SELECT 1 FROM tb_entitlements WHERE ent_customer_id = ? AND ent_product_id = ? AND ent_status <> 'revoked' LIMIT 1",
        [customerId, productId]
    );
    return rows.length > 0;
}

module.exports = { everEntitledSql, hasEverEntitled };
