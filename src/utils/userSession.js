// session ของผู้ใช้งานระบบหลังบ้าน — ทำให้ token ของแอดมิน "เพิกถอนได้" (2026-09-20)
//
// JWT ล้วนเพิกถอนไม่ได้ตามธรรมชาติของมัน: เซิร์ฟเวอร์ไม่ได้จำอะไรไว้ ใครถือ token ที่ลายเซ็นถูกก็ผ่าน
// จนกว่าจะหมดอายุ (ของเรา 30 วัน) — การผูก `jti` กับแถวใน DB แล้วเช็คทุก request คือการแลก
// "query เพิ่ม 1 ครั้งต่อ request" กับ "ตัดสิทธิ์ได้ทันที" ซึ่งคุ้มมากสำหรับบัญชีที่เข้าถึงข้อมูลลูกค้าทั้งระบบ
// (ทราฟฟิกฝั่งแอดมินคือคนไม่กี่คน ไม่ใช่ลูกค้าทั้งเว็บ ต้นทุนนี้จึงแทบไม่มีผล)
//
// ตัวเทียบเคียง: tb_customer_sessions ฝั่งลูกค้า (utils/customerSession.js) — ต่างกันที่ฝั่งนั้นจำกัด 2 อุปกรณ์
// เพื่อกันแชร์บัญชี ส่วนฝั่งนี้ไม่จำกัด เพราะแอดมินคนเดียวใช้หลายเครื่องตามงานจริงได้
const crypto = require("crypto");
const pool = require("../config/db");
const { generateId } = require("./generateId");

// อัปเดต "ใช้งานล่าสุด" อย่างมากนาทีละครั้งต่อ session — ไม่งั้นทุก request จะกลายเป็น write ลง DB
const LAST_SEEN_THROTTLE_MS = 60 * 1000;
const lastSeenAt = new Map(); // jti -> เวลาที่เพิ่งอัปเดต (ในหน่วยความจำ process เดียวพอ)

async function createSession(userId, { deviceInfo, ip } = {}) {
    const jti = crypto.randomUUID();
    const usessId = await generateId("tb_user_sessions", "USS");
    await pool.query(
        "INSERT INTO tb_user_sessions (usess_id, usess_user_id, usess_jti, usess_device_info, usess_ip) VALUES (?, ?, ?, ?, ?)",
        [usessId, userId, jti, deviceInfo ? String(deviceInfo).slice(0, 255) : null, ip ? String(ip).slice(0, 45) : null]
    );
    return jti;
}

async function sessionExists(jti) {
    return !!(await sessionOwner(jti));
}

// คืนเจ้าของ session (อีเมล/ชื่อ) มาพร้อมกันเลย — audit log ต้องเก็บ snapshot ว่า "ตอนนั้นใครทำ"
// รวมไว้ใน query เดียวกับที่ requireAuth เช็ค session อยู่แล้ว จึงไม่มีรอบ query เพิ่มต่อ request
async function sessionOwner(jti) {
    if (!jti) return null;
    const [rows] = await pool.query(
        `SELECT s.usess_id, u.user_id, u.user_email, CONCAT(u.user_fname, ' ', u.user_lname) AS user_name
         FROM tb_user_sessions s
         JOIN tb_users u ON u.user_id = s.usess_user_id
         WHERE s.usess_jti = ? LIMIT 1`,
        [jti]
    );
    return rows[0] ?? null;
}

function touchSession(jti) {
    if (!jti) return;
    const now = Date.now();
    if (now - (lastSeenAt.get(jti) ?? 0) < LAST_SEEN_THROTTLE_MS) return;
    lastSeenAt.set(jti, now);
    // ไม่ await — เป็นข้อมูลประกอบ ห้ามทำให้ request ของแอดมินช้าลงหรือพังถ้า query นี้ล้ม
    pool.query("UPDATE tb_user_sessions SET usess_last_seen_at = NOW() WHERE usess_jti = ?", [jti]).catch(() => {});
}

const listSessions = async (userId) => {
    const [rows] = await pool.query(
        `SELECT usess_id, usess_jti, usess_device_info, usess_ip, usess_created_at, usess_last_seen_at
         FROM tb_user_sessions WHERE usess_user_id = ? ORDER BY usess_created_at DESC`,
        [userId]
    );
    return rows;
};

const revokeSessionByJti = (jti) => pool.query("DELETE FROM tb_user_sessions WHERE usess_jti = ?", [jti]);

// เตะทุกอุปกรณ์ของผู้ใช้คนนี้ — ใช้ตอนตั้งรหัสผ่านใหม่/เปลี่ยนรหัสผ่าน เพราะเหตุผลที่ต้องเปลี่ยนรหัส
// มักคือ "สงสัยว่าคนอื่นเข้าถึงบัญชีได้" ถ้าไม่เตะออก การเปลี่ยนรหัสจะไม่ได้ตัดคนร้ายออกจริง
const revokeAllSessions = (userId) => pool.query("DELETE FROM tb_user_sessions WHERE usess_user_id = ?", [userId]);

module.exports = { createSession, sessionExists, sessionOwner, touchSession, listSessions, revokeSessionByJti, revokeAllSessions };
