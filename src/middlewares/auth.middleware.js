const { verifyToken } = require("../utils/jwt");

function requireAuth(req, res, next) {
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : null;

    if (!token) return res.status(401).json({ message: "ไม่พบ token" });

    try {
        req.user = verifyToken(token); // { user_id, user_role_id }
        next();
    } catch {
        res.status(401).json({ message: "token ไม่ถูกต้องหรือหมดอายุ" });
    }
}

module.exports = { requireAuth };
