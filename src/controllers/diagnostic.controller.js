const pool = require("../config/db");
const { fetchQuestionsByIds, buildQuestionPayload, SAMPLE_QUESTION_COUNT } = require("./attempt.controller");

// ─── แบบทดสอบวัดระดับฟรี (2026-09-15) — ไม่ต้อง login ทำ 15 ข้อคละหัวข้อของหมวดสอบที่เลือก
// แล้วบอกว่าอ่อนหัวข้อไหน + แนะนำชุดข้อสอบที่มีข้อหัวข้อนั้นเยอะที่สุด
//
// ⚠ สุ่มข้อจาก "ตัวอย่างฟรี" ของทุกชุดในหมวดเท่านั้น (10 ข้อแรกต่อชุด — SAMPLE_QUESTION_COUNT ตัวเดียวกับหน้า
// /products/[id]/sample) ไม่ใช่ทั้งคลัง — หน้าผลเปิดเฉลยเต็มทุกข้อ ถ้าสุ่มจากทั้งคลัง คนทำซ้ำไปเรื่อยๆ จะเก็บเฉลย
// ของข้อที่ต้องซื้อได้ครบทุกข้อฟรี (เฉลยคือสินค้าหลักของธุรกิจนี้) — ตอนตรวจก็เช็คซ้ำว่าทุกข้อที่ส่งมาอยู่ในกองนี้
// ส่วนการแนะนำชุดนับจากทั้งคลังได้ เพราะส่งออกไปแค่ "จำนวนข้อ" ไม่มีเนื้อหา
//
// ไม่บันทึกอะไรลงฐานข้อมูลเลย (ตรวจแล้วส่งผลกลับอย่างเดียว) — ไม่มีตารางใหม่ ไม่ต้อง migration
// จำนวนคนที่ทำดูได้จากสถิติผู้เยี่ยมชมหน้า /diagnostic อยู่แล้ว

const DIAGNOSTIC_QUESTION_COUNT = 15;
const MIN_POOL_SIZE = 5;       // หมวดที่มีตัวอย่างฟรีน้อยกว่านี้ วัดอะไรไม่ได้ ไม่เปิดให้ทำ
const WEAK_BELOW_PCT = 60;     // เส้นแบ่ง "ควรเร่ง" ของเราเอง (ไม่อ้างว่าเป็นเกณฑ์ทางการของสนามสอบใด)
const MAX_RECOMMENDATIONS = 3;
const NO_TOPIC_KEY = "_none";

