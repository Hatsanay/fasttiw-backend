const pool = require("../config/db");

async function getAll(req, res, next) {
    try {
        const limit = Number(req.query.limit) || 10;
        const offset = Number(req.query.offset) || 0;
        const search = `%${req.query.search ?? ""}%`;

        const [rows] = await pool.query(
            `SELECT user_id, CONCAT(user_fname, ' ', user_lname) AS fullname,
                    user_email, user_partner_share_percent AS share_percent
             FROM tb_users
             WHERE user_is_partner = TRUE
               AND (user_fname LIKE ? OR user_lname LIKE ? OR user_email LIKE ?)
             ORDER BY user_partner_share_percent DESC
             LIMIT ? OFFSET ?`,
            [search, search, search, limit, offset]
        );
        const [[{ total }]] = await pool.query(
            `SELECT COUNT(*) AS total FROM tb_users
             WHERE user_is_partner = TRUE
               AND (user_fname LIKE ? OR user_lname LIKE ? OR user_email LIKE ?)`,
            [search, search, search]
        );

        res.json({ data: rows, total });
    } catch (err) {
        next(err);
    }
}

// สัดส่วนหุ้นต้องมากกว่า 0 และไม่เกิน 100 — คืน error message หรือ null ถ้าผ่าน
function validateSharePercent(value) {
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0 || num > 100) return "กรุณากรอกสัดส่วนหุ้น (0-100)";
    return null;
}

// ตั้ง/แก้ไขสัดส่วนหุ้นของ user คนหนึ่งให้เป็นหุ้นส่วน (upsert ผ่าน user_id ที่มีอยู่แล้วในระบบ)
async function setPartner(req, res, next) {
    try {
        const { user_id, share_percent } = req.body;
        if (!user_id) return res.status(400).json({ message: "กรุณาเลือกพนักงาน" });

        const error = validateSharePercent(share_percent);
        if (error) return res.status(400).json({ message: error });

        const [result] = await pool.query(
            "UPDATE tb_users SET user_is_partner = TRUE, user_partner_share_percent = ? WHERE user_id = ?",
            [share_percent, user_id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ message: "ไม่พบผู้ใช้งานนี้" });

        res.json({ message: "บันทึกข้อมูลหุ้นส่วนสำเร็จ" });
    } catch (err) {
        next(err);
    }
}

// ถอดออกจากการเป็นหุ้นส่วน (ไม่ได้ลบ user ทิ้ง แค่ปิด flag)
async function removePartner(req, res, next) {
    try {
        const [result] = await pool.query(
            "UPDATE tb_users SET user_is_partner = FALSE, user_partner_share_percent = NULL WHERE user_id = ?",
            [req.params.userId]
        );
        if (result.affectedRows === 0) return res.status(404).json({ message: "ไม่พบผู้ใช้งานนี้" });

        res.status(204).end();
    } catch (err) {
        next(err);
    }
}

module.exports = { getAll, setPartner, removePartner };
