const fs = require("fs/promises");
const path = require("path");
const sharp = require("sharp");
const pool = require("../config/db");
const { generateIds } = require("../utils/generateId");
const { parseQuestionFile } = require("../utils/parseQuestionFile");
const { generateQuestionTemplate } = require("../utils/generateQuestionTemplate");
const { generateQuestionExport } = require("../utils/generateQuestionExport");
const { resolveUploadPath } = require("../utils/uploads");

const QUESTION_IMAGE_DIR = path.join(__dirname, "..", "..", "uploads", "questions");
const CHOICE_IMAGE_DIR = path.join(__dirname, "..", "..", "uploads", "choices");

async function downloadTemplate(req, res, next) {
    try {
        const buffer = await generateQuestionTemplate();
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", "attachment; filename=\"template_import_questions.xlsx\"");
        res.send(buffer);
    } catch (err) {
        next(err);
    }
}

async function getAll(req, res, next) {
    try {
        const limit = Number(req.query.limit) || 10;
        const offset = Number(req.query.offset) || 0;
        const search = `%${req.query.search ?? ""}%`;

        const [questions] = await pool.query(
            `SELECT q.ques_id, q.ques_text, q.ques_explanation, q.ques_image_url, q.ques_order, t.tpc_name AS ques_topic_name
             FROM tb_questions q
             LEFT JOIN tb_topics t ON t.tpc_id = q.ques_topic_id
             WHERE q.ques_product_id = ? AND q.ques_text LIKE ?
             ORDER BY q.ques_order
             LIMIT ? OFFSET ?`,
            [req.params.productId, search, limit, offset]
        );
        const [[{ total }]] = await pool.query(
            "SELECT COUNT(*) AS total FROM tb_questions WHERE ques_product_id = ? AND ques_text LIKE ?",
            [req.params.productId, search]
        );

        if (questions.length === 0) return res.json({ data: [], total });

        const [choices] = await pool.query(
            `SELECT cho_id, cho_question_id, cho_text, cho_is_correct, cho_wrong_reason, cho_image_url, cho_order
             FROM tb_choices WHERE cho_question_id IN (?) ORDER BY cho_order`,
            [questions.map((q) => q.ques_id)]
        );

        const data = questions.map((q) => ({
            ...q,
            choices: choices.filter((c) => c.cho_question_id === q.ques_id),
        }));

        res.json({ data, total });
    } catch (err) {
        next(err);
    }
}

// ส่งออกคำถามทั้งหมดของ product เป็นไฟล์ .xlsx รูปแบบคอลัมน์เดียวกับเทมเพลตนำเข้าเป๊ะ (ใช้ HEADER_COLUMNS
// เดียวกัน ดู generateQuestionExport.js) เพื่อให้ export แล้วนำกลับไป import ใหม่ได้ทันที เช่น ย้ายชุดข้อสอบ
// ไปอีก product, แก้ไขนอกระบบทีละหลายข้อสะดวกกว่าฟอร์มทีละข้อ, หรือสำรองไว้ก่อนแก้ไขใหญ่
// คอลัมน์ "บทความร่วม" จะว่างเสมอ — ดูเหตุผลที่ comment บนสุดของ generateQuestionExport.js
async function exportQuestions(req, res, next) {
    try {
        const [[product]] = await pool.query(
            "SELECT prod_id, prod_name FROM tb_products WHERE prod_id = ?",
            [req.params.productId]
        );
        if (!product) return res.status(404).json({ message: "ไม่พบชุดข้อสอบนี้" });

        const [questions] = await pool.query(
            `SELECT q.ques_id, q.ques_text, q.ques_explanation, q.ques_image_url, t.tpc_name AS ques_topic_name
             FROM tb_questions q
             LEFT JOIN tb_topics t ON t.tpc_id = q.ques_topic_id
             WHERE q.ques_product_id = ?
             ORDER BY q.ques_order`,
            [req.params.productId]
        );
        if (questions.length === 0) return res.status(400).json({ message: "ชุดข้อสอบนี้ยังไม่มีคำถาม ไม่มีอะไรให้ส่งออก" });

        const [choices] = await pool.query(
            `SELECT cho_id, cho_question_id, cho_text, cho_is_correct, cho_wrong_reason, cho_image_url
             FROM tb_choices WHERE cho_question_id IN (?) ORDER BY cho_order`,
            [questions.map((q) => q.ques_id)]
        );

        // รูปประกอบทั้งหมดถูกบันทึกเป็น .webp เสมอ (ดู saveResizedImage) กำหนด extension ตรงๆ ได้เลย ไม่ต้อง
        // เดาจากนามสกุลไฟล์ — ไฟล์หายจาก disk (ถูกลบมือ/ย้ายเซิร์ฟเวอร์) ก็แค่ข้ามรูปนั้นไป ไม่ทำให้ export ทั้งชุดพัง
        async function loadImage(url) {
            if (!url) return null;
            try {
                return { buffer: await fs.readFile(resolveUploadPath(url)), extension: "webp" };
            } catch {
                return null;
            }
        }

        const exportRows = [];
        for (const q of questions) {
            const questionChoices = choices.filter((c) => c.cho_question_id === q.ques_id);
            exportRows.push({
                questionText: q.ques_text,
                explanation: q.ques_explanation,
                topicName: q.ques_topic_name,
                image: await loadImage(q.ques_image_url),
                choices: await Promise.all(questionChoices.map(async (c) => ({
                    text: c.cho_text,
                    isCorrect: !!c.cho_is_correct,
                    wrongReason: c.cho_wrong_reason,
                    image: await loadImage(c.cho_image_url),
                }))),
            });
        }

        const buffer = await generateQuestionExport(exportRows);
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", `attachment; filename="export_questions_${product.prod_id}.xlsx"`);
        res.send(buffer);
    } catch (err) {
        next(err);
    }
}

