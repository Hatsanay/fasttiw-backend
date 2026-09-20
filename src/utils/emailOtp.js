// รหัส OTP ทางอีเมล — ที่เดียวของทั้งระบบ (2026-09-20)
//
// เดิมกติกาทั้งหมดเขียนอยู่ใน customerAuth.controller.js (ใช้กับการสมัครสมาชิกอย่างเดียว) พอต้องใช้ซ้ำกับ
// "ลืมรหัสผ่านฝั่งแอดมิน" จึงย้ายมาไว้ที่เดียว — ถ้าก๊อปไปเขียนซ้ำ วันไหนแก้กติกาที่หนึ่งแล้วลืมอีกที่
// ช่องโหว่จะเปิดอยู่ฝั่งเดียวโดยไม่มีใครรู้
//
// แยกกันด้วย purpose (`register`, `staff_reset`) — รหัสของคนละเรื่องใช้ข้ามกันไม่ได้แม้เป็นอีเมลเดียวกัน
//
// เกราะจริงของรหัส 6 หลักคือ **อายุสั้น + จำกัดจำนวนครั้งที่กรอกผิด + ใช้ได้ครั้งเดียว** ไม่ใช่การเก็บแฮช
// (6 หลักมีล้านค่า ถ้า DB หลุดก็ไล่ย้อนได้ในพริบตา) — แต่เก็บแฮชไว้อยู่ดี เพราะไม่มีเหตุผลให้เก็บตัวเลขตรงๆ
const crypto = require("node:crypto");
const pool = require("../config/db");
const { generateId } = require("./generateId");

const OTP_TTL_MINUTES = 10;       // สั้นพอที่จะปลอดภัย ยาวพอให้เมลเข้าช้าได้บ้าง
const OTP_MAX_REQUESTS_PER_HOUR = 5; // ต่อ 1 อีเมล — เผื่อคนกดขอรหัสใหม่หลายรอบเพราะเมลเข้าช้า
const OTP_MAX_ATTEMPTS = 5;       // กรอกผิดได้กี่ครั้งต่อรหัส 1 ชุด ก่อนต้องขอรหัสใหม่

// รหัส 6 หลักแบบสุ่มเท่ากันทุกค่า — ใช้ crypto.randomInt ไม่ใช่ Math.random เพราะอันหลังเดาลำดับถัดไปได้
// ถ้ารู้ค่าก่อนหน้า (ไม่ใช่ CSPRNG) padStart กัน 6 หลักที่ขึ้นต้นด้วย 0 หายไปตอนแปลงเป็นสตริง
const generateOtp = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
const hashOtp = (code) => crypto.createHash("sha256").update(String(code ?? "")).digest("hex");

const otpError = (status, message) => Object.assign(new Error(message), { status });

// ออกรหัสใหม่ให้อีเมลนี้ — คืนรหัสตัวจริงกลับไปให้ผู้เรียกส่งอีเมลเอง (ตัวนี้ไม่ส่งเมล เพราะแต่ละเรื่อง
// ใช้เทมเพลตคนละแบบ) · โยน error 429 ถ้าขอถี่เกินไป
async function issueOtp({ email, purpose }) {
    const [recent] = await pool.query(
        `SELECT COUNT(*) AS n FROM tb_email_otps
         WHERE otp_email = ? AND otp_purpose = ? AND otp_created_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)`,
        [email, purpose]
    );
    if (recent[0].n >= OTP_MAX_REQUESTS_PER_HOUR) {
        throw otpError(429, "ขอรหัสยืนยันถี่เกินไป กรุณารอสักครู่แล้วลองใหม่");
    }

    // ขอรหัสใหม่ = รหัสเก่าที่ยังไม่ได้ใช้เป็นอันใช้ไม่ได้ทันที ให้มีรหัสที่ใช้ได้แค่ชุดล่าสุดชุดเดียว
    await pool.query(
        "UPDATE tb_email_otps SET otp_used_at = NOW() WHERE otp_email = ? AND otp_purpose = ? AND otp_used_at IS NULL",
        [email, purpose]
    );

    const code = generateOtp();
    const otp_id = await generateId("tb_email_otps", "OTP");
    await pool.query(
        `INSERT INTO tb_email_otps (otp_id, otp_email, otp_purpose, otp_code_hash, otp_expires_at)
         VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE))`,
        [otp_id, email, purpose, hashOtp(code), OTP_TTL_MINUTES]
    );

    // เก็บกวาดรหัสเก่าที่หมดอายุนานแล้ว (ตารางนี้โตเร็ว แต่ยังไม่คุ้มตั้ง job แยก)
    await pool.query("DELETE FROM tb_email_otps WHERE otp_expires_at < DATE_SUB(NOW(), INTERVAL 1 DAY)");

    return { code, otp_id, expiresMinutes: OTP_TTL_MINUTES };
}

// ตรวจรหัสของอีเมล+purpose นั้น — คืน otp_id ที่ใช้ได้ · ยังไม่ตัดรหัสทิ้ง ให้ผู้เรียกเรียก markOtpUsed()
// หลังงานหลักสำเร็จแล้ว (ถ้าตัดตรงนี้แล้วงานหลักล้มทีหลัง ผู้ใช้จะต้องขอรหัสใหม่ทั้งที่กรอกถูก)
//
// นับ attempts ทุกครั้งที่กรอกผิด เพื่อไม่ให้ไล่เดา 6 หลักได้ไม่จำกัด
async function consumeOtp({ email, purpose, code }) {
    const [rows] = await pool.query(
        `SELECT otp_id, otp_code_hash, otp_attempts FROM tb_email_otps
         WHERE otp_email = ? AND otp_purpose = ? AND otp_used_at IS NULL AND otp_expires_at > NOW()
         ORDER BY otp_created_at DESC LIMIT 1`,
        [email, purpose]
    );
    const otp = rows[0];
    if (!otp) throw otpError(400, "รหัสยืนยันหมดอายุหรือยังไม่ได้ขอรหัส กรุณากดขอรหัสใหม่");

    if (otp.otp_attempts >= OTP_MAX_ATTEMPTS) {
        throw otpError(400, "กรอกรหัสผิดหลายครั้งเกินไป กรุณากดขอรหัสใหม่");
    }
    if (otp.otp_code_hash !== hashOtp(code)) {
        await pool.query("UPDATE tb_email_otps SET otp_attempts = otp_attempts + 1 WHERE otp_id = ?", [otp.otp_id]);
        const left = OTP_MAX_ATTEMPTS - otp.otp_attempts - 1;
        throw otpError(400, left > 0 ? `รหัสยืนยันไม่ถูกต้อง (เหลือ ${left} ครั้ง)` : "กรอกรหัสผิดหลายครั้งเกินไป กรุณากดขอรหัสใหม่");
    }
    return otp.otp_id;
}

const markOtpUsed = (otpId) => pool.query("UPDATE tb_email_otps SET otp_used_at = NOW() WHERE otp_id = ?", [otpId]);

module.exports = {
    issueOtp, consumeOtp, markOtpUsed, generateOtp,
    OTP_TTL_MINUTES, OTP_MAX_REQUESTS_PER_HOUR, OTP_MAX_ATTEMPTS,
};
