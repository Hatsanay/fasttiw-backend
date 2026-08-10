const pool = require("../config/db");
const { generateId } = require("../utils/generateId");

async function getAll(req, res, next) {
    try {
        const limit = Number(req.query.limit) || 10;
        const offset = Number(req.query.offset) || 0;
        const search = `%${req.query.search ?? ""}%`;
        const status = req.query.status === "active" || req.query.status === "inactive"
            ? req.query.status
            : null;

        const statusClause = status ? "AND excat_status = ?" : "";
        const whereParams = status ? [search, status] : [search];

        const [rows] = await pool.query(
            `SELECT excat_id, excat_name, excat_status, excat_created_at, excat_updated_at
             FROM tb_expense_categories
             WHERE excat_name LIKE ? ${statusClause}
             ORDER BY excat_id DESC
             LIMIT ? OFFSET ?`,
            [...whereParams, limit, offset]
        );
        const [[{ total }]] = await pool.query(
            `SELECT COUNT(*) AS total FROM tb_expense_categories WHERE excat_name LIKE ? ${statusClause}`,
            whereParams
        );

        res.json({ data: rows, total });
    } catch (err) {
        next(err);
    }
}

async function getOne(req, res, next) {
    try {
        const [rows] = await pool.query(
            "SELECT excat_id, excat_name, excat_status, excat_created_at, excat_updated_at FROM tb_expense_categories WHERE excat_id = ?",
            [req.params.id]
        );
        if (!rows[0]) return res.status(404).json({ message: "ไม่พบหมวดหมู่ค่าใช้จ่ายนี้" });
        res.json(rows[0]);
    } catch (err) {
        next(err);
    }
}

async function create(req, res, next) {
    try {
        const { excat_name } = req.body;
        if (!excat_name) return res.status(400).json({ message: "กรุณากรอกชื่อหมวดหมู่" });

        const excat_id = await generateId("tb_expense_categories", "EXC");
        await pool.query("INSERT INTO tb_expense_categories (excat_id, excat_name) VALUES (?, ?)", [
            excat_id, excat_name,
        ]);

        res.status(201).json({ excat_id, excat_name });
    } catch (err) {
        if (err.code === "ER_DUP_ENTRY") {
            return res.status(409).json({ message: "ชื่อหมวดหมู่นี้ถูกใช้งานแล้ว" });
        }
        next(err);
    }
}

async function update(req, res, next) {
    try {
        const { excat_name, excat_status } = req.body;
        if (!excat_name) return res.status(400).json({ message: "กรุณากรอกชื่อหมวดหมู่" });

        await pool.query(
            "UPDATE tb_expense_categories SET excat_name = ?, excat_status = ? WHERE excat_id = ?",
            [excat_name, excat_status === "inactive" ? "inactive" : "active", req.params.id]
        );

        res.json({ message: "แก้ไขหมวดหมู่สำเร็จ" });
    } catch (err) {
        if (err.code === "ER_DUP_ENTRY") {
            return res.status(409).json({ message: "ชื่อหมวดหมู่นี้ถูกใช้งานแล้ว" });
        }
        next(err);
    }
}

async function remove(req, res, next) {
    try {
        await pool.query("DELETE FROM tb_expense_categories WHERE excat_id = ?", [req.params.id]);
        res.status(204).end();
    } catch (err) {
        if (err.code === "ER_ROW_IS_REFERENCED_2" || err.code === "ER_ROW_IS_REFERENCED") {
            return res.status(409).json({ message: "ไม่สามารถลบหมวดหมู่นี้ได้ เพราะมีค่าใช้จ่ายผูกอยู่" });
        }
        next(err);
    }
}

module.exports = { getAll, getOne, create, update, remove };