async function getOne(req, res, next) {
    try {
        const [[question]] = await pool.query(
            `SELECT q.ques_id, q.ques_product_id, q.ques_text, q.ques_explanation, q.ques_image_url,
                    q.ques_topic_id, q.ques_order
             FROM tb_questions q WHERE q.ques_id = ?`,
            [req.params.id]
        );
        if (!question) return res.status(404).json({ message: "ไม่พบคำถามนี้" });

        const [choices] = await pool.query(
            `SELECT cho_id, cho_text, cho_is_correct, cho_wrong_reason, cho_image_url, cho_order
             FROM tb_choices WHERE cho_question_id = ? ORDER BY cho_order`,
            [question.ques_id]
        );

        res.json({ ...question, choices });
    } catch (err) {
        next(err);
    }
}

// เหมือนกฎที่ parseQuestionFile.js ใช้ตอน import: ต้องมีอย่างน้อย 2 ตัวเลือก และมีตัวเลือกที่ถูกพอดี 1 ข้อ
function validateChoices(choices) {
    if (!Array.isArray(choices) || choices.length < 2) {
        return "ต้องมีตัวเลือกอย่างน้อย 2 ข้อ";
    }
    if (choices.some((c) => !c.cho_text?.trim())) {
        return "กรุณากรอกข้อความของทุกตัวเลือก";
    }
    const correctCount = choices.filter((c) => c.cho_is_correct).length;
    if (correctCount !== 1) {
        return "ต้องเลือกตัวเลือกที่ถูก 1 ข้อเท่านั้น";
    }
    return null;
}

// insert คำถาม 1 ข้อ + ตัวเลือกของมัน โดยรับ id ที่จองไว้ล่วงหน้ามาแล้ว (ไม่เรียก generateId ในนี้)
// เพราะตอนสร้างหลายข้อพร้อมกัน (createBatch/importFile) ต้องจองไอดีเป็นชุดเดียวก่อนเข้าลูป
// ไม่ใช่ขอทีละอันต่อคำถาม/ตัวเลือก — ลดจำนวน round-trip ไป DB ได้มหาศาลตอนมีข้อมูลเยอะ
async function insertQuestionWithChoices(conn, productId, order, quesId, choiceIds, { ques_text, ques_explanation, ques_topic_id, choices }) {
    await conn.query(
        `INSERT INTO tb_questions (ques_id, ques_product_id, ques_topic_id, ques_text, ques_explanation, ques_order)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [quesId, productId, ques_topic_id || null, ques_text, ques_explanation || null, order]
    );

    for (let ci = 0; ci < choices.length; ci++) {
        const c = choices[ci];
        await conn.query(
            `INSERT INTO tb_choices (cho_id, cho_question_id, cho_text, cho_is_correct, cho_wrong_reason, cho_order)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [choiceIds[ci], quesId, c.cho_text, !!c.cho_is_correct, c.cho_is_correct ? null : (c.cho_wrong_reason || null), ci]
        );
    }
}

async function create(req, res, next) {
    const conn = await pool.getConnection();
    try {
        const { ques_text, choices } = req.body;
        if (!ques_text?.trim()) return res.status(400).json({ message: "กรุณากรอกคำถาม" });

        const choicesError = validateChoices(choices);
        if (choicesError) return res.status(400).json({ message: choicesError });

        const [[product]] = await pool.query("SELECT prod_id FROM tb_products WHERE prod_id = ?", [
            req.params.productId,
        ]);
        if (!product) return res.status(404).json({ message: "ไม่พบชุดข้อสอบนี้" });

        const [[{ maxOrder }]] = await pool.query(
            "SELECT COALESCE(MAX(ques_order), -1) AS maxOrder FROM tb_questions WHERE ques_product_id = ?",
            [req.params.productId]
        );

        const [ques_id] = await generateIds("tb_questions", "QUE", 1);
        const choiceIds = await generateIds("tb_choices", "CHO", choices.length);

        await conn.beginTransaction();
        await insertQuestionWithChoices(conn, req.params.productId, maxOrder + 1, ques_id, choiceIds, req.body);
        await conn.commit();
        // คืน choice_ids ตามลำดับเดียวกับ choices ที่ส่งมา ให้ frontend อัปโหลดรูปตัวเลือกต่อได้ (เหมือน ques_id)
        res.status(201).json({ ques_id, choice_ids: choiceIds });
    } catch (err) {
        await conn.rollback();
        next(err);
    } finally {
        conn.release();
    }
}

