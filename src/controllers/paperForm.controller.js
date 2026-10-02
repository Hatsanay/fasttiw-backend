const crypto = require("crypto");
const pool = require("../config/db");
const { generateId, generateIds } = require("../utils/generateId");
const { hasActiveEntitlement } = require("./entitlement.controller");
const { fetchQuestionsWithChoices, computeAttemptScore } = require("./attempt.controller");
const { saveScanImage, scanPath, deleteScanFiles } = require("../utils/paperScanStorage");

// ใบสอบกระดาษ (ระบบสอบกระดาษ เฟส 1, 2026-09-27) — ดู CLAUDE.md ข้อ 6.9
//
// ลูกค้ากด "สร้างชุดสอบกระดาษ" 1 ครั้ง = ใบสอบ 1 ใบ ตรึงลำดับข้อ/ตัวเลือกไว้ แล้วพิมพ์ PDF 2 ไฟล์ (ชุดข้อสอบ +
// กระดาษคำตอบ) จากใบสอบนี้เสมอ — ดาวน์โหลดซ้ำกี่ครั้งก็ได้ลำดับเดิม เลขข้อบนกระดาษคำตอบจึงตรงกับชุดข้อสอบที่พิมพ์ไป
// ตรวจ (เฟส 2) ก็อ่านลำดับจากใบสอบนี้ ไม่ใช่จากชุดข้อสอบปัจจุบันที่แอดมินอาจแก้ไปแล้ว

// ต้องตรงกับ lib/paper/layout.ts (tiwwai-store) — วงบนกระดาษมีได้สูงสุด 5 วง (ก-จ)
const MAX_CHOICES_ON_PAPER = 5;
const QUESTIONS_PER_PAGE = 100;
const LAYOUT_VERSION = 1;
// กันกดสร้างรัวๆ (แต่ละใบเก็บลำดับข้อทั้งชุดเป็น JSON) — ใช้งานจริงไม่มีใครพิมพ์เกินวันละไม่กี่ชุด
const MAX_FORMS_PER_DAY = 20;