function shuffle(array) {
    const arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

const pct = (correct, total) => (total > 0 ? Math.round((correct / total) * 100) : 0);

// กองข้อที่ใช้วัดระดับได้ของหมวดหนึ่ง = ตัวอย่างฟรีของทุกชุดที่ published ในหมวดนั้น
// (ROW_NUMBER เรียงด้วย ques_id ให้ตรงกับ fetchSampleQuestions ทุกประการ — ถ้าเรียงคนละแบบ จะกลายเป็นคนละชุดข้อ)
async function fetchSamplePool(categoryId) {
    const [rows] = await pool.query(
        `SELECT x.ques_id, x.ques_product_id, x.ques_topic_id, t.tpc_name
         FROM (
             SELECT q.ques_id, q.ques_product_id, q.ques_topic_id,
                    ROW_NUMBER() OVER (PARTITION BY q.ques_product_id ORDER BY q.ques_id) AS rn
             FROM tb_questions q
             JOIN tb_products p ON p.prod_id = q.ques_product_id
             WHERE p.prod_status = 'published' AND p.prod_category_id = ? AND q.ques_status = 'active'
         ) x
         LEFT JOIN tb_topics t ON t.tpc_id = x.ques_topic_id
         WHERE x.rn <= ?`,
        [categoryId, SAMPLE_QUESTION_COUNT]
    );
    return rows;
}

async function findCategory(categoryId) {
    const [[cat]] = await pool.query(
        "SELECT cat_id, cat_name FROM tb_categories WHERE cat_id = ? AND cat_status = 'active'",
        [categoryId]
    );
    return cat ?? null;
}

// เลือกข้อแบบกระจายหัวข้อ: สุ่มในแต่ละหัวข้อ แล้วหยิบวนทีละหัวข้อ — ไม่งั้นหัวข้อที่มีตัวอย่างเยอะจะกินโควตา
// จนหัวข้ออื่นไม่ได้วัดเลย (ผลรายหัวข้อจะไม่มีความหมาย) · สุดท้ายสลับลำดับอีกรอบให้คละเหมือนข้อสอบจริง
function pickBalanced(poolRows, count) {
    const byTopic = new Map();
    for (const row of shuffle(poolRows)) {
        const key = row.ques_topic_id ?? NO_TOPIC_KEY;
        if (!byTopic.has(key)) byTopic.set(key, []);
        byTopic.get(key).push(row);
    }
    const queues = shuffle([...byTopic.values()]);
    const picked = [];
    while (picked.length < count && queues.some((q) => q.length)) {
        for (const queue of queues) {
            if (picked.length >= count) break;
            if (queue.length) picked.push(queue.shift());
        }
    }
    return shuffle(picked);
}

// GET /store/diagnostic — หมวดสอบที่เปิดให้วัดระดับได้ (active + มีตัวอย่างฟรีพอ)
async function listDiagnosticCategories(req, res, next) {
    try {
        const [rows] = await pool.query(
            `SELECT c.cat_id, c.cat_name, COUNT(*) AS pool_size, COUNT(DISTINCT x.ques_topic_id) AS topic_count
             FROM (
                 SELECT q.ques_topic_id, p.prod_category_id,
                        ROW_NUMBER() OVER (PARTITION BY q.ques_product_id ORDER BY q.ques_id) AS rn
                 FROM tb_questions q
                 JOIN tb_products p ON p.prod_id = q.ques_product_id
                 WHERE p.prod_status = 'published' AND q.ques_status = 'active'
             ) x
             JOIN tb_categories c ON c.cat_id = x.prod_category_id AND c.cat_status = 'active'
             WHERE x.rn <= ?
             GROUP BY c.cat_id, c.cat_name
             HAVING pool_size >= ?
             ORDER BY c.cat_show_on_landing DESC, pool_size DESC`,
            [SAMPLE_QUESTION_COUNT, MIN_POOL_SIZE]
        );
        res.json({
            data: rows.map((r) => ({
                cat_id: r.cat_id,
                cat_name: r.cat_name,
                question_count: Math.min(Number(r.pool_size), DIAGNOSTIC_QUESTION_COUNT),
                topic_count: Number(r.topic_count),
            })),
        });
    } catch (err) {
        next(err);
    }
}

// GET /store/diagnostic/:categoryId/questions — สุ่มชุดใหม่ทุกครั้ง ไม่มีเฉลยปน (เฉลยมาตอนตรวจ)
async function getDiagnosticQuestions(req, res, next) {
    try {
        const category = await findCategory(req.params.categoryId);
        if (!category) return res.status(404).json({ message: "ไม่พบหมวดสอบนี้" });

        const poolRows = await fetchSamplePool(category.cat_id);
        if (poolRows.length < MIN_POOL_SIZE) {
            return res.status(404).json({ message: "หมวดนี้ยังไม่มีข้อสอบพอสำหรับวัดระดับ" });
        }

        const picked = pickBalanced(poolRows, DIAGNOSTIC_QUESTION_COUNT);
        const questionMap = await fetchQuestionsByIds(picked.map((r) => r.ques_id));
        const questions = picked
            .filter((r) => questionMap[r.ques_id])
            .map((r) => {
                const q = questionMap[r.ques_id];
                return { ...buildQuestionPayload(q, q.choices.map((c) => c.cho_id), null, false), tpc_name: r.tpc_name ?? null };
            });

        res.json({ category, questions });
    } catch (err) {
        next(err);
    }
}

// แนะนำชุดที่มีข้อของหัวข้อที่อ่อนมากที่สุด — นับจากทั้งคลังของชุด (ส่งออกแค่จำนวน ไม่มีเนื้อหา)
// ไม่มีหัวข้อที่อ่อนเลย → แนะนำชุดที่มีข้อเยอะสุดแทน (ยังมีของให้ฝึกต่อ ไม่ใช่หน้าผลที่จบเฉยๆ)
async function recommendProducts(categoryId, weakTopics) {
    const weakIds = weakTopics.map((t) => t.tpc_id);
    const [products] = await pool.query(
        `SELECT p.prod_id, p.prod_name, p.prod_price, p.prod_compare_price, p.prod_is_free, p.prod_cover_url,
                COUNT(q.ques_id) AS question_count,
                COALESCE(SUM(q.ques_topic_id IN (?)), 0) AS weak_question_count
         FROM tb_products p
         LEFT JOIN tb_questions q ON q.ques_product_id = p.prod_id AND q.ques_status = 'active'
         WHERE p.prod_status = 'published' AND p.prod_category_id = ?
         GROUP BY p.prod_id
         ORDER BY weak_question_count DESC, question_count DESC, p.prod_id DESC`,
        [weakIds.length ? weakIds : [""], categoryId]
    );
    const matching = products.filter((p) => Number(p.weak_question_count) > 0);
    const chosen = (matching.length ? matching : products).slice(0, MAX_RECOMMENDATIONS);
    if (chosen.length === 0) return [];

    // ข้อของหัวข้อที่อ่อน แยกรายหัวข้อ ต่อชุด — "มีข้ออนุกรม 45 ข้อ" บอกเหตุผลที่แนะนำชุดนี้ได้ตรงกว่าตัวเลขรวม
    const perTopic = {};
    if (weakIds.length) {
        const [rows] = await pool.query(
            `SELECT q.ques_product_id, q.ques_topic_id, COUNT(*) AS n
             FROM tb_questions q
             WHERE q.ques_product_id IN (?) AND q.ques_topic_id IN (?) AND q.ques_status = 'active'
             GROUP BY q.ques_product_id, q.ques_topic_id`,
            [chosen.map((p) => p.prod_id), weakIds]
        );
        const nameOf = Object.fromEntries(weakTopics.map((t) => [t.tpc_id, t.tpc_name]));
        for (const r of rows) {
            (perTopic[r.ques_product_id] ??= []).push({ tpc_id: r.ques_topic_id, tpc_name: nameOf[r.ques_topic_id], count: Number(r.n) });
        }
        for (const list of Object.values(perTopic)) list.sort((a, b) => b.count - a.count);
    }

    return chosen.map((p) => ({
        prod_id: p.prod_id,
        prod_name: p.prod_name,
        prod_price: p.prod_price,
        prod_compare_price: p.prod_compare_price,
        prod_is_free: !!p.prod_is_free,
        prod_cover_url: p.prod_cover_url,
        question_count: Number(p.question_count),
        weak_topic_counts: perTopic[p.prod_id] ?? [],
    }));
}

// POST /store/diagnostic/:categoryId/grade — body { answers: [{ ques_id, cho_id }] } (cho_id null = ข้าม)
async function gradeDiagnostic(req, res, next) {
    try {
        const category = await findCategory(req.params.categoryId);
        if (!category) return res.status(404).json({ message: "ไม่พบหมวดสอบนี้" });

        const answers = Array.isArray(req.body?.answers) ? req.body.answers : null;
        if (!answers || answers.length === 0 || answers.length > DIAGNOSTIC_QUESTION_COUNT * 2) {
            return res.status(400).json({ message: "รูปแบบคำตอบไม่ถูกต้อง" });
        }
        const answerByQuestion = new Map();
        for (const a of answers) {
            if (typeof a?.ques_id !== "string" || answerByQuestion.has(a.ques_id)) {
                return res.status(400).json({ message: "รูปแบบคำตอบไม่ถูกต้อง" });
            }
            answerByQuestion.set(a.ques_id, typeof a.cho_id === "string" ? a.cho_id : null);
        }

        // ทุกข้อต้องอยู่ในกองตัวอย่างฟรีของหมวดนี้ — กันใช้ endpoint นี้ดึงเฉลยของข้อที่ต้องซื้อ (ดูหมายเหตุหัวไฟล์)
        const poolById = new Map((await fetchSamplePool(category.cat_id)).map((r) => [r.ques_id, r]));
        if ([...answerByQuestion.keys()].some((id) => !poolById.has(id))) {
            return res.status(400).json({ message: "มีข้อที่ไม่อยู่ในแบบทดสอบนี้ กรุณาเริ่มทำใหม่" });
        }

        const questionMap = await fetchQuestionsByIds([...answerByQuestion.keys()]);
        const topics = new Map();
        const questions = [];
        let correct = 0, answered = 0;

        for (const [quesId, choId] of answerByQuestion) {
            const question = questionMap[quesId];
            if (!question) continue; // ถูกปิดไประหว่างทำ — ไม่นับ
            const meta = poolById.get(quesId);
            const validChoice = question.choices.some((c) => c.cho_id === choId) ? choId : null;
            const isCorrect = !!validChoice && !!question.choices.find((c) => c.cho_id === validChoice)?.cho_is_correct;
            if (validChoice) answered++;
            if (isCorrect) correct++;

            const key = meta.ques_topic_id ?? NO_TOPIC_KEY;
            if (!topics.has(key)) topics.set(key, { tpc_id: meta.ques_topic_id, tpc_name: meta.tpc_name ?? "ไม่ระบุหัวข้อ", correct: 0, total: 0 });
            const topic = topics.get(key);
            topic.total++;
            if (isCorrect) topic.correct++;

            questions.push({
                ...buildQuestionPayload(question, question.choices.map((c) => c.cho_id), { ans_selected_choice_id: validChoice }, true),
                tpc_name: meta.tpc_name ?? null,
                is_correct: isCorrect,
            });
        }

        const total = questions.length;
        const topicList = [...topics.values()]
            .map((t) => ({ ...t, pct: pct(t.correct, t.total) }))
            .sort((a, b) => a.pct - b.pct || b.total - a.total);
        const weakTopics = topicList.filter((t) => t.tpc_id && t.pct < WEAK_BELOW_PCT);

        res.json({
            category,
            summary: { correct, answered, total, pct: pct(correct, total), weak_below_pct: WEAK_BELOW_PCT },
            topics: topicList,
            weak_topics: weakTopics.map(({ tpc_id, tpc_name }) => ({ tpc_id, tpc_name })),
            recommendations: await recommendProducts(category.cat_id, weakTopics),
            questions,
        });
    } catch (err) {
        next(err);
    }
}

module.exports = {
    listDiagnosticCategories, getDiagnosticQuestions, gradeDiagnostic,
    // สำหรับทดสอบ
    pickBalanced, fetchSamplePool, DIAGNOSTIC_QUESTION_COUNT, WEAK_BELOW_PCT,
};
