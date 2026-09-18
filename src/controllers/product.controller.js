const fs = require("fs/promises");
const path = require("path");
const sharp = require("sharp");
const pool = require("../config/db");
const { generateId } = require("../utils/generateId");
const { resolveUploadPath } = require("../utils/uploads");
const { validateTotalScore, normalizeTotalScore, checkScoreBudget, sumActiveQuestionScore } = require("../utils/scoring");

const PRODUCT_COVER_DIR = path.join(__dirname, "..", "..", "uploads", "products");

async function getAll(req, res, next) {
    try {
        const limit = Number(req.query.limit) || 10;
        const offset = Number(req.query.offset) || 0;
        const search = `%${req.query.search ?? ""}%`;
        const status = ["draft", "published", "archived"].includes(req.query.status)
            ? req.query.status
            : null;
        const categoryId = req.query.category_id || null;

        const conditions = ["p.prod_name LIKE ?"];
        const params = [search];
        if (status) {
            conditions.push("p.prod_status = ?");
            params.push(status);
        } else {
            // ไม่ระบุ status มา = มุมมองเริ่มต้นของหน้าจัดการหลัก ไม่โชว์ของที่เก็บเข้าคลังแล้วปนอยู่ด้วย
            // ต้องเจาะจง ?status=archived เท่านั้นถึงจะเห็น (ดูหน้า /products/archived)
            conditions.push("p.prod_status != 'archived'");
        }
        if (categoryId) { conditions.push("p.prod_category_id = ?"); params.push(categoryId); }
        const whereClause = conditions.join(" AND ");

        const [rows] = await pool.query(
            `SELECT p.prod_id, p.prod_name, p.prod_price, p.prod_compare_price, p.prod_is_free, p.prod_cover_url, p.prod_status,
                    p.prod_exam_duration_minutes, p.prod_entitlement_duration_months, p.prod_total_score,
                    p.prod_created_at, p.prod_updated_at,
                    c.cat_name AS prod_category_name
             FROM tb_products p
             LEFT JOIN tb_categories c ON c.cat_id = p.prod_category_id
             WHERE ${whereClause}
             ORDER BY p.prod_id DESC
             LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );
        const [[{ total }]] = await pool.query(
            `SELECT COUNT(*) AS total FROM tb_products p WHERE ${whereClause}`,
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
            `SELECT p.prod_id, p.prod_name, p.prod_description, p.prod_price, p.prod_compare_price, p.prod_is_free, p.prod_cover_url, p.prod_status,
                    p.prod_category_id, p.prod_commission_staff_id, p.prod_commission_type, p.prod_commission_value,
                    p.prod_exam_duration_minutes, p.prod_entitlement_duration_months, p.prod_total_score, p.prod_pass_percent, p.prod_pass_min,
                    p.prod_created_at, p.prod_updated_at,
                    c.cat_name AS prod_category_name
             FROM tb_products p
             LEFT JOIN tb_categories c ON c.cat_id = p.prod_category_id
             WHERE p.prod_id = ?`,
            [req.params.id]
        );
        if (!rows[0]) return res.status(404).json({ message: "ไม่พบชุดข้อสอบนี้" });
        // used_score = ผลรวมคะแนนของข้อที่ active อยู่ตอนนี้ ส่งไปให้หน้าแอดมินโชว์ตัวนับ "ใช้ไป 95/100"
        // และเตือนล่วงหน้าได้ก่อนกดบันทึกว่าคะแนนเต็มใหม่จะต่ำกว่าที่ใช้ไปแล้ว
        res.json({
            ...rows[0],
            used_score: await sumActiveQuestionScore(req.params.id),
            topic_pass_criteria: await listTopicPassCriteria(req.params.id),
        });
    } catch (err) {
        next(err);
    }
}

// ค่าคอมไม่บังคับ แต่ถ้าจะตั้งต้องให้ครบทั้ง staff + ประเภท + มูลค่า (ตั้งครึ่งๆ กลางๆ ไม่มีความหมาย)
// คืน error message หรือ null ถ้าผ่าน
function validateCommission({ prod_commission_staff_id, prod_commission_type, prod_commission_value }) {
    const hasAny = prod_commission_staff_id || prod_commission_type || prod_commission_value;
    if (!hasAny) return null;
    if (!prod_commission_staff_id) return "กรุณาเลือกพนักงานที่รับค่าคอม";
    if (prod_commission_type !== "percent" && prod_commission_type !== "fixed") return "กรุณาเลือกประเภทค่าคอม";

    const value = Number(prod_commission_value);
    if (!Number.isFinite(value) || value <= 0) return "มูลค่าค่าคอมต้องมากกว่า 0";
    if (prod_commission_type === "percent" && value > 100) return "ค่าคอมแบบเปอร์เซ็นต์ต้องไม่เกิน 100";

    return null;
}

// เวลาสอบต้องเป็นจำนวนเต็มบวก จำกัดเพดานไว้กันกรอกเลขมั่ว (10 ชม.) — ไม่บังคับส่งมา ถ้าไม่ส่งใช้ default 60
// ที่ตั้งไว้ระดับ DB คืน error message หรือ null ถ้าผ่าน
function validateExamDuration(prod_exam_duration_minutes) {
    if (prod_exam_duration_minutes === undefined || prod_exam_duration_minutes === null || prod_exam_duration_minutes === "") {
        return null;
    }
    const value = Number(prod_exam_duration_minutes);
    if (!Number.isInteger(value) || value < 1 || value > 600) return "เวลาสอบต้องเป็นจำนวนเต็ม 1-600 นาที";
    return null;
}

// ระยะเวลาสิทธิ์ (เดือน) ที่ลูกค้าได้รับหลังซื้อ product นี้เอง — ไม่บังคับ ไม่ส่งมา/ว่าง = lifetime
// (prod_entitlement_duration_months เป็น NULL) ถ้าส่งมาต้องเป็นจำนวนเต็มบวก จำกัดเพดานกันกรอกเลขมั่ว (10 ปี)
function validateEntitlementDuration(prod_entitlement_duration_months) {
    if (prod_entitlement_duration_months === undefined || prod_entitlement_duration_months === null || prod_entitlement_duration_months === "") {
        return null;
    }
    const value = Number(prod_entitlement_duration_months);
    if (!Number.isInteger(value) || value < 1 || value > 120) return "ระยะเวลาสิทธิ์ต้องเป็นจำนวนเต็ม 1-120 เดือน";
    return null;
}

// เกณฑ์ผ่าน — ไม่บังคับ ว่าง/ไม่ส่ง = ไม่ตั้งเกณฑ์ (หน้าผลลูกค้าไม่แสดงผ่าน/ไม่ผ่าน)
// กำหนดได้ 2 แบบ ใส่อย่างใดอย่างหนึ่ง (2026-09-16):
//   percent = % จำนวนเต็ม 1-100
//   min     = ขั้นต่ำ — "จำนวนข้อ" (จำนวนเต็ม) ถ้าชุดไม่ใช้ระบบคะแนน / "คะแนน" (ทศนิยม 2 ตำแหน่ง) ถ้าใช้
//             สนามสอบหลายแห่งประกาศเกณฑ์เป็นจำนวนข้อ แปลงเป็น % เองแล้วปัดเศษเพี้ยนได้
const isBlank = (v) => v === undefined || v === null || v === "";
const normalizePassValue = (v) => (isBlank(v) ? null : Number(v));
const MAX_PASS_MIN = 99999.99;

function validatePassPercent(value) {
    if (isBlank(value)) return null;
    const num = Number(value);
    if (!Number.isInteger(num) || num < 1 || num > 100) return "แบบ % ต้องเป็นจำนวนเต็ม 1-100 หรือเว้นว่างถ้าไม่ตั้งเกณฑ์";
    return null;
}

// คืน error message หรือ null — label บอกว่าเกณฑ์ไหนผิด ("เกณฑ์ผ่านรวม" / "เกณฑ์ผ่านรายวิชา")
function validatePassCriterion({ percent, min }, scored, label) {
    if (!isBlank(percent) && !isBlank(min)) return `${label}: เลือกกำหนดเป็น % หรือขั้นต่ำอย่างใดอย่างหนึ่ง`;
    const percentError = validatePassPercent(percent);
    if (percentError) return `${label}: ${percentError}`;
    if (isBlank(min)) return null;
    const num = Number(min);
    if (!Number.isFinite(num) || num <= 0 || num > MAX_PASS_MIN) return `${label}: ขั้นต่ำต้องมากกว่า 0`;
    if (!scored && !Number.isInteger(num)) return `${label}: จำนวนข้อขั้นต่ำต้องเป็นจำนวนเต็ม`;
    if (scored && Math.abs(Math.round(num * 100) - num * 100) > 1e-6) return `${label}: คะแนนขั้นต่ำมีทศนิยมได้ไม่เกิน 2 ตำแหน่ง`;
    return null;
}

// เกณฑ์ผ่านรายวิชา (2026-09-16) — "วิชา" = หัวข้อของคำถามในชุด ดึงมาให้แอดมินเองจากคำถามที่ active อยู่
// รวมหัวข้อที่เคยตั้งเกณฑ์ไว้แต่ตอนนี้ไม่มีคำถามแล้วด้วย (question_count = 0) ให้แอดมินเห็นและลบทิ้งได้ ไม่ค้างเงียบๆ
async function listTopicPassCriteria(productId) {
    const [rows] = await pool.query(
        `SELECT t.tpc_id, t.tpc_name, COALESCE(q.n, 0) AS question_count,
                ptp.ptp_pass_percent AS pass_percent, ptp.ptp_pass_min AS pass_min
         FROM tb_topics t
         LEFT JOIN (
             SELECT ques_topic_id, COUNT(*) AS n FROM tb_questions
             WHERE ques_product_id = ? AND ques_status = 'active' GROUP BY ques_topic_id
         ) q ON q.ques_topic_id = t.tpc_id
         LEFT JOIN tb_product_topic_pass_criteria ptp ON ptp.ptp_topic_id = t.tpc_id AND ptp.ptp_product_id = ?
         WHERE q.n IS NOT NULL OR ptp.ptp_topic_id IS NOT NULL
         ORDER BY question_count DESC, t.tpc_name ASC`,
        [productId, productId]
    );
    return rows.map((r) => ({
        ...r,
        question_count: Number(r.question_count),
        pass_min: r.pass_min == null ? null : Number(r.pass_min),
    }));
}

const hasTopicCriterion = (i) => !isBlank(i.pass_percent) || !isBlank(i.pass_min);

// รับ [{ tpc_id, pass_percent, pass_min }] — ว่างทั้งคู่ = ไม่ตั้งเกณฑ์วิชานั้น · คืน error message หรือ null
// เช็คให้ครบ (รวมว่าหัวข้อมีอยู่จริง) ก่อนเขียนอะไรลง DB — ไม่งั้นข้อมูลชุดถูกบันทึกไปครึ่งหนึ่งแล้วค่อยเด้ง error
async function validateTopicPassCriteria(list, scored) {
    if (!Array.isArray(list)) return "รูปแบบเกณฑ์ผ่านรายวิชาไม่ถูกต้อง";
    const seen = new Set();
    for (const item of list) {
        if (!item || typeof item.tpc_id !== "string" || !item.tpc_id) return "รูปแบบเกณฑ์ผ่านรายวิชาไม่ถูกต้อง";
        if (seen.has(item.tpc_id)) return "มีวิชาซ้ำในเกณฑ์ผ่านรายวิชา";
        seen.add(item.tpc_id);
        const error = validatePassCriterion({ percent: item.pass_percent, min: item.pass_min }, scored, "เกณฑ์ผ่านรายวิชา");
        if (error) return error;
    }
    const ids = list.filter(hasTopicCriterion).map((i) => i.tpc_id);
    if (ids.length) {
        const [found] = await pool.query("SELECT tpc_id FROM tb_topics WHERE tpc_id IN (?)", [ids]);
        if (found.length !== ids.length) return "ไม่พบบางวิชาในเกณฑ์ผ่านรายวิชา (อาจถูกลบไปแล้ว) กรุณาโหลดหน้าใหม่";
    }
    return null;
}

// แทนที่เกณฑ์รายวิชาทั้งชุดในครั้งเดียว (ลบของเดิม + ใส่ใหม่ใน transaction) — ไม่ต้องไล่ diff ว่าวิชาไหนเพิ่ม/ลบ
async function replaceTopicPassCriteria(productId, list) {
    const rows = list.filter(hasTopicCriterion);
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        await conn.query("DELETE FROM tb_product_topic_pass_criteria WHERE ptp_product_id = ?", [productId]);
        if (rows.length) {
            await conn.query(
                "INSERT INTO tb_product_topic_pass_criteria (ptp_product_id, ptp_topic_id, ptp_pass_percent, ptp_pass_min) VALUES ?",
                [rows.map((r) => [productId, r.tpc_id, normalizePassValue(r.pass_percent), normalizePassValue(r.pass_min)])]
            );
        }
        await conn.commit();
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

// ไม่มี validation ราคามาก่อนเลย — ราคาติดลบหลุดเข้าไปได้ (เช่น พิมพ์ผิด) แล้วไปลดยอดรวมทั้งตะกร้าตอน
// checkout() ผิดเพี้ยนได้ (subtotal รวมค่าติดลบเข้าไปด้วย) อนุญาต 0 ไว้เผื่อ product แจกฟรี แต่ห้ามติดลบ
function validatePrice(prod_price) {
    if (prod_price === undefined || prod_price === null || prod_price === "") return null;
    const value = Number(prod_price);
    if (!Number.isFinite(value) || value < 0) return "ราคาต้องเป็นตัวเลขและไม่ติดลบ";
    return null;
}

// ราคาปกติ (compare-at price) — ไม่บังคับ ใช้แค่โชว์ขีดฆ่าคู่กับราคาจริงเพื่อสร้างความรู้สึกลดราคา
// ไม่กระทบยอดเงินที่เก็บจริงเลย (ดู comment ใน migration) ต้องมากกว่า prod_price เท่านั้น ไม่งั้นขีดฆ่า
// ไม่มีความหมาย (ราคาปกติต่ำกว่าราคาขายจริงจะดูเหมือน bug ไม่ใช่ส่วนลด)
function validateComparePrice(prod_compare_price, prod_price) {
    if (prod_compare_price === undefined || prod_compare_price === null || prod_compare_price === "") return null;
    const value = Number(prod_compare_price);
    if (!Number.isFinite(value) || value < 0) return "ราคาปกติต้องเป็นตัวเลขและไม่ติดลบ";
    const realPrice = Number(prod_price) || 0;
    if (value <= realPrice) return "ราคาปกติต้องมากกว่าราคาขายจริง ไม่งั้นจะไม่ใช่ส่วนลด";
    return null;
}

async function create(req, res, next) {
    try {
        const {
            prod_name, prod_description, prod_price, prod_compare_price, prod_is_free, prod_category_id,
            prod_commission_staff_id, prod_commission_type, prod_commission_value,
            prod_exam_duration_minutes, prod_entitlement_duration_months, prod_total_score, prod_pass_percent, prod_pass_min,
        } = req.body;
        if (!prod_name) return res.status(400).json({ message: "กรุณากรอกชื่อชุดข้อสอบ" });

        const commissionError = validateCommission(req.body);
        if (commissionError) return res.status(400).json({ message: commissionError });
        const durationError = validateExamDuration(prod_exam_duration_minutes);
        if (durationError) return res.status(400).json({ message: durationError });
        const entitlementDurationError = validateEntitlementDuration(prod_entitlement_duration_months);
        if (entitlementDurationError) return res.status(400).json({ message: entitlementDurationError });
        const totalScoreError = validateTotalScore(prod_total_score);
        if (totalScoreError) return res.status(400).json({ message: totalScoreError });
        const passError = validatePassCriterion(
            { percent: prod_pass_percent, min: prod_pass_min }, normalizeTotalScore(prod_total_score) != null, "เกณฑ์ผ่านรวม"
        );
        if (passError) return res.status(400).json({ message: passError });
        const priceError = validatePrice(prod_price);
        if (priceError) return res.status(400).json({ message: priceError });
        const comparePriceError = validateComparePrice(prod_compare_price, prod_price);
        if (comparePriceError) return res.status(400).json({ message: comparePriceError });

        const prod_id = await generateId("tb_products", "PRD");
        await pool.query(
            `INSERT INTO tb_products
                (prod_id, prod_name, prod_description, prod_price, prod_compare_price, prod_is_free, prod_category_id, prod_created_by_id,
                 prod_commission_staff_id, prod_commission_type, prod_commission_value, prod_exam_duration_minutes,
                 prod_entitlement_duration_months, prod_total_score, prod_pass_percent, prod_pass_min)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                prod_id, prod_name, prod_description || null, prod_price || 0, prod_compare_price || null, !!prod_is_free, prod_category_id || null, req.user.user_id,
                prod_commission_staff_id || null, prod_commission_type || null, prod_commission_value || null,
                prod_exam_duration_minutes || 60, prod_entitlement_duration_months || null, normalizeTotalScore(prod_total_score),
                normalizePassValue(prod_pass_percent), normalizePassValue(prod_pass_min),
            ]
        );

        res.status(201).json({ prod_id });
    } catch (err) {
        next(err);
    }
}

