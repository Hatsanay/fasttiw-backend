const pool = require("../config/db");
const stripeClient = require("../utils/stripeClient");
const { settlePaidOrder } = require("../controllers/store.controller");

const SWEEP_INTERVAL_MS = 5 * 60 * 1000; // ทุก 5 นาที — สั้นกว่า entitlement sweep เพราะ QR หมดอายุใน 1 ชม.
// (ดู PROMPTPAY_QR_TTL_MS ใน store.controller.js) ต้องตรวจถี่กว่านั้นไม่งั้นลูกค้าจะเห็นคำสั่งซื้อค้าง
// "รอชำระเงิน" นานเกินจำเป็นกว่าจะถูกเคลียร์สถานะ

// Stripe ไม่มี field วันหมดอายุ QR ของ PromptPay ให้เหมือน Omise (ดูคอมเมนต์ที่ store.controller.js/
// stripeClient.js) — job นี้จึงเป็นตัวยกเลิก PaymentIntent ที่ค้าง pending เกิน TTL ที่เรากำหนดเองแทน Stripe
// ที่ไม่ auto-expire ให้ (charge ของ Omise auto-expire เองหลัง 24 ชม. แต่ PaymentIntent ของ Stripe ไม่ auto-cancel)
//
// สำคัญ: ก่อนยกเลิกทุกครั้งต้องเช็คสถานะจริงกับ Stripe ก่อนเสมอ ห้ามยกเลิกจากแค่ ord_qr_expires_at < NOW()
// เฉยๆ — กันเคส race ที่ลูกค้าจ่ายเงินสำเร็จจริงในช่วงเวลาไล่เลี่ยกับที่ TTL หมดพอดี แต่ webhook ยังมาไม่ถึง
// ถ้าเจอว่า Stripe บอกว่า succeeded แล้วจริง ต้อง settlePaidOrder() ให้สิทธิ์ตามปกติ ไม่ใช่ยกเลิกทิ้ง
async function sweepExpiredOrders() {
    try {
        const [rows] = await pool.query(
            `SELECT ord_id, ord_omise_charge_id, ord_total FROM tb_orders
             WHERE ord_status = 'pending' AND ord_qr_expires_at IS NOT NULL AND ord_qr_expires_at < NOW()`
        );
        if (rows.length === 0) return;

        let cancelledCount = 0;
        for (const row of rows) {
            if (!row.ord_omise_charge_id) {
                // ไม่เคยสร้าง PaymentIntent สำเร็จเลย (เช่น Stripe ล่มตอน checkout) — ยกเลิกออเดอร์ได้เลย
                const [result] = await pool.query(
                    "UPDATE tb_orders SET ord_status = 'cancelled' WHERE ord_id = ? AND ord_status = 'pending'",
                    [row.ord_id]
                );
                cancelledCount += result.affectedRows;
                continue;
            }

            const liveIntent = await stripeClient.getPaymentIntent(row.ord_omise_charge_id);
            if (liveIntent?.status === "succeeded") {
                const expectedSatang = Math.round(Number(row.ord_total) * 100);
                if (liveIntent.amount === expectedSatang) {
                    await settlePaidOrder(row.ord_id);
                }
                continue; // ไม่ยกเลิก ไม่ว่ายอดจะตรงหรือไม่ก็ตาม — จ่ายจริงแล้ว ปล่อยให้แอดมิน force-confirm มือถ้ายอดไม่ตรง
            }

            await stripeClient.cancelPaymentIntent(row.ord_omise_charge_id);
            const [result] = await pool.query(
                "UPDATE tb_orders SET ord_status = 'cancelled' WHERE ord_id = ? AND ord_status = 'pending'",
                [row.ord_id]
            );
            cancelledCount += result.affectedRows;
        }

        if (cancelledCount > 0) {
            console.log(`[order-expiry-sweep] ยกเลิกคำสั่งซื้อที่ QR หมดอายุ ${cancelledCount} รายการ`);
        }
    } catch (err) {
        console.error("[order-expiry-sweep] เกิดข้อผิดพลาด:", err.message);
    }
}

function startOrderExpirySweep() {
    sweepExpiredOrders(); // รันทันทีตอน startup ไม่ต้องรอครบรอบแรก
    setInterval(sweepExpiredOrders, SWEEP_INTERVAL_MS);
}

module.exports = { startOrderExpirySweep, sweepExpiredOrders };
