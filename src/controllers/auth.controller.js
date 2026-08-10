const bcrypt = require("bcryptjs");
const pool = require("../config/db");
const { signToken } = require("../utils/jwt");
const { generateId } = require("../utils/generateId");

async function writeLoginLog({ user_id, email, fullname, action, req }) {
    const log_id = await generateId("tb_login_logs", "LOG");
    await pool.query(
        `INSERT INTO tb_login_logs
            (log_id, log_user_id, log_email, log_fullname, log_action, log_ip_address, log_user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [log_id, user_id ?? null, email, fullname ?? null, action, req.ip, req.headers["user-agent"] ?? null]
    );
}

async function login(req, res, next) {
    try {
        const { user_email, user_password } = req.body;
        if (!user_email || !user_password) {
            return res.status(400).json({ message: "กรุณากรอกอีเมลและรหัสผ่าน" });
        }

        const [rows] = await pool.query(
            `SELECT user_id, user_password, user_role_id, user_status, user_fname, user_lname
             FROM tb_users WHERE user_email = ?`,
            [user_email]
        );
        const user = rows[0];
        const fullname = user ? `${user.user_fname} ${user.user_lname}` : null;

        if (!user || user.user_status !== "active") {
            await writeLoginLog({ user_id: user?.user_id, email: user_email, fullname, action: "login_failed", req });
            return res.status(401).json({ message: "อีเมลหรือรหัสผ่านไม่ถูกต้อง" });
        }

        const passwordOk = await bcrypt.compare(user_password, user.user_password);
        if (!passwordOk) {
            await writeLoginLog({ user_id: user.user_id, email: user_email, fullname, action: "login_failed", req });
            return res.status(401).json({ message: "อีเมลหรือรหัสผ่านไม่ถูกต้อง" });
        }

        await pool.query("UPDATE tb_users SET user_last_login_at = NOW() WHERE user_id = ?", [
            user.user_id,
        ]);
        await writeLoginLog({ user_id: user.user_id, email: user_email, fullname, action: "login", req });

        const token = signToken({ user_id: user.user_id, user_role_id: user.user_role_id });
        res.json({ token });
    } catch (err) {
        next(err);
    }
}

async function logout(req, res, next) {
    try {
        const [rows] = await pool.query(
            "SELECT user_email, user_fname, user_lname FROM tb_users WHERE user_id = ?",
            [req.user.user_id]
        );
        const user = rows[0];
        await writeLoginLog({
            user_id: req.user.user_id,
            email: user?.user_email ?? "",
            fullname: user ? `${user.user_fname} ${user.user_lname}` : null,
            action: "logout",
            req,
        });
        res.json({ message: "ออกจากระบบสำเร็จ" });
    } catch (err) {
        next(err);
    }
}

async function verifyPermission(req, res, next) {
    try {
        const user_role_id = req.query.user_role_id;
        const [rows] = await pool.query(
            "SELECT role_permission FROM tb_roles WHERE role_id = ?",
            [user_role_id]
        );
        if (!rows[0]) return res.status(404).json({ message: "ไม่พบสิทธิ์นี้" });

        res.json({ role_permission: rows[0].role_permission });
    } catch (err) {
        next(err);
    }
}

module.exports = { login, logout, verifyPermission };
