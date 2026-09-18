const pool = require("../config/db");
const { toCriterion, judgeAgainstPass } = require("../utils/passCriteria");
const { pickQuestions } = require("./mockExam.controller");
const { generateId, generateIds } = require("../utils/generateId");
const { hasActiveEntitlement } = require("./entitlement.controller");

// mysql2 ปกติจะ auto-parse คอลัมน์ JSON ให้เป็น array/object อยู่แล้ว แต่กันไว้เผื่อ driver
// บางเวอร์ชันคืนมาเป็น string ดิบ
function parseJsonColumn(value) {
    if (value == null) return null;
    return typeof value === "string" ? JSON.parse(value) : value;
}

function shuffle(array) {
    const arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

// โครงคำถาม 1 ข้อที่จะส่งให้ frontend — ไม่มี cho_is_correct/cho_wrong_reason เว้นแต่ reveal != null
// reveal เปิดได้แค่ 2 กรณี: โหมดฝึกที่ตอบข้อนี้ไปแล้ว, หรือหลัง submit (endpoint /review)
function buildQuestionPayload(question, choiceOrder, answer, reveal) {
    const choicesById = Object.fromEntries(question.choices.map((c) => [c.cho_id, c]));
    const orderedChoices = choiceOrder.map((choId) => choicesById[choId]).filter(Boolean);

    return {
        ques_id: question.ques_id,
        ques_text: question.ques_text,
        ques_image_url: question.ques_image_url ?? null,
        // คะแนนของข้อนี้ — ใช้ ans_score ที่ freeze ไว้ตอนเริ่มทำก่อนเสมอ ถ้าไม่มี (attempt ที่สร้างก่อนมี
        // ระบบคะแนน หรือหน้าตัวอย่างฟรีที่ไม่มี attempt) ค่อยตกมาใช้ค่าปัจจุบันของคำถาม
        ques_score: answer?.ans_score ?? question.ques_score ?? null,
        choices: orderedChoices.map((c) => ({ cho_id: c.cho_id, cho_text: c.cho_text, cho_image_url: c.cho_image_url ?? null })),
        selected_choice_id: answer?.ans_selected_choice_id ?? null,
        reveal: reveal
            ? {
                  correct_choice_id: orderedChoices.find((c) => c.cho_is_correct)?.cho_id ?? null,
                  explanation: question.ques_explanation,
                  choice_reasons: orderedChoices.map((c) => ({
                      cho_id: c.cho_id,
                      is_correct: !!c.cho_is_correct,
                      wrong_reason: c.cho_is_correct ? null : c.cho_wrong_reason,
                  })),
              }
            : null,
    };
}

// ดึงคำถาม+ตัวเลือกทั้งหมดของ product (active เท่านั้น) จัดกลุ่มเป็น map ques_id -> { ...question, choices: [] }
// ใช้ตอนสร้าง attempt ใหม่เท่านั้น (ต้องรู้ "ทั้งคลังคำถาม" ของ product จริงๆ) — ถ้าแค่ต้องอ่านคำถามที่ระบุ
// id ชัดเจนอยู่แล้ว (attempt ที่มีอยู่แล้ว) ให้ใช้ fetchQuestionsByIds แทนเสมอ ไม่งั้น product ที่มีคำถามเยอะ
// (เช่น หลักพันข้อ) จะโดนดึงคำถาม+ตัวเลือกทั้งหมดมาทิ้งซ้ำๆ ทุกครั้งที่เปิดหน้า/ตอบทีละข้อ ทั้งที่ 1 attempt
// ใช้จริงแค่ไม่กี่สิบ/ร้อยข้อ — ORDER BY ques_order เพราะลำดับข้อตอนทำข้อสอบต้องตรงกับที่แอดมินจัดไว้เป๊ะ
// (ไม่สลับสุ่มแล้ว — ดู startOrResumeAttempt)
async function fetchQuestionsWithChoices(productId) {
    const [questions] = await pool.query(
        `SELECT ques_id, ques_text, ques_explanation, ques_image_url, ques_score FROM tb_questions
         WHERE ques_product_id = ? AND ques_status = 'active' ORDER BY ques_order ASC`,
        [productId]
    );
    return buildQuestionMap(questions);
}

// เหมือน fetchQuestionsWithChoices แต่จำกัดเฉพาะ ques_id ที่ระบุ (เช่น att_question_order ของ attempt
// หนึ่งอัน หรือคำถามข้อเดียวตอนเปิดเฉลยโหมดฝึก) — ยังคงกรอง ques_status = 'active' เหมือนเดิมทุกจุดที่เคย
// กรอง เพื่อไม่เปลี่ยนพฤติกรรมเดิม แค่ไม่ต้องดึงคำถามข้ออื่นที่ไม่เกี่ยวกับ attempt นี้มาด้วย
async function fetchQuestionsByIds(questionIds) {
    if (questionIds.length === 0) return {};
    const [questions] = await pool.query(
        `SELECT ques_id, ques_text, ques_explanation, ques_image_url, ques_score FROM tb_questions
         WHERE ques_id IN (?) AND ques_status = 'active'`,
        [questionIds]
    );
    return buildQuestionMap(questions);
}

// จำนวนข้อ "ตัวอย่างฟรี" ต่อชุด = ข้อที่เปิดเฉลยให้คนทั่วไปดูได้โดยไม่ต้องซื้อ — ใช้ร่วมกันทั้งหน้าตัวอย่าง
// (/products/[id]/sample) และแบบทดสอบวัดระดับ (diagnostic.controller.js) ห้ามแยกกันตั้ง ไม่งั้นแบบทดสอบ
// วัดระดับจะเปิดเฉลยของข้อที่ต้องซื้อหลุดออกไปฟรี
const SAMPLE_QUESTION_COUNT = 10;

// ดึงคำถามตัวอย่างจำนวนจำกัดของ product (ใช้กับหน้าตัวอย่างฟรีก่อนซื้อ) — กรอง+จำกัดจำนวนที่ระดับ SQL
// เลย (ORDER BY + LIMIT) แทนที่จะดึงคำถามทั้งคลังมาเก็บใน JS แล้วค่อย .slice() ทีหลัง เพราะ endpoint นี้
// ไม่ต้อง login เรียกได้อิสระ ถ้า product มีคำถามเยอะจะโดนดึงข้อมูลทิ้งจำนวนมากทุกครั้งที่มีคนเข้าดูตัวอย่าง
async function fetchSampleQuestions(productId, limit) {
    const [questions] = await pool.query(
        `SELECT ques_id, ques_text, ques_explanation, ques_image_url, ques_score FROM tb_questions
         WHERE ques_product_id = ? AND ques_status = 'active' ORDER BY ques_id ASC LIMIT ?`,
        [productId, limit]
    );
    return buildQuestionMap(questions);
}

async function buildQuestionMap(questions) {
    // ORDER BY cho_order เพราะลำดับตัวเลือกตอนทำข้อสอบต้องตรงกับที่แอดมินจัดไว้เป๊ะ (ไม่สลับสุ่มแล้ว — ดู
    // startOrResumeAttempt) — ไม่มี ORDER BY มาก่อนเลย ตอนนั้นไม่มีผลเพราะทุกจุดที่ใช้ map นี้เอาไปสุ่มต่ออยู่ดี
    const [choices] = await pool.query(
        `SELECT cho_id, cho_question_id, cho_text, cho_is_correct, cho_wrong_reason, cho_image_url
         FROM tb_choices WHERE cho_question_id IN (?) ORDER BY cho_order ASC`,
        [questions.length ? questions.map((q) => q.ques_id) : [""]]
    );

    const questionMap = {};
    for (const q of questions) questionMap[q.ques_id] = { ...q, choices: [] };
    for (const c of choices) questionMap[c.cho_question_id]?.choices.push(c);

    return questionMap;
}

// เช็คสิทธิ์ว่ายังใช้งานได้จริง ณ ตอนนี้ ไม่ใช่แค่ตอนเริ่ม attempt ครั้งแรก — เดิม hasActiveEntitlement ถูกเช็ค
// แค่ใน startOrResumeAttempt เท่านั้น ถ้าสิทธิ์หมดอายุ/ถูกแอดมิน revoke (เช่น สงสัยแชร์บัญชี ตาม CLAUDE.md
// ข้อ 7) ระหว่างที่ attempt ยัง in_progress ค้างอยู่ ลูกค้าจะยังตอบ/ส่ง/ดูเฉลยต่อได้ตามปกติไม่จำกัด ทั้งที่ไม่
// ควรเข้าถึงเนื้อหานี้แล้ว — ไม่ใช้กับ abandonAttempt เพราะเป็นแค่การล้าง state ไม่ได้เปิดเผยเนื้อหา/ให้
// ประโยชน์อะไรเพิ่ม ปล่อยให้ยกเลิกได้เสมอไม่ว่าสิทธิ์จะเป็นอย่างไร
// ใบสนามสอบเสมือนไม่ได้ผูกกับชุดเดียว (ข้อมาจากหลายชุด) — ใช้กติกา "ยังต้องมีสิทธิ์ชุดใดชุดหนึ่งอยู่จริง"
// ถ้าสิทธิ์หมดทุกชุดแล้วต้องเข้าไม่ได้เหมือนกัน ไม่งั้นใบเก่าจะกลายเป็นช่องดูเฉลยฟรีถาวรหลังหมดอายุ
async function requireStillEntitledForAttempt(customerId, attempt, res) {
    if (!attempt.att_mock_exam_id) return requireStillEntitled(customerId, attempt.att_product_id, res);
    const [rows] = await pool.query(
        `SELECT 1 FROM tb_entitlements
         WHERE ent_customer_id = ? AND ent_status = 'active' AND (ent_expires_at IS NULL OR ent_expires_at > NOW())
         LIMIT 1`,
        [customerId]
    );
    if (!rows.length) {
        res.status(403).json({ message: "สิทธิ์เข้าถึงชุดข้อสอบของคุณหมดอายุหรือถูกยกเลิกไปแล้ว" });
        return false;
    }
    return true;
}

async function requireStillEntitled(customerId, productId, res) {
    const hasAccess = await hasActiveEntitlement(customerId, productId);
    if (!hasAccess) {
        res.status(403).json({ message: "สิทธิ์เข้าถึงชุดข้อสอบนี้หมดอายุหรือถูกยกเลิกไปแล้ว" });
        return false;
    }
    return true;
}

// โหลด attempt พร้อมเช็คว่าเป็นของลูกค้าที่ login อยู่จริง — คืน null ถ้าไม่พบ/ไม่ใช่เจ้าของ (404 ไม่ใช่
// 403 กันคนเดา attempt id ของคนอื่นแล้วรู้ว่ามี id นี้จริง)
async function loadOwnAttempt(attemptId, customerId) {
    const [rows] = await pool.query(
        `SELECT att_id, att_customer_id, att_product_id, att_mock_exam_id, att_mode, att_status, att_question_order,
                att_score, att_earned_score, att_max_score, att_total_questions,
                att_time_limit_minutes, att_started_at, att_submitted_at
         FROM tb_attempts WHERE att_id = ? AND att_customer_id = ?`,
        [attemptId, customerId]
    );
    return rows[0] ?? null;
}

// สร้าง response เต็มของ attempt หนึ่งอัน (ใช้ทั้งตอน start ใหม่และตอน resume/refresh)
async function buildAttemptResponse(attempt) {
    const questionOrder = parseJsonColumn(attempt.att_question_order) ?? [];
    const questionMap = await fetchQuestionsByIds(questionOrder);

    const [answers] = await pool.query(
        `SELECT ans_question_id, ans_selected_choice_id, ans_choice_order, ans_is_correct, ans_score
         FROM tb_attempt_answers WHERE ans_attempt_id = ?`,
        [attempt.att_id]
    );
    const answerByQuestion = Object.fromEntries(answers.map((a) => [a.ans_question_id, a]));

    const questions = questionOrder
        .map((quesId) => {
            const question = questionMap[quesId];
            const answer = answerByQuestion[quesId];
            if (!question || !answer) return null;
            const choiceOrder = parseJsonColumn(answer.ans_choice_order) ?? [];
            // โหมดฝึก + ตอบข้อนี้ไปแล้ว = เฉลยทันที ตาม CLAUDE.md ข้อ 4
            const shouldReveal = attempt.att_mode === "practice" && !!answer.ans_selected_choice_id;
            return buildQuestionPayload(question, choiceOrder, answer, shouldReveal);
        })
        .filter(Boolean);

    return {
        att_id: attempt.att_id,
        att_product_id: attempt.att_product_id,
        // ใบสนามสอบเสมือน — หน้าทำข้อสอบใช้บอกว่ากำลังสอบสนามไหนอยู่ (ไม่มีชื่อชุดข้อสอบให้แสดง)
        att_mock_exam_id: attempt.att_mock_exam_id ?? null,
        att_mode: attempt.att_mode,
        att_status: attempt.att_status,
        att_score: attempt.att_score,
        att_earned_score: attempt.att_earned_score,
        att_max_score: attempt.att_max_score,
        att_total_questions: attempt.att_total_questions,
        att_time_limit_minutes: attempt.att_time_limit_minutes,
        att_started_at: attempt.att_started_at,
        questions,
    };
}

// เริ่ม/resume ทำข้อสอบ — ถ้ามี attempt ที่ยังไม่จบของ (ลูกค้า, product) นี้อยู่แล้ว ให้ resume อันเดิม
// ไม่สร้างซ้ำ (กัน attempt ค้างเยอะโดยไม่ตั้งใจถ้าผู้ใช้กดเริ่มซ้ำ/รีเฟรชหน้า)
async function startOrResumeAttempt(req, res, next) {
    try {
        const productId = req.params.id;
        const mode = req.body?.mode === "timed" ? "timed" : "practice";

        const hasAccess = await hasActiveEntitlement(req.customer.cus_id, productId);
        if (!hasAccess) return res.status(403).json({ message: "คุณไม่มีสิทธิ์เข้าถึงชุดข้อสอบนี้" });

        const [existing] = await pool.query(
            `SELECT att_id FROM tb_attempts
             WHERE att_customer_id = ? AND att_product_id = ? AND att_status = 'in_progress'
             LIMIT 1`,
            [req.customer.cus_id, productId]
        );
        if (existing[0]) {
            const attempt = await loadOwnAttempt(existing[0].att_id, req.customer.cus_id);
            return res.json(await buildAttemptResponse(attempt));
        }

        const [productRows] = await pool.query(
            "SELECT prod_exam_duration_minutes, prod_total_score FROM tb_products WHERE prod_id = ?",
            [productId]
        );
        if (!productRows[0]) return res.status(404).json({ message: "ไม่พบชุดข้อสอบนี้" });

        const questionMap = await fetchQuestionsWithChoices(productId);
        const questionIds = Object.keys(questionMap);
        if (questionIds.length === 0) {
            return res.status(400).json({ message: "ชุดข้อสอบนี้ยังไม่มีคำถาม" });
        }

        // ลำดับข้อ/ตัวเลือกตอนทำข้อสอบ = ลำดับที่แอดมินจัดไว้เป๊ะ (ques_order/cho_order จาก fetchQuestionsWithChoices/
        // buildQuestionMap) ไม่สุ่มสลับแล้ว — ยังคง snapshot ไว้ที่ att_question_order/ans_choice_order เหมือนเดิม
        // (ไม่ใช่แค่เพื่อกันสุ่ม แต่กันแอดมินแก้ไข/เพิ่มลบคำถามระหว่างที่ attempt ยัง in_progress อยู่แล้วชุดคำถาม
        // เปลี่ยนกลางอากาศ)
        const timeLimitMinutes = mode === "timed" ? productRows[0].prod_exam_duration_minutes : null;

        // snapshot คะแนนเต็ม + คะแนนรายข้อไว้ตั้งแต่ตอนเริ่ม ด้วยเหตุผลเดียวกับ att_question_order ข้างบน —
        // ถ้าอ่านสดตอน submit แอดมินแก้คะแนนระหว่างที่ลูกค้ากำลังทำอยู่ ผลสอบจะเพี้ยนโดยไม่มีใครรู้
        // maxScore เป็น null = ชุดนี้ไม่ใช้ระบบคะแนน (คิดผลเป็น % จากจำนวนข้อเหมือนเดิม)
        const maxScore = productRows[0].prod_total_score;

        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            const att_id = await generateId("tb_attempts", "ATT");
            await conn.query(
                `INSERT INTO tb_attempts
                    (att_id, att_customer_id, att_product_id, att_mode, att_question_order,
                     att_max_score, att_total_questions, att_time_limit_minutes)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [att_id, req.customer.cus_id, productId, mode, JSON.stringify(questionIds), maxScore, questionIds.length, timeLimitMinutes]
            );

            // INSERT รวมทีเดียวแทนการวน query ทีละแถว (เดิม 1 คำถาม = 1 round trip ไป DB) — product ที่มี
            // คำถามเยอะ (หลักร้อย/พัน) จะสร้าง attempt ใหม่ช้ามากถ้าต้อง insert ทีละแถวแบบนั้น
            const answerIds = await generateIds("tb_attempt_answers", "ANS", questionIds.length);
            const answerRows = questionIds.map((quesId, i) => {
                const choiceOrder = questionMap[quesId].choices.map((c) => c.cho_id);
                // ans_score เก็บเฉพาะชุดที่ใช้ระบบคะแนน ชุดอื่นปล่อย null ไว้ให้ชัดว่าไม่มีความหมาย
                const score = maxScore === null ? null : questionMap[quesId].ques_score;
                return [answerIds[i], att_id, quesId, JSON.stringify(choiceOrder), score];
            });
            if (answerRows.length > 0) {
                await conn.query(
                    `INSERT INTO tb_attempt_answers (ans_id, ans_attempt_id, ans_question_id, ans_choice_order, ans_score) VALUES ?`,
                    [answerRows]
                );
            }

            await conn.commit();

            const attempt = await loadOwnAttempt(att_id, req.customer.cus_id);
            res.status(201).json(await buildAttemptResponse(attempt));
        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }
    } catch (err) {
        // ER_DUP_ENTRY จาก uniq_att_in_progress = แพ้ race ให้อีกคำขอที่มาถึงก่อนแบบเสี้ยววินาที (สองแท็บ/
        // ดับเบิลคลิก "เริ่มทำข้อสอบ") — DB เป็นผู้ตัดสินสุดท้ายว่าใครสร้าง attempt ได้ก่อนจริง ตัวที่แพ้แค่
        // ไป resume attempt ที่ชนะสร้างไว้แทน ไม่ต้อง error ให้ผู้ใช้เห็นเลย (ประสบการณ์เหมือนกดแล้ว resume ปกติ)
        if (err.code === "ER_DUP_ENTRY" && err.sqlMessage?.includes("uniq_att_in_progress")) {
            const [existing] = await pool.query(
                `SELECT att_id FROM tb_attempts
                 WHERE att_customer_id = ? AND att_product_id = ? AND att_status = 'in_progress'
                 LIMIT 1`,
                [req.customer.cus_id, req.params.id]
            );
            if (existing[0]) {
                const attempt = await loadOwnAttempt(existing[0].att_id, req.customer.cus_id);
                return res.json(await buildAttemptResponse(attempt));
            }
        }
        next(err);
    }
}

// เริ่ม/ทำต่อ "สนามสอบเสมือนจริง" (2026-09-18) — ต่างจาก startOrResumeAttempt ตรงที่ข้อมาจากหลายชุด
// ตามโควตารายวิชาที่แอดมินตั้งไว้ ดู mockExam.controller.js · ใบนี้เป็นโหมดจับเวลาเสมอ (จำลองสนามจริง)
// และไม่ใช้ระบบคะแนนรายข้อ (att_max_score = NULL) เพราะข้อมาจากชุดที่ตั้งคะแนนกันคนละแบบ
async function startMockAttempt(req, res, next) {
    try {
        const examId = req.params.id;
        const [[exam]] = await pool.query(
            "SELECT me_id, me_time_limit_minutes FROM tb_mock_exams WHERE me_id = ? AND me_status = 'published'",
            [examId]
        );
        if (!exam) return res.status(404).json({ message: "ไม่พบสนามสอบนี้" });

        const resumeExisting = async () => {
            const [rows] = await pool.query(
                "SELECT att_id FROM tb_attempts WHERE att_customer_id = ? AND att_mock_exam_id = ? AND att_status = 'in_progress' LIMIT 1",
                [req.customer.cus_id, examId]
            );
            if (!rows[0]) return null;
            return buildAttemptResponse(await loadOwnAttempt(rows[0].att_id, req.customer.cus_id));
        };
        const resumed = await resumeExisting();
        if (resumed) return res.json(resumed);

        const [sections] = await pool.query(
            "SELECT mes_topic_id, mes_question_count FROM tb_mock_exam_sections WHERE mes_exam_id = ? ORDER BY mes_order ASC",
            [examId]
        );
        if (!sections.length) return res.status(400).json({ message: "สนามสอบนี้ยังไม่ได้ตั้งวิชา" });

        // สุ่มใหม่ทุกครั้งที่เริ่ม จากชุดที่ลูกค้ามีสิทธิ์ ณ ตอนนี้ — ข้อที่ได้จึง snapshot ไว้ที่ att_question_order
        // เหมือนการทำข้อสอบปกติ (สิทธิ์หมดอายุระหว่างทำ ไม่ทำให้ชุดคำถามเปลี่ยนกลางอากาศ)
        const questionIds = await pickQuestions(req.customer.cus_id, sections);
        if (!questionIds.length) {
            return res.status(403).json({ message: "คุณยังไม่มีสิทธิ์ในชุดข้อสอบที่ใช้ในสนามสอบนี้" });
        }
        const questionMap = await fetchQuestionsByIds(questionIds);

        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            const att_id = await generateId("tb_attempts", "ATT");
            await conn.query(
                `INSERT INTO tb_attempts
                    (att_id, att_customer_id, att_product_id, att_mock_exam_id, att_mode, att_question_order,
                     att_max_score, att_total_questions, att_time_limit_minutes)
                 VALUES (?, ?, NULL, ?, 'timed', ?, NULL, ?, ?)`,
                [att_id, req.customer.cus_id, examId, JSON.stringify(questionIds), questionIds.length, exam.me_time_limit_minutes]
            );
            const answerIds = await generateIds("tb_attempt_answers", "ANS", questionIds.length);
            await conn.query(
                "INSERT INTO tb_attempt_answers (ans_id, ans_attempt_id, ans_question_id, ans_choice_order, ans_score) VALUES ?",
                [questionIds.map((quesId, i) => [
                    answerIds[i], att_id, quesId, JSON.stringify(questionMap[quesId].choices.map((c) => c.cho_id)), null,
                ])]
            );
            await conn.commit();
            res.status(201).json(await buildAttemptResponse(await loadOwnAttempt(att_id, req.customer.cus_id)));
        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }
    } catch (err) {
        // แพ้ race ให้คำขอที่มาถึงก่อน (กดสองแท็บ/ดับเบิลคลิก) — ไปทำต่อใบที่ชนะสร้างไว้ เหมือน startOrResumeAttempt
        if (err.code === "ER_DUP_ENTRY" && err.sqlMessage?.includes("uniq_att_in_progress")) {
            const [rows] = await pool.query(
                "SELECT att_id FROM tb_attempts WHERE att_customer_id = ? AND att_mock_exam_id = ? AND att_status = 'in_progress' LIMIT 1",
                [req.customer.cus_id, req.params.id]
            );
            if (rows[0]) return res.json(await buildAttemptResponse(await loadOwnAttempt(rows[0].att_id, req.customer.cus_id)));
        }
        next(err);
    }
}

async function getAttempt(req, res, next) {
    try {
        const attempt = await loadOwnAttempt(req.params.id, req.customer.cus_id);
        if (!attempt) return res.status(404).json({ message: "ไม่พบการทำข้อสอบนี้" });
        if (!(await requireStillEntitledForAttempt(req.customer.cus_id, attempt, res))) return;
        res.json(await buildAttemptResponse(attempt));
    } catch (err) {
        next(err);
    }
}

async function submitAnswer(req, res, next) {
    try {
        const attempt = await loadOwnAttempt(req.params.id, req.customer.cus_id);
        if (!attempt) return res.status(404).json({ message: "ไม่พบการทำข้อสอบนี้" });
        if (!(await requireStillEntitledForAttempt(req.customer.cus_id, attempt, res))) return;
        if (attempt.att_status !== "in_progress") {
            return res.status(400).json({ message: "ทำข้อสอบชุดนี้เสร็จไปแล้ว" });
        }

        const questionId = req.params.questionId;
        const choiceId = req.body?.choice_id || null;

        const [answerRows] = await pool.query(
            "SELECT ans_id, ans_choice_order FROM tb_attempt_answers WHERE ans_attempt_id = ? AND ans_question_id = ?",
            [attempt.att_id, questionId]
        );
        if (!answerRows[0]) return res.status(404).json({ message: "ไม่พบคำถามนี้ในชุดข้อสอบนี้" });

        let isCorrect = null;
        if (choiceId) {
            const [choiceRows] = await pool.query(
                "SELECT cho_is_correct FROM tb_choices WHERE cho_id = ? AND cho_question_id = ?",
                [choiceId, questionId]
            );
            if (!choiceRows[0]) return res.status(400).json({ message: "ตัวเลือกนี้ไม่ตรงกับคำถาม" });
            isCorrect = !!choiceRows[0].cho_is_correct;
        }

        await pool.query(
            "UPDATE tb_attempt_answers SET ans_selected_choice_id = ?, ans_is_correct = ?, ans_answered_at = NOW() WHERE ans_id = ?",
            [choiceId, isCorrect, answerRows[0].ans_id]
        );

        if (attempt.att_mode !== "practice" || !choiceId) {
            return res.json({ selected_choice_id: choiceId, reveal: null });
        }

        // โหมดฝึก + ตอบแล้ว → คืนเฉลยทันที
        const questionMap = await fetchQuestionsByIds([questionId]);
        const question = questionMap[questionId];
        const choiceOrder = parseJsonColumn(answerRows[0].ans_choice_order) ?? [];
        const payload = buildQuestionPayload(question, choiceOrder, { ans_selected_choice_id: choiceId }, true);
        res.json({ selected_choice_id: choiceId, reveal: payload.reveal });
    } catch (err) {
        next(err);
    }
}

async function submitAttempt(req, res, next) {
    try {
        const attempt = await loadOwnAttempt(req.params.id, req.customer.cus_id);
        if (!attempt) return res.status(404).json({ message: "ไม่พบการทำข้อสอบนี้" });
        if (!(await requireStillEntitledForAttempt(req.customer.cus_id, attempt, res))) return;
        if (attempt.att_status !== "in_progress") {
            return res.status(400).json({ message: "ทำข้อสอบชุดนี้เสร็จไปแล้ว" });
        }

        const [[{ correctCount, earnedScore }]] = await pool.query(
            `SELECT COUNT(*) AS correctCount, COALESCE(SUM(ans_score), 0) AS earnedScore
             FROM tb_attempt_answers WHERE ans_attempt_id = ? AND ans_is_correct = TRUE`,
            [attempt.att_id]
        );

        // สองโหมดคิดคะแนน — แยกที่ att_max_score ที่ freeze ไว้ตอนเริ่มทำ ไม่ใช่ค่าปัจจุบันของ product
        // (ถ้าแอดมินเพิ่งเปิด/ปิดระบบคะแนนระหว่างที่ลูกค้ากำลังทำอยู่ ต้องยึดกติกา ณ ตอนเริ่มเสมอ)
        //
        // att_score ยังเป็น "เปอร์เซ็นต์" เหมือนเดิมทั้งสองโหมด — ประวัติเก่าและกราฟหน้า /history จึงใช้ต่อได้
        // โดยไม่ต้องแก้อะไร ส่วนคะแนนดิบเก็บแยกที่ att_earned_score
        const maxScore = attempt.att_max_score === null ? null : Number(attempt.att_max_score);
        const useScoring = maxScore !== null && maxScore > 0;
        const earned = useScoring ? Math.round(Number(earnedScore) * 100) / 100 : null;
        const score = useScoring
            ? (earned / maxScore) * 100
            : attempt.att_total_questions > 0
              ? (correctCount / attempt.att_total_questions) * 100
              : 0;

        await pool.query(
            "UPDATE tb_attempts SET att_status = 'submitted', att_score = ?, att_earned_score = ?, att_submitted_at = NOW() WHERE att_id = ?",
            [score.toFixed(2), earned, attempt.att_id]
        );

        res.json({
            att_id: attempt.att_id,
            score: Number(score.toFixed(2)),
            correct_count: correctCount,
            total_questions: attempt.att_total_questions,
            earned_score: earned,
            max_score: useScoring ? maxScore : null,
        });
    } catch (err) {
        next(err);
    }
}

// ยกเลิกทำข้อสอบกลางคัน (ต่างจาก "ออกแล้วบันทึกไว้ทำต่อ" ที่ฝั่ง frontend แค่ไม่เรียก endpoint นี้เลย
// ปล่อยให้ยัง in_progress) — ตั้ง status เป็น abandoned เพื่อไม่ให้นับเป็นการทำข้อสอบจริง (ไม่ขึ้นในประวัติ/
// ไม่คิดคะแนน) และคืน att_in_progress_key ให้เป็น NULL (generated column ดู
// alter_attempts_unique_in_progress.sql) ทำให้ครั้งต่อไปที่กด "เริ่มทำข้อสอบ" ได้ attempt ใหม่ทั้งชุด
// (สุ่มลำดับข้อ/ตัวเลือกใหม่) แทนที่จะ resume ชุดเดิมที่ยกเลิกไปแล้ว
async function abandonAttempt(req, res, next) {
    try {
        const attempt = await loadOwnAttempt(req.params.id, req.customer.cus_id);
        if (!attempt) return res.status(404).json({ message: "ไม่พบการทำข้อสอบนี้" });
        if (attempt.att_status !== "in_progress") {
            return res.status(400).json({ message: "ทำข้อสอบชุดนี้เสร็จไปแล้ว หรือถูกยกเลิกไปแล้ว" });
        }

        await pool.query("UPDATE tb_attempts SET att_status = 'abandoned' WHERE att_id = ?", [attempt.att_id]);

        res.json({ att_id: attempt.att_id, att_status: "abandoned" });
    } catch (err) {
        next(err);
    }
}

// endpoint สำคัญที่สุด — เฉลยละเอียดครบ 4 อย่างตาม CLAUDE.md ข้อ 4 อนุญาตเฉพาะหลัง submit แล้วเท่านั้น
// นิยามเดียวของคำว่า "ข้อที่ยังต้องทบทวน" = เคยตอบผิด และครั้งล่าสุดที่ตอบยังผิดอยู่
//
// ใช้ร่วมกันระหว่างตัวนับรายชุดใน getProductSummary กับลิสต์จริงใน getMistakes — ถ้าแยกกันเขียน
// วันไหนแก้ที่เดียวลืมอีกที่ ตัวเลข "ต้องทบทวน N ข้อ" บนหน้าสรุปจะไม่ตรงกับจำนวนการ์ดที่กดเข้าไปเห็นจริง
// ซึ่งเป็นบั๊กที่ผู้ใช้เจอก่อนเราเสมอ
//
// "ครั้งที่ตอบ" มาจาก 2 แหล่ง (2026-09-15): คำตอบในข้อสอบที่ส่งแล้ว + การทำใหม่จากหน้าทบทวน (tb_mistake_retries)
// ทำใหม่ถูก = ครั้งล่าสุดถูก = หลุดจากรายการเอง · สอบรอบหน้าแล้วผิดอีก = กลับมาอยู่ในรายการ
// การทำใหม่มีผลกับเรื่องนี้เรื่องเดียว — ไม่ปนในคะแนน/ประวัติ/จุดอ่อนรายหมวด (พวกนั้นอ่านจาก attempt ตรงๆ)
// ทุก query ที่ตัดสินว่า "ต้องทบทวนไหม" ต้องอ่านผ่าน mistakeEventsSql() เท่านั้น ห้ามกลับไป JOIN คำตอบเอง
// ใส่ customer filter ในแต่ละฝั่งของ UNION เอง (ไม่พึ่ง optimizer ดันเงื่อนไขเข้า derived table) → params [cid, cid]
const mistakeEventsSql = () => `(
    SELECT a.ans_question_id AS question_id, q.ques_product_id AS product_id, a.ans_is_correct AS is_correct,
           a.ans_selected_choice_id AS choice_id, att.att_submitted_at AS answered_at
    FROM tb_attempt_answers a
    JOIN tb_attempts att ON att.att_id = a.ans_attempt_id
    JOIN tb_questions q ON q.ques_id = a.ans_question_id
    WHERE att.att_customer_id = ? AND att.att_status = 'submitted' AND a.ans_is_correct IS NOT NULL
    UNION ALL
    SELECT r.mr_question_id, q.ques_product_id, r.mr_is_correct, r.mr_selected_choice_id, r.mr_created_at
    FROM tb_mistake_retries r
    JOIN tb_questions q ON q.ques_id = r.mr_question_id
    WHERE r.mr_customer_id = ?
) ev`;
const LATEST_CORRECT_SQL = "SUBSTRING_INDEX(GROUP_CONCAT(ev.is_correct ORDER BY ev.answered_at DESC), ',', 1) + 0";
const WRONG_COUNT_SQL = "SUM(ev.is_correct = 0)";
const UNRESOLVED_MISTAKE_HAVING = "HAVING wrong_count > 0 AND latest_correct = 0";


// จำนวน "ข้อที่ยังต้องทบทวน" ของชุดข้อสอบหนึ่ง — เขียนเป็นฟังก์ชันกลางเพราะถูกใช้ 2 ที่แล้ว
// (ท้ายหน้าเฉลยหลังส่งคำตอบ และตัวนับรายชุดในหน้าประวัติ) และทั้งสองที่ต้องได้เลขเดียวกันเสมอ
async function countUnresolvedMistakes(customerId, productId) {
    const [[row]] = await pool.query(
        `SELECT COUNT(*) AS total FROM (
            SELECT ${WRONG_COUNT_SQL} AS wrong_count,
                   ${LATEST_CORRECT_SQL} AS latest_correct
            FROM ${mistakeEventsSql()}
            ${productId ? "WHERE ev.product_id = ?" : ""}
            GROUP BY ev.question_id
            ${UNRESOLVED_MISTAKE_HAVING}
         ) m`,
        productId ? [customerId, customerId, productId] : [customerId, customerId]
    );
    return Number(row.total);
}

// "ถ้าสอบวันนี้ ผ่านไหม" (2026-09-15) — เทียบผลใบนี้กับเกณฑ์ผ่านของชุด (prod_pass_percent หรือ prod_pass_min, NULL ทั้งคู่ = ไม่ตั้ง)
// ชุดที่ใช้ระบบคะแนนเทียบ "คะแนน" (earned/max ที่ freeze ไว้) ชุดที่ไม่ใช้เทียบ "จำนวนข้อ" — ตรงกับที่ att_score คิดไว้
// correctCount นับจาก ans_is_correct ของทุกข้อใน attempt (รวมข้อที่แอดมินปิดไปทีหลัง) ห้ามถอดจาก att_score ที่ปัดแล้ว
//
// เกณฑ์รายวิชา (2026-09-16) — สนามสอบอย่าง ก.พ. ภาค ก ต้องผ่านทุกวิชา เกณฑ์รวมอย่างเดียวบอก "ผ่าน" ผิดได้
// (คิดวิเคราะห์เต็มแต่อังกฤษตก) · "วิชา" = หัวข้อ ใช้ topicRows ชุดเดียวกับผลรายหมวดในหน้าเดียวกัน ตัวเลขจึงตรงกันเสมอ
// ผ่านรวม = ผ่านทุกเกณฑ์ที่ตั้ง · วิชาที่ตั้งเกณฑ์ไว้แต่ไม่มีข้อในใบนี้ข้ามไป (ไม่มีอะไรให้ตัดสิน)
//
// เกณฑ์แบบขั้นต่ำ (2026-09-16) — criterion = { percent } หรือ { min } อย่างใดอย่างหนึ่ง (null ทั้งคู่ = ไม่ตั้ง)
// min คือ "ข้อ" หรือ "คะแนน" ตามหน่วยของใบนี้ (unit) · pass_percent ที่ส่งกลับ = ตำแหน่งเส้นเกณฑ์บนแถบ (0-100)
// ใบที่มีข้อน้อยกว่าขั้นต่ำ (แอดมินลดข้อทีหลัง) ต้องการ = ขั้นต่ำเดิม ไม่ตัดลง — ผ่านไม่ได้ ตรงกับเกณฑ์ที่ประกาศไว้
function buildReadiness(attempt, criterion, correctCount, topicRows = [], topicCriteria = []) {
    const scored = attempt.att_max_score != null && Number(attempt.att_max_score) > 0;
    const overall = !criterion
        ? null
        : scored
            ? judgeAgainstPass(criterion, "points", Number(attempt.att_earned_score) || 0, Number(attempt.att_max_score))
            : judgeAgainstPass(criterion, "questions", correctCount, Number(attempt.att_total_questions) || 0);

    const criterionByTopic = new Map(
        topicCriteria
            .map((t) => [t.ptp_topic_id, toCriterion(t.ptp_pass_percent, t.ptp_pass_min)])
            .filter(([, c]) => c)
    );
    const subjects = topicRows
        .filter((t) => criterionByTopic.has(t.tpc_id))
        .map((t) => {
            const unit = Number(t.scored_answers) > 0 ? "points" : "questions";
            const result = unit === "points"
                ? judgeAgainstPass(criterionByTopic.get(t.tpc_id), unit, Number(t.earned), Number(t.possible))
                : judgeAgainstPass(criterionByTopic.get(t.tpc_id), unit, Number(t.correct), Number(t.total));
            return { tpc_id: t.tpc_id, tpc_name: t.tpc_name, percent: Math.round((Number(t.earned) / Number(t.possible)) * 100), ...result };
        })
        .sort((a, b) => a.tpc_name.localeCompare(b.tpc_name, "th"));

    if (!overall && subjects.length === 0) return null;
    return {
        passed: (!overall || overall.passed) && subjects.every((s) => s.passed),
        overall,
        subjects,
    };
}

// เวลาเฉลี่ยต่อข้อเทียบกับเวลาที่ชุดกำหนด — เฉพาะโหมดจับเวลา (โหมดฝึกนับเวลาอ่านเฉลยรวมไปด้วย เทียบไม่ได้)
// ใช้เวลาเริ่ม-ส่งที่มีอยู่แล้ว ไม่ต้องเก็บเวลารายข้อเพิ่ม
function buildPace(attempt) {
    const limitMinutes = Number(attempt.att_time_limit_minutes);
    const total = Number(attempt.att_total_questions);
    if (attempt.att_mode !== "timed" || !limitMinutes || !total || !attempt.att_started_at || !attempt.att_submitted_at) return null;
    const limitSeconds = limitMinutes * 60;
    // ส่งอัตโนมัติตอนหมดเวลาอาจช้ากว่ากำหนดเล็กน้อย — ตัดไม่ให้เกินเวลาที่กำหนด
    const usedSeconds = Math.min(limitSeconds, Math.max(0, Math.round((new Date(attempt.att_submitted_at) - new Date(attempt.att_started_at)) / 1000)));
    return {
        used_seconds: usedSeconds,
        limit_seconds: limitSeconds,
        avg_seconds_per_question: Math.round(usedSeconds / total),
        target_seconds_per_question: Math.round(limitSeconds / total),
    };
}

// ─── เทียบกับคนอื่นแบบไม่เปิดเผยตัว (2026-09-18) ────────────────────────────────────────────────
// "ได้ 68%" ไม่ได้บอกว่าพอสอบติดไหม โดยเฉพาะสนามที่แข่งกับคนอื่นอย่าง ก.พ. — ตัวเลขที่มีความหมายคือ
// "สูงกว่าคนอื่นกี่ %" · **ไม่ใช่ leaderboard**: ไม่มีชื่อ ไม่มีอันดับ ไม่มีใครเห็นคะแนนของใคร
// (CLAUDE.md ข้อ 5 ระบุว่าไม่ทำ leaderboard — อันนี้เป็นค่าสถิติล้วน ตัดสินใจร่วมกับผู้ใช้ 2026-09-18)
//
// นับ "คนละ 1 เสียง" โดยใช้คะแนนที่ดีที่สุดของแต่ละคน — ไม่งั้นคนที่ทำชุดเดิม 30 รอบจะถ่วงค่ากลางทั้งหมด
// ซ่อนไปเลยถ้าคนทำยังน้อย (เทียบกับ 2 คนแล้วบอก "สูงกว่า 100%" ดูตลกและไม่มีความหมายทางสถิติ)
const MIN_PEERS_FOR_COMPARISON = 5;

async function buildPeerComparison(attempt) {
    const isMock = !!attempt.att_mock_exam_id;
    const score = Number(attempt.att_score);
    if (!Number.isFinite(score)) return null;

    const [[row]] = await pool.query(
        `SELECT COUNT(*) AS peers, COALESCE(SUM(best_score < ?), 0) AS lower_count, COALESCE(AVG(best_score), 0) AS avg_score
         FROM (
            SELECT MAX(att_score) AS best_score
            FROM tb_attempts
            WHERE att_status = 'submitted' AND att_customer_id <> ? AND att_score IS NOT NULL
              AND ${isMock ? "att_mock_exam_id = ?" : "att_product_id = ?"}
            GROUP BY att_customer_id
         ) peers`,
        [score, attempt.att_customer_id, isMock ? attempt.att_mock_exam_id : attempt.att_product_id]
    );
    const peers = Number(row.peers);
    if (peers < MIN_PEERS_FOR_COMPARISON) return null;
    return {
        peers,
        // % ของคนอื่นที่คะแนนดีที่สุดของเขายังต่ำกว่าคะแนนครั้งนี้ของเรา
        better_than_percent: Math.round((Number(row.lower_count) / peers) * 100),
        average_score: Math.round(Number(row.avg_score)),
    };
}

async function getReview(req, res, next) {
    try {
        const attempt = await loadOwnAttempt(req.params.id, req.customer.cus_id);
        if (!attempt) return res.status(404).json({ message: "ไม่พบการทำข้อสอบนี้" });
        if (!(await requireStillEntitledForAttempt(req.customer.cus_id, attempt, res))) return;
        if (attempt.att_status !== "submitted") {
            return res.status(400).json({ message: "ยังไม่ได้ส่งคำตอบ ดูเฉลยไม่ได้" });
        }

        const questionOrder = parseJsonColumn(attempt.att_question_order) ?? [];
        const questionMap = await fetchQuestionsByIds(questionOrder);
        const [answers] = await pool.query(
            "SELECT ans_question_id, ans_selected_choice_id, ans_choice_order, ans_is_correct, ans_score FROM tb_attempt_answers WHERE ans_attempt_id = ?",
            [attempt.att_id]
        );
        const answerByQuestion = Object.fromEntries(answers.map((a) => [a.ans_question_id, a]));

        // ใบปกติอ่านเกณฑ์จากชุดข้อสอบ · ใบสนามสอบอ่านจากสนามสอบ (โครงสร้าง+เกณฑ์เป็นของสนามสอบ ไม่ใช่ของชุดใดชุดหนึ่ง)
        const [[product]] = attempt.att_mock_exam_id
            ? [[]]
            : await pool.query("SELECT prod_name, prod_pass_percent, prod_pass_min FROM tb_products WHERE prod_id = ?", [attempt.att_product_id]);
        const [[mockExam]] = attempt.att_mock_exam_id
            ? await pool.query("SELECT me_name, me_pass_percent, me_pass_min FROM tb_mock_exams WHERE me_id = ?", [attempt.att_mock_exam_id])
            : [[]];

        // is_correct ต้องมาจาก ans_is_correct ที่บันทึกไว้ตอนตอบจริง (frozen ณ ตอนนั้น) ห้ามคำนวณสดจาก
        // choices.cho_is_correct ปัจจุบัน — เพราะแอดมินอาจแก้เฉลยทีหลัง (เช่น มีคนแจ้งปัญหาข้อนี้แล้วแก้ให้ถูก)
        // ถ้าหน้ารีวิวเทียบกับเฉลยสดจะทำให้ % คะแนนรวม (att_score ที่ freeze ไว้ตอน submit) กับจำนวนข้อถูก/ผิด
        // ที่โชว์ในหน้าเดียวกันขัดแย้งกันเอง (เช่น สรุปบอก 80% แต่นับข้อถูกจริงได้แค่ 60%) — ตัวเลือกที่ไฮไลต์
        // เป็น "คำตอบที่ถูก" ในเฉลย (reveal.correct_choice_id) ยังคงใช้ข้อมูลสดต่อไปได้ตามปกติ (ต้องการให้เห็น
        // เฉลยที่แก้ไขล่าสุดเพื่อประโยชน์ในการเรียนรู้) แค่ต้องแยกออกจากตัวเลขที่ใช้นับคะแนน/ตัดสินถูก-ผิด
        const questions = questionOrder
            .map((quesId) => {
                const question = questionMap[quesId];
                const answer = answerByQuestion[quesId];
                if (!question || !answer) return null;
                const choiceOrder = parseJsonColumn(answer.ans_choice_order) ?? [];
                return { ...buildQuestionPayload(question, choiceOrder, answer, true), is_correct: !!answer.ans_is_correct };
            })
            .filter(Boolean);

        // ผลรายหมวด "ของครั้งนี้เท่านั้น" — ต่างจาก /me/weak-areas ที่รวมทุกครั้งทุกชุด
        // ตอบคำถามที่ผู้ใช้อยากรู้ทันทีหลังส่งคำตอบว่า "รอบนี้พลาดเรื่องอะไร" โดยไม่ต้องออกจากหน้านี้
        //
        // สูตร accuracy ใช้ COALESCE(ans_score, 1) เหมือน getWeakAreas/getProductSummary เป๊ะ — ชุดที่ไม่ใช้
        // ระบบคะแนนนับข้อละ 1 คะแนน ผลจึงเท่ากับการนับจำนวนข้อ ตัวเลขทุกหน้าจึงตรงกันเสมอ
        // ข้อที่ไม่ได้ตอบนับเป็นตอบผิด (ans_is_correct = 0) ตรงกับที่ att_score คิดไว้แล้วตอน submit
        const [topicRows] = await pool.query(
            `SELECT t.tpc_id, t.tpc_name,
                    COUNT(*) AS total,
                    SUM(a.ans_is_correct) AS correct,
                    SUM(CASE WHEN a.ans_is_correct THEN COALESCE(a.ans_score, 1) ELSE 0 END) AS earned,
                    SUM(COALESCE(a.ans_score, 1)) AS possible,
                    SUM(a.ans_score IS NOT NULL) AS scored_answers
             FROM tb_attempt_answers a
             JOIN tb_questions q ON q.ques_id = a.ans_question_id
             JOIN tb_topics t ON t.tpc_id = q.ques_topic_id
             WHERE a.ans_attempt_id = ? AND a.ans_is_correct IS NOT NULL
             GROUP BY t.tpc_id, t.tpc_name
             ORDER BY (SUM(CASE WHEN a.ans_is_correct THEN COALESCE(a.ans_score, 1) ELSE 0 END) / SUM(COALESCE(a.ans_score, 1))) ASC,
                      t.tpc_name ASC`,
            [attempt.att_id]
        );

        const [topicCriteria] = attempt.att_mock_exam_id
            ? await pool.query(
                "SELECT mes_topic_id AS ptp_topic_id, mes_pass_percent AS ptp_pass_percent, mes_pass_min AS ptp_pass_min FROM tb_mock_exam_sections WHERE mes_exam_id = ?",
                [attempt.att_mock_exam_id]
            )
            : await pool.query(
                "SELECT ptp_topic_id, ptp_pass_percent, ptp_pass_min FROM tb_product_topic_pass_criteria WHERE ptp_product_id = ?",
                [attempt.att_product_id]
            );

        // คะแนนครั้งก่อนของชุดเดียวกัน (ที่ส่งคำตอบแล้วและเกิดก่อนใบนี้) — ใช้บอกว่าดีขึ้นหรือแย่ลง
        // เทียบกับ "ครั้งก่อน" ไม่ใช่ "ดีที่สุด" เพราะสิ่งที่ผู้ใช้อยากรู้ทันทีคือรอบนี้พัฒนาขึ้นไหม
        const [[prev]] = await pool.query(
            `SELECT att_score FROM tb_attempts
             WHERE att_customer_id = ? AND att_status = 'submitted' AND att_submitted_at < ?
               AND ${attempt.att_mock_exam_id ? "att_mock_exam_id = ?" : "att_product_id = ?"}
             ORDER BY att_submitted_at DESC LIMIT 1`,
            [req.customer.cus_id, attempt.att_submitted_at, attempt.att_mock_exam_id ?? attempt.att_product_id]
        );

        res.json({
            att_id: attempt.att_id,
            att_product_id: attempt.att_product_id,
            att_mock_exam_id: attempt.att_mock_exam_id ?? null,
            prod_name: product?.prod_name ?? mockExam?.me_name ?? "",
            att_mode: attempt.att_mode,
            att_score: attempt.att_score,
            att_earned_score: attempt.att_earned_score,
            att_max_score: attempt.att_max_score,
            att_total_questions: attempt.att_total_questions,
            att_started_at: attempt.att_started_at,
            att_submitted_at: attempt.att_submitted_at,
            // null = ยังไม่เคยทำชุดนี้มาก่อน (ครั้งแรก จึงไม่มีอะไรให้เทียบ)
            prev_score: prev?.att_score ?? null,
            // จำนวนข้อของชุดนี้ที่ยังตอบผิดอยู่ (นับข้ามทุกครั้งที่ทำ ไม่ใช่เฉพาะใบนี้) — ใช้กับปุ่มไปหน้าทบทวน
            // ใบสนามสอบดึงข้อจากหลายชุด ตัวเลข "ยังต้องทบทวน" จึงนับรวมทุกชุดที่ลูกค้ามี
            mistake_count: await countUnresolvedMistakes(req.customer.cus_id, attempt.att_product_id),
            // null = ชุดนี้ไม่ได้ตั้งเกณฑ์ผ่าน / ไม่ใช่โหมดจับเวลา — หน้าเว็บซ่อนส่วนนั้นไปเลย
            readiness: buildReadiness(
                attempt, toCriterion(
                    product?.prod_pass_percent ?? mockExam?.me_pass_percent,
                    product?.prod_pass_min ?? mockExam?.me_pass_min
                ),
                answers.filter((a) => a.ans_is_correct).length, topicRows, topicCriteria
            ),
            pace: buildPace(attempt),
            // null = คนทำชุดนี้ยังน้อยเกินกว่าจะเทียบได้อย่างมีความหมาย → หน้าเว็บซ่อนส่วนนี้ไปเลย
            peer_comparison: await buildPeerComparison(attempt),
            topic_breakdown: topicRows.map((t) => ({
                tpc_id: t.tpc_id,
                tpc_name: t.tpc_name,
                correct: Number(t.correct),
                total: Number(t.total),
                earned: Number(t.earned),
                possible: Number(t.possible),
                scored: Number(t.scored_answers) > 0,
                accuracy: Math.round((Number(t.earned) / Number(t.possible)) * 100),
            })),
            questions,
        });
    } catch (err) {
        next(err);
    }
}

// สรุปผลแยกรายชุดข้อสอบ — ตอบคำถาม "ชุดไหนเราแม่นแล้ว ชุดไหนยังต้องซ้อม"
//
// ต่างจากสรุปภาพรวมใน getAttemptHistory ที่รวมทุกชุดเป็นก้อนเดียว (บอกได้แค่ว่าเก่งขึ้นโดยรวมไหม)
// และต่างจากจุดอ่อนรายหมวดที่ตัดข้ามชุด (บอกว่าอ่อนเรื่องอะไร) — อันนี้บอกว่าควรกลับไปซ้อม "ชุดไหน"
//
// นับเฉพาะ attempt ที่ส่งคำตอบแล้ว เพราะที่ยกเลิก/ทำค้างไม่มีคะแนนให้สรุป (ของจริงมีเยอะกว่าที่ทำเสร็จ
// เกือบเท่าตัว ถ้านับรวมค่าเฉลี่ยจะเพี้ยนทันที)
// ค่าคะแนนจาก SQL อาจมาเป็น NULL หรือสตริงว่าง (จาก IFNULL ที่ต้องใส่กัน GROUP_CONCAT ข้าม NULL)
// ทั้งสองแบบแปลว่า "ครั้งนั้นไม่ได้ใช้ระบบคะแนน" ต้องเป็น null ไม่ใช่ 0
function num(value) {
    return value === null || value === undefined || value === "" ? null : Number(value);
}

async function getProductSummary(req, res, next) {
    try {
        const customerId = req.customer.cus_id;
        const [rows] = await pool.query(
            `SELECT s.att_product_id, p.prod_name,
                    COUNT(*) AS attempts,
                    ROUND(MAX(s.att_score), 2) AS best_score,
                    ROUND(AVG(s.att_score), 1) AS avg_score,
                    MAX(s.att_submitted_at) AS last_attempt_at,
                    MAX(s.att_max_score) AS max_score,
                    AVG(s.att_earned_score) AS avg_earned_score,
                    -- ค่าของ "ครั้งล่าสุด" และ "ครั้งที่ดีที่สุด" หยิบด้วย GROUP_CONCAT+SUBSTRING_INDEX
                    -- (แพตเทิร์นเดียวกับที่ใช้ใน getMistakes) เอาแค่ตัวแรกจึงไม่ติดลิมิตความยาวของ
                    -- group_concat_max_len ที่ตัดท้ายสตริง
                    SUBSTRING_INDEX(GROUP_CONCAT(s.att_score ORDER BY s.att_submitted_at DESC), ',', 1) + 0 AS latest_score,
                    SUBSTRING_INDEX(GROUP_CONCAT(s.correct_count ORDER BY s.att_submitted_at DESC), ',', 1) + 0 AS latest_correct,
                    SUBSTRING_INDEX(GROUP_CONCAT(s.att_total_questions ORDER BY s.att_submitted_at DESC), ',', 1) + 0 AS latest_questions,
                    -- เสมอกันให้เอาครั้งที่ใหม่กว่า เพื่อให้ตัวเลขดิบตรงกับ best_score เสมอ
                    SUBSTRING_INDEX(GROUP_CONCAT(s.correct_count ORDER BY s.att_score DESC, s.att_submitted_at DESC), ',', 1) + 0 AS best_correct,
                    SUBSTRING_INDEX(GROUP_CONCAT(s.att_total_questions ORDER BY s.att_score DESC, s.att_submitted_at DESC), ',', 1) + 0 AS best_questions,
                    -- คะแนนดิบ "ของ attempt ใบนั้นจริงๆ" ไม่ใช่ MAX ข้ามใบ — ชุดเดียวกันทำหลายครั้ง MAX(earned)
                    -- อาจมาจากคนละใบกับที่ให้ best_score ทำให้ตัวเลขที่โชว์คู่กันมาจากคนละครั้ง
                    --
                    -- ต้อง IFNULL เป็นสตริงว่างก่อน เพราะ GROUP_CONCAT ข้าม NULL ทิ้ง ถ้าชุดนั้นมีทั้งครั้งที่
                    -- ใช้ระบบคะแนนและครั้งที่ไม่ใช้ปนกัน ตัวแรกที่ได้จะกลายเป็นของครั้งอื่นที่ไม่ใช่ครั้งที่ต้องการ
                    SUBSTRING_INDEX(GROUP_CONCAT(IFNULL(s.att_earned_score, '') ORDER BY s.att_score DESC, s.att_submitted_at DESC), ',', 1) AS best_earned_score,
                    SUBSTRING_INDEX(GROUP_CONCAT(IFNULL(s.att_max_score, '') ORDER BY s.att_score DESC, s.att_submitted_at DESC), ',', 1) AS best_max_score,
                    SUBSTRING_INDEX(GROUP_CONCAT(IFNULL(s.att_earned_score, '') ORDER BY s.att_submitted_at DESC), ',', 1) AS latest_earned_score,
                    SUBSTRING_INDEX(GROUP_CONCAT(IFNULL(s.att_max_score, '') ORDER BY s.att_submitted_at DESC), ',', 1) AS latest_max_score,
                    ROUND(AVG(s.correct_count), 1) AS avg_correct,
                    ROUND(AVG(s.att_total_questions), 1) AS avg_questions
             FROM (
                SELECT a.att_id, a.att_product_id, a.att_score, a.att_earned_score, a.att_max_score,
                       a.att_total_questions, a.att_submitted_at,
                       (SELECT COUNT(*) FROM tb_attempt_answers x
                         WHERE x.ans_attempt_id = a.att_id AND x.ans_is_correct = 1) AS correct_count
                FROM tb_attempts a
                WHERE a.att_customer_id = ? AND a.att_status = 'submitted'
             ) s
             JOIN tb_products p ON p.prod_id = s.att_product_id
             GROUP BY s.att_product_id, p.prod_name
             ORDER BY last_attempt_at DESC`,
            [customerId]
        );

        // จุดอ่อนรายหมวด "ของแต่ละชุด" — ดึงทีเดียวทุกชุดแล้วค่อยแจกเข้าแถว ไม่ยิงทีละชุด
        // (ลูกค้าที่มี 10 ชุดจะกลายเป็น 10 query ทันทีถ้าทำแบบนั้น)
        //
        // สูตร accuracy ใช้ COALESCE(ans_score, 1) เหมือน getWeakAreas เป๊ะ — คำตอบจากชุดที่ไม่ใช้ระบบ
        // คะแนนนับเป็นข้อละ 1 คะแนน ผลจึงเท่ากับการนับจำนวนข้อ ตัวเลขสองที่จึงตรงกันเสมอ
        const [topicRows] = await pool.query(
            `SELECT att.att_product_id, t.tpc_id, t.tpc_name,
                    SUM(a.ans_is_correct) AS correct,
                    COUNT(*) AS total,
                    SUM(CASE WHEN a.ans_is_correct THEN COALESCE(a.ans_score, 1) ELSE 0 END) AS earned,
                    SUM(COALESCE(a.ans_score, 1)) AS possible,
                    SUM(a.ans_score IS NOT NULL) AS scored_answers
             FROM tb_attempt_answers a
             JOIN tb_attempts att ON att.att_id = a.ans_attempt_id
             JOIN tb_questions q ON q.ques_id = a.ans_question_id
             JOIN tb_topics t ON t.tpc_id = q.ques_topic_id
             WHERE att.att_customer_id = ? AND att.att_status = 'submitted' AND a.ans_is_correct IS NOT NULL
             GROUP BY att.att_product_id, t.tpc_id, t.tpc_name
             HAVING COUNT(*) >= ?
             ORDER BY (SUM(CASE WHEN a.ans_is_correct THEN COALESCE(a.ans_score, 1) ELSE 0 END) / SUM(COALESCE(a.ans_score, 1))) ASC`,
            [customerId, MIN_TOPIC_SAMPLE]
        );

        // จำนวน "ข้อที่ยังต้องทบทวน" ของแต่ละชุด — ตัวเลขนี้คือสิ่งที่ทำให้การ์ดสรุปกดต่อได้
        // (จุดอ่อนบอกว่าอ่อนหมวดไหน แต่ไม่บอกว่ามีกี่ข้อรออยู่ และกดไปทำอะไรต่อไม่ได้)
        const [mistakeRows] = await pool.query(
            `SELECT m.att_product_id, COUNT(*) AS mistakes FROM (
                SELECT ev.product_id AS att_product_id,
                       ${WRONG_COUNT_SQL} AS wrong_count,
                       ${LATEST_CORRECT_SQL} AS latest_correct
                FROM ${mistakeEventsSql()}
                GROUP BY ev.product_id, ev.question_id
                ${UNRESOLVED_MISTAKE_HAVING}
             ) m
             GROUP BY m.att_product_id`,
            [customerId, customerId]
        );
        const mistakesByProduct = {};
        for (const m of mistakeRows) mistakesByProduct[m.att_product_id] = Number(m.mistakes);

        const topicsByProduct = {};
        for (const t of topicRows) {
            (topicsByProduct[t.att_product_id] ??= []).push({
                tpc_id: t.tpc_id,
                tpc_name: t.tpc_name,
                correct: Number(t.correct),
                total: Number(t.total),
                earned: Number(t.earned),
                possible: Number(t.possible),
                scored: Number(t.scored_answers) > 0,
                accuracy: Math.round((Number(t.earned) / Number(t.possible)) * 100),
            });
        }

        res.json({
            data: rows.map((r) => ({
                att_product_id: r.att_product_id,
                prod_name: r.prod_name,
                attempts: Number(r.attempts),
                best_score: r.best_score === null ? null : Number(r.best_score),
                avg_score: r.avg_score === null ? null : Number(r.avg_score),
                latest_score: r.latest_score === null ? null : Number(r.latest_score),
                last_attempt_at: r.last_attempt_at,
                // ค่าคะแนนเป็น null ถ้าครั้งนั้นไม่ได้ใช้ระบบคะแนน — ฝั่งหน้าเว็บจะถอยไปโชว์จำนวนข้อแทน
                // (สตริงว่างจาก IFNULL ใน SQL ต้องแปลงกลับเป็น null ตรงนี้ ไม่งั้น Number("") = 0)
                best_earned_score: num(r.best_earned_score),
                best_max_score: num(r.best_max_score),
                latest_earned_score: num(r.latest_earned_score),
                latest_max_score: num(r.latest_max_score),
                avg_earned_score: num(r.avg_earned_score),
                max_score: num(r.max_score),
                // ตัวเลขดิบคู่กับ % ทั้งสามค่า — ชุดที่ไม่ใช้ระบบคะแนนก็ยังบอกได้ว่า "ถูกกี่ข้อจากกี่ข้อ"
                best_correct: Number(r.best_correct),
                best_questions: Number(r.best_questions),
                latest_correct: Number(r.latest_correct),
                latest_questions: Number(r.latest_questions),
                avg_correct: Number(r.avg_correct),
                avg_questions: Number(r.avg_questions),
                // เรียงหมวดที่แม่นน้อยสุดขึ้นก่อน — ว่างได้ถ้าชุดนั้นยังตอบไม่ถึงเกณฑ์ขั้นต่ำต่อหมวด
                weak_topics: topicsByProduct[r.att_product_id] ?? [],
                mistake_count: mistakesByProduct[r.att_product_id] ?? 0,
            })),
        });
    } catch (err) {
        next(err);
    }
}

// ─── "ทำใหม่ 10 ข้อที่เคยผิด" (2026-09-15) ───────────────────────────────────────────────────────────
// หยิบข้อที่ยังต้องทบทวน (นิยามเดียวกับรายการ — UNRESOLVED_MISTAKE_HAVING) มาให้ตอบใหม่แบบโหมดฝึก:
// ตอบแล้วเห็นเฉลยทันที ตอบถูก = บันทึกลง tb_mistake_retries แล้วข้อนั้นหลุดจากรายการเอง
// เฉพาะชุดที่ยังมีสิทธิ์อยู่ (สิทธิ์หมด/ถูกยกเลิก = ทำใหม่ไม่ได้ เหมือนทำข้อสอบชุดนั้นไม่ได้)
const PRACTICE_SIZE = 10;

// ─── แผนทบทวนรายวัน (2026-09-18) ────────────────────────────────────────────────────────────────
// "ตอบถูกวันนี้" ไม่เท่ากับ "จำได้ตอนสอบ" — ข้อที่แก้ได้แล้วจะถูกนัดกลับมาถามอีกโดยเว้นห่างขึ้นเรื่อยๆ
// ตอบถูกอีก = เลื่อนชั้น (เว้นห่างขึ้น) · ตอบผิด = ลบนัดทิ้ง กลับไปเป็นข้อที่ต้องทบทวนทันที
// ผ่านครบทุกชั้นแล้ว = ถือว่าจำได้จริง ไม่ถามอีก (ยกเว้นไปเจอในข้อสอบแล้วผิดใหม่)
const REVIEW_INTERVALS_DAYS = [1, 3, 7, 14, 30];
// จำนวนข้อต่อวันเมื่อ "ยังไม่ได้ตั้งวันสอบ" — พอให้ทำได้จริงทุกวันโดยไม่ท้อ
const DEFAULT_DAILY_TARGET = 10;
const MAX_DAILY_TARGET = 40;

// วันที่ตามเวลาไทยเสมอ (เซิร์ฟเวอร์อาจเป็น UTC) — กติกาเดียวกับ bangkokDate() ของสถิติผู้เยี่ยมชม
// คอลัมน์ DATE จาก mysql2 เป็น Date object ไม่ใช่สตริง — ต้องแปลงด้วยค่าตามเวลาท้องถิ่นของ Date นั้น
// (ใช้ toISOString ไม่ได้ เพราะจะเลื่อนวันตาม timezone ของเครื่อง)
function toDateString(value) {
    if (!value) return null;
    if (typeof value === "string") return value.slice(0, 10);
    const pad = (n) => String(n).padStart(2, "0");
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

function bangkokToday() {
    const now = new Date(Date.now() + 7 * 60 * 60 * 1000);
    return now.toISOString().slice(0, 10);
}
// จุดเริ่มต้นของ "วันนี้ตามเวลาไทย" ในรูป Date จริง — เอาไปเทียบกับคอลัมน์ DATETIME ได้ตรงๆ
function bangkokDayStart() {
    return new Date(new Date(`${bangkokToday()}T00:00:00Z`).getTime() - 7 * 60 * 60 * 1000);
}

function daysUntil(examDate) {
    if (!examDate) return null;
    const target = new Date(`${String(examDate).slice(0, 10)}T00:00:00Z`).getTime();
    const today = new Date(`${bangkokToday()}T00:00:00Z`).getTime();
    return Math.round((target - today) / 86400000);
}

// ข้อที่ "ถึงคิวทบทวนวันนี้" = ข้อที่ยังตอบผิดอยู่ (ต้องทบทวนเสมอ) + ข้อที่เคยแก้ได้แล้วแต่ถึงกำหนดทวนซ้ำ
// คืนรายการ ques_id + product เพื่อให้กรองสิทธิ์ต่อได้ · due_kind บอกว่ามาจากทางไหน (ใช้เรียงลำดับ)
async function fetchDueQuestions(customerId, filters = {}) {
    const conditions = ["q.ques_status = 'active'"];
    const params = [customerId, customerId];
    if (filters.product_id) { conditions.push("q.ques_product_id = ?"); params.push(filters.product_id); }
    if (filters.topic_id) { conditions.push("q.ques_topic_id = ?"); params.push(filters.topic_id); }

    const [rows] = await pool.query(
        `SELECT m.ques_id, m.ques_product_id, m.wrong_count,
                CASE WHEN m.latest_correct = 0 THEN 'unresolved'
                     WHEN rs.rs_due_at IS NOT NULL AND rs.rs_due_at <= NOW() THEN 'scheduled'
                     ELSE 'later' END AS due_kind,
                rs.rs_due_at, rs.rs_stage
         FROM (
            SELECT q.ques_id, q.ques_product_id,
                   ${WRONG_COUNT_SQL} AS wrong_count,
                   ${LATEST_CORRECT_SQL} AS latest_correct
            FROM ${mistakeEventsSql()}
            JOIN tb_questions q ON q.ques_id = ev.question_id
            WHERE ${conditions.join(" AND ")}
            GROUP BY q.ques_id, q.ques_product_id
            HAVING wrong_count > 0
         ) m
         LEFT JOIN tb_review_schedule rs ON rs.rs_question_id = m.ques_id AND rs.rs_customer_id = ?
         ORDER BY m.wrong_count DESC, RAND()`,
        [...params, customerId]
    );
    return rows;
}

// นัดครั้งถัดไปหลังตอบใหม่ — ถูก = เลื่อนชั้น, ผิด = ลบนัดทิ้ง (กลับไปต้องทบทวนทันที)
async function updateReviewSchedule(customerId, questionId, isCorrect) {
    if (!isCorrect) {
        await pool.query("DELETE FROM tb_review_schedule WHERE rs_customer_id = ? AND rs_question_id = ?", [customerId, questionId]);
        return;
    }
    const [[current]] = await pool.query(
        "SELECT rs_stage FROM tb_review_schedule WHERE rs_customer_id = ? AND rs_question_id = ?", [customerId, questionId]
    );
    const stage = Math.min((current ? Number(current.rs_stage) : 0) + 1, REVIEW_INTERVALS_DAYS.length);
    const days = REVIEW_INTERVALS_DAYS[stage - 1];
    await pool.query(
        `INSERT INTO tb_review_schedule (rs_customer_id, rs_question_id, rs_stage, rs_due_at)
         VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ? DAY))
         ON DUPLICATE KEY UPDATE rs_stage = VALUES(rs_stage), rs_due_at = VALUES(rs_due_at)`,
        [customerId, questionId, stage, days]
    );
}

// GET /store/me/review-plan — "วันนี้ควรทบทวนกี่ข้อ" + นับถอยหลังวันสอบ
// เป้าต่อวันคำนวณจากจำนวนข้อที่ต้องเคลียร์หารด้วยจำนวนวันที่เหลือ ถ้ายังไม่ตั้งวันสอบใช้ค่าเริ่มต้น
async function getReviewPlan(req, res, next) {
    try {
        const customerId = req.customer.cus_id;
        const [[customer]] = await pool.query("SELECT cus_exam_date FROM tb_customers WHERE cus_id = ?", [customerId]);
        const examDate = toDateString(customer?.cus_exam_date);
        const daysLeft = daysUntil(examDate);

        const rows = await fetchDueQuestions(customerId);
        const entitled = await entitledProductIds(customerId, rows.map((r) => r.ques_product_id));
        const usable = rows.filter((r) => entitled.has(r.ques_product_id));
        const unresolved = usable.filter((r) => r.due_kind === "unresolved").length;
        const scheduled = usable.filter((r) => r.due_kind === "scheduled").length;
        const later = usable.filter((r) => r.due_kind === "later").length;
        const dueToday = unresolved + scheduled;

        // ทบทวนไปแล้วกี่ข้อวันนี้ (นับข้อไม่ซ้ำ ตอบข้อเดิมซ้ำๆ ไม่ควรนับเป็นความคืบหน้า)
        const [[{ done_today: doneToday }]] = await pool.query(
            `SELECT COUNT(DISTINCT mr_question_id) AS done_today FROM tb_mistake_retries
             WHERE mr_customer_id = ? AND mr_created_at >= ?`,
            [customerId, bangkokDayStart()]
        );

        const target = daysLeft !== null && daysLeft > 0
            ? Math.min(MAX_DAILY_TARGET, Math.max(1, Math.ceil(unresolved / daysLeft)))
            : DEFAULT_DAILY_TARGET;

        res.json({
            exam_date: examDate,
            days_left: daysLeft,
            // ข้อที่ยังตอบผิดอยู่ (ต้องเคลียร์ให้ได้ก่อนสอบ) + ข้อที่ถึงกำหนดทวนซ้ำวันนี้
            unresolved_count: unresolved,
            scheduled_count: scheduled,
            due_today: dueToday,
            // ข้อที่แก้ได้แล้วและยังไม่ถึงกำหนดทวน — บอกให้เห็นว่า "เก็บไปแล้วเท่าไหร่"
            resting_count: later,
            done_today: Number(doneToday),
            daily_target: Math.min(target, dueToday || target),
        });
    } catch (err) {
        next(err);
    }
}

// PUT /store/me/exam-date — body { exam_date: "YYYY-MM-DD" | null }
async function setExamDate(req, res, next) {
    try {
        const raw = req.body?.exam_date;
        if (raw !== null && raw !== undefined && raw !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(String(raw))) {
            return res.status(400).json({ message: "รูปแบบวันสอบไม่ถูกต้อง" });
        }
        const examDate = raw === null || raw === undefined || raw === "" ? null : String(raw);
        // กันตั้งวันในอดีต (พิมพ์ปีผิดเป็นเรื่องปกติ) — วันนี้ยังตั้งได้ เผื่อสอบวันนี้
        if (examDate && examDate < bangkokToday()) {
            return res.status(400).json({ message: "วันสอบต้องไม่ใช่วันที่ผ่านมาแล้ว" });
        }
        await pool.query("UPDATE tb_customers SET cus_exam_date = ? WHERE cus_id = ?", [examDate, req.customer.cus_id]);
        res.json({ exam_date: examDate, days_left: daysUntil(examDate) });
    } catch (err) {
        next(err);
    }
}


async function entitledProductIds(customerId, productIds) {
    const unique = [...new Set(productIds)];
    const checks = await Promise.all(unique.map((pid) => hasActiveEntitlement(customerId, pid)));
    return new Set(unique.filter((_, i) => checks[i]));
}

// GET /store/me/mistakes/practice?product_id=&topic_id= — ข้อที่ผิดซ้ำหลายครั้งมาก่อน (สัญญาณชัดสุดว่ายังไม่เข้าใจ)
// เสมอกันสุ่มลำดับ ทำรอบหน้าจะได้ไม่เจอ 10 ข้อเดิมทุกครั้ง · ส่งแบบไม่มีเฉลย (เฉลยมาตอนตอบ)
async function getMistakePractice(req, res, next) {
    try {
        const customerId = req.customer.cus_id;
        const conditions = ["q.ques_status = 'active'"];
        const params = [customerId, customerId];
        if (req.query.product_id) { conditions.push("q.ques_product_id = ?"); params.push(req.query.product_id); }
        if (req.query.topic_id) { conditions.push("q.ques_topic_id = ?"); params.push(req.query.topic_id); }

        // โหมดแผนวันนี้ (?plan=1): ข้อที่ยังผิด + ข้อที่ถึงกำหนดทวนซ้ำ · โหมดปกติ: เฉพาะข้อที่ยังผิด
        const planMode = req.query.plan === "1";
        const rows = planMode
            ? (await fetchDueQuestions(customerId, req.query)).filter((r) => r.due_kind !== "later")
            : (await pool.query(
                `SELECT m.ques_id, m.ques_product_id FROM (
                    SELECT q.ques_id, q.ques_product_id,
                           ${WRONG_COUNT_SQL} AS wrong_count,
                           ${LATEST_CORRECT_SQL} AS latest_correct
                    FROM ${mistakeEventsSql()}
                    JOIN tb_questions q ON q.ques_id = ev.question_id
                    WHERE ${conditions.join(" AND ")}
                    GROUP BY q.ques_id, q.ques_product_id
                    ${UNRESOLVED_MISTAKE_HAVING}
                 ) m
                 ORDER BY m.wrong_count DESC, RAND()`,
                params
            ))[0];
        const entitled = await entitledProductIds(customerId, rows.map((r) => r.ques_product_id));
        const available = rows.filter((r) => entitled.has(r.ques_product_id));
        // แผนวันนี้: ข้อที่ "ถึงกำหนดทวนซ้ำ" ได้คิวก่อน เพราะมีจำนวนจำกัดและเลยกำหนดแล้วคุณค่าลดลง
        // ส่วนข้อที่ยังตอบผิดอยู่มีให้ทำได้ทุกวันอยู่แล้ว (ถ้าเรียงกลับกัน ข้อที่นัดไว้จะโดนเบียดตกรอบตลอดไป)
        const ordered = planMode
            ? [...available].sort((a, b) => (a.due_kind === b.due_kind ? 0 : a.due_kind === "scheduled" ? -1 : 1))
            : available;
        const picked = shuffle(ordered.slice(0, PRACTICE_SIZE));

        const questionMap = await fetchQuestionsByIds(picked.map((r) => r.ques_id));
        const [meta] = picked.length
            ? await pool.query(
                  `SELECT q.ques_id, p.prod_name, t.tpc_name FROM tb_questions q
                   JOIN tb_products p ON p.prod_id = q.ques_product_id
                   LEFT JOIN tb_topics t ON t.tpc_id = q.ques_topic_id
                   WHERE q.ques_id IN (?)`,
                  [picked.map((r) => r.ques_id)]
              )
            : [[]];
        const metaById = Object.fromEntries(meta.map((m) => [m.ques_id, m]));

        res.json({
            questions: picked
                .filter((r) => questionMap[r.ques_id])
                .map((r) => {
                    const q = questionMap[r.ques_id];
                    return {
                        ...buildQuestionPayload(q, q.choices.map((c) => c.cho_id), null, false),
                        prod_name: metaById[r.ques_id]?.prod_name ?? null,
                        tpc_name: metaById[r.ques_id]?.tpc_name ?? null,
                    };
                }),
            // ข้อที่ยังต้องทบทวนทั้งหมดที่ทำใหม่ได้ (ตามตัวกรอง) — หน้าเว็บบอก "เหลืออีก N ข้อ"
            remaining: available.length,
            // ข้อที่ต้องทบทวนแต่อยู่ในชุดที่สิทธิ์หมดแล้ว — บอกลูกค้าตรงๆ ว่าทำไมไม่ขึ้นมา
            locked: rows.length - available.length,
        });
    } catch (err) {
        next(err);
    }
}

// POST /store/me/mistakes/:questionId/retry — body { cho_id } → บันทึก + ส่งเฉลยกลับทันที
// ต้องเป็นข้อที่ลูกค้าคนนี้เคยตอบผิดจริง (กันใช้ endpoint นี้เปิดเฉลยข้อที่ไม่เคยทำ) + ยังมีสิทธิ์ในชุดนั้น
async function retryMistake(req, res, next) {
    try {
        const customerId = req.customer.cus_id;
        const { questionId } = req.params;
        const choId = typeof req.body?.cho_id === "string" ? req.body.cho_id : null;

        const [[history]] = await pool.query(
            `SELECT ${WRONG_COUNT_SQL} AS wrong_count FROM ${mistakeEventsSql()} WHERE ev.question_id = ?`,
            [customerId, customerId, questionId]
        );
        if (!history || !Number(history.wrong_count)) return res.status(404).json({ message: "ไม่พบข้อนี้ในรายการที่ต้องทบทวน" });

        const questionMap = await fetchQuestionsByIds([questionId]);
        const question = questionMap[questionId];
        if (!question) return res.status(404).json({ message: "ข้อนี้ถูกปิดใช้งานแล้ว" });
        const [[{ ques_product_id: productId }]] = await pool.query("SELECT ques_product_id FROM tb_questions WHERE ques_id = ?", [questionId]);
        if (!(await requireStillEntitled(customerId, productId, res))) return;

        const choice = question.choices.find((c) => c.cho_id === choId);
        if (!choice) return res.status(400).json({ message: "กรุณาเลือกคำตอบ" });
        const isCorrect = !!choice.cho_is_correct;

        await pool.query(
            "INSERT INTO tb_mistake_retries (mr_customer_id, mr_question_id, mr_selected_choice_id, mr_is_correct) VALUES (?, ?, ?, ?)",
            [customerId, questionId, choId, isCorrect ? 1 : 0]
        );
        await updateReviewSchedule(customerId, questionId, isCorrect);
        const payload = buildQuestionPayload(question, question.choices.map((c) => c.cho_id), { ans_selected_choice_id: choId }, true);
        res.json({ is_correct: isCorrect, reveal: payload.reveal });
    } catch (err) {
        next(err);
    }
}

// "ข้อที่ต้องทบทวน" — ข้อที่ลูกค้าเคยตอบผิด รวมทุกครั้งที่ทำ
//
// นี่คือจุดที่เปลี่ยนหน้าประวัติจาก "รายงานผล" เป็น "เครื่องมือฝึก" — เดิมบอกได้แค่ว่าอ่อนหมวดไหน
// แต่ไม่มีทางกดไปดูว่าผิดข้อไหนบ้าง ทั้งที่จุดขายของธุรกิจคือเฉลยที่อธิบายวิธีคิด (CLAUDE.md ข้อ 4)
//
// เรียงตาม "ยังผิดอยู่" ก่อน แล้วค่อยตามจำนวนครั้งที่ผิด — ข้อที่เคยผิดแต่ครั้งล่าสุดตอบถูกแล้วถือว่า
// แก้ได้แล้ว ดันลงไปท้ายลิสต์ ส่วนข้อที่ผิดซ้ำหลายครั้งคือสัญญาณชัดที่สุดว่ายังไม่เข้าใจจริง
//
// คืนเฉลยเต็ม (ตัวเลือกถูก + วิธีคิด + เหตุผลที่ตัวเลือกอื่นผิด) เหมือน bookmark — เป็นข้อที่ทำไปแล้ว
// การเปิดเฉลยจึงไม่กระทบความยุติธรรมของการสอบ
async function getMistakes(req, res, next) {
    try {
        const customerId = req.customer.cus_id;
        const limit = Math.min(Number(req.query.limit) || 20, 100);
        const offset = Number(req.query.offset) || 0;
        const productId = req.query.product_id || null;
        const topicId = req.query.topic_id || null;
        // ค่าเริ่มต้นโชว์เฉพาะข้อที่ "ยังผิดอยู่" เพราะเป็นสิ่งที่ต้องลงมือทบทวนจริงๆ
        const includeResolved = req.query.include_resolved === "1";

        // คนละข้อกันกับเงื่อนไขลูกค้า (อยู่ใน mistakeEventsSql แล้ว) — ที่นี่เหลือแค่ตัวกรองชุด/หัวข้อ
        const conditions = ["1 = 1"];
        const params = [customerId, customerId];
        if (productId) { conditions.push("q.ques_product_id = ?"); params.push(productId); }
        if (topicId) { conditions.push("q.ques_topic_id = ?"); params.push(topicId); }

        // รวมสถิติรายข้อก่อน แล้วค่อยกรองเอาเฉพาะข้อที่เคยผิด — ต้องรู้จำนวนครั้งที่ตอบทั้งหมดด้วย
        // ไม่งั้นแยกไม่ออกระหว่าง "ผิด 1 จาก 1" กับ "ผิด 1 จาก 5" ซึ่งความหมายต่างกันมาก
        const havingSql = includeResolved ? "HAVING wrong_count > 0" : UNRESOLVED_MISTAKE_HAVING;
        const [rows] = await pool.query(
            `SELECT * FROM (
                SELECT q.ques_id, q.ques_text, q.ques_explanation, q.ques_image_url,
                       q.ques_product_id, p.prod_name, t.tpc_id, t.tpc_name,
                       ${WRONG_COUNT_SQL} AS wrong_count,
                       COUNT(*) AS answered_count,
                       MAX(ev.answered_at) AS last_answered_at,
                       -- ผลของ "ครั้งล่าสุด" ที่ตอบข้อนี้ (ไม่ใช่ครั้งไหนก็ได้) ใช้ตัดสินว่าแก้ได้แล้วหรือยัง
                       ${LATEST_CORRECT_SQL} AS latest_correct,
                       SUBSTRING_INDEX(GROUP_CONCAT(COALESCE(ev.choice_id, '') ORDER BY ev.answered_at DESC), ',', 1) AS latest_choice_id
                FROM ${mistakeEventsSql()}
                JOIN tb_questions q ON q.ques_id = ev.question_id
                JOIN tb_products p ON p.prod_id = q.ques_product_id
                LEFT JOIN tb_topics t ON t.tpc_id = q.ques_topic_id
                WHERE ${conditions.join(" AND ")}
                GROUP BY q.ques_id, q.ques_text, q.ques_explanation, q.ques_image_url,
                         q.ques_product_id, p.prod_name, t.tpc_id, t.tpc_name
                ${havingSql}
             ) m
             -- ques_id ปิดท้ายเพื่อให้ลำดับ "เต็ม" (total order) ขาดไม่ได้ — สามคีย์แรกเสมอกันได้ง่ายมาก
             -- (ข้อที่ผิดครั้งเดียวจาก attempt เดียวกันมี last_answered_at เท่ากันเป๊ะทุกข้อ) พอเสมอกัน
             -- MySQL จัดลำดับกันเองอิสระในแต่ละ query ข้อเดียวกันจึงโผล่ทั้งหน้า 1 และหน้า 2 ได้
             -- (เจอจริงตอนทดสอบ: หน้า 1 กับ 2 ซ้ำกัน 1 ข้อ)
             ORDER BY m.latest_correct ASC, m.wrong_count DESC, m.last_answered_at DESC, m.ques_id ASC
             LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );

        const [[{ total }]] = await pool.query(
            `SELECT COUNT(*) AS total FROM (
                SELECT q.ques_id,
                       ${WRONG_COUNT_SQL} AS wrong_count,
                       ${LATEST_CORRECT_SQL} AS latest_correct
                FROM ${mistakeEventsSql()}
                JOIN tb_questions q ON q.ques_id = ev.question_id
                WHERE ${conditions.join(" AND ")}
                GROUP BY q.ques_id
                ${havingSql}
             ) c`,
            params
        );

        if (rows.length === 0) return res.json({ data: [], total: 0 });

        const [choices] = await pool.query(
            `SELECT cho_id, cho_question_id, cho_text, cho_is_correct, cho_wrong_reason, cho_image_url
             FROM tb_choices WHERE cho_question_id IN (?) ORDER BY cho_order ASC`,
            [rows.map((r) => r.ques_id)]
        );
        const choicesByQuestion = {};
        for (const c of choices) (choicesByQuestion[c.cho_question_id] ??= []).push(c);

        // สถานะ bookmark ของข้อพวกนี้ — ปุ่มบันทึกต้องรู้สถานะจริงตั้งแต่ render แรก ไม่งั้นข้อที่บันทึกไว้
        // แล้วจะโชว์เป็น "ยังไม่บันทึก" แล้วกดครั้งแรกกลายเป็นการลบทิ้งโดยที่ผู้ใช้ตั้งใจจะบันทึก
        const [bookmarked] = await pool.query(
            "SELECT bmk_question_id FROM tb_bookmarks WHERE bmk_customer_id = ? AND bmk_question_id IN (?)",
            [customerId, rows.map((r) => r.ques_id)]
        );
        const bookmarkedSet = new Set(bookmarked.map((b) => b.bmk_question_id));

        res.json({
            total: Number(total),
            data: rows.map((r) => ({
                ques_id: r.ques_id,
                ques_text: r.ques_text,
                ques_explanation: r.ques_explanation,
                ques_image_url: r.ques_image_url,
                prod_id: r.ques_product_id,
                prod_name: r.prod_name,
                tpc_id: r.tpc_id,
                tpc_name: r.tpc_name,
                wrong_count: Number(r.wrong_count),
                answered_count: Number(r.answered_count),
                last_answered_at: r.last_answered_at,
                // ครั้งล่าสุดตอบถูกแล้ว = เคยพลาดแต่แก้ได้แล้ว
                resolved: Number(r.latest_correct) === 1,
                latest_choice_id: r.latest_choice_id || null,
                is_bookmarked: bookmarkedSet.has(r.ques_id),
                choices: (choicesByQuestion[r.ques_id] ?? []).map((c) => ({
                    cho_id: c.cho_id,
                    cho_text: c.cho_text,
                    cho_image_url: c.cho_image_url,
                    is_correct: !!c.cho_is_correct,
                    wrong_reason: c.cho_is_correct ? null : c.cho_wrong_reason,
                })),
            })),
        });
    } catch (err) {
        next(err);
    }
}

