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

        const statusClause = status ? "AND cat_status = ?" : "";
        const whereParams = status ? [search, status] : [search];

        const [rows] = await pool.query(
            `SELECT cat_id, cat_name, cat_status, cat_show_on_landing, cat_created_at, cat_updated_at
             FROM tb_categories
             WHERE cat_name LIKE ? ${statusClause}
             ORDER BY cat_id DESC
             LIMIT ? OFFSET ?`,
            [...whereParams, limit, offset]
        );
        const [[{ total }]] = await pool.query(
            `SELECT COUNT(*) AS total FROM tb_categories WHERE cat_name LIKE ? ${statusClause}`,
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
            "SELECT cat_id, cat_name, cat_status, cat_show_on_landing, cat_created_at, cat_updated_at FROM tb_categories WHERE cat_id = ?",
            [req.params.id]
        );
        if (!rows[0]) return res.status(404).json({ message: "ไม่พบหมวดหมู่นี้" });
        res.json(rows[0]);
    } catch (err) {
        next(err);
    }
}

async function create(req, res, next) {
    try {
        const { cat_name, cat_show_on_landing } = req.body;
        if (!cat_name) return res.status(400).json({ message: "กรุณากรอกชื่อหมวดหมู่" });

        const cat_id = await generateId("tb_categories", "CAT");
        await pool.query("INSERT INTO tb_categories (cat_id, cat_name, cat_show_on_landing) VALUES (?, ?, ?)", [
            cat_id,
            cat_name,
            !!cat_show_on_landing,
        ]);

        res.status(201).json({ cat_id, cat_name });
    } catch (err) {
        if (err.code === "ER_DUP_ENTRY") {
            return res.status(409).json({ message: "ชื่อหมวดหมู่นี้ถูกใช้งานแล้ว" });
        }
        next(err);
    }
}

async function update(req, res, next) {
    try {
        const { cat_name, cat_status, cat_show_on_landing } = req.body;
        if (!cat_name) return res.status(400).json({ message: "กรุณากรอกชื่อหมวดหมู่" });

        await pool.query(
            "UPDATE tb_categories SET cat_name = ?, cat_status = ?, cat_show_on_landing = ? WHERE cat_id = ?",
            [cat_name, cat_status === "inactive" ? "inactive" : "active", !!cat_show_on_landing, req.params.id]
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
        await pool.query("DELETE FROM tb_categories WHERE cat_id = ?", [req.params.id]);
        res.status(204).end();
    } catch (err) {
        if (err.code === "ER_ROW_IS_REFERENCED_2" || err.code === "ER_ROW_IS_REFERENCED") {
            return res.status(409).json({ message: "ไม่สามารถลบหมวดหมู่นี้ได้ เพราะมีชุดข้อสอบผูกอยู่" });
        }
        next(err);
    }
}

module.exports = { getAll, getOne, create, update, remove };
