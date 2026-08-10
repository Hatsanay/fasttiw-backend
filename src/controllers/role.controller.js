const pool = require("../config/db");
const { generateId } = require("../utils/generateId");

async function getAll(req, res, next) {
    try {
        const limit = Number(req.query.limit) || 10;
        const offset = Number(req.query.offset) || 0;
        const search = `%${req.query.search ?? ""}%`;

        const [rows] = await pool.query(
            `SELECT r.role_id, r.role_name, r.role_granted_at, r.role_update_at,
                    d.dep_name AS role_department_name,
                    CONCAT(u.user_fname, ' ', u.user_lname) AS by_fullname
             FROM tb_roles r
             LEFT JOIN tb_users u ON u.user_id = r.role_granted_by_id
             LEFT JOIN tb_department d ON d.dep_id = r.role_department
             WHERE r.role_name LIKE ?
             ORDER BY r.role_id DESC
             LIMIT ? OFFSET ?`,
            [search, limit, offset]
        );
        const [[{ total }]] = await pool.query(
            "SELECT COUNT(*) AS total FROM tb_roles WHERE role_name LIKE ?",
            [search]
        );

        res.json({ data: rows, total });
    } catch (err) {
        next(err);
    }
}

async function getOne(req, res, next) {
    try {
        const [rows] = await pool.query(
            `SELECT r.role_id, r.role_name, r.role_permission, r.role_department,
                    r.role_granted_at, r.role_update_at,
                    d.dep_name AS role_department_name,
                    CONCAT(u.user_fname, ' ', u.user_lname) AS by_fullname
             FROM tb_roles r
             LEFT JOIN tb_users u ON u.user_id = r.role_granted_by_id
             LEFT JOIN tb_department d ON d.dep_id = r.role_department
             WHERE r.role_id = ?`,
            [req.params.id]
        );
        if (!rows[0]) return res.status(404).json({ message: "ไม่พบสิทธิ์นี้" });
        res.json(rows[0]);
    } catch (err) {
        next(err);
    }
}

async function create(req, res, next) {
    try {
        const { role_name, role_permission, role_granted_by_id, role_type, role_department } = req.body;
        if (!role_name || !role_permission) {
            return res.status(400).json({ message: "กรอกข้อมูลไม่ครบ" });
        }

        const role_id = await generateId("tb_roles", "ROL");

        await pool.query(
            `INSERT INTO tb_roles (role_id, role_name, role_permission, role_granted_by_id, role_type, role_department)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [role_id, role_name, role_permission, role_granted_by_id || null, role_type || "R", role_department || null]
        );

        res.status(201).json({ role_id });
    } catch (err) {
        if (err.code === "ER_DUP_ENTRY") {
            return res.status(409).json({ message: "ชื่อสิทธิ์นี้ถูกใช้งานแล้ว" });
        }
        next(err);
    }
}

async function update(req, res, next) {
    try {
        const { role_name, role_permission, role_department } = req.body;

        await pool.query(
            "UPDATE tb_roles SET role_name = ?, role_permission = ?, role_department = ? WHERE role_id = ?",
            [role_name, role_permission, role_department || null, req.params.id]
        );

        res.json({ message: "แก้ไขสิทธิ์สำเร็จ" });
    } catch (err) {
        if (err.code === "ER_DUP_ENTRY") {
            return res.status(409).json({ message: "ชื่อสิทธิ์นี้ถูกใช้งานแล้ว" });
        }
        next(err);
    }
}

async function remove(req, res, next) {
    try {
        const [rows] = await pool.query("SELECT role_type FROM tb_roles WHERE role_id = ?", [
            req.params.id,
        ]);
        if (rows[0]?.role_type === "S") {
            return res.status(400).json({ message: "ไม่สามารถลบ system role ได้" });
        }

        await pool.query("DELETE FROM tb_roles WHERE role_id = ?", [req.params.id]);
        res.status(204).end();
    } catch (err) {
        next(err);
    }
}

module.exports = { getAll, getOne, create, update, remove };