// รหัสใบสอบ: PF- + 5 ตัว จากชุดตัวอักษรที่ไม่ชวนสับสนเวลาอ่านจากกระดาษ (ตัด 0/O, 1/I/L)
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
function randomCode() {
    const bytes = crypto.randomBytes(5);
    return "PF-" + Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

function shuffle(array) {
    const a = [...array];
    for (let i = a.length - 1; i > 0; i--) {
        const j = crypto.randomInt(i + 1);
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

/**
 * ข้อสอบของชุดที่พิมพ์เป็นกระดาษได้ ตามลำดับที่แอดมินจัด (ques_order / cho_order)
 * คืน { base } = { questionIds, choicesById } หรือ { error } ถ้าชุดนี้ยังพิมพ์ไม่ได้ — ใช้ร่วมกับใบสอบของกลุ่ม
 */
async function loadPrintableQuestions(productId) {
    // fetchQuestionsWithChoices คืนตามลำดับที่แอดมินจัดอยู่แล้ว
    const questionMap = await fetchQuestionsWithChoices(productId);
    const ids = Object.keys(questionMap);
    if (ids.length === 0) return { error: "ชุดนี้ยังไม่มีข้อสอบ" };
    const tooMany = ids.filter((id) => questionMap[id].choices.length > MAX_CHOICES_ON_PAPER);
    if (tooMany.length) {
        return { error: `ชุดนี้มี ${tooMany.length} ข้อที่มีตัวเลือกเกิน ${MAX_CHOICES_ON_PAPER} ตัว ยังพิมพ์เป็นกระดาษคำตอบไม่ได้ — ทำบนเว็บแทนได้` };
    }
    // ข้อที่ไม่มีตัวเลือกเลยฝนไม่ได้ — ไม่ใส่ในใบสอบ
    const questionIds = ids.filter((id) => questionMap[id].choices.length > 0);
    const choicesById = Object.fromEntries(questionIds.map((id) => [id, questionMap[id].choices.map((c) => c.cho_id)]));
    return { base: { questionIds, choicesById } };
}

/** ลำดับข้อ/ตัวเลือกของใบสอบ 1 ใบ — ไม่สลับ = ตามที่แอดมินจัด (ตรงกับออนไลน์) */
function makeFormOrder(base, shouldShuffle) {
    const questionIds = shouldShuffle ? shuffle(base.questionIds) : [...base.questionIds];
    const choiceOrders = Object.fromEntries(
        questionIds.map((id) => [id, shouldShuffle ? shuffle(base.choicesById[id]) : [...base.choicesById[id]]])
    );
    return { questionIds, choiceOrders };
}

/**
 * บันทึกใบสอบ 1 ใบ (ใช้ได้ทั้ง pool และ connection ใน transaction) — คืนรหัสใบสอบ
 * รหัสสุ่ม 5 ตัวจาก 31 ตัวอักษร (~28 ล้านแบบ) ชนกันยากมาก แต่ถ้าชนก็สุ่มใหม่ (unique key ที่ pf_code)
 */
async function insertForm(db, { pfId, customerId, productId, order, shuffled, groupId = null, round = null, variant = null }) {
    const pages = Math.ceil(order.questionIds.length / QUESTIONS_PER_PAGE);
    for (let attempt = 0; ; attempt++) {
        const code = randomCode();
        try {
            await db.query(
                `INSERT INTO tb_paper_forms
                    (pf_id, pf_code, pf_customer_id, pf_product_id, pf_group_id, pf_group_round, pf_variant,
                     pf_question_ids, pf_choice_orders, pf_shuffled, pf_pages, pf_layout_version)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    pfId, code, customerId, productId, groupId, round, variant,
                    JSON.stringify(order.questionIds), JSON.stringify(order.choiceOrders), shuffled ? 1 : 0, pages, LAYOUT_VERSION,
                ]
            );
            return { code, pages };
        } catch (err) {
            if (err.code !== "ER_DUP_ENTRY" || !String(err.message).includes("uq_pf_code") || attempt >= 4) throw err;
        }
    }
}

// POST /V1/store/paper-forms  { product_id, shuffle }
async function createForm(req, res, next) {
    try {
        const customerId = req.customer.cus_id;
        const productId = req.body?.product_id;
        const shouldShuffle = req.body?.shuffle === true;
        if (!productId) return res.status(400).json({ message: "ต้องระบุชุดข้อสอบ" });

        if (!(await hasActiveEntitlement(customerId, productId))) {
            return res.status(403).json({ message: "ยังไม่มีสิทธิ์ใช้ชุดข้อสอบนี้ หรือสิทธิ์หมดอายุแล้ว" });
        }
        // นับเฉพาะใบส่วนตัว — ใบของกลุ่มมีเพดานของกลุ่มเอง (paperGroup.controller.js)
        const [[{ recent }]] = await pool.query(
            "SELECT COUNT(*) AS recent FROM tb_paper_forms WHERE pf_customer_id = ? AND pf_group_id IS NULL AND pf_created_at > NOW() - INTERVAL 1 DAY",
            [customerId]
        );
        if (recent >= MAX_FORMS_PER_DAY) {
            return res.status(429).json({ message: `สร้างชุดสอบกระดาษได้วันละไม่เกิน ${MAX_FORMS_PER_DAY} ชุด — ใช้ชุดที่สร้างไว้แล้วได้เลย` });
        }

        const [[product]] = await pool.query("SELECT prod_name FROM tb_products WHERE prod_id = ?", [productId]);
        if (!product) return res.status(404).json({ message: "ไม่พบชุดข้อสอบนี้" });

        const loaded = await loadPrintableQuestions(productId);
        if (loaded.error) return res.status(400).json({ message: loaded.error });
        const order = makeFormOrder(loaded.base, shouldShuffle);
        const pfId = await generateId("tb_paper_forms", "PPF");
        const { code, pages } = await insertForm(pool, { pfId, customerId, productId, order, shuffled: shouldShuffle });

        res.status(201).json({
            code,
            product_id: productId,
            prod_name: product.prod_name,
            question_count: order.questionIds.length,
            pages,
            shuffled: shouldShuffle,
        });
    } catch (err) {
        next(err);
    }
}

// GET /V1/store/paper-forms?product_id= — ใบสอบของฉัน (ล่าสุดก่อน)
async function listMyForms(req, res, next) {
    try {
        const params = [req.customer.cus_id];
        let filter = "";
        if (req.query.product_id) {
            filter = " AND pf.pf_product_id = ?";
            params.push(req.query.product_id);
        }
        const [rows] = await pool.query(
            `SELECT pf.pf_code AS code, pf.pf_product_id AS product_id, p.prod_name, pf.pf_pages AS pages,
                    JSON_LENGTH(pf.pf_question_ids) AS question_count, pf.pf_shuffled AS shuffled,
                    pf.pf_status AS status, pf.pf_created_at AS created_at,
                    a.att_id, a.att_score, a.att_submitted_at AS graded_at
             FROM tb_paper_forms pf JOIN tb_products p ON p.prod_id = pf.pf_product_id
             LEFT JOIN tb_attempts a ON a.att_paper_form_id = pf.pf_id
             WHERE pf.pf_customer_id = ? AND pf.pf_group_id IS NULL AND pf.pf_status <> 'void'${filter}
             ORDER BY pf.pf_created_at DESC LIMIT 50`,
            params
        );
        res.json({ data: rows.map((r) => ({ ...r, shuffled: !!r.shuffled, att_score: r.att_score === null ? null : Number(r.att_score) })) });
    } catch (err) {
        next(err);
    }
}

/**
 * ใบสอบที่ลูกค้าคนนี้ตรวจ/ดูได้ — คืน { form, viewer } หรือ { status, message } ถ้าเข้าไม่ได้
 *   viewer "holder"    = เจ้าของใบ — ใบส่วนตัวต้องยังมีสิทธิ์ชุดนั้น · ใบของกลุ่มต้องยังเป็นสมาชิกกลุ่ม (ไม่ต้องซื้อชุด —
 *                        สมาชิกที่ไม่ได้ซื้อตรวจได้ เห็นคะแนน แต่หน้าเฉลยไม่เปิดรายข้อ: getReview + utils/solutionAccess.js)
 *   viewer "organizer" = ผู้จัดของกลุ่มที่ใบนี้สังกัด (สแกนทั้งกอง) — ต้องยังถือสิทธิ์ชุดนั้น
 * ใบที่ไม่เข้าทางไหนเลยตอบเหมือนไม่มีอยู่ (ไม่บอกว่ามีรหัสนี้จริง)
 */
async function loadOwnForm(customerId, code) {
    const [[form]] = await pool.query(
        `SELECT pf.*, p.prod_name, p.prod_total_score, g.pg_owner_id, g.pg_title,
                c.cus_fname AS holder_fname, c.cus_lname AS holder_lname,
                (SELECT 1 FROM tb_paper_group_members m WHERE m.pgm_group_id = pf.pf_group_id AND m.pgm_customer_id = pf.pf_customer_id) AS holder_in_group
         FROM tb_paper_forms pf
         JOIN tb_products p ON p.prod_id = pf.pf_product_id
         JOIN tb_customers c ON c.cus_id = pf.pf_customer_id
         LEFT JOIN tb_paper_groups g ON g.pg_id = pf.pf_group_id
         WHERE pf.pf_code = ?`,
        [String(code || "").toUpperCase()]
    );
    const notFound = { status: 404, message: "ไม่พบใบสอบนี้" };
    if (!form) return notFound;
    const viewer = form.pf_customer_id === customerId ? "holder" : form.pg_owner_id && form.pg_owner_id === customerId ? "organizer" : null;
    if (!viewer) return notFound;
    // ใบของกลุ่มที่ผู้จัดเริ่มรอบใหม่/เอาออก/ลบกลุ่มไปแล้ว — กระดาษแผ่นเก่าตรวจไม่ได้ ต้องใช้ใบของรอบปัจจุบัน
    if (form.pf_status === "void") return { status: 410, message: "ใบสอบนี้ถูกยกเลิกแล้ว (ผู้จัดเริ่มรอบสอบใหม่) — ใช้กระดาษใบใหม่ที่ผู้จัดพิมพ์ให้" };

    const entitled = await hasActiveEntitlement(customerId, form.pf_product_id);
    if (viewer === "organizer") {
        if (!form.holder_in_group) return notFound; // สมาชิกออกจากกลุ่มไปแล้ว ผู้จัดไม่มีสิทธิ์แตะผลของเขาอีก
        if (!entitled) return { status: 403, message: "สิทธิ์ชุดข้อสอบนี้ของคุณหมดอายุหรือถูกยกเลิกแล้ว — ต่ออายุก่อนถึงจะตรวจกระดาษของกลุ่มได้" };
    } else if (!entitled && !(form.pf_group_id && form.holder_in_group)) {
        return { status: 403, message: "สิทธิ์ใช้ชุดข้อสอบนี้หมดอายุหรือถูกยกเลิกแล้ว" };
    }
    return { form, viewer };
}

function parseJson(value) {
    return typeof value === "string" ? JSON.parse(value) : value;
}

/** จำนวนวงของแต่ละข้อบนกระดาษคำตอบ — จากใบสอบ (ไม่ใช่จากตัวเลือกปัจจุบัน) ผังจึงไม่เปลี่ยนแม้แอดมินแก้ข้อ */
function formChoiceCounts(form) {
    const questionIds = parseJson(form.pf_question_ids);
    const choiceOrders = parseJson(form.pf_choice_orders);
    return questionIds.map((id) => (choiceOrders[id] || []).length);
}

/**
 * ข้อมูลพิมพ์ชุดข้อสอบของใบสอบ 1 ใบ ตามลำดับที่ตรึงไว้ (ไม่มีเฉลย) — form ต้องมี prod_name / prod_total_score
 * ดึงตามรหัสที่ตรึงไว้ รวมข้อที่แอดมินซ่อนไปแล้วด้วย (สถานะไม่ใช่ active) — ต้องพิมพ์ได้ครบตามลำดับเดิม
 * ไม่งั้นเลขข้อหลังจากนั้นเลื่อนทั้งหมด ข้อที่ถูกซ่อนแสดงเป็นข้อความแจ้งแทนเนื้อหา
 */
async function buildPrintData(form) {
    const questionIds = parseJson(form.pf_question_ids);
    const choiceOrders = parseJson(form.pf_choice_orders);
    const ids = questionIds.length ? questionIds : [""];
    const [[questions], [choices]] = await Promise.all([
        pool.query("SELECT ques_id, ques_text, ques_image_url, ques_score, ques_status FROM tb_questions WHERE ques_id IN (?)", [ids]),
        pool.query("SELECT cho_id, cho_question_id, cho_text, cho_image_url FROM tb_choices WHERE cho_question_id IN (?)", [ids]),
    ]);
    const byId = Object.fromEntries(questions.map((q) => [q.ques_id, q]));
    const choiceById = Object.fromEntries(choices.map((c) => [c.cho_id, c]));

    return {
        code: form.pf_code,
        prod_name: form.prod_name,
        prod_total_score: form.prod_total_score,
        pages: form.pf_pages,
        shuffled: !!form.pf_shuffled,
        variant: form.pf_variant ?? null,
        choice_counts: formChoiceCounts(form),
        questions: questionIds.map((id) => {
            const q = byId[id];
            const removed = !q || q.ques_status !== "active";
            return {
                ques_id: id,
                ques_text: removed ? "(ข้อนี้ถูกนำออกจากชุดข้อสอบแล้ว — ข้ามข้อนี้ได้ ไม่นับคะแนน)" : q.ques_text,
                ques_image_url: removed ? null : q.ques_image_url,
                ques_score: removed ? null : q.ques_score,
                choices: removed
                    ? []
                    : (choiceOrders[id] || [])
                          .map((cid) => choiceById[cid])
                          .filter(Boolean)
                          .map((c) => ({ cho_id: c.cho_id, cho_text: c.cho_text, cho_image_url: c.cho_image_url })),
                reveal: null,
            };
        }),
    };
}

// GET /V1/store/paper-forms/:code/print — ข้อมูลสำหรับพิมพ์ PDF ทั้ง 2 ไฟล์ ตามลำดับที่ตรึงไว้ (ไม่มีเฉลย)
async function getPrintData(req, res, next) {
    try {
        const result = await loadOwnForm(req.customer.cus_id, req.params.code);
        if (!result.form) return res.status(result.status).json({ message: result.message });
        // ตัวโจทย์พิมพ์ได้เฉพาะคนที่ถือสิทธิ์ชุดนั้น — สมาชิกกลุ่มที่ไม่ได้ซื้อใช้ชุดข้อสอบที่ผู้จัดพิมพ์แจก
        if (!(await hasActiveEntitlement(req.customer.cus_id, result.form.pf_product_id))) {
            return res.status(403).json({ message: "ต้องมีสิทธิ์ชุดข้อสอบนี้ถึงจะพิมพ์ชุดข้อสอบได้" });
        }
        res.json(await buildPrintData(result.form));
    } catch (err) {
        next(err);
    }
}

// GET /V1/store/paper-forms/:code — ข้อมูลที่หน้าสแกนต้องใช้อ่านกระดาษ (จำนวนวงต่อข้อ) + ผลตรวจล่าสุด (ถ้ามี)
async function getFormInfo(req, res, next) {
    try {
        const result = await loadOwnForm(req.customer.cus_id, req.params.code);
        if (!result.form) return res.status(result.status).json({ message: result.message });
        const { form } = result;
        const questionIds = parseJson(form.pf_question_ids);
        const choiceOrders = parseJson(form.pf_choice_orders);
        const [[[attempt]], [scans]] = await Promise.all([
            pool.query("SELECT att_id, att_score, att_submitted_at FROM tb_attempts WHERE att_paper_form_id = ?", [form.pf_id]),
            pool.query("SELECT ps_page FROM tb_paper_scans WHERE ps_form_id = ? ORDER BY ps_page", [form.pf_id]),
        ]);
        res.json({
            code: form.pf_code,
            product_id: form.pf_product_id,
            prod_name: form.prod_name,
            pages: form.pf_pages,
            question_count: questionIds.length,
            choice_counts: questionIds.map((id) => (choiceOrders[id] || []).length),
            created_at: form.pf_created_at,
            result: attempt ? { att_id: attempt.att_id, score: Number(attempt.att_score), graded_at: attempt.att_submitted_at } : null,
            scanned_pages: scans.map((r) => r.ps_page),
            // ผู้จัดสแกนแทนสมาชิก: หน้าเว็บบอกว่าเป็นใบของใคร และส่งตรวจแล้วกลับหน้ากลุ่ม (หน้าเฉลยเป็นของสมาชิก เปิดไม่ได้)
            viewer: result.viewer,
            holder_name: [form.holder_fname, form.holder_lname].filter(Boolean).join(" "),
            group: form.pf_group_id ? { id: form.pf_group_id, title: form.pg_title, variant: form.pf_variant } : null,
        });
    } catch (err) {
        next(err);
    }
}

const PAGE_FIELD = /^page_(\d{1,3})$/;

// POST /V1/store/paper-forms/:code/grade (multipart) — ตรวจกระดาษคำตอบ
//   answers  = JSON [ดัชนีตัวเลือก 0.. | null, ...] เรียงตามเลขข้อบนกระดาษ (ยาวเท่าจำนวนข้อในใบสอบ)
//   page_<n> = ภาพที่ดึงตรงแล้วของหน้าที่สแกน (อย่างน้อย 1 หน้า)
//
// อ่านภาพเกิดในเบราว์เซอร์ (lib/paper/omr.ts) ที่นี่ตรวจแค่ "คำตอบ → ถูก/ผิด" จากลำดับที่ตรึงไว้ในใบสอบ — ดัชนี 2
// ของข้อ 37 = ตัวเลือกลำดับที่ 3 ของข้อ 37 *ตอนพิมพ์* ไม่ใช่ลำดับปัจจุบันของชุดข้อสอบ
// ผลเป็นแถว tb_attempts ธรรมดา (att_mode 'paper') · ใบเดิมตรวจแล้ว = แทนผลเดิมในแถวเดิม (ผู้ใช้เลือก)
//
// กติกาที่ตั้งใจ:
// - ข้อที่แอดมินนำออกไปแล้ว (ไม่ active ณ ตอนตรวจ) ไม่นับเลย — ตรงกับที่ชุดข้อสอบที่พิมพ์ใหม่เขียนไว้ว่า "ไม่นับคะแนน"
// - ข้อที่อยู่ในหน้าที่ไม่ได้แนบภาพมาต้องเป็น "ไม่ได้ตอบ" เท่านั้น — คำตอบทุกข้อต้องมีภาพหน้ากระดาษรองรับ
// - คะแนนเต็ม/คะแนนรายข้อใช้ค่าของชุด ณ ตอนตรวจ (เทียบได้กับ "ตอนเริ่มทำ" ของออนไลน์) แล้ว freeze ลงผลนี้
async function gradeForm(req, res, next) {
    const savedFiles = [];
    try {
        const result = await loadOwnForm(req.customer.cus_id, req.params.code);
        if (!result.form) return res.status(result.status).json({ message: result.message });
        const { form } = result;
        const questionIds = parseJson(form.pf_question_ids);
        const choiceOrders = parseJson(form.pf_choice_orders);

        let answers = null;
        try {
            answers = JSON.parse(req.body?.answers ?? "null");
        } catch {
            answers = null;
        }
        if (!Array.isArray(answers) || answers.length !== questionIds.length) {
            return res.status(400).json({ message: "ข้อมูลคำตอบไม่ตรงกับใบสอบนี้ — สแกนใหม่อีกครั้ง" });
        }
        const pageFiles = new Map();
        for (const file of req.files ?? []) {
            const page = Number(PAGE_FIELD.exec(file.fieldname)?.[1] ?? 0);
            if (!page || page > form.pf_pages || pageFiles.has(page)) {
                return res.status(400).json({ message: "ภาพกระดาษคำตอบไม่ถูกต้อง — สแกนใหม่อีกครั้ง" });
            }
            pageFiles.set(page, file);
        }
        if (!pageFiles.size) return res.status(400).json({ message: "ต้องสแกนกระดาษคำตอบอย่างน้อย 1 หน้า" });
        for (let i = 0; i < answers.length; i++) {
            const a = answers[i];
            if (a === null) continue;
            const inRange = Number.isInteger(a) && a >= 0 && a < (choiceOrders[questionIds[i]] || []).length;
            if (!inRange || !pageFiles.has(Math.floor(i / QUESTIONS_PER_PAGE) + 1)) {
                return res.status(400).json({ message: `คำตอบข้อ ${i + 1} ไม่ถูกต้อง — สแกนใหม่อีกครั้ง` });
            }
        }

        const [[questions], [choices]] = await Promise.all([
            pool.query("SELECT ques_id, ques_score FROM tb_questions WHERE ques_id IN (?) AND ques_status = 'active'", [questionIds]),
            pool.query("SELECT cho_id, cho_question_id, cho_is_correct FROM tb_choices WHERE cho_question_id IN (?)", [questionIds]),
        ]);
        const scoreById = new Map(questions.map((q) => [q.ques_id, q.ques_score]));
        const choiceById = new Map(choices.map((c) => [c.cho_id, c]));
        const maxScore = form.prod_total_score; // null = ชุดนี้ไม่ใช้ระบบคะแนน
        let correctCount = 0;
        let earnedScore = 0;
        const rows = [];
        questionIds.forEach((id, i) => {
            if (!scoreById.has(id)) return;
            const order = choiceOrders[id] || [];
            // ตัวเลือกที่แอดมินลบไปหลังพิมพ์ = ตรวจไม่ได้ ถือว่าไม่ได้ตอบ (ไม่เดาว่าลูกค้าหมายถึงอะไร)
            const picked = answers[i] === null ? null : choiceById.get(order[answers[i]]);
            const selected = picked && picked.cho_question_id === id ? picked : null;
            const isCorrect = selected ? !!selected.cho_is_correct : null;
            const score = maxScore === null ? null : scoreById.get(id);
            if (isCorrect) {
                correctCount++;
                earnedScore += Number(score ?? 0);
            }
            rows.push({ id, order, selectedId: selected?.cho_id ?? null, isCorrect, score });
        });
        if (!rows.length) return res.status(400).json({ message: "ข้อสอบในใบนี้ถูกนำออกจากชุดทั้งหมดแล้ว จึงตรวจไม่ได้" });
        const { score, earned } = computeAttemptScore({ maxScore, totalQuestions: rows.length, correctCount, earnedScore });

        // เขียนภาพก่อนเริ่ม transaction — ภาพเสีย/ไม่ใช่ภาพ ตอบ 400 โดยไม่แตะฐานข้อมูลเลย
        for (const [page, file] of pageFiles) {
            try {
                savedFiles.push({ page, name: await saveScanImage(file.buffer, form.pf_id, page) });
            } catch (err) {
                if (err.code === "EACCES" || err.code === "ENOSPC" || err.code === "EPERM") throw err;
                await deleteScanFiles(savedFiles.map((f) => f.name));
                savedFiles.length = 0;
                return res.status(400).json({ message: "อ่านไฟล์ภาพไม่ได้ — สแกนใหม่อีกครั้ง" });
            }
        }

        const conn = await pool.getConnection();
        let attId;
        let replaced = false;
        let oldFiles = [];
        try {
            await conn.beginTransaction();
            // ล็อกใบสอบก่อน — กดส่งซ้ำ/สองแท็บพร้อมกัน ต้องได้ผลเดียว ไม่ใช่สองแถว (UNIQUE กันไว้อีกชั้น)
            await conn.query("SELECT pf_id FROM tb_paper_forms WHERE pf_id = ? FOR UPDATE", [form.pf_id]);
            const [[existing]] = await conn.query("SELECT att_id FROM tb_attempts WHERE att_paper_form_id = ?", [form.pf_id]);
            const questionOrder = JSON.stringify(rows.map((r) => r.id));
            if (existing) {
                attId = existing.att_id;
                replaced = true;
                await conn.query("DELETE FROM tb_attempt_answers WHERE ans_attempt_id = ?", [attId]);
                await conn.query(
                    `UPDATE tb_attempts SET att_question_order = ?, att_max_score = ?, att_total_questions = ?, att_score = ?,
                            att_earned_score = ?, att_started_at = NOW(), att_submitted_at = NOW()
                     WHERE att_id = ?`,
                    [questionOrder, maxScore, rows.length, score.toFixed(2), earned, attId]
                );
            } else {
                attId = await generateId("tb_attempts", "ATT");
                await conn.query(
                    `INSERT INTO tb_attempts
                        (att_id, att_customer_id, att_product_id, att_paper_form_id, att_mode, att_status, att_question_order,
                         att_score, att_earned_score, att_max_score, att_total_questions, att_time_limit_minutes, att_started_at, att_submitted_at)
                     VALUES (?, ?, ?, ?, 'paper', 'submitted', ?, ?, ?, ?, ?, NULL, NOW(), NOW())`,
                    // ผลเป็นของเจ้าของใบเสมอ — ผู้จัดสแกนแทน ผลต้องเข้าประวัติของสมาชิกคนนั้น ไม่ใช่ของผู้จัด
                    [attId, form.pf_customer_id, form.pf_product_id, form.pf_id, questionOrder, score.toFixed(2), earned, maxScore, rows.length]
                );
            }
            const answerIds = await generateIds("tb_attempt_answers", "ANS", rows.length);
            await conn.query(
                `INSERT INTO tb_attempt_answers
                    (ans_id, ans_attempt_id, ans_question_id, ans_selected_choice_id, ans_choice_order, ans_is_correct, ans_score)
                 VALUES ?`,
                [rows.map((r, i) => [answerIds[i], attId, r.id, r.selectedId, JSON.stringify(r.order), r.isCorrect, r.score])]
            );
            await conn.query(
                "UPDATE tb_attempt_answers SET ans_answered_at = NOW() WHERE ans_attempt_id = ? AND ans_selected_choice_id IS NOT NULL",
                [attId]
            );
            const [old] = await conn.query("SELECT ps_file FROM tb_paper_scans WHERE ps_form_id = ?", [form.pf_id]);
            oldFiles = old.map((r) => r.ps_file);
            await conn.query("DELETE FROM tb_paper_scans WHERE ps_form_id = ?", [form.pf_id]);
            await conn.query("INSERT INTO tb_paper_scans (ps_form_id, ps_page, ps_file) VALUES ?", [
                savedFiles.map((f) => [form.pf_id, f.page, f.name]),
            ]);
            await conn.query("UPDATE tb_paper_forms SET pf_status = 'graded' WHERE pf_id = ?", [form.pf_id]);
            await conn.commit();
        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }
        savedFiles.length = 0; // บันทึกสำเร็จแล้ว ไฟล์ใหม่เป็นของจริง ห้ามลบใน catch ข้างล่าง
        deleteScanFiles(oldFiles); // ภาพชุดเดิม — ลบหลัง commit (ล้มก็แค่ไฟล์ค้าง sweep ตามอายุไฟล์เก็บให้)

        res.status(replaced ? 200 : 201).json({
            att_id: attId,
            replaced,
            score: Number(score.toFixed(2)),
            correct_count: correctCount,
            total_questions: rows.length,
            viewer: result.viewer,
        });
    } catch (err) {
        if (savedFiles.length) await deleteScanFiles(savedFiles.map((f) => f.name));
        next(err);
    }
}

// GET /V1/store/paper-forms/:code/scans/:page — ภาพกระดาษคำตอบที่สแกนไว้ (เจ้าของใบสอบเท่านั้น)
async function getScanImage(req, res, next) {
    try {
        const result = await loadOwnForm(req.customer.cus_id, req.params.code);
        if (!result.form) return res.status(result.status).json({ message: result.message });
        const [[scan]] = await pool.query("SELECT ps_file FROM tb_paper_scans WHERE ps_form_id = ? AND ps_page = ?", [
            result.form.pf_id,
            Number(req.params.page) || 0,
        ]);
        const gone = { message: "ไม่พบภาพหน้านี้ (ภาพเก็บไว้ 90 วันหลังสแกน)" };
        if (!scan) return res.status(404).json(gone);
        res.set("Cache-Control", "private, no-store");
        res.type("image/webp");
        res.sendFile(scanPath(scan.ps_file), (err) => {
            if (err && !res.headersSent) res.status(404).json(gone);
        });
    } catch (err) {
        next(err);
    }
}

module.exports = {
    createForm,
    listMyForms,
    getPrintData,
    getFormInfo,
    gradeForm,
    getScanImage,
    // ใช้ร่วมกับใบสอบของกลุ่ม (paperGroup.controller.js)
    loadPrintableQuestions,
    makeFormOrder,
    insertForm,
    buildPrintData,
    formChoiceCounts,
    parseJson,
    MAX_CHOICES_ON_PAPER,
};
