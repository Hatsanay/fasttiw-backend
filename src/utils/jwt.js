const jwt = require("jsonwebtoken");

// expiresIn: ใส่เฉพาะกรณีที่ต้องการอายุสั้นกว่าปกติ (เช่น challenge_token ของ 2FA) — ปกติใช้ค่าจาก env
function signToken(payload, expiresIn) {
    return jwt.sign(payload, process.env.JWT_SECRET, {
        expiresIn: expiresIn || process.env.JWT_EXPIRES_IN || "30d",
    });
}

function verifyToken(token) {
    return jwt.verify(token, process.env.JWT_SECRET);
}

module.exports = { signToken, verifyToken };