async function update(req, res, next) {
    try {
        const {
            prod_name, prod_description, prod_price, prod_compare_price, prod_is_free, prod_status, prod_category_id,
            prod_commission_staff_id, prod_commission_type, prod_commission_value,
            prod_exam_duration_minutes, prod_entitlement_duration_months, prod_total_score,
        } = req.body;
        if (!prod_name) return res.status(400).json({ message: "กรุณากรอกชื่อชุดข้อสอบ" });

        const commissionError = validateCommission(req.body);
        if (commissionError) return res.status(400).json({ message: commissionError });
        const durationError = validateExamDuration(prod_exam_duration_minutes);
        if (durationError) return res.status(400).json({ message: durationError });
        const entitlementDurationError = validateEntitlementDuration(prod_entitlement_duration_months);
        if (entitlementDurationError) return res.status(400).json({ message: entitlementDurationError });
        const totalScoreError = validateTotalScore(prod_total_score);
        if (totalScoreError) return res.status(400).json({ message: totalScoreError });
        const scored = normalizeTotalScore(prod_total_score) != null;
        const passError = validatePassCriterion({ percent: req.body.prod_pass_percent, min: req.body.prod_pass_min }, scored, "เกณฑ์ผ่านรวม");
        if (passError) return res.status(400).json({ message: passError });
        const hasTopicPass = Object.prototype.hasOwnProperty.call(req.body, "topic_pass_criteria");
        const topicPassError = hasTopicPass ? await validateTopicPassCriteria(req.body.topic_pass_criteria, scored) : null;
        if (topicPassError) return res.status(400).json({ message: topicPassError });
        const priceError = validatePrice(prod_price);
        if (priceError) return res.status(400).json({ message: priceError });
        const comparePriceError = validateComparePrice(prod_compare_price, prod_price);
        if (comparePriceError) return res.status(400).json({ message: comparePriceError });

        const status = ["draft", "published", "archived"].includes(prod_status) ? prod_status : "draft";

        // ห้ามลดคะแนนเต็มลงจนต่ำกว่าผลรวมคะแนนของข้อที่มีอยู่แล้ว — เป็นทางที่ผลรวมจะ "เกิน" ได้โดยไม่ต้อง
        // แตะคำถามสักข้อ จึงต้องเช็คที่นี่ด้วย ไม่ใช่เช็คแค่ตอนสร้าง/แก้คำถาม
        const budgetError = await checkScoreBudget({
            productId: req.params.id,
            totalScore: normalizeTotalScore(prod_total_score),
        });
        if (budgetError) return res.status(400).json({ message: budgetError });

        await pool.query(
            `UPDATE tb_products SET prod_name = ?, prod_description = ?, prod_price = ?, prod_compare_price = ?, prod_is_free = ?,
                    prod_status = ?, prod_category_id = ?,
                    prod_commission_staff_id = ?, prod_commission_type = ?, prod_commission_value = ?,
                    prod_exam_duration_minutes = ?, prod_entitlement_duration_months = ?, prod_total_score = ?
             WHERE prod_id = ?`,
            [
                prod_name, prod_description || null, prod_price || 0, prod_compare_price || null, !!prod_is_free, status, prod_category_id || null,
                prod_commission_staff_id || null, prod_commission_type || null, prod_commission_value || null,
                prod_exam_duration_minutes || 60, prod_entitlement_duration_months || null, normalizeTotalScore(prod_total_score),
                req.params.id,
            ]
        );
        // เกณฑ์ผ่านเปลี่ยนเฉพาะตอนส่งฟิลด์มาจริง — หน้าจอ/สคริปต์ที่ไม่รู้จักฟิลด์ (เช่น JS แอดมินรุ่นเก่า
        // ที่ค้างในเบราว์เซอร์หลัง deploy) กดบันทึกแล้วต้องไม่ลบเกณฑ์ที่ตั้งไว้ทิ้งเงียบๆ
        // รุ่นที่รู้จักแค่ % (ไม่ส่ง prod_pass_min): ตั้ง % = ล้างขั้นต่ำ (ใช้ได้ทีละแบบ) · ส่ง % ว่าง = ไม่แตะขั้นต่ำ
        const has = (key) => Object.prototype.hasOwnProperty.call(req.body, key);
        if (has("prod_pass_min")) {
            await pool.query("UPDATE tb_products SET prod_pass_percent = ?, prod_pass_min = ? WHERE prod_id = ?", [
                normalizePassValue(req.body.prod_pass_percent), normalizePassValue(req.body.prod_pass_min), req.params.id,
            ]);
        } else if (has("prod_pass_percent")) {
            const percent = normalizePassValue(req.body.prod_pass_percent);
            if (percent == null) {
                await pool.query("UPDATE tb_products SET prod_pass_percent = NULL WHERE prod_id = ?", [req.params.id]);
            } else {
                await pool.query("UPDATE tb_products SET prod_pass_percent = ?, prod_pass_min = NULL WHERE prod_id = ?", [percent, req.params.id]);
            }
        }
        // เกณฑ์รายวิชาใช้กติกาเดียวกัน — ไม่ส่งฟิลด์มา = ไม่แตะของเดิม
        if (hasTopicPass) await replaceTopicPassCriteria(req.params.id, req.body.topic_pass_criteria);

        res.json({ message: "แก้ไขชุดข้อสอบสำเร็จ" });
    } catch (err) {
        next(err);
    }
}

