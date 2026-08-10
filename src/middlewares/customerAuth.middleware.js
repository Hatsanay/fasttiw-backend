const { verifyToken } = require("../utils/jwt");
const { sessionExists } = require("../utils/customerSession");

// แยกจาก requireAuth (staff) โดยตั้งใจ — token ของลูกค้ามี payload รูปทรงต่างกันชัดเจน ({ cus_id }
// ไม่ใช่ { user_id, user_role_id }) กันไม่ให้ staff token ใช้เข้าถึง route ฝั่งลูกค้าได้ (หรือกลับกัน)
//
// ต้อง query DB เพิ่ม 1 ครั้งต่อ request (เช็ค jti ใน tb_customer_sessions) เพื่อรองรับจำกัดจำนวน
// อุปกรณ์ล็อกอินพร้อมกัน (กันแชร์บัญชี) — token เดิมที่ออกก่อนมี jti (ถ้ามีหลงเหลือ) จะถือว่าไม่ผ่าน
// บังคับให้ล็อกอินใหม่ครั้งเดียว ยอมรับความไม่สะดวกเล็กน้อยตรงนี้เพื่อความปลอดภัย
async function requireCustomerAuth(req, res, next) {
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : null;

    if (!token) return res.status(401).json({ message: "ไม่พบ token" });

    try {
        const payload = verifyToken(token);
        if (!payload.cus_id) return res.status(401).json({ message: "token ไม่ถูกต้อง" });

        const stillActive = await sessionExists(payload.jti);
        if (!stillActive) {
            return res.status(401).json({ message: "เซสชันนี้ถูกออกจากระบบแล้ว (อาจเพราะล็อกอินเครื่องใหม่เกินโควตา) กรุณาเข้าสู่ระบบใหม่" });
        }

        req.customer = payload; // { cus_id, mcp, jti }
        next();
    } catch (err) {
        if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError") {
            return res.status(401).json({ message: "token ไม่ถูกต้องหรือหมดอายุ" });
        }
        next(err);
    }
}

// เหมือน requireCustomerAuth แต่ไม่ปฏิเสธถ้าไม่มี token — ใช้กับ endpoint แชทที่ต้องรองรับทั้งผู้เยี่ยมชม
// (ยังไม่ login เลย) และลูกค้าที่ login แล้วในคนละ request เดียวกัน ผลลัพธ์: req.customer = payload ถ้า token
// ถูกต้อง มิฉะนั้น (ไม่มี token, token หมดอายุ, เซสชันถูกเตะ) req.customer = null แล้วปล่อยผ่านไปให้ controller
// เป็นคนตัดสินเองว่าจะรับ guest ID แทนหรือปฏิเสธ (ไม่ error ที่ชั้น middleware เพราะ "ไม่ login" เป็นสถานะ
// ปกติที่รองรับได้ ไม่ใช่ auth failure)
async function optionalCustomerAuth(req, res, next) {
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : null;

    if (!token) {
        req.customer = null;
        return next();
    }

    try {
        const payload = verifyToken(token);
        const stillActive = payload.cus_id && await sessionExists(payload.jti);
        req.customer = stillActive ? payload : null;
    } catch {
        req.customer = null;
    }
    next();
}

module.exports = { requireCustomerAuth, optionalCustomerAuth };