// สรุปจุดอ่อนรายหมวด — group ตาม topic (ไม่ใช่ category เพราะ "อนุกรม"/"อุปมาอุปไมย" ถูกแท็กที่ระดับ
// คำถามผ่าน ques_topic_id) นับเฉพาะ attempt ที่ submitted แล้ว และต้องตอบอย่างน้อย MIN_SAMPLE ข้อ
// ต่อหมวดถึงจะโชว์ กัน % ดูน่าเชื่อถือผิดๆ จากตัวอย่างน้อยเกินไป (เช่น ทำข้อเดียวแล้วผิด = 0%)
const MIN_TOPIC_SAMPLE = 3;

async function getWeakAreas(req, res, next) {
    try {
        const productId = req.query.product_id || null;
        const conditions = ["att.att_customer_id = ?", "att.att_status = 'submitted'", "a.ans_is_correct IS NOT NULL"];
        const params = [req.customer.cus_id];
        if (productId) {
            conditions.push("att.att_product_id = ?");
            params.push(productId);
        }

        const [rows] = await pool.query(
            // คิดเป็น "คะแนนที่ได้ / คะแนนเต็มของหมวดนั้น" โดยใช้ COALESCE(ans_score, 1) — คำตอบจากชุดที่ไม่ใช้
            // ระบบคะแนน (ans_score เป็น NULL) นับเป็นข้อละ 1 คะแนน ผลลัพธ์จึงเท่ากับการนับจำนวนข้อแบบเดิมเป๊ะ
            // ไม่มีอะไรเปลี่ยนสำหรับลูกค้าที่ยังไม่เคยทำชุดที่ใช้ระบบคะแนน แต่พอมีชุดที่ให้น้ำหนักต่างกัน หมวดที่
            // "เสียคะแนนเยอะ" จะลอยขึ้นมาก่อนหมวดที่พลาดหลายข้อแต่ข้อละคะแนนน้อย ซึ่งตรงกับความเป็นจริงกว่า
            //
            // scored_answers ใช้บอกฝั่งหน้าเว็บว่าหมวดนี้มีคำตอบจากชุดที่ใช้ระบบคะแนนปนอยู่ไหม จะได้เลือกคำ
            // ที่ใช้แสดงผลให้ตรง ("ได้ 13.5 จาก 30 คะแนน" กับ "ถูก 9 จาก 20 ข้อ")
            `SELECT t.tpc_id, t.tpc_name,
                    SUM(a.ans_is_correct) AS correct,
                    COUNT(*) AS total,
                    SUM(CASE WHEN a.ans_is_correct THEN COALESCE(a.ans_score, 1) ELSE 0 END) AS earned,
                    SUM(COALESCE(a.ans_score, 1)) AS possible,
                    SUM(a.ans_score IS NOT NULL) AS scored_answers
             FROM tb_attempt_answers a
             JOIN tb_attempts att ON att.att_id = a.ans_attempt_id
             JOIN tb_questions q ON q.ques_id = a.ans_question_id
             JOIN tb_topics t ON t.tpc_id = q.ques_topic_id
             WHERE ${conditions.join(" AND ")}
             GROUP BY t.tpc_id, t.tpc_name
             HAVING COUNT(*) >= ?
             ORDER BY (SUM(CASE WHEN a.ans_is_correct THEN COALESCE(a.ans_score, 1) ELSE 0 END) / SUM(COALESCE(a.ans_score, 1))) ASC`,
            [...params, MIN_TOPIC_SAMPLE]
        );

        const data = rows.map((r) => ({
            tpc_id: r.tpc_id,
            tpc_name: r.tpc_name,
            correct: Number(r.correct),
            total: Number(r.total),
            earned: Number(r.earned),
            possible: Number(r.possible),
            scored: Number(r.scored_answers) > 0,
            accuracy: Math.round((Number(r.earned) / Number(r.possible)) * 100),
        }));
        res.json({ data });
    } catch (err) {
        next(err);
    }
}

