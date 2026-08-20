const pool = require("../config/db");
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
        `SELECT ques_id, ques_text, ques_explanation, ques_image_url FROM tb_questions
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
        `SELECT ques_id, ques_text, ques_explanation, ques_image_url FROM tb_questions
         WHERE ques_id IN (?) AND ques_status = 'active'`,
        [questionIds]
    );
    return buildQuestionMap(questions);
}

// ดึงคำถามตัวอย่างจำนวนจำกัดของ product (ใช้กับหน้าตัวอย่างฟรีก่อนซื้อ) — กรอง+จำกัดจำนวนที่ระดับ SQL
// เลย (ORDER BY + LIMIT) แทนที่จะดึงคำถามทั้งคลังมาเก็บใน JS แล้วค่อย .slice() ทีหลัง เพราะ endpoint นี้
// ไม่ต้อง login เรียกได้อิสระ ถ้า product มีคำถามเยอะจะโดนดึงข้อมูลทิ้งจำนวนมากทุกครั้งที่มีคนเข้าดูตัวอย่าง
async function fetchSampleQuestions(productId, limit) {
    const [questions] = await pool.query(
        `SELECT ques_id, ques_text, ques_explanation, ques_image_url FROM tb_questions
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
        `SELECT att_id, att_customer_id, att_product_id, att_mode, att_status, att_question_order,
                att_score, att_total_questions, att_time_limit_minutes, att_started_at, att_submitted_at
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
        `SELECT ans_question_id, ans_selected_choice_id, ans_choice_order, ans_is_correct
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
        att_mode: attempt.att_mode,
        att_status: attempt.att_status,
        att_score: attempt.att_score,
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
            "SELECT prod_exam_duration_minutes FROM tb_products WHERE prod_id = ?",
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

        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            const att_id = await generateId("tb_attempts", "ATT");
            await conn.query(
                `INSERT INTO tb_attempts
                    (att_id, att_customer_id, att_product_id, att_mode, att_question_order,
                     att_total_questions, att_time_limit_minutes)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [att_id, req.customer.cus_id, productId, mode, JSON.stringify(questionIds), questionIds.length, timeLimitMinutes]
            );

            // INSERT รวมทีเดียวแทนการวน query ทีละแถว (เดิม 1 คำถาม = 1 round trip ไป DB) — product ที่มี
            // คำถามเยอะ (หลักร้อย/พัน) จะสร้าง attempt ใหม่ช้ามากถ้าต้อง insert ทีละแถวแบบนั้น
            const answerIds = await generateIds("tb_attempt_answers", "ANS", questionIds.length);
            const answerRows = questionIds.map((quesId, i) => {
                const choiceOrder = questionMap[quesId].choices.map((c) => c.cho_id);
                return [answerIds[i], att_id, quesId, JSON.stringify(choiceOrder)];
            });
            if (answerRows.length > 0) {
                await conn.query(
                    `INSERT INTO tb_attempt_answers (ans_id, ans_attempt_id, ans_question_id, ans_choice_order) VALUES ?`,
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

async function getAttempt(req, res, next) {
    try {
        const attempt = await loadOwnAttempt(req.params.id, req.customer.cus_id);
        if (!attempt) return res.status(404).json({ message: "ไม่พบการทำข้อสอบนี้" });
        if (!(await requireStillEntitled(req.customer.cus_id, attempt.att_product_id, res))) return;
        res.json(await buildAttemptResponse(attempt));
    } catch (err) {
        next(err);
    }
}

async function submitAnswer(req, res, next) {
    try {
        const attempt = await loadOwnAttempt(req.params.id, req.customer.cus_id);
        if (!attempt) return res.status(404).json({ message: "ไม่พบการทำข้อสอบนี้" });
        if (!(await requireStillEntitled(req.customer.cus_id, attempt.att_product_id, res))) return;
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
        if (!(await requireStillEntitled(req.customer.cus_id, attempt.att_product_id, res))) return;
        if (attempt.att_status !== "in_progress") {
            return res.status(400).json({ message: "ทำข้อสอบชุดนี้เสร็จไปแล้ว" });
        }

        const [[{ correctCount }]] = await pool.query(
            "SELECT COUNT(*) AS correctCount FROM tb_attempt_answers WHERE ans_attempt_id = ? AND ans_is_correct = TRUE",
            [attempt.att_id]
        );
        const score = attempt.att_total_questions > 0 ? (correctCount / attempt.att_total_questions) * 100 : 0;

        await pool.query(
            "UPDATE tb_attempts SET att_status = 'submitted', att_score = ?, att_submitted_at = NOW() WHERE att_id = ?",
            [score.toFixed(2), attempt.att_id]
        );

        res.json({ att_id: attempt.att_id, score: Number(score.toFixed(2)), correct_count: correctCount, total_questions: attempt.att_total_questions });
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
async function getReview(req, res, next) {
    try {
        const attempt = await loadOwnAttempt(req.params.id, req.customer.cus_id);
        if (!attempt) return res.status(404).json({ message: "ไม่พบการทำข้อสอบนี้" });
        if (!(await requireStillEntitled(req.customer.cus_id, attempt.att_product_id, res))) return;
        if (attempt.att_status !== "submitted") {
            return res.status(400).json({ message: "ยังไม่ได้ส่งคำตอบ ดูเฉลยไม่ได้" });
        }

        const questionOrder = parseJsonColumn(attempt.att_question_order) ?? [];
        const questionMap = await fetchQuestionsByIds(questionOrder);
        const [answers] = await pool.query(
            "SELECT ans_question_id, ans_selected_choice_id, ans_choice_order, ans_is_correct FROM tb_attempt_answers WHERE ans_attempt_id = ?",
            [attempt.att_id]
        );
        const answerByQuestion = Object.fromEntries(answers.map((a) => [a.ans_question_id, a]));

        const [[product]] = await pool.query("SELECT prod_name FROM tb_products WHERE prod_id = ?", [attempt.att_product_id]);

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

        res.json({
            att_id: attempt.att_id,
            prod_name: product?.prod_name ?? "",
            att_mode: attempt.att_mode,
            att_score: attempt.att_score,
            att_total_questions: attempt.att_total_questions,
            att_submitted_at: attempt.att_submitted_at,
            questions,
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
            `SELECT t.tpc_id, t.tpc_name,
                    SUM(a.ans_is_correct) AS correct,
                    COUNT(*) AS total
             FROM tb_attempt_answers a
             JOIN tb_attempts att ON att.att_id = a.ans_attempt_id
             JOIN tb_questions q ON q.ques_id = a.ans_question_id
             JOIN tb_topics t ON t.tpc_id = q.ques_topic_id
             WHERE ${conditions.join(" AND ")}
             GROUP BY t.tpc_id, t.tpc_name
             HAVING COUNT(*) >= ?
             ORDER BY (SUM(a.ans_is_correct) / COUNT(*)) ASC`,
            [...params, MIN_TOPIC_SAMPLE]
        );

        const data = rows.map((r) => ({
            tpc_id: r.tpc_id,
            tpc_name: r.tpc_name,
            correct: Number(r.correct),
            total: Number(r.total),
            accuracy: Math.round((Number(r.correct) / Number(r.total)) * 100),
        }));
        res.json({ data });
    } catch (err) {
        next(err);
    }
}

async function getAttemptHistory(req, res, next) {
    try {
        const [rows] = await pool.query(
            `SELECT a.att_id, a.att_product_id, p.prod_name, a.att_mode, a.att_status,
                    a.att_score, a.att_total_questions, a.att_started_at, a.att_submitted_at
             FROM tb_attempts a JOIN tb_products p ON p.prod_id = a.att_product_id
             WHERE a.att_customer_id = ?
             ORDER BY a.att_started_at DESC`,
            [req.customer.cus_id]
        );
        res.json({ data: rows });
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

        const [productRows] = await pool.query("SELECT prod_name FROM tb_products WHERE prod_id = ?", [productId]);
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

        res.json({ prod_name: productRows[0].prod_name, questions });
    } catch (err) {
        next(err);
    }
}

module.exports = {
    startOrResumeAttempt, getAttempt, submitAnswer, submitAttempt, abandonAttempt, getReview, getAttemptHistory, getWeakAreas,
    fetchQuestionsWithChoices, fetchSampleQuestions, buildQuestionPayload, exportPrintableQuestions,
};
