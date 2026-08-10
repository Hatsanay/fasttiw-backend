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

        const statusClause = status ? "AND dep_status = ?" : "";
        const whereParams = status ? [search, status] : [search];

        const [rows] = await pool.query(
            `SELECT dep_id, dep_name, dep_status, dep_created_at, dep_updated_at
             FROM tb_department
             WHERE dep_name LIKE ? ${statusClause}
             ORDER BY dep_id DESC
             LIMIT ? OFFSET ?`,
            [...whereParams, limit, offset]
        );
        const [[{ total }]] = await pool.query(
            `SELECT COUNT(*) AS total FROM tb_department WHERE dep_name LIKE ? ${statusClause}`,
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
            "SELECT dep_id, dep_name, dep_status, dep_created_at, dep_updated_at FROM tb_department WHERE dep_id = ?",
            [req.params.id]
        );
        if (!rows[0]) return res.status(404).json({ message: "ไม่พบแผนกนี้" });
        res.json(rows[0]);
    } catch (err) {
        next(err);
    }
}

async function create(req, res, next) {
    try {
        const { dep_name } = req.body;
        if (!dep_name) return res.status(400).json({ message: "กรุณากรอกชื่อแผนก" });

        const dep_id = await generateId("tb_department", "DEP");
        await pool.query("INSERT INTO tb_department (dep_id, dep_name) VALUES (?, ?)", [
            dep_id,
            dep_name,
        ]);

        res.status(201).json({ dep_id, dep_name });
    } catch (err) {
        if (err.code === "ER_DUP_ENTRY") {
            return res.status(409).json({ message: "ชื่อแผนกนี้ถูกใช้งานแล้ว" });
        }
        next(err);
    }
}

async function update(req, res, next) {
    try {
        const { dep_name, dep_status } = req.body;
        if (!dep_name) return res.status(400).json({ message: "กรุณากรอกชื่อแผนก" });

        await pool.query(
            "UPDATE tb_department SET dep_name = ?, dep_status = ? WHERE dep_id = ?",
            [dep_name, dep_status === "inactive" ? "inactive" : "active", req.params.id]
        );

        res.json({ message: "แก้ไขแผนกสำเร็จ" });
    } catch (err) {
        if (err.code === "ER_DUP_ENTRY") {
            return res.status(409).json({ message: "ชื่อแผนกนี้ถูกใช้งานแล้ว" });
        }
        next(err);
    }
}

async function remove(req, res, next) {
    try {
        await pool.query("DELETE FROM tb_department WHERE dep_id = ?", [req.params.id]);
        res.status(204).end();
    } catch (err) {
        if (err.code === "ER_ROW_IS_REFERENCED_2" || err.code === "ER_ROW_IS_REFERENCED") {
            return res.status(409).json({ message: "ไม่สามารถลบแผนกนี้ได้ เพราะมีสิทธิ์ผูกอยู่กับแผนกนี้" });
        }
        next(err);
    }
}

module.exports = { getAll, getOne, create, update, remove };
