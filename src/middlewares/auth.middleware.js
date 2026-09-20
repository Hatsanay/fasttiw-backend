const { verifyToken } = require("../utils/jwt");
const { sessionOwner, touchSession } = require("../utils/userSession");

// ตรวจ 2 ชั้น: ลายเซ็น JWT ถูกต้อง **และ** session ยังมีอยู่จริงใน DB (2026-09-20)
// ชั้นที่สองคือสิ่งที่ทำให้ "เพิกถอน token ได้" — ลบแถว session แล้ว token ใบนั้นใช้ไม่ได้ทันที
// ไม่ต้องรอ 30 วันให้หมดอายุเอง (ดู utils/userSession.js)
//
// ⚠ token รุ่นเก่าที่ออกก่อนระบบนี้ไม่มี jti → ใช้ไม่ได้ ทุกคนต้องล็อกอินใหม่ครั้งเดียวหลัง deploy
// ตั้งใจให้เป็นแบบนั้น: ถ้ายอมรับ token ที่ไม่มี jti ต่อไป ช่องที่เพิ่งปิดก็ยังเปิดอยู่อีก 30 วัน
async function requireAuth(req, res, next) {
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : null;

    if (!token) return res.status(401).json({ message: "ไม่พบ token" });

    let payload;
    try {
        payload = verifyToken(token); // { user_id, user_role_id, jti }
    } catch {
        return res.status(401).json({ message: "token ไม่ถูกต้องหรือหมดอายุ" });
    }

    try {
        const owner = await sessionOwner(payload.jti);
        if (!owner) {
            return res.status(401).json({ message: "เซสชันนี้ถูกยกเลิกแล้ว กรุณาเข้าสู่ระบบใหม่" });
        }
        touchSession(payload.jti);
        req.user = payload;
        // snapshot ไว้ให้ audit log — ต้องอ่านได้แม้ผู้ใช้คนนั้นถูกลบไปแล้วในภายหลัง
        req.auditUser = { email: owner.user_email, name: owner.user_name };
        next();
    } catch (err) {
        next(err);
    }
}

module.exports = { requireAuth };