async function remove(req, res, next) {
    try {
        const [rows] = await pool.query("SELECT prod_cover_url FROM tb_products WHERE prod_id = ?", [
            req.params.id,
        ]);

        // เก็บ path รูปคำถาม+ตัวเลือกทั้งหมดของ product นี้ไว้ก่อนลบ เพราะ ON DELETE CASCADE จะลบแถว
        // tb_questions/tb_choices ทิ้งไปเลย ถ้าไม่ query เก็บไว้ก่อนจะไม่มีทางรู้ path ไฟล์เพื่อไปลบตามทีหลัง
        const [questionImageRows] = await pool.query(
            "SELECT ques_image_url FROM tb_questions WHERE ques_product_id = ? AND ques_image_url IS NOT NULL",
            [req.params.id]
        );
        const [choiceImageRows] = await pool.query(
            `SELECT c.cho_image_url FROM tb_choices c
             JOIN tb_questions q ON q.ques_id = c.cho_question_id
             WHERE q.ques_product_id = ? AND c.cho_image_url IS NOT NULL`,
            [req.params.id]
        );

        // ลบ product แล้วคำถาม+ตัวเลือกทั้งหมดของมันหายไปด้วย (ON DELETE CASCADE บน tb_questions)
        // เพราะคำถามไม่มีความหมายแยกจาก product ของมันเลย ต่างจาก entitlement/attempt/order_items ที่ยังกัน
        // ด้วย RESTRICT ไว้เหมือนเดิม เพราะเป็นประวัติทางธุรกิจจริงของลูกค้าที่ไม่ควรหายไปเงียบๆ — RESTRICT บน
        // tb_order_items.oi_product_id โดยเฉพาะ กันไม่ให้ลบ product ที่มีคำสั่งซื้อ (แม้แต่ที่ยัง pending)
        // ผูกอยู่ได้เลย ตัดปัญหา settlePaidOrder ไปเจอ product ที่หายไปกลางทางตอนออเดอร์เก่านั้นจ่ายเงินสำเร็จ
        await pool.query("DELETE FROM tb_products WHERE prod_id = ?", [req.params.id]);

        // ลบไฟล์รูปหน้าปก + รูปคำถาม/ตัวเลือกทั้งหมดทิ้งด้วย ไม่ให้ค้างอยู่ใน uploads/ เปล่าๆ หลังลบ product
        if (rows[0]?.prod_cover_url) {
            await fs.unlink(resolveUploadPath(rows[0].prod_cover_url)).catch(() => {});
        }
        await Promise.all([
            ...questionImageRows.map((r) => fs.unlink(resolveUploadPath(r.ques_image_url)).catch(() => {})),
            ...choiceImageRows.map((r) => fs.unlink(resolveUploadPath(r.cho_image_url)).catch(() => {})),
        ]);

        res.status(204).end();
    } catch (err) {
        if (err.code === "ER_ROW_IS_REFERENCED_2" || err.code === "ER_ROW_IS_REFERENCED") {
            return res.status(409).json({
                message: "ไม่สามารถลบชุดข้อสอบนี้ได้ เพราะมีสิทธิ์การเข้าถึง คำสั่งซื้อ หรือประวัติการทำข้อสอบผูกอยู่ — ใช้ปุ่ม \"เก็บเข้าคลัง\" แทนได้ ซ่อนจากลูกค้าโดยไม่กระทบสิทธิ์เดิม",
            });
        }
        next(err);
    }
}

