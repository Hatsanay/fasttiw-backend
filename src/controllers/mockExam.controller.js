// สนามสอบเสมือนจริง (2026-09-18) — ทำข้อสอบข้ามชุดตามโครงสร้างสนามสอบจริง ดู database/query/create_mock_exams.sql
//
// แอดมินตั้งโครงสร้างไว้ (วิชาไหนกี่ข้อ เวลาเท่าไหร่ เกณฑ์ผ่านรายวิชา) แล้วระบบสุ่มข้อจาก **ทุกชุดที่ลูกค้า
// คนนั้นมีสิทธิ์อยู่** มาประกอบเป็นชุดสอบใหม่ทุกครั้งที่เริ่ม — ลูกค้ามีชุดเยอะ ข้อสอบยิ่งไม่ซ้ำ
//
// v1 ไม่ใช้ระบบคะแนนรายข้อ (att_max_score = NULL เสมอ) เพราะข้อมาจากหลายชุดที่ตั้งคะแนนคนละแบบ
// เอามารวมกันแล้วคะแนนเต็มไม่มีความหมาย — นับเป็นจำนวนข้อล้วน
const pool = require("../config/db");
const { generateId } = require("../utils/generateId");
const { isBlank, normalizePassValue, validatePassCriterion } = require("../utils/passCriteria");

const MAX_SECTION_QUESTIONS = 500;

// ── แอดมิน ─────────────────────────────────────────────────────────────────────

async function getAll(req, res, next) {
    try {
        const limit = Number(req.query.limit) || 10;
        const offset = Number(req.query.offset) || 0;
        const search = `%${req.query.search ?? ""}%`;
        const status = ["draft", "published", "archived"].includes(req.query.status) ? req.query.status : null;

        const conditions = ["me_name LIKE ?"];
        const params = [search];
        if (status) { conditions.push("me_status = ?"); params.push(status); }
        const whereClause = conditions.join(" AND ");

        const [rows] = await pool.query(
            `SELECT m.me_id, m.me_name, m.me_status, m.me_time_limit_minutes, m.me_category_id, c.cat_name AS me_category_name,
                    m.me_pass_percent, m.me_pass_min, m.me_created_at,
                    (SELECT COUNT(*) FROM tb_mock_exam_sections s WHERE s.mes_exam_id = m.me_id) AS section_count,
                    (SELECT COALESCE(SUM(s.mes_question_count), 0) FROM tb_mock_exam_sections s WHERE s.mes_exam_id = m.me_id) AS question_count
             FROM tb_mock_exams m
             LEFT JOIN tb_categories c ON c.cat_id = m.me_category_id
             WHERE ${whereClause}
             ORDER BY m.me_id DESC
             LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );
        const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM tb_mock_exams WHERE ${whereClause}`, params);
        res.json({ data: rows.map(withNumbers), total });
    } catch (err) {
        next(err);
    }
}

const withNumbers = (r) => ({
    ...r,
    section_count: Number(r.section_count ?? 0),
    question_count: Number(r.question_count ?? 0),
    me_pass_min: r.me_pass_min == null ? null : Number(r.me_pass_min),
});

// วิชาของสนามสอบ + จำนวนข้อที่ "มีอยู่จริงในคลังทั้งหมด" ให้แอดมินเห็นว่าโควตาที่ตั้งไว้เกินของที่มีไหม
// (ของลูกค้าแต่ละคนจะน้อยกว่านี้ เพราะเห็นเฉพาะชุดที่ตัวเองมีสิทธิ์ — ดู buildSectionPools)
async function listSections(examId) {
    const [rows] = await pool.query(
        `SELECT s.mes_topic_id, t.tpc_name, c.cat_name AS tpc_category_name,
                s.mes_question_count, s.mes_pass_percent, s.mes_pass_min, s.mes_order,
                (SELECT COUNT(*) FROM tb_questions q
                  JOIN tb_products p ON p.prod_id = q.ques_product_id
                  WHERE q.ques_topic_id = s.mes_topic_id AND q.ques_status = 'active' AND p.prod_status = 'published') AS available
         FROM tb_mock_exam_sections s
         JOIN tb_topics t ON t.tpc_id = s.mes_topic_id
         LEFT JOIN tb_categories c ON c.cat_id = t.tpc_category_id
         WHERE s.mes_exam_id = ?
         ORDER BY s.mes_order ASC, t.tpc_name ASC`,
        [examId]
    );
    return rows.map((r) => ({
        tpc_id: r.mes_topic_id,
        tpc_name: r.tpc_name,
        tpc_category_name: r.tpc_category_name,
        question_count: Number(r.mes_question_count),
        pass_percent: r.mes_pass_percent,
        pass_min: r.mes_pass_min == null ? null : Number(r.mes_pass_min),
        order: Number(r.mes_order),
        available: Number(r.available),
    }));
}

