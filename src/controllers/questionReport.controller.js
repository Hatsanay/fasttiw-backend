const pool = require("../config/db");
const { generateId } = require("../utils/generateId");

// ลูกค้าแจ้งปัญหารายข้อ (เฉลยผิด/พิมพ์ตก) จากหน้ารีวิว/bookmark — ไม่ auto แก้อะไร แค่สร้างเคสไว้
// ให้แอดมินมาตรวจสอบ/แก้ไขคำถามจริงเอง
async function createReport(req, res, next) {
    try {
        const { message } = req.body ?? {};
        if (!message?.trim()) return res.status(400).json({ message: "กรุณาระบุปัญหาที่พบ" });

        const [questionRows] = await pool.query("SELECT ques_id FROM tb_questions WHERE ques_id = ?", [req.params.id]);
        if (!questionRows[0]) return res.status(404).json({ message: "ไม่พบคำถามนี้" });

        const qrp_id = await generateId("tb_question_reports", "QRP");
        await pool.query(
            "INSERT INTO tb_question_reports (qrp_id, qrp_question_id, qrp_customer_id, qrp_message) VALUES (?, ?, ?, ?)",
            [qrp_id, req.params.id, req.customer.cus_id, message.trim()]
        );
        res.status(201).json({ qrp_id });
    } catch (err) {
        next(err);
    }
}

async function getAll(req, res, next) {
    try {
        const status = ["open", "resolved"].includes(req.query.status) ? req.query.status : null;
        const whereClause = status ? "WHERE r.qrp_status = ?" : "";
        const params = status ? [status] : [];

        const [rows] = await pool.query(
            `SELECT r.qrp_id, r.qrp_question_id, q.ques_text, q.ques_product_id, p.prod_name,
                    r.qrp_customer_id, c.cus_username, r.qrp_message, r.qrp_status,
                    r.qrp_created_at, r.qrp_resolved_at
             FROM tb_question_reports r
             JOIN tb_questions q ON q.ques_id = r.qrp_question_id
             JOIN tb_products p ON p.prod_id = q.ques_product_id
             JOIN tb_customers c ON c.cus_id = r.qrp_customer_id
             ${whereClause}
             ORDER BY r.qrp_created_at DESC`,
            params
        );
        res.json({ data: rows });
    } catch (err) {
        next(err);
    }
}

async function resolve(req, res, next) {
    try {
        await pool.query(
            "UPDATE tb_question_reports SET qrp_status = 'resolved', qrp_resolved_at = NOW() WHERE qrp_id = ?",
            [req.params.id]
        );
        res.json({ message: "ปิดเคสแล้ว" });
    } catch (err) {
        next(err);
    }
}

module.exports = { createReport, getAll, resolve };
