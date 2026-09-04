const crypto = require("crypto");
const pool = require("../config/db");
const { generateId } = require("./generateId");

const MAX_ACTIVE_SESSIONS = 2;

// สร้าง session ใหม่ตอน register/login (ไม่เรียกตอน completeOnboarding — จุดนั้นแค่ต่ออายุ token
// เดิม ใช้ jti เดิม ไม่กินโควตาอุปกรณ์เพิ่ม) เกินโควตาแล้วเตะอุปกรณ์เก่าสุดออกอัตโนมัติ (FIFO)
async function createSession(customerId, deviceInfo) {
    const jti = crypto.randomUUID();
    const sessId = await generateId("tb_customer_sessions", "SES");
    await pool.query(
        "INSERT INTO tb_customer_sessions (sess_id, sess_customer_id, sess_jti, sess_device_info) VALUES (?, ?, ?, ?)",
        [sessId, customerId, jti, deviceInfo ? deviceInfo.slice(0, 255) : null]
    );

    const [rows] = await pool.query(
        "SELECT sess_id FROM tb_customer_sessions WHERE sess_customer_id = ? ORDER BY sess_created_at ASC",
        [customerId]
    );
    if (rows.length > MAX_ACTIVE_SESSIONS) {
        const toEvict = rows.slice(0, rows.length - MAX_ACTIVE_SESSIONS).map((r) => r.sess_id);
        await pool.query("DELETE FROM tb_customer_sessions WHERE sess_id IN (?)", [toEvict]);
    }

    return jti;
}

async function sessionExists(jti) {
    if (!jti) return false;
    const [rows] = await pool.query("SELECT sess_id FROM tb_customer_sessions WHERE sess_jti = ? LIMIT 1", [jti]);
    return !!rows[0];
}

async function listSessions(customerId) {
    const [rows] = await pool.query(
        "SELECT sess_id, sess_jti, sess_device_info, sess_created_at FROM tb_customer_sessions WHERE sess_customer_id = ? ORDER BY sess_created_at DESC",
        [customerId]
    );
    return rows;
}

async function revokeSession(customerId, sessionId) {
    await pool.query(
        "DELETE FROM tb_customer_sessions WHERE sess_id = ? AND sess_customer_id = ?",
        [sessionId, customerId]
    );
}

// เรียกตอน logout จริง — ลบ session แถวของอุปกรณ์ปัจจุบันด้วย jti ที่ decode ได้จาก token ตรงๆ
// (ไม่ต้อง query หา sess_id ก่อนเหมือน revokeSession เพราะรู้ jti ของตัวเองอยู่แล้วจาก req.customer.jti)
async function revokeSessionByJti(customerId, jti) {
    await pool.query(
        "DELETE FROM tb_customer_sessions WHERE sess_jti = ? AND sess_customer_id = ?",
        [jti, customerId]
    );
}

// เตะทุกอุปกรณ์ของลูกค้าคนนี้ออกพร้อมกัน — ใช้ตอนตั้งรหัสผ่านใหม่ผ่านลิงก์ในอีเมล เพราะเหตุผลที่ลูกค้า
// กดลืมรหัสผ่านอาจเป็นเพราะบัญชีถูกคนอื่นเข้าถึงอยู่ ถ้าไม่เตะออก คนที่ล็อกอินค้างอยู่ก็ยังใช้ต่อได้เรื่อยๆ
// ทั้งที่เจ้าของเพิ่งเปลี่ยนรหัสผ่านไปแล้ว
async function revokeAllSessions(customerId) {
    await pool.query("DELETE FROM tb_customer_sessions WHERE sess_customer_id = ?", [customerId]);
}

module.exports = { createSession, sessionExists, listSessions, revokeSession, revokeSessionByJti, revokeAllSessions, MAX_ACTIVE_SESSIONS };
