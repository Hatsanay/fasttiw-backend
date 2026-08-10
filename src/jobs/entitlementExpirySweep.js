const pool = require("../config/db");

const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // ทุก 1 ชั่วโมง

// เดิม effective_status คำนวณสดตอน query เท่านั้น (ดู getMyEntitlements/getAll ใน entitlement.controller.js)
// คอลัมน์ ent_status ในตารางเลยค้างเป็น 'active' แม้เลยวันหมดอายุแล้ว — sweep นี้เขียนกลับ DB จริง
// เป็นระยะ ให้ query ตรงๆ ที่ยังไม่ผ่าน CASE (เช่น รายงาน/ระบบอื่นในอนาคต) เห็นสถานะถูกต้องด้วย
async function sweepExpiredEntitlements() {
    try {
        const [result] = await pool.query(
            `UPDATE tb_entitlements
             SET ent_status = 'expired'
             WHERE ent_status = 'active' AND ent_expires_at IS NOT NULL AND ent_expires_at < NOW()`
        );
        if (result.affectedRows > 0) {
            console.log(`[entitlement-sweep] ปรับสถานะหมดอายุ ${result.affectedRows} รายการ`);
        }
    } catch (err) {
        console.error("[entitlement-sweep] เกิดข้อผิดพลาด:", err.message);
    }
}

function startEntitlementExpirySweep() {
    sweepExpiredEntitlements(); // รันทันทีตอน startup ไม่ต้องรอครบชั่วโมงแรก
    setInterval(sweepExpiredEntitlements, SWEEP_INTERVAL_MS);
}

module.exports = { startEntitlementExpirySweep, sweepExpiredEntitlements };