// สลับ archive/กู้คืนแบบเบาๆ (แค่เปลี่ยน prod_status) ไม่ต้องส่งฟอร์มเต็มเหมือน update() ปกติที่บังคับ
// ต้องมีชื่อ/ราคา/ฯลฯ ครบ — ใช้เป็นทางเลือกแทนการลบจริงตอนมี entitlement/order/package ผูกอยู่จนลบไม่ได้
// (product ที่ archived แล้วจะหายไปจากทุกจุดที่ลูกค้าเห็น เพราะทุก query ฝั่งลูกค้ากรอง prod_status='published'
// อยู่แล้ว แต่ entitlement เดิมของลูกค้าที่ซื้อไปแล้วยังใช้งานได้ปกติ ไม่ถูกกระทบ) กู้คืนกลับไปที่ 'draft' เสมอ
// (ไม่ใช่ 'published' ตรงๆ) บังคับให้แอดมินต้องกดเผยแพร่ใหม่เองผ่านฟอร์มแก้ไขปกติ กันเผยแพร่คืนโดยไม่ตั้งใจ
async function setStatus(req, res, next) {
    try {
        const { prod_status } = req.body;
        if (!["archived", "draft"].includes(prod_status)) {
            return res.status(400).json({ message: "สถานะไม่ถูกต้อง" });
        }

        if (prod_status === "archived") {
            // กันเก็บเข้าคลังทั้งที่ยังอยู่ในแพ็กเกจที่เผยแพร่อยู่ — ไม่งั้น checkout ของแพ็กเกจนั้นจะพังทันที
            // เพราะ checkout() เช็คว่าทุก product ในแพ็กเกจต้อง prod_status='published' ครบทุกชิ้น
            const [pkgRows] = await pool.query(
                `SELECT pkg.pkg_name FROM tb_package_items pi
                 JOIN tb_packages pkg ON pkg.pkg_id = pi.pki_package_id
                 WHERE pi.pki_product_id = ? AND pkg.pkg_status = 'published'`,
                [req.params.id]
            );
            if (pkgRows.length > 0) {
                return res.status(409).json({
                    message: `ไม่สามารถเก็บเข้าคลังได้ เพราะยังอยู่ในแพ็กเกจที่เผยแพร่อยู่: ${pkgRows.map((r) => r.pkg_name).join(", ")} — กรุณาเอาออกจากแพ็กเกจก่อน`,
                });
            }
        }

        await pool.query("UPDATE tb_products SET prod_status = ? WHERE prod_id = ?", [prod_status, req.params.id]);
        res.json({ message: prod_status === "archived" ? "เก็บเข้าคลังชุดข้อสอบแล้ว" : "กู้คืนชุดข้อสอบแล้ว" });
    } catch (err) {
        next(err);
    }
}