// สร้างหลายคำถามพร้อมกันจากหน้า "สร้างคำถาม" (กดปุ่ม + เพิ่มคำถาม แล้วบันทึกทีเดียว)
// validate ทุกข้อก่อน ถ้ามีข้อไหนผิดแม้ข้อเดียวจะไม่ insert อะไรเลย (all-or-nothing เหมือน import CSV)
async function createBatch(req, res, next) {
    const conn = await pool.getConnection();
    try {
        const { questions } = req.body;
        if (!Array.isArray(questions) || questions.length === 0) {
            return res.status(400).json({ message: "ไม่พบคำถามที่จะบันทึก" });
        }

        const errors = [];
        questions.forEach((q, i) => {
            if (!q.ques_text?.trim()) errors.push(`ข้อที่ ${i + 1}: กรุณากรอกคำถาม`);
            const choicesError = validateChoices(q.choices);
            if (choicesError) errors.push(`ข้อที่ ${i + 1}: ${choicesError}`);
        });
        if (errors.length > 0) {
            return res.status(422).json({ message: "พบข้อผิดพลาด กรุณาแก้ไขก่อนบันทึก", errors });
        }

        const [[product]] = await pool.query("SELECT prod_id FROM tb_products WHERE prod_id = ?", [
            req.params.productId,
        ]);
        if (!product) return res.status(404).json({ message: "ไม่พบชุดข้อสอบนี้" });

        const [[{ maxOrder }]] = await pool.query(
            "SELECT COALESCE(MAX(ques_order), -1) AS maxOrder FROM tb_questions WHERE ques_product_id = ?",
            [req.params.productId]
        );

        const quesIds = await generateIds("tb_questions", "QUE", questions.length);
        const totalChoices = questions.reduce((sum, q) => sum + q.choices.length, 0);
        const allChoiceIds = await generateIds("tb_choices", "CHO", totalChoices);

        await conn.beginTransaction();
        let cursor = 0;
        const choiceIdsByQuestion = [];
        for (let i = 0; i < questions.length; i++) {
            const q = questions[i];
            const choiceIds = allChoiceIds.slice(cursor, cursor + q.choices.length);
            cursor += q.choices.length;
            choiceIdsByQuestion.push(choiceIds);
            await insertQuestionWithChoices(conn, req.params.productId, maxOrder + 1 + i, quesIds[i], choiceIds, q);
        }
        await conn.commit();

        // คืน ques_ids/choice_ids ตามลำดับเดียวกับ questions/choices ที่ส่งมา ให้ฝั่ง frontend map ไปแนบรูปทีละข้อ/
        // ตัวเลือกได้ (อัปโหลดรูปแยก request อยู่แล้วเหมือนหน้าแก้ไข — ต้องรู้ id ก่อนถึงจะอัปโหลดได้)
        res.status(201).json({
            message: `บันทึกสำเร็จ ${questions.length} ข้อ`,
            created: questions.length,
            ques_ids: quesIds,
            choice_ids: choiceIdsByQuestion,
        });
    } catch (err) {
        await conn.rollback();
        next(err);
    } finally {
        conn.release();
    }
}