// ประวัติการทำข้อสอบ — แบ่งหน้าเสมอ
//
// เดิมดึงทุก attempt ของลูกค้ามาทั้งก้อนโดยไม่มี LIMIT เลย ลูกค้าที่ซ้อมทุกวันจะสะสมหลักร้อยครั้งภายใน
// เดือนเดียว แล้วหน้านี้จะช้าลงเรื่อยๆ แบบไม่มีเพดาน ทั้งที่ไม่มีใครเลื่อนไปดูครั้งที่ 80
//
// status: กรองได้ (submitted/in_progress/abandoned) — ของจริงตอนนี้ attempt ที่ถูกยกเลิกมีมากกว่าที่ทำเสร็จ
// เกือบเท่าตัว ถ้าปนกันหมดหน้าจะดูเหมือนประวัติที่ล้มเหลวมากกว่าสำเร็จ
//
// attempt_no / prev_score: ลำดับครั้งที่ทำชุดนั้น + คะแนนครั้งก่อนของชุดเดียวกัน ใช้บอกว่า "ดีขึ้นหรือแย่ลง"
// ต้องคำนวณด้วย window function บนข้อมูลทั้งหมดก่อนตัดหน้า ไม่งั้นเลขครั้งที่จะเพี้ยนตามหน้าที่เปิดอยู่
async function getAttemptHistory(req, res, next) {
    try {
        const limit = Math.min(Number(req.query.limit) || 20, 100);
        const offset = Number(req.query.offset) || 0;
        const status = ["submitted", "in_progress", "abandoned"].includes(req.query.status) ? req.query.status : null;

        const conditions = ["a.att_customer_id = ?"];
        const params = [req.customer.cus_id];
        if (status) { conditions.push("a.att_status = ?"); params.push(status); }
        const whereClause = conditions.join(" AND ");

        const [rows] = await pool.query(
            `SELECT * FROM (
                SELECT a.att_id, a.att_product_id, a.att_mock_exam_id,
                       COALESCE(p.prod_name, m.me_name) AS prod_name, a.att_mode, a.att_status,
                       a.att_score, a.att_earned_score, a.att_max_score, a.att_total_questions,
                       a.att_time_limit_minutes, a.att_started_at, a.att_submitted_at,
                       -- จำนวนข้อที่ตอบถูกจริง — นับจาก ans_is_correct ที่ freeze ไว้ตอนตอบ ไม่ถอดกลับจาก
                       -- att_score เพราะ % ถูกปัดทศนิยมเก็บไว้ การคูณกลับจะคลาดเคลื่อนได้เมื่อจำนวนข้อเยอะ
                       (SELECT COUNT(*) FROM tb_attempt_answers x
                         WHERE x.ans_attempt_id = a.att_id AND x.ans_is_correct = 1) AS att_correct_count,
                       -- ใบสนามสอบนับ "ครั้งที่" แยกของตัวเอง ไม่ปนกับครั้งที่ทำชุดข้อสอบ
                       ROW_NUMBER() OVER (PARTITION BY COALESCE(a.att_product_id, a.att_mock_exam_id) ORDER BY a.att_started_at ASC) AS attempt_no,
                       -- คะแนนของครั้งก่อนหน้า "ที่ส่งคำตอบแล้ว" ของชุดเดียวกัน — ใช้ subquery แทน LAG()
                       -- เพราะ LAG จะหยิบแถวที่ติดกันมาตรงๆ ถ้าครั้งก่อนหน้าเป็น attempt ที่ยกเลิก/ทำค้าง
                       -- (att_score เป็น NULL) การเทียบ "ดีขึ้น/แย่ลง" จะหายไปทั้งที่มีคะแนนเก่าให้เทียบอยู่
                       -- MySQL ไม่รองรับ LAG(...) IGNORE NULLS จึงต้องเขียนแบบนี้
                       (SELECT b.att_score FROM tb_attempts b
                         WHERE b.att_customer_id = a.att_customer_id
                           AND COALESCE(b.att_product_id, b.att_mock_exam_id) = COALESCE(a.att_product_id, a.att_mock_exam_id)
                           AND b.att_status = 'submitted'
                           AND b.att_started_at < a.att_started_at
                         ORDER BY b.att_started_at DESC LIMIT 1) AS prev_score
                -- LEFT JOIN ทั้งคู่: ใบปกติมีแต่ชุดข้อสอบ ใบสนามสอบมีแต่สนามสอบ
                FROM tb_attempts a
                LEFT JOIN tb_products p ON p.prod_id = a.att_product_id
                LEFT JOIN tb_mock_exams m ON m.me_id = a.att_mock_exam_id
                WHERE ${whereClause}
             ) t
             ORDER BY t.att_started_at DESC
             LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );

        // เงื่อนไขใช้แต่ alias a อยู่แล้ว จึงนับได้โดยไม่ต้อง join tb_products มาด้วย
        const [[{ total }]] = await pool.query(
            `SELECT COUNT(*) AS total FROM tb_attempts a WHERE ${whereClause}`,
            params
        );

        // สรุปภาพรวมคิดจาก attempt ที่ "ส่งคำตอบแล้ว" ทั้งหมดเสมอ ไม่ใช่เฉพาะหน้าที่เปิดอยู่ —
        // ไม่งั้นค่าเฉลี่ยจะเปลี่ยนไปมาตามหน้าที่กดดู ซึ่งไม่มีความหมายอะไรเลย
        const [[summary]] = await pool.query(
            `SELECT COUNT(*) AS submitted_count,
                    ROUND(AVG(a.att_score), 1) AS avg_score,
                    MAX(a.att_submitted_at) AS last_submitted_at,
                    -- ยอดรวมข้อที่ตอบถูก/ข้อทั้งหมดของทุกครั้งรวมกัน — เป็นตัวเลขดิบที่คู่กับ "คะแนนเฉลี่ย"
                    -- (ค่าเฉลี่ยของ % ข้ามชุดที่จำนวนข้อไม่เท่ากัน ไม่มีตัวหารเดียวให้แสดงเป็นเศษส่วนได้)
                    SUM(a.att_total_questions) AS total_questions,
                    SUM((SELECT COUNT(*) FROM tb_attempt_answers x
                          WHERE x.ans_attempt_id = a.att_id AND x.ans_is_correct = 1)) AS total_correct
             FROM tb_attempts a WHERE a.att_customer_id = ? AND a.att_status = 'submitted'`,
            [req.customer.cus_id]
        );
        const [[latest]] = await pool.query(
            `SELECT a.att_score, a.att_total_questions,
                    (SELECT COUNT(*) FROM tb_attempt_answers x
                      WHERE x.ans_attempt_id = a.att_id AND x.ans_is_correct = 1) AS correct_count
             FROM tb_attempts a
             WHERE a.att_customer_id = ? AND a.att_status = 'submitted'
             ORDER BY a.att_submitted_at DESC LIMIT 1`,
            [req.customer.cus_id]
        );

        res.json({
            data: rows,
            total: Number(total),
            summary: {
                submitted_count: Number(summary.submitted_count),
                avg_score: summary.avg_score === null ? null : Number(summary.avg_score),
                latest_score: latest ? Number(latest.att_score) : null,
                last_submitted_at: summary.last_submitted_at,
                total_correct: Number(summary.total_correct ?? 0),
                total_questions: Number(summary.total_questions ?? 0),
                latest_correct: latest ? Number(latest.correct_count) : null,
                latest_questions: latest ? Number(latest.att_total_questions) : null,
            },
        });
    } catch (err) {
        next(err);
    }
}

// พิมพ์แบบฝึกหัด PDF (หน้าคลังข้อสอบของฉัน) — ลูกค้าเลือกได้เองว่าจะสลับลำดับข้อ/ตัวเลือกไหม (?shuffle=0
// ปิด, default เปิด) และจะเอาเฉลยเต็ม (คำตอบถูก+วิธีคิด+เหตุผลตัวเลือกผิด) ติดไปด้วยไหม (?answers=1 เปิด,
// default ปิด) — reveal=withAnswers ใช้ buildQuestionPayload ตัวเดียวกับหน้า review ออนไลน์เป๊ะ ไม่ต้อง
// เขียน logic เฉลยซ้ำ ไม่สร้างแถว tb_attempts เพราะแค่ต้องการชุดคำถามไปพิมพ์ ไม่ใช่เริ่มทำข้อสอบจริง (กัน
// ชนกับ unique-in-progress-attempt constraint ของ startOrResumeAttempt โดยไม่ตั้งใจ)
async function exportPrintableQuestions(req, res, next) {
    try {
        const productId = req.params.id;
        const shouldShuffle = req.query.shuffle !== "0";
        const withAnswers = req.query.answers === "1";

        const hasAccess = await hasActiveEntitlement(req.customer.cus_id, productId);
        if (!hasAccess) {
            return res.status(403).json({ message: "สิทธิ์เข้าถึงชุดข้อสอบนี้หมดอายุหรือถูกยกเลิกไปแล้ว" });
        }

        const [productRows] = await pool.query("SELECT prod_name, prod_total_score FROM tb_products WHERE prod_id = ?", [productId]);
        if (productRows.length === 0) return res.status(404).json({ message: "ไม่พบชุดข้อสอบนี้" });

        const questionMap = await fetchQuestionsWithChoices(productId);
        // ไม่สลับ: เรียงตาม ques_id/cho_id ให้ได้ลำดับคงที่แน่นอน (SQL ไม่ได้ ORDER BY มาให้)
        const orderedQuestionIds = shouldShuffle ? shuffle(Object.keys(questionMap)) : Object.keys(questionMap).sort();

        const questions = orderedQuestionIds.map((quesId) => {
            const question = questionMap[quesId];
            const choiceIds = question.choices.map((c) => c.cho_id);
            const choiceOrder = shouldShuffle ? shuffle(choiceIds) : choiceIds.sort();
            return buildQuestionPayload(question, choiceOrder, null, withAnswers);
        });

        // ไม่มี attempt จึงไม่มี snapshot — ใช้คะแนนเต็มปัจจุบันของชุด (null = ชุดนี้ไม่ใช้ระบบคะแนน
        // ฝั่ง PDF จะไม่พิมพ์คะแนนเลย)
        res.json({ prod_name: productRows[0].prod_name, prod_total_score: productRows[0].prod_total_score, questions });
    } catch (err) {
        next(err);
    }
}

module.exports = {
    startOrResumeAttempt, startMockAttempt, getReviewPlan, setExamDate, getAttempt, submitAnswer, submitAttempt, abandonAttempt, getReview, getAttemptHistory,
    getProductSummary, getWeakAreas, getMistakes, getMistakePractice, retryMistake,
    fetchQuestionsWithChoices, fetchSampleQuestions, fetchQuestionsByIds, buildQuestionPayload, exportPrintableQuestions,
    SAMPLE_QUESTION_COUNT,
    // สำหรับทดสอบ
    buildReadiness, buildPace, toCriterion, buildPeerComparison, MIN_PEERS_FOR_COMPARISON,
};
