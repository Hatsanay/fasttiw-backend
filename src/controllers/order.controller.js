const pool = require("../config/db");
const { settlePaidOrder, cancelOrder } = require("./store.controller");

// รายการคำสั่งซื้อของลูกค้า — ใช้ดูภาพรวม และเป็นช่องทางหา order ที่ค้าง pending สำหรับ fallback
// ยืนยันจ่ายเงินด้วยมือ (กฎเหล็กข้อ 5 ใน CLAUDE.md: PromptPay ไม่ real-time ต้องมี fallback ให้แอดมิน)
async function getAll(req, res, next) {
    try {
        const status = ["pending", "paid", "cancelled"].includes(req.query.status) ? req.query.status : null;
        const whereClause = status ? "WHERE o.ord_status = ?" : "";
        const params = status ? [status] : [];

        const [rows] = await pool.query(
            `SELECT o.ord_id, o.ord_customer_id, c.cus_username, c.cus_email,
                    o.ord_total, o.ord_status, o.ord_omise_charge_id, o.ord_created_at, o.ord_paid_at
             FROM tb_orders o
             JOIN tb_customers c ON c.cus_id = o.ord_customer_id
             ${whereClause}
             ORDER BY o.ord_created_at DESC
             LIMIT 200`,
            params
        );
        res.json({ data: rows });
    } catch (err) {
        next(err);
    }
}

// แอดมินยืนยันจ่ายเงินด้วยมือ (เช่น ลูกค้าแจ้งสลิปทางแชท แต่ webhook ยังไม่มา/QR มีปัญหา) — เรียก
// settlePaidOrder() จุดเดียวกับ webhook จริงเป๊ะ ไม่มี logic แยก กันสิทธิ์เพี้ยนระหว่าง 2 ช่องทาง
async function forceConfirm(req, res, next) {
    try {
        const result = await settlePaidOrder(req.params.id);
        if (result.alreadySettled) {
            return res.status(400).json({ message: "คำสั่งซื้อนี้ไม่ได้อยู่ในสถานะรอชำระเงินแล้ว" });
        }
        res.json({ message: "ยืนยันการชำระเงินสำเร็จ" });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ message: err.message });
        next(err);
    }
}

// แอดมินยกเลิกคำสั่งซื้อที่ยังไม่จ่าย (เช่น ลูกค้าขอยกเลิกทางแชทแต่ตัวเองกดยกเลิกเองไม่ได้แล้ว/ค้างนาน) —
// เรียก cancelOrder() จุดเดียวกับที่ลูกค้ายกเลิกเอง (cancelMyOrder ใน store.controller.js) ไม่มี logic แยก
async function cancel(req, res, next) {
    try {
        await cancelOrder(req.params.id);
        res.json({ message: "ยกเลิกคำสั่งซื้อสำเร็จ" });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ message: err.message });
        next(err);
    }
}

module.exports = { getAll, forceConfirm, cancel };