async function update(req, res, next) {
    const conn = await pool.getConnection();
    try {
        const { ques_text, ques_explanation, ques_topic_id, choices } = req.body;
        if (!ques_text?.trim()) return res.status(400).json({ message: "กรุณากรอกคำถาม" });

        const choicesError = validateChoices(choices);
        if (choicesError) return res.status(400).json({ message: choicesError });

        await conn.beginTransaction();

        const [result] = await conn.query(
            `UPDATE tb_questions SET ques_text = ?, ques_explanation = ?, ques_topic_id = ?
             WHERE ques_id = ?`,
            [ques_text, ques_explanation || null, ques_topic_id || null, req.params.id]
        );
        if (result.affectedRows === 0) {
            await conn.rollback();
            return res.status(404).json({ message: "ไม่พบคำถามนี้" });
        }

        // แก้ไขตัวเลือกในที่เดิม (คง cho_id ไว้) แทนลบทั้งหมดแล้วสร้างใหม่ทุกครั้งแบบเดิม — เดิมทำแบบนั้นแล้ว
        // เจอปัญหาจริง: tb_attempt_answers ผูก FK กับ cho_id ตรงๆ (ans_selected_choice_id) พอมีลูกค้าตอบ
        // คำถามนี้ไปแล้วแม้ข้อเดียว การลบ+สร้างใหม่ทุกตัวเลือกจะชน FK (ER_ROW_IS_REFERENCED_2) ทำให้แก้ไข
        // คำถามนั้นไม่ได้อีกเลย — ปิดทาง "ลูกค้าแจ้งปัญหา → แอดมินแก้เฉลย" ทันทีที่ product เริ่มมีคนใช้จริง
        // ตอนนี้: frontend ส่ง cho_id เดิมกลับมาด้วยถ้าเป็นตัวเลือกที่มีอยู่แล้ว (null = เพิ่งเพิ่มใหม่ในฟอร์ม)
        // ตัวเลือกที่มี cho_id ตรงกับของเดิม → UPDATE ในที่เดิม, ไม่มี cho_id หรือไม่ตรง → INSERT ใหม่,
        // ตัวเลือกเดิมที่ไม่ถูกส่งกลับมาเลย → ถือว่าแอดมินลบออกจริง → DELETE เฉพาะแถวนั้น (ถ้าแถวนั้นมีคนตอบ
        // ไปแล้วจะยัง reject ด้วย FK เหมือนเดิม แต่เป็นพฤติกรรมที่ถูกต้องแล้ว — ลบตัวเลือกที่มีคนตอบแล้วจริงๆ
        // ไม่ได้ ไม่ใช่บั๊ก — catch ไว้ด้านล่างเพื่อแจ้ง error ที่อ่านเข้าใจได้แทน SQL error ดิบ)
        //
        // cho_id ที่ frontend ส่งมาห้ามเชื่อทันที ต้อง whitelist กับตัวเลือกเดิมของคำถามนี้เท่านั้น (กัน client
        // ส่ง cho_id ของคำถามอื่นมาสวมสิทธิ์แก้ไขข้าม question) — cho_image_url ก็ยัง whitelist เหมือนเดิม
        // กันช่องโหว่ path traversal ตอน carry-over รูป
        const [oldChoices] = await conn.query("SELECT cho_id, cho_image_url FROM tb_choices WHERE cho_question_id = ?", [req.params.id]);
        const oldChoiceIds = new Set(oldChoices.map((c) => c.cho_id));
        const existingImageUrls = new Set(oldChoices.map((c) => c.cho_image_url).filter(Boolean));
        const sanitizedChoices = choices.map((c) => ({
            cho_id: c.cho_id && oldChoiceIds.has(c.cho_id) ? c.cho_id : null,
            cho_text: c.cho_text,
            cho_is_correct: !!c.cho_is_correct,
            cho_wrong_reason: c.cho_is_correct ? null : (c.cho_wrong_reason || null),
            cho_image_url: c.cho_image_url && existingImageUrls.has(c.cho_image_url) ? c.cho_image_url : null,
        }));

        const keptChoiceIds = new Set(sanitizedChoices.map((c) => c.cho_id).filter(Boolean));
        const keptImageUrls = new Set(sanitizedChoices.map((c) => c.cho_image_url).filter(Boolean));

        const removedChoiceIds = oldChoices.map((c) => c.cho_id).filter((id) => !keptChoiceIds.has(id));
        if (removedChoiceIds.length > 0) {
            await conn.query("DELETE FROM tb_choices WHERE cho_id IN (?)", [removedChoiceIds]);
        }

        const newChoiceCount = sanitizedChoices.filter((c) => !c.cho_id).length;
        const newChoiceIds = newChoiceCount > 0 ? await generateIds("tb_choices", "CHO", newChoiceCount) : [];
        let newIdCursor = 0;
        const finalChoiceIds = [];

        for (let ci = 0; ci < sanitizedChoices.length; ci++) {
            const c = sanitizedChoices[ci];
            if (c.cho_id) {
                await conn.query(
                    `UPDATE tb_choices SET cho_text = ?, cho_is_correct = ?, cho_wrong_reason = ?, cho_image_url = ?, cho_order = ?
                     WHERE cho_id = ?`,
                    [c.cho_text, c.cho_is_correct, c.cho_wrong_reason, c.cho_image_url, ci, c.cho_id]
                );
                finalChoiceIds.push(c.cho_id);
            } else {
                const newId = newChoiceIds[newIdCursor++];
                await conn.query(
                    `INSERT INTO tb_choices (cho_id, cho_question_id, cho_text, cho_is_correct, cho_wrong_reason, cho_image_url, cho_order)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [newId, req.params.id, c.cho_text, c.cho_is_correct, c.cho_wrong_reason, c.cho_image_url, ci]
                );
                finalChoiceIds.push(newId);
            }
        }

        await conn.commit();
        await Promise.all(
            oldChoices
                .filter((c) => c.cho_image_url && !keptImageUrls.has(c.cho_image_url))
                .map((c) => fs.unlink(resolveUploadPath(c.cho_image_url)).catch(() => {}))
        );
        res.json({ message: "แก้ไขคำถามสำเร็จ", choice_ids: finalChoiceIds });
    } catch (err) {
        await conn.rollback();
        if (err.code === "ER_ROW_IS_REFERENCED_2" || err.code === "ER_ROW_IS_REFERENCED") {
            return res.status(409).json({ message: "ไม่สามารถลบตัวเลือกนี้ได้ เพราะมีคนตอบคำถามนี้ไปแล้ว ลองแก้ไขข้อความของตัวเลือกแทนการลบ" });
        }
        next(err);
    } finally {
        conn.release();
    }
}

// resize + บีบเป็น webp เหมือน prod_cover_url แต่ใช้ fit:"inside" เพราะรูปประกอบโจทย์/ตัวเลือก (ตาราง/กราฟ/รูปทรง)
// ไม่ควรถูกครอปเป็นสี่เหลี่ยมจัตุรัส แค่จำกัดขนาดสูงสุดไว้กันไฟล์ใหญ่เกินจำเป็น — ใช้ร่วมกันทั้งรูปคำถาม
// และรูปตัวเลือกเพราะ logic เหมือนกันทุกจุด ต่างแค่ตาราง/คอลัมน์/โฟลเดอร์ปลายทาง
// table/idColumn/imageColumn/urlDir มาจาก call site ที่ hardcode ไว้เท่านั้น (ไม่ใช่ input จาก request)
// จึงปลอดภัยจาก SQL injection แม้จะประกอบ query ด้วย string interpolation
async function saveResizedImage({ table, idColumn, imageColumn, urlDir, dir, id, file, notFoundMessage }) {
    const [rows] = await pool.query(`SELECT ${imageColumn} FROM ${table} WHERE ${idColumn} = ?`, [id]);
    if (!rows[0]) {
        const err = new Error(notFoundMessage);
        err.status = 404;
        throw err;
    }
    const oldImageUrl = rows[0][imageColumn];

    await fs.mkdir(dir, { recursive: true });

    const filename = `${Date.now()}-${Math.round(Math.random() * 1e9)}.webp`;
    await sharp(file.buffer)
        .resize(1000, 1000, { fit: "inside", withoutEnlargement: true })
        .webp({ quality: 80 })
        .toFile(path.join(dir, filename));

    const url = `/uploads/${urlDir}/${filename}`;
    await pool.query(`UPDATE ${table} SET ${imageColumn} = ? WHERE ${idColumn} = ?`, [url, id]);

    if (oldImageUrl) {
        await fs.unlink(resolveUploadPath(oldImageUrl)).catch(() => {});
    }

    return url;
}

function saveImageForQuestion(questionId, file) {
    return saveResizedImage({
        table: "tb_questions", idColumn: "ques_id", imageColumn: "ques_image_url",
        urlDir: "questions", dir: QUESTION_IMAGE_DIR, id: questionId, file,
        notFoundMessage: "ไม่พบคำถามนี้",
    });
}

function saveImageForChoice(choiceId, file) {
    return saveResizedImage({
        table: "tb_choices", idColumn: "cho_id", imageColumn: "cho_image_url",
        urlDir: "choices", dir: CHOICE_IMAGE_DIR, id: choiceId, file,
        notFoundMessage: "ไม่พบตัวเลือกนี้",
    });
}

async function uploadImage(req, res, next) {
    try {
        if (!req.file) return res.status(400).json({ message: "ไม่พบไฟล์รูปภาพ" });
        const ques_image_url = await saveImageForQuestion(req.params.id, req.file);
        res.json({ ques_image_url });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ message: err.message });
        next(err);
    }
}

async function removeImage(req, res, next) {
    try {
        const [rows] = await pool.query("SELECT ques_image_url FROM tb_questions WHERE ques_id = ?", [req.params.id]);
        if (!rows[0]) return res.status(404).json({ message: "ไม่พบคำถามนี้" });

        await pool.query("UPDATE tb_questions SET ques_image_url = NULL WHERE ques_id = ?", [req.params.id]);
        if (rows[0].ques_image_url) {
            await fs.unlink(resolveUploadPath(rows[0].ques_image_url)).catch(() => {});
        }
        res.json({ message: "ลบรูปภาพประกอบโจทย์แล้ว" });
    } catch (err) {
        next(err);
    }
}

async function uploadChoiceImage(req, res, next) {
    try {
        if (!req.file) return res.status(400).json({ message: "ไม่พบไฟล์รูปภาพ" });
        const cho_image_url = await saveImageForChoice(req.params.choiceId, req.file);
        res.json({ cho_image_url });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ message: err.message });
        next(err);
    }
}

async function removeChoiceImage(req, res, next) {
    try {
        const [rows] = await pool.query("SELECT cho_image_url FROM tb_choices WHERE cho_id = ?", [req.params.choiceId]);
        if (!rows[0]) return res.status(404).json({ message: "ไม่พบตัวเลือกนี้" });

        await pool.query("UPDATE tb_choices SET cho_image_url = NULL WHERE cho_id = ?", [req.params.choiceId]);
        if (rows[0].cho_image_url) {
            await fs.unlink(resolveUploadPath(rows[0].cho_image_url)).catch(() => {});
        }
        res.json({ message: "ลบรูปภาพตัวเลือกแล้ว" });
    } catch (err) {
        next(err);
    }
}

async function remove(req, res, next) {
    try {
        // เก็บ path รูปคำถาม+รูปตัวเลือกไว้ก่อนลบ เพราะ ON DELETE CASCADE บน tb_choices จะลบแถวทิ้งไปเลย
        // ถ้าไม่ query เก็บไว้ก่อนจะไม่มีทางรู้ path ไฟล์เพื่อไปลบตามทีหลัง
        const [[quesRow]] = await pool.query("SELECT ques_image_url FROM tb_questions WHERE ques_id = ?", [req.params.id]);
        const [choiceRows] = await pool.query(
            "SELECT cho_image_url FROM tb_choices WHERE cho_question_id = ? AND cho_image_url IS NOT NULL",
            [req.params.id]
        );

        // ลบคำถามได้เลย — tb_choices ผูก ON DELETE CASCADE ไว้แล้ว ตัวเลือกจะหายตามไปเองโดยไม่ต้องลบมือ
        await pool.query("DELETE FROM tb_questions WHERE ques_id = ?", [req.params.id]);

        // ลบไฟล์รูปคำถาม+รูปตัวเลือกทั้งหมดทิ้งด้วย ไม่ให้ค้างอยู่ใน uploads/ เปล่าๆ หลังลบคำถาม
        if (quesRow?.ques_image_url) {
            await fs.unlink(resolveUploadPath(quesRow.ques_image_url)).catch(() => {});
        }
        await Promise.all(choiceRows.map((r) => fs.unlink(resolveUploadPath(r.cho_image_url)).catch(() => {})));

        res.status(204).end();
    } catch (err) {
        if (err.code === "ER_ROW_IS_REFERENCED_2" || err.code === "ER_ROW_IS_REFERENCED") {
            return res.status(409).json({ message: "ไม่สามารถลบคำถามนี้ได้ เพราะมีการทำข้อสอบผูกอยู่แล้ว" });
        }
        next(err);
    }
}

// ลบหลายข้อพร้อมกัน (ติ๊กเลือกจากหน้ารายการคำถาม) — DELETE ... WHERE ques_id IN (?) เป็น statement เดียว
// ถ้ามีข้อไหนติด RESTRICT (มีคนทำข้อสอบไปแล้ว) ทั้ง statement จะ rollback หมด ไม่ลบบางส่วนค้างไว้ครึ่งๆ
// กลางๆ — เหมือนพฤติกรรม remove() เดี่ยวๆ แค่ขยายเป็นหลายข้อ
async function removeBatch(req, res, next) {
    try {
        const { ques_ids } = req.body;
        if (!Array.isArray(ques_ids) || ques_ids.length === 0) {
            return res.status(400).json({ message: "กรุณาเลือกคำถามที่จะลบ" });
        }

        const [quesRows] = await pool.query(
            "SELECT ques_image_url FROM tb_questions WHERE ques_id IN (?) AND ques_image_url IS NOT NULL",
            [ques_ids]
        );
        const [choiceRows] = await pool.query(
            "SELECT cho_image_url FROM tb_choices WHERE cho_question_id IN (?) AND cho_image_url IS NOT NULL",
            [ques_ids]
        );

        const [result] = await pool.query("DELETE FROM tb_questions WHERE ques_id IN (?)", [ques_ids]);

        await Promise.all([
            ...quesRows.map((r) => fs.unlink(resolveUploadPath(r.ques_image_url)).catch(() => {})),
            ...choiceRows.map((r) => fs.unlink(resolveUploadPath(r.cho_image_url)).catch(() => {})),
        ]);

        res.json({ message: `ลบคำถาม ${result.affectedRows} ข้อสำเร็จ` });
    } catch (err) {
        if (err.code === "ER_ROW_IS_REFERENCED_2" || err.code === "ER_ROW_IS_REFERENCED") {
            return res.status(409).json({ message: "ไม่สามารถลบได้ เพราะมีคำถามบางข้อที่เลือกมีการทำข้อสอบผูกอยู่แล้ว" });
        }
        next(err);
    }
}

// เก็บสถานะงาน import ไว้ใน memory (jobId -> { processed, total, done, error, message })
// ให้ frontend poll ดูความคืบหน้าได้แบบ real-time ระหว่าง insert หลายร้อย/พันแถว — ไม่ต้องใช้
// WebSocket/SSE เพราะแอปนี้รันโปรเซสเดียว ของหายได้ถ้า server restart กลางทาง ยอมรับได้เพราะงาน
// ใช้เวลาไม่กี่วินาที ลบทิ้งเองหลัง done ไปแล้วสักพักกันโตค้างใน memory
const importJobs = new Map();
const JOB_TTL_AFTER_DONE_MS = 60_000;

function createImportJob(total) {
    const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    importJobs.set(jobId, {
        processed: 0, total, done: false, error: null, message: null, imported: 0,
        cancelRequested: false, cancelled: false,
    });
    return jobId;
}

function finishJob(jobId, patch) {
    const job = importJobs.get(jobId);
    if (!job) return;
    Object.assign(job, patch, { done: true });
    setTimeout(() => importJobs.delete(jobId), JOB_TTL_AFTER_DONE_MS);
}

// insert คำถามทั้งหมดจริงๆ ทำงานเบื้องหลังหลังตอบ response ไปแล้ว (ไม่ await ตอนเรียกจาก importFile)
// อัปเดต job.processed ทีละคำถามให้ endpoint สถานะอ่านไปแสดง progress ได้
async function runImportJob(jobId, productId, categoryId, questions) {
    const job = importJobs.get(jobId);
    if (job.cancelRequested) {
        finishJob(jobId, { cancelled: true, message: "ยกเลิกการนำเข้าแล้ว ไม่มีข้อมูลถูกบันทึก" });
        return;
    }

    const conn = await pool.getConnection();
    try {
        // สร้าง ID ล่วงหน้านอก transaction ได้ปกติ — เป็นแค่การจองเลขจาก counter แยกตาราง
        // ถ้ายกเลิก/rollback ทีหลัง เลขที่จองไปจะเสียเปล่า (มีช่องว่างในลำดับ) แต่ไม่กระทบความถูกต้องของข้อมูล
        const topicNames = [...new Set(questions.map((q) => q.topicName).filter(Boolean))];
        const quesIds = await generateIds("tb_questions", "QUE", questions.length);
        const totalChoices = questions.reduce((sum, q) => sum + q.choices.length, 0);
        const choiceIds = await generateIds("tb_choices", "CHO", totalChoices);

        await conn.beginTransaction();

        // เช็คคำขอยกเลิกก่อนเริ่มแตะ DB จริงเลย (รวมถึงก่อนสร้างหมวดหมู่ใหม่) กันเสียเวลาสร้างอะไรที่ต้อง rollback ทิ้งอยู่ดี
        if (job.cancelRequested) {
            await conn.rollback();
            finishJob(jobId, { cancelled: true, message: "ยกเลิกการนำเข้าแล้ว ไม่มีข้อมูลถูกบันทึก" });
            return;
        }

        // สร้างหมวดหมู่คำถามใหม่ (ถ้ามี) ในธุรกรรมเดียวกับการ insert คำถาม — ถ้ายกเลิก/error แล้ว rollback
        // หมวดหมู่ที่เพิ่งสร้างจะหายไปด้วย ไม่ทิ้งหมวดหมู่ค้างที่ไม่มีคำถามผูกอยู่เลย
        const topicIdByName = {};
        if (topicNames.length > 0) {
            const [existing] = await conn.query(
                "SELECT tpc_id, tpc_name FROM tb_topics WHERE tpc_name IN (?) AND tpc_category_id <=> ?",
                [topicNames, categoryId]
            );
            existing.forEach((t) => { topicIdByName[t.tpc_name] = t.tpc_id; });

            const missingNames = topicNames.filter((n) => !topicIdByName[n]);
            if (missingNames.length > 0) {
                const newTopicIds = await generateIds("tb_topics", "TPC", missingNames.length);
                for (let i = 0; i < missingNames.length; i++) {
                    await conn.query("INSERT INTO tb_topics (tpc_id, tpc_name, tpc_category_id) VALUES (?, ?, ?)", [
                        newTopicIds[i], missingNames[i], categoryId,
                    ]);
                    topicIdByName[missingNames[i]] = newTopicIds[i];
                }
            }
        }

        let choiceCursor = 0;
        const pendingChoiceImages = []; // [{ cho_id, image }] — แนบไฟล์จริงหลัง commit เหมือนรูปคำถาม
        for (let i = 0; i < questions.length; i++) {
            // เช็คก่อน insert แต่ละข้อ — ถ้ามีคำขอยกเลิกระหว่างทาง rollback transaction ทั้งหมดทันที
            // ไม่ commit สิ่งที่ insert ไปแล้วบางส่วน กันข้อมูลค้างครึ่งๆ กลางๆ
            if (job.cancelRequested) {
                await conn.rollback();
                finishJob(jobId, { cancelled: true, message: "ยกเลิกการนำเข้าแล้ว ไม่มีข้อมูลถูกบันทึก" });
                return;
            }

            const q = questions[i];
            const ques_id = quesIds[i];
            const ques_topic_id = q.topicName ? topicIdByName[q.topicName] : null;
            await conn.query(
                `INSERT INTO tb_questions (ques_id, ques_product_id, ques_topic_id, ques_text, ques_explanation, ques_order)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [ques_id, productId, ques_topic_id, q.questionText, q.explanation, i]
            );

            for (let ci = 0; ci < q.choices.length; ci++) {
                const c = q.choices[ci];
                const cho_id = choiceIds[choiceCursor++];
                await conn.query(
                    `INSERT INTO tb_choices (cho_id, cho_question_id, cho_text, cho_is_correct, cho_wrong_reason, cho_order)
                     VALUES (?, ?, ?, ?, ?, ?)`,
                    [cho_id, ques_id, c.text, c.isCorrect, c.wrongReason, ci]
                );
                if (c.image) pendingChoiceImages.push({ cho_id, image: c.image });
            }

            job.processed = i + 1;
        }

        await conn.commit();

        // แนบรูปภาพหลัง commit เท่านั้น (นอก transaction เดิม — เขียนไฟล์ลง disk ทำ rollback คืนไม่ได้อยู่แล้ว)
        // ล้มเหลวทีละรูปไม่ทำให้ import ทั้งชุดเสียหาย เพราะคำถาม/ตัวเลือกถูกบันทึกจริงไปแล้ว
        let quesImagesSaved = 0;
        for (let i = 0; i < questions.length; i++) {
            if (!questions[i].image) continue;
            try {
                await saveImageForQuestion(quesIds[i], { buffer: questions[i].image.buffer });
                quesImagesSaved++;
            } catch {
                // ไม่ critical — ข้อนั้นแค่ไม่มีรูป ไม่ทำให้ import ทั้งชุดล้มเหลว
            }
        }

        let choImagesSaved = 0;
        for (const { cho_id, image } of pendingChoiceImages) {
            try {
                await saveImageForChoice(cho_id, { buffer: image.buffer });
                choImagesSaved++;
            } catch {
                // ไม่ critical — ตัวเลือกนั้นแค่ไม่มีรูป ไม่ทำให้ import ทั้งชุดล้มเหลว
            }
        }

        const imageNotes = [];
        if (quesImagesSaved) imageNotes.push(`รูปคำถาม ${quesImagesSaved} ข้อ`);
        if (choImagesSaved) imageNotes.push(`รูปตัวเลือก ${choImagesSaved} รายการ`);

        finishJob(jobId, {
            imported: questions.length,
            message: `นำเข้าสำเร็จ ${questions.length} ข้อ${imageNotes.length ? ` (แนบ${imageNotes.join(", ")})` : ""}`,
        });
    } catch (err) {
        await conn.rollback();
        finishJob(jobId, { error: err.message ?? "เกิดข้อผิดพลาดระหว่างบันทึกข้อมูล" });
    } finally {
        conn.release();
    }
}

// นำเข้าคำถามจาก CSV/Excel — validate ทุกแถวก่อน ถ้ามี error แม้แถวเดียวจะไม่ insert อะไรเลย (all-or-nothing)
// กันไฟล์นำเข้าครึ่งๆ กลางๆ ที่ต้องมานั่งไล่ว่าข้อไหนเข้าไปแล้วบ้าง
// ตอบกลับทันทีด้วย jobId (ไม่รอ insert เสร็จ) แล้วให้ frontend poll /import/status/:jobId ดู progress ต่อ
// เพราะไฟล์ใหญ่ (หลักร้อย-พันข้อ) insert จริงใช้เวลาหลายวินาที ถ้ารอในนี้ผู้ใช้จะไม่เห็นความคืบหน้าเลย
async function importFile(req, res, next) {
    if (!req.file) return res.status(400).json({ message: "ไม่พบไฟล์ที่อัปโหลด" });

    try {
        const [[product]] = await pool.query(
            "SELECT prod_id, prod_category_id FROM tb_products WHERE prod_id = ?",
            [req.params.productId]
        );
        if (!product) return res.status(404).json({ message: "ไม่พบชุดข้อสอบนี้" });

        const { questions, errors } = await parseQuestionFile(req.file.buffer, req.file.originalname);
        if (errors.length > 0) {
            return res.status(422).json({ message: "พบข้อผิดพลาดในไฟล์ กรุณาแก้ไขก่อนนำเข้า", errors });
        }
        if (questions.length === 0) {
            return res.status(400).json({ message: "ไม่พบคำถามในไฟล์" });
        }

        const jobId = createImportJob(questions.length);
        res.status(202).json({ jobId, total: questions.length });

        // ไม่ await — รันเบื้องหลังต่อหลังตอบ response ไปแล้ว ถ้า error จะเก็บไว้ใน job.error ให้ poll เจอ
        runImportJob(jobId, req.params.productId, product.prod_category_id, questions);
    } catch (err) {
        next(err);
    }
}

function getImportStatus(req, res) {
    const job = importJobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ message: "ไม่พบงานนำเข้านี้ หรือหมดอายุแล้ว" });
    res.json(job);
}

// ตั้งค่า cancelRequested ให้ runImportJob เห็นแล้ว rollback เอง (ไม่ commit อะไรที่ insert ไปแล้ว)
// ไม่ยกเลิกทันทีที่นี่เพราะ insert ยังรันอยู่ใน transaction เดียวกันซึ่งต้องรอ query ปัจจุบันจบก่อน
function cancelImportJob(req, res) {
    const job = importJobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ message: "ไม่พบงานนำเข้านี้ หรือหมดอายุแล้ว" });
    if (job.done) return res.status(409).json({ message: "งานนำเข้าเสร็จสิ้นไปแล้ว ไม่สามารถยกเลิกได้" });
    job.cancelRequested = true;
    res.json({ message: "ได้รับคำขอยกเลิกแล้ว กำลังหยุดการนำเข้า" });
}

module.exports = {
    getAll, getOne, create, createBatch, update, remove, removeBatch,
    uploadImage, removeImage,
    uploadChoiceImage, removeChoiceImage,
    importFile, getImportStatus, cancelImportJob, downloadTemplate, exportQuestions,
};