async function getOne(req, res, next) {
    try {
        const [[exam]] = await pool.query(
            `SELECT m.*, c.cat_name AS me_category_name FROM tb_mock_exams m
             LEFT JOIN tb_categories c ON c.cat_id = m.me_category_id WHERE m.me_id = ?`,
            [req.params.id]
        );
        if (!exam) return res.status(404).json({ message: "ไม่พบสนามสอบนี้" });
        res.json({ ...withNumbers(exam), sections: await listSections(exam.me_id) });
    } catch (err) {
        next(err);
    }
}

function validateExam(body) {
    if (!body.me_name || !String(body.me_name).trim()) return "กรุณากรอกชื่อสนามสอบ";
    const minutes = Number(body.me_time_limit_minutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 600) return "เวลาสอบต้องเป็นจำนวนเต็ม 1-600 นาที";
    // สนามสอบนับเป็นจำนวนข้อเสมอ (ไม่ใช้ระบบคะแนน) → scored = false
    return validatePassCriterion({ percent: body.me_pass_percent, min: body.me_pass_min }, false, "เกณฑ์ผ่านรวม");
}

// วิชาต้องมีอย่างน้อย 1 วิชา ไม่งั้นสนามสอบไม่มีข้อให้ทำเลย · ตรวจให้ครบก่อนเขียนอะไรลง DB
async function validateSections(sections) {
    if (!Array.isArray(sections) || sections.length === 0) return "สนามสอบต้องมีอย่างน้อย 1 วิชา";
    const seen = new Set();
    for (const s of sections) {
        if (!s || typeof s.tpc_id !== "string" || !s.tpc_id) return "รูปแบบวิชาไม่ถูกต้อง";
        if (seen.has(s.tpc_id)) return "มีวิชาซ้ำกันในสนามสอบ";
        seen.add(s.tpc_id);
        const count = Number(s.question_count);
        if (!Number.isInteger(count) || count < 1 || count > MAX_SECTION_QUESTIONS) {
            return `จำนวนข้อของแต่ละวิชาต้องเป็นจำนวนเต็ม 1-${MAX_SECTION_QUESTIONS}`;
        }
        const error = validatePassCriterion({ percent: s.pass_percent, min: s.pass_min }, false, "เกณฑ์ผ่านรายวิชา");
        if (error) return error;
        // ขั้นต่ำมากกว่าจำนวนข้อที่ออกสอบ = ไม่มีทางผ่านได้เลย เกือบทุกครั้งคือพิมพ์ผิด
        if (!isBlank(s.pass_min) && Number(s.pass_min) > count) {
            return `เกณฑ์ขั้นต่ำของวิชาต้องไม่เกินจำนวนข้อที่ออกสอบ (${count} ข้อ)`;
        }
    }
    const ids = sections.map((s) => s.tpc_id);
    const [found] = await pool.query("SELECT tpc_id FROM tb_topics WHERE tpc_id IN (?)", [ids]);
    if (found.length !== ids.length) return "ไม่พบบางวิชา (อาจถูกลบไปแล้ว) กรุณาโหลดหน้าใหม่";
    return null;
}

async function replaceSections(conn, examId, sections) {
    await conn.query("DELETE FROM tb_mock_exam_sections WHERE mes_exam_id = ?", [examId]);
    if (!sections.length) return;
    await conn.query(
        `INSERT INTO tb_mock_exam_sections (mes_exam_id, mes_topic_id, mes_question_count, mes_pass_percent, mes_pass_min, mes_order)
         VALUES ?`,
        [sections.map((s, i) => [examId, s.tpc_id, Number(s.question_count), normalizePassValue(s.pass_percent), normalizePassValue(s.pass_min), i])]
    );
}

