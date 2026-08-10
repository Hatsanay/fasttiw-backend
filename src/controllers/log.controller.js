const pool = require("../config/db");

async function getAll(req, res, next) {
    try {
        const limit = Number(req.query.limit) || 10;
        const offset = Number(req.query.offset) || 0;
        const search = `%${req.query.search ?? ""}%`;

        // ใช้ log_fullname ที่ snapshot ไว้ตอนเขียน log ตรงๆ ไม่ join ไป tb_users
        // เพราะถ้า user ถูกลบไปแล้ว join จะหาไม่เจอ ชื่อจะหายจาก log ทั้งที่ log_email ยังอยู่
        const [rows] = await pool.query(
            `SELECT log_id, log_email, log_fullname AS by_fullname, log_action,
                    log_ip_address, log_user_agent, log_created_at
             FROM tb_login_logs
             WHERE log_email LIKE ?
             ORDER BY log_id DESC
             LIMIT ? OFFSET ?`,
            [search, limit, offset]
        );
        const [[{ total }]] = await pool.query(
            "SELECT COUNT(*) AS total FROM tb_login_logs WHERE log_email LIKE ?",
            [search]
        );

        res.json({ data: rows, total });
    } catch (err) {
        next(err);
    }
}

async function removeAll(req, res, next) {
    try {
        await pool.query("DELETE FROM tb_login_logs");
        res.status(204).end();
    } catch (err) {
        next(err);
    }
}

module.exports = { getAll, removeAll };
