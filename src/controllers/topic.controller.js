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
        const categoryId = req.query.category_id || null;

        const statusClause = status ? "AND t.tpc_status = ?" : "";
        const categoryClause = categoryId ? "AND t.tpc_category_id = ?" : "";
        const extraParams = [
            ...(status ? [status] : []),
            ...(categoryId ? [categoryId] : []),
        ];

        const [rows] = await pool.query(
            `SELECT t.tpc_id, t.tpc_name, t.tpc_category_id, t.tpc_status,
                    t.tpc_created_at, t.tpc_updated_at, c.cat_name AS tpc_category_name
             FROM tb_topics t
             LEFT JOIN tb_categories c ON c.cat_id = t.tpc_category_id
             WHERE t.tpc_name LIKE ? ${statusClause} ${categoryClause}
             ORDER BY t.tpc_id DESC
             LIMIT ? OFFSET ?`,
            [search, ...extraParams, limit, offset]
        );
        const [[{ total }]] = await pool.query(
            `SELECT COUNT(*) AS total FROM tb_topics t
             WHERE t.tpc_name LIKE ? ${statusClause} ${categoryClause}`,
            [search, ...extraParams]
        );

        res.json({ data: rows, total });
    } catch (err) {
        next(err);
    }
}

async function getOne(req, res, next) {
    try {
        const [rows] = await pool.query(
            `SELECT t.tpc_id, t.tpc_name, t.tpc_category_id, t.tpc_status,
                    t.tpc_created_at, t.tpc_updated_at, c.cat_name AS tpc_category_name
             FROM tb_topics t
             LEFT JOIN tb_categories c ON c.cat_id = t.tpc_category_id
             WHERE t.tpc_id = ?`,
            [req.params.id]
        );
        if (!rows[0]) return res.status(404).json({ message: "ไม่พบหมวดหมู่คำถามนี้" });
        res.json(rows[0]);
    } catch (err) {
        next(err);
    }
}

async function create(req, res, next) {
    try {
        const { tpc_name, tpc_category_id } = req.body;
        if (!tpc_name) return res.status(400).json({ message: "กรุณากรอกชื่อหมวดหมู่คำถาม" });

        const tpc_id = await generateId("tb_topics", "TPC");
        await pool.query("INSERT INTO tb_topics (tpc_id, tpc_name, tpc_category_id) VALUES (?, ?, ?)", [
            tpc_id,
            tpc_name,
            tpc_category_id || null,
        ]);

        res.status(201).json({ tpc_id, tpc_name });
    } catch (err) {
        if (err.code === "ER_DUP_ENTRY") {
            return res.status(409).json({ message: "ชื่อหมวดหมู่คำถามนี้ถูกใช้งานแล้วในหมวดหมู่เดียวกัน" });
        }
        next(err);
    }
}

async function update(req, res, next) {
    try {
        const { tpc_name, tpc_status, tpc_category_id } = req.body;
        if (!tpc_name) return res.status(400).json({ message: "กรุณากรอกชื่อหมวดหมู่คำถาม" });

        await pool.query(
            "UPDATE tb_topics SET tpc_name = ?, tpc_status = ?, tpc_category_id = ? WHERE tpc_id = ?",
            [tpc_name, tpc_status === "inactive" ? "inactive" : "active", tpc_category_id || null, req.params.id]
        );

        res.json({ message: "แก้ไขหมวดหมู่คำถามสำเร็จ" });
    } catch (err) {
        if (err.code === "ER_DUP_ENTRY") {
            return res.status(409).json({ message: "ชื่อหมวดหมู่คำถามนี้ถูกใช้งานแล้วในหมวดหมู่เดียวกัน" });
        }
        next(err);
    }
}

async function remove(req, res, next) {
    try {
        await pool.query("DELETE FROM tb_topics WHERE tpc_id = ?", [req.params.id]);
        res.status(204).end();
    } catch (err) {
        if (err.code === "ER_ROW_IS_REFERENCED_2" || err.code === "ER_ROW_IS_REFERENCED") {
            return res.status(409).json({ message: "ไม่สามารถลบหมวดหมู่นี้ได้ เพราะมีคำถามผูกอยู่" });
        }
        next(err);
    }
}

module.exports = { getAll, getOne, create, update, remove };
