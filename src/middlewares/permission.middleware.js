const pool = require("../config/db");
const { hasBit } = require("../utils/permissions");

// Looks up the caller's role_permission fresh from the DB on every request —
// never trust a bitmask cached in the JWT/cookie, since roles are editable at runtime.
// keys: single permission key, or an array where ANY match grants access.
function requirePermission(keys) {
    const required = Array.isArray(keys) ? keys : [keys];
    return async function (req, res, next) {
        try {
            const [rows] = await pool.query(
                "SELECT role_permission FROM tb_roles WHERE role_id = ?",
                [req.user?.user_role_id]
            );
            const rolePermission = rows[0]?.role_permission ?? "";

            if (!required.some((key) => hasBit(rolePermission, key))) {
                return res.status(403).json({ message: "ไม่มีสิทธิ์เข้าถึง" });
            }
            next();
        } catch (err) {
            next(err);
        }
    };
}

module.exports = { requirePermission };