// resize + บีบเป็น webp เหมือน avatar ผู้ใช้งาน แต่ใช้ fit:"inside" แทน "cover" เพราะรูปหน้าปก
// ไม่ควรถูกครอปเป็นสี่เหลี่ยมจัตุรัสตายตัว (โปสเตอร์แนวตั้ง/แนวนอนได้ทั้งคู่) แค่จำกัดขนาดสูงสุดไว้
async function saveCoverForProduct(productId, file) {
    const [rows] = await pool.query("SELECT prod_cover_url FROM tb_products WHERE prod_id = ?", [
        productId,
    ]);
    if (!rows[0]) {
        const err = new Error("ไม่พบชุดข้อสอบนี้");
        err.status = 404;
        throw err;
    }
    const oldCoverUrl = rows[0].prod_cover_url;

    // เก็บแยกโฟลเดอร์ตามประเภทไฟล์ (uploads/products/) ไม่ปนกับ avatar ผู้ใช้งานหรืออื่นๆ
    await fs.mkdir(PRODUCT_COVER_DIR, { recursive: true });

    const filename = `${Date.now()}-${Math.round(Math.random() * 1e9)}.webp`;
    await sharp(file.buffer)
        .resize(800, 800, { fit: "inside", withoutEnlargement: true })
        .webp({ quality: 80 })
        .toFile(path.join(PRODUCT_COVER_DIR, filename));

    const prod_cover_url = `/uploads/products/${filename}`;
    await pool.query("UPDATE tb_products SET prod_cover_url = ? WHERE prod_id = ?", [
        prod_cover_url,
        productId,
    ]);

    if (oldCoverUrl) {
        await fs.unlink(resolveUploadPath(oldCoverUrl)).catch(() => {});
    }

    return prod_cover_url;
}