async function create(req, res, next) {
    try {
        const examError = validateExam(req.body);
        if (examError) return res.status(400).json({ message: examError });
        const sectionsError = await validateSections(req.body.sections);
        if (sectionsError) return res.status(400).json({ message: sectionsError });

        const me_id = await generateId("tb_mock_exams", "MCK");
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            await conn.query(
                `INSERT INTO tb_mock_exams (me_id, me_name, me_description, me_category_id, me_time_limit_minutes,
                                            me_pass_percent, me_pass_min, me_status, me_created_by_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    me_id, String(req.body.me_name).trim(), req.body.me_description || null, req.body.me_category_id || null,
                    Number(req.body.me_time_limit_minutes), normalizePassValue(req.body.me_pass_percent),
                    normalizePassValue(req.body.me_pass_min), normalizeStatus(req.body.me_status), req.user.user_id,
                ]
            );
            await replaceSections(conn, me_id, req.body.sections);
            await conn.commit();
        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }
        res.status(201).json({ me_id });
    } catch (err) {
        next(err);
    }
}

const normalizeStatus = (v) => (["draft", "published", "archived"].includes(v) ? v : "draft");

async function update(req, res, next) {
    try {
        const examError = validateExam(req.body);
        if (examError) return res.status(400).json({ message: examError });
        const sectionsError = await validateSections(req.body.sections);
        if (sectionsError) return res.status(400).json({ message: sectionsError });

        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            const [result] = await conn.query(
                `UPDATE tb_mock_exams SET me_name = ?, me_description = ?, me_category_id = ?, me_time_limit_minutes = ?,
                        me_pass_percent = ?, me_pass_min = ?, me_status = ?
                 WHERE me_id = ?`,
                [
                    String(req.body.me_name).trim(), req.body.me_description || null, req.body.me_category_id || null,
                    Number(req.body.me_time_limit_minutes), normalizePassValue(req.body.me_pass_percent),
                    normalizePassValue(req.body.me_pass_min), normalizeStatus(req.body.me_status), req.params.id,
                ]
            );
            if (!result.affectedRows) {
                await conn.rollback();
                return res.status(404).json({ message: "ไม่พบสนามสอบนี้" });
            }
            await replaceSections(conn, req.params.id, req.body.sections);
            await conn.commit();
        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }
        res.json({ message: "แก้ไขสนามสอบสำเร็จ" });
    } catch (err) {
        next(err);
    }
}

// ลบไม่ได้ถ้ามีคนเคยสอบไปแล้ว — ใบสอบเก่าของลูกค้าชี้มาที่สนามสอบนี้ ลบทิ้งแล้วประวัติเขาจะอ่านไม่ได้
// (FK ไม่ได้ตั้ง CASCADE ไว้โดยตั้งใจ) แนะนำให้เก็บเข้ากรุ (archived) แทน
async function remove(req, res, next) {
    try {
        const [[{ used }]] = await pool.query(
            "SELECT COUNT(*) AS used FROM tb_attempts WHERE att_mock_exam_id = ?", [req.params.id]
        );
        if (used > 0) {
            return res.status(400).json({
                message: `ลบไม่ได้ เพราะมีลูกค้าทำสนามสอบนี้ไปแล้ว ${used} ครั้ง — เปลี่ยนสถานะเป็น "เก็บเข้ากรุ" แทนได้`,
            });
        }
        const [result] = await pool.query("DELETE FROM tb_mock_exams WHERE me_id = ?", [req.params.id]);
        if (!result.affectedRows) return res.status(404).json({ message: "ไม่พบสนามสอบนี้" });
        res.json({ message: "ลบสนามสอบสำเร็จ" });
    } catch (err) {
        next(err);
    }
}

// ── ฝั่งลูกค้า ───────────────────────────────────────────────────────────────────

// คลังข้อที่ลูกค้าคนนี้ใช้ได้จริงในแต่ละวิชา = ข้อ active ของชุดที่ยังมีสิทธิ์อยู่ (ไม่หมดอายุ/ไม่ถูกยกเลิก)
// คืน Map topic_id → จำนวนข้อที่มี · ใช้ทั้งตอนแสดงรายการและตอนประกอบชุดสอบ ตัวเลขจึงตรงกันเสมอ
async function countAvailableByTopic(customerId, topicIds) {
    if (!topicIds.length) return new Map();
    const [rows] = await pool.query(
        `SELECT q.ques_topic_id AS tpc_id, COUNT(*) AS n
         FROM tb_questions q
         JOIN tb_entitlements e ON e.ent_product_id = q.ques_product_id
         WHERE q.ques_topic_id IN (?) AND q.ques_status = 'active'
           AND e.ent_customer_id = ? AND e.ent_status = 'active'
           AND (e.ent_expires_at IS NULL OR e.ent_expires_at > NOW())
         GROUP BY q.ques_topic_id`,
        [topicIds, customerId]
    );
    return new Map(rows.map((r) => [r.tpc_id, Number(r.n)]));
}

// รายการสนามสอบที่เปิดให้ทำ + บอกตรงๆ ว่าด้วยสิทธิ์ที่ลูกค้ามีตอนนี้ ทำได้กี่ข้อจากที่ควรได้
// (ไม่ปิดบังแล้วปล่อยให้เจอตอนเริ่มสอบ — คนเตรียมสอบต้องรู้ก่อนว่าชุดนี้ซ้อมได้เต็มรูปแบบไหม)
async function listMockExams(req, res, next) {
    try {
        const [exams] = await pool.query(
            `SELECT m.me_id, m.me_name, m.me_description, m.me_time_limit_minutes, m.me_pass_percent, m.me_pass_min,
                    m.me_category_id, c.cat_name AS me_category_name
             FROM tb_mock_exams m
             LEFT JOIN tb_categories c ON c.cat_id = m.me_category_id
             WHERE m.me_status = 'published'
             ORDER BY m.me_name ASC`
        );
        if (!exams.length) return res.json({ data: [] });

        const [sections] = await pool.query(
            `SELECT s.mes_exam_id, s.mes_topic_id, t.tpc_name, s.mes_question_count, s.mes_pass_percent, s.mes_pass_min, s.mes_order
             FROM tb_mock_exam_sections s
             JOIN tb_topics t ON t.tpc_id = s.mes_topic_id
             WHERE s.mes_exam_id IN (?)
             ORDER BY s.mes_order ASC`,
            [exams.map((e) => e.me_id)]
        );
        const available = await countAvailableByTopic(req.customer.cus_id, [...new Set(sections.map((s) => s.mes_topic_id))]);

        // ใบที่ค้างอยู่ (ยังไม่ส่ง) ของลูกค้าคนนี้ — หน้าเว็บจะได้ขึ้นปุ่ม "ทำต่อ" แทน "เริ่มสอบ"
        const [inProgress] = await pool.query(
            "SELECT att_id, att_mock_exam_id FROM tb_attempts WHERE att_customer_id = ? AND att_status = 'in_progress' AND att_mock_exam_id IS NOT NULL",
            [req.customer.cus_id]
        );
        const openByExam = new Map(inProgress.map((a) => [a.att_mock_exam_id, a.att_id]));

        const data = exams.map((e) => {
            const own = sections.filter((s) => s.mes_exam_id === e.me_id);
            const list = own.map((s) => ({
                tpc_id: s.mes_topic_id,
                tpc_name: s.tpc_name,
                question_count: Number(s.mes_question_count),
                usable: Math.min(Number(s.mes_question_count), available.get(s.mes_topic_id) ?? 0),
                pass_percent: s.mes_pass_percent,
                pass_min: s.mes_pass_min == null ? null : Number(s.mes_pass_min),
            }));
            const planned = list.reduce((sum, s) => sum + s.question_count, 0);
            const usable = list.reduce((sum, s) => sum + s.usable, 0);
            return {
                me_id: e.me_id,
                me_name: e.me_name,
                me_description: e.me_description,
                me_time_limit_minutes: e.me_time_limit_minutes,
                me_pass_percent: e.me_pass_percent,
                me_pass_min: e.me_pass_min == null ? null : Number(e.me_pass_min),
                me_category_id: e.me_category_id,
                me_category_name: e.me_category_name,
                sections: list,
                planned_questions: planned,
                usable_questions: usable,
                // ทำได้ไหมด้วยสิทธิ์ที่มีตอนนี้ · usable < planned = ทำได้แต่ไม่ครบโครงสร้าง (ต้องซื้อชุดเพิ่ม)
                can_start: usable > 0,
                in_progress_attempt_id: openByExam.get(e.me_id) ?? null,
            };
        });
        res.json({ data });
    } catch (err) {
        next(err);
    }
}

// ประกอบชุดสอบ: สุ่มข้อของแต่ละวิชาตามโควตา จากชุดที่ลูกค้ามีสิทธิ์
// เรียงตามวิชา (mes_order) เหมือนข้อสอบจริงที่ทำวิชาต่อวิชา ไม่สลับข้ามวิชาให้สับสน
async function pickQuestions(customerId, sections) {
    const picked = [];
    for (const s of sections) {
        const [rows] = await pool.query(
            `SELECT q.ques_id
             FROM tb_questions q
             JOIN tb_entitlements e ON e.ent_product_id = q.ques_product_id
             WHERE q.ques_topic_id = ? AND q.ques_status = 'active'
               AND e.ent_customer_id = ? AND e.ent_status = 'active'
               AND (e.ent_expires_at IS NULL OR e.ent_expires_at > NOW())
             GROUP BY q.ques_id
             ORDER BY RAND()
             LIMIT ?`,
            [s.mes_topic_id, customerId, Number(s.mes_question_count)]
        );
        picked.push(...rows.map((r) => r.ques_id));
    }
    return picked;
}

module.exports = {
    getAll, getOne, create, update, remove,
    listMockExams,
    // ใช้ต่อใน attempt.controller (startMockAttempt/getReview)
    countAvailableByTopic, pickQuestions,
};
