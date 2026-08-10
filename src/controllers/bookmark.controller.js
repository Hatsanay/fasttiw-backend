const pool = require("../config/db");
const { generateId } = require("../utils/generateId");

// คืนครบทั้งเฉลย (ตัวเลือก+เหตุผลตัวเลือกผิด+วิธีคิด) ไม่ใช่แค่ข้อความคำถามเฉยๆ — เพราะจุดประสงค์ของ
// bookmark คือกลับมา "ทบทวน" ข้อที่เคยพลาด ไม่ผูกกับ attempt ไหนเป็นการเฉพาะ จึงเปิดเฉลยได้เลยไม่ต้อง
// รอ submit เหมือนตอนทำข้อสอบจริง (ไม่กระทบความยุติธรรมของการสอบ เพราะเป็นข้อที่ทำเสร็จไปแล้ว)
async function getAll(req, res, next) {
    try {
        const [bookmarks] = await pool.query(
            `SELECT b.bmk_id, b.bmk_question_id, q.ques_text, q.ques_explanation, q.ques_image_url, q.ques_product_id,
                    p.prod_name, b.bmk_created_at
             FROM tb_bookmarks b
             JOIN tb_questions q ON q.ques_id = b.bmk_question_id
             JOIN tb_products p ON p.prod_id = q.ques_product_id
             WHERE b.bmk_customer_id = ?
             ORDER BY b.bmk_created_at DESC`,
            [req.customer.cus_id]
        );

        if (bookmarks.length === 0) return res.json({ data: [] });

        const [choices] = await pool.query(
            `SELECT cho_id, cho_question_id, cho_text, cho_is_correct, cho_wrong_reason, cho_image_url, cho_order
             FROM tb_choices WHERE cho_question_id IN (?)
             ORDER BY cho_order`,
            [bookmarks.map((b) => b.bmk_question_id)]
        );
        const choicesByQuestion = {};
        for (const c of choices) {
            (choicesByQuestion[c.cho_question_id] ??= []).push(c);
        }

        const data = bookmarks.map((b) => ({
            bmk_id: b.bmk_id,
            ques_id: b.bmk_question_id,
            ques_text: b.ques_text,
            ques_explanation: b.ques_explanation,
            ques_image_url: b.ques_image_url,
            prod_id: b.ques_product_id,
            prod_name: b.prod_name,
            bmk_created_at: b.bmk_created_at,
            choices: (choicesByQuestion[b.bmk_question_id] ?? []).map((c) => ({
                cho_id: c.cho_id,
                cho_text: c.cho_text,
                cho_image_url: c.cho_image_url,
                is_correct: !!c.cho_is_correct,
                wrong_reason: c.cho_is_correct ? null : c.cho_wrong_reason,
            })),
        }));

        res.json({ data });
    } catch (err) {
        next(err);
    }
}

async function add(req, res, next) {
    try {
        const bmk_id = await generateId("tb_bookmarks", "BMK");
        await pool.query(
            "INSERT INTO tb_bookmarks (bmk_id, bmk_customer_id, bmk_question_id) VALUES (?, ?, ?)",
            [bmk_id, req.customer.cus_id, req.params.questionId]
        );
        res.status(201).json({ bmk_id });
    } catch (err) {
        if (err.code === "ER_DUP_ENTRY") {
            return res.status(200).json({ message: "บันทึกไว้แล้ว" }); // idempotent — กดซ้ำไม่ error
        }
        if (err.code === "ER_NO_REFERENCED_ROW_2" || err.code === "ER_NO_REFERENCED_ROW") {
            return res.status(400).json({ message: "ไม่พบคำถามนี้" });
        }
        next(err);
    }
}

async function remove(req, res, next) {
    try {
        await pool.query(
            "DELETE FROM tb_bookmarks WHERE bmk_customer_id = ? AND bmk_question_id = ?",
            [req.customer.cus_id, req.params.questionId]
        );
        res.status(204).end();
    } catch (err) {
        next(err);
    }
}

module.exports = { getAll, add, remove };