// ─── preview ก่อน publish (staff เท่านั้น) — ดูคำถาม+ตัวเลือก+เฉลยเต็มได้ไม่ว่า prod_status จะเป็นอะไร
// (ต่างจากฝั่งลูกค้าที่บังคับ published เสมอ) ให้แอดมินเช็คเนื้อหาก่อนกด publish จริง ─────────────────
async function preview(req, res, next) {
    try {
        const [[product]] = await pool.query(
            "SELECT prod_id, prod_name, prod_status FROM tb_products WHERE prod_id = ?",
            [req.params.id]
        );
        if (!product) return res.status(404).json({ message: "ไม่พบชุดข้อสอบนี้" });

        const [questions] = await pool.query(
            `SELECT ques_id, ques_text, ques_explanation, ques_image_url, ques_order
             FROM tb_questions WHERE ques_product_id = ? AND ques_status = 'active'
             ORDER BY ques_order`,
            [req.params.id]
        );
        if (questions.length === 0) {
            return res.json({ prod_id: product.prod_id, prod_name: product.prod_name, prod_status: product.prod_status, questions: [] });
        }

        const [choices] = await pool.query(
            `SELECT cho_id, cho_question_id, cho_text, cho_is_correct, cho_wrong_reason, cho_image_url, cho_order
             FROM tb_choices WHERE cho_question_id IN (?) ORDER BY cho_order`,
            [questions.map((q) => q.ques_id)]
        );
        const choicesByQuestion = {};
        for (const c of choices) (choicesByQuestion[c.cho_question_id] ??= []).push(c);

        const data = questions.map((q) => ({ ...q, choices: choicesByQuestion[q.ques_id] ?? [] }));
        res.json({ prod_id: product.prod_id, prod_name: product.prod_name, prod_status: product.prod_status, questions: data });
    } catch (err) {
        next(err);
    }
}

async function uploadCover(req, res, next) {
    try {
        if (!req.file) return res.status(400).json({ message: "ไม่พบไฟล์รูปภาพ" });
        const prod_cover_url = await saveCoverForProduct(req.params.id, req.file);
        res.json({ prod_cover_url });
    } catch (err) {
        next(err);
    }
}

module.exports = { getAll, getOne, create, update, remove, setStatus, uploadCover, preview };
