const pool = require("../config/db");
const { generateId } = require("../utils/generateId");

async function getAll(req, res, next) {
    try {
        const limit = Number(req.query.limit) || 10;
        const offset = Number(req.query.offset) || 0;
        const search = `%${req.query.search ?? ""}%`;

        const conditions = ["(ec.excat_name LIKE ? OR e.exp_note LIKE ?)"];
        const params = [search, search];
        if (req.query.from) { conditions.push("e.exp_date >= ?"); params.push(req.query.from); }
        if (req.query.to) { conditions.push("e.exp_date <= ?"); params.push(req.query.to); }
        // product_id="" หรือไม่ส่งมา = ไม่กรอง, "general" = เอาเฉพาะรายจ่ายทั่วไป (ไม่ผูก product),
        // ค่าอื่น = กรองเฉพาะรายจ่ายของ product นั้น
        if (req.query.product_id === "general") {
            conditions.push("e.exp_product_id IS NULL");
        } else if (req.query.product_id) {
            conditions.push("e.exp_product_id = ?");
            params.push(req.query.product_id);
        }
        const whereClause = conditions.join(" AND ");

        const [rows] = await pool.query(
            `SELECT e.exp_id, e.exp_category_id, ec.excat_name, e.exp_product_id, p.prod_name,
                    e.exp_amount, e.exp_note, e.exp_date, e.exp_created_at, e.exp_updated_at
             FROM tb_expenses e
             JOIN tb_expense_categories ec ON ec.excat_id = e.exp_category_id
             LEFT JOIN tb_products p ON p.prod_id = e.exp_product_id
             WHERE ${whereClause}
             ORDER BY e.exp_date DESC, e.exp_id DESC
             LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );
        const [[{ total }]] = await pool.query(
            `SELECT COUNT(*) AS total FROM tb_expenses e
             JOIN tb_expense_categories ec ON ec.excat_id = e.exp_category_id
             WHERE ${whereClause}`,
            params
        );

        res.json({ data: rows, total });
    } catch (err) {
        next(err);
    }
}

async function getOne(req, res, next) {
    try {
        const [rows] = await pool.query(
            `SELECT exp_id, exp_category_id, exp_product_id, exp_amount, exp_note, exp_date, exp_created_at, exp_updated_at
             FROM tb_expenses WHERE exp_id = ?`,
            [req.params.id]
        );
        if (!rows[0]) return res.status(404).json({ message: "ไม่พบรายการค่าใช้จ่ายนี้" });
        res.json(rows[0]);
    } catch (err) {
        next(err);
    }
}

// ตรวจค่าที่ใช้ร่วมกันทั้ง create/update — คืน error message หรือ null ถ้าผ่าน
function validateExpense({ exp_category_id, exp_amount, exp_date }) {
    if (!exp_category_id) return "กรุณาเลือกหมวดหมู่ค่าใช้จ่าย";
    const amount = Number(exp_amount);
    if (!Number.isFinite(amount) || amount <= 0) return "จำนวนเงินต้องมากกว่า 0";
    if (!exp_date) return "กรุณาเลือกวันที่";
    return null;
}

async function create(req, res, next) {
    try {
        const { exp_category_id, exp_product_id, exp_amount, exp_note, exp_date } = req.body ?? {};
        const error = validateExpense(req.body ?? {});
        if (error) return res.status(400).json({ message: error });

        const exp_id = await generateId("tb_expenses", "EXP");
        await pool.query(
            `INSERT INTO tb_expenses (exp_id, exp_category_id, exp_product_id, exp_amount, exp_note, exp_date, exp_created_by_id)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [exp_id, exp_category_id, exp_product_id || null, exp_amount, exp_note || null, exp_date, req.user.user_id]
        );

        res.status(201).json({ exp_id });
    } catch (err) {
        if (err.code === "ER_NO_REFERENCED_ROW_2" || err.code === "ER_NO_REFERENCED_ROW") {
            return res.status(400).json({ message: "ไม่พบหมวดหมู่ค่าใช้จ่ายหรือชุดข้อสอบที่เลือก" });
        }
        next(err);
    }
}

async function update(req, res, next) {
    try {
        const { exp_category_id, exp_product_id, exp_amount, exp_note, exp_date } = req.body ?? {};
        const error = validateExpense(req.body ?? {});
        if (error) return res.status(400).json({ message: error });

        await pool.query(
            `UPDATE tb_expenses SET exp_category_id = ?, exp_product_id = ?, exp_amount = ?, exp_note = ?, exp_date = ?
             WHERE exp_id = ?`,
            [exp_category_id, exp_product_id || null, exp_amount, exp_note || null, exp_date, req.params.id]
        );

        res.json({ message: "แก้ไขค่าใช้จ่ายสำเร็จ" });
    } catch (err) {
        if (err.code === "ER_NO_REFERENCED_ROW_2" || err.code === "ER_NO_REFERENCED_ROW") {
            return res.status(400).json({ message: "ไม่พบหมวดหมู่ค่าใช้จ่ายหรือชุดข้อสอบที่เลือก" });
        }
        next(err);
    }
}

async function remove(req, res, next) {
    try {
        await pool.query("DELETE FROM tb_expenses WHERE exp_id = ?", [req.params.id]);
        res.status(204).end();
    } catch (err) {
        next(err);
    }
}

module.exports = { getAll, getOne, create, update, remove };
