const fs = require("fs/promises");
const path = require("path");
const sharp = require("sharp");
const pool = require("../config/db");
const { generateId } = require("../utils/generateId");
const { resolveUploadPath } = require("../utils/uploads");

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
        if (status) { conditions.push("p.prod_status = ?"); params.push(status); }
        if (categoryId) { conditions.push("p.prod_category_id = ?"); params.push(categoryId); }
        const whereClause = conditions.join(" AND ");

        const [rows] = await pool.query(
            `SELECT p.prod_id, p.prod_name, p.prod_price, p.prod_is_free, p.prod_cover_url, p.prod_status,
                    p.prod_exam_duration_minutes, p.prod_entitlement_duration_months,
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
            `SELECT p.prod_id, p.prod_name, p.prod_description, p.prod_price, p.prod_is_free, p.prod_cover_url, p.prod_status,
                    p.prod_category_id, p.prod_commission_staff_id, p.prod_commission_type, p.prod_commission_value,
                    p.prod_exam_duration_minutes, p.prod_entitlement_duration_months,
                    p.prod_created_at, p.prod_updated_at,
                    c.cat_name AS prod_category_name
             FROM tb_products p
             LEFT JOIN tb_categories c ON c.cat_id = p.prod_category_id
             WHERE p.prod_id = ?`,
            [req.params.id]
        );
        if (!rows[0]) return res.status(404).json({ message: "ไม่พบชุดข้อสอบนี้" });
        res.json(rows[0]);
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

// ไม่มี validation ราคามาก่อนเลย — ราคาติดลบหลุดเข้าไปได้ (เช่น พิมพ์ผิด) แล้วไปลดยอดรวมทั้งตะกร้าตอน
// checkout() ผิดเพี้ยนได้ (subtotal รวมค่าติดลบเข้าไปด้วย) อนุญาต 0 ไว้เผื่อ product แจกฟรี แต่ห้ามติดลบ
function validatePrice(prod_price) {
    if (prod_price === undefined || prod_price === null || prod_price === "") return null;
    const value = Number(prod_price);
    if (!Number.isFinite(value) || value < 0) return "ราคาต้องเป็นตัวเลขและไม่ติดลบ";
    return null;
}

async function create(req, res, next) {
    try {
        const {
            prod_name, prod_description, prod_price, prod_is_free, prod_category_id,
            prod_commission_staff_id, prod_commission_type, prod_commission_value,
            prod_exam_duration_minutes, prod_entitlement_duration_months,
        } = req.body;
        if (!prod_name) return res.status(400).json({ message: "กรุณากรอกชื่อชุดข้อสอบ" });

        const commissionError = validateCommission(req.body);
        if (commissionError) return res.status(400).json({ message: commissionError });
        const durationError = validateExamDuration(prod_exam_duration_minutes);
        if (durationError) return res.status(400).json({ message: durationError });
        const entitlementDurationError = validateEntitlementDuration(prod_entitlement_duration_months);
        if (entitlementDurationError) return res.status(400).json({ message: entitlementDurationError });
        const priceError = validatePrice(prod_price);
        if (priceError) return res.status(400).json({ message: priceError });

        const prod_id = await generateId("tb_products", "PRD");
        await pool.query(
            `INSERT INTO tb_products
                (prod_id, prod_name, prod_description, prod_price, prod_is_free, prod_category_id, prod_created_by_id,
                 prod_commission_staff_id, prod_commission_type, prod_commission_value, prod_exam_duration_minutes,
                 prod_entitlement_duration_months)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                prod_id, prod_name, prod_description || null, prod_price || 0, !!prod_is_free, prod_category_id || null, req.user.user_id,
                prod_commission_staff_id || null, prod_commission_type || null, prod_commission_value || null,
                prod_exam_duration_minutes || 60, prod_entitlement_duration_months || null,
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
            prod_name, prod_description, prod_price, prod_is_free, prod_status, prod_category_id,
            prod_commission_staff_id, prod_commission_type, prod_commission_value,
            prod_exam_duration_minutes, prod_entitlement_duration_months,
        } = req.body;
        if (!prod_name) return res.status(400).json({ message: "กรุณากรอกชื่อชุดข้อสอบ" });

        const commissionError = validateCommission(req.body);
        if (commissionError) return res.status(400).json({ message: commissionError });
        const durationError = validateExamDuration(prod_exam_duration_minutes);
        if (durationError) return res.status(400).json({ message: durationError });
        const entitlementDurationError = validateEntitlementDuration(prod_entitlement_duration_months);
        if (entitlementDurationError) return res.status(400).json({ message: entitlementDurationError });
        const priceError = validatePrice(prod_price);
        if (priceError) return res.status(400).json({ message: priceError });

        const status = ["draft", "published", "archived"].includes(prod_status) ? prod_status : "draft";

        await pool.query(
            `UPDATE tb_products SET prod_name = ?, prod_description = ?, prod_price = ?, prod_is_free = ?,
                    prod_status = ?, prod_category_id = ?,
                    prod_commission_staff_id = ?, prod_commission_type = ?, prod_commission_value = ?,
                    prod_exam_duration_minutes = ?, prod_entitlement_duration_months = ?
             WHERE prod_id = ?`,
            [
                prod_name, prod_description || null, prod_price || 0, !!prod_is_free, status, prod_category_id || null,
                prod_commission_staff_id || null, prod_commission_type || null, prod_commission_value || null,
                prod_exam_duration_minutes || 60, prod_entitlement_duration_months || null,
                req.params.id,
            ]
        );

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

        // ลบ product แล้วคำถาม+ตัวเลือกทั้งหมดของมันหายไปด้วย (ON DELETE CASCADE บน tb_questions)
        // เพราะคำถามไม่มีความหมายแยกจาก product ของมันเลย ต่างจาก entitlement/attempt/order_items ที่ยังกัน
        // ด้วย RESTRICT ไว้เหมือนเดิม เพราะเป็นประวัติทางธุรกิจจริงของลูกค้าที่ไม่ควรหายไปเงียบๆ — RESTRICT บน
        // tb_order_items.oi_product_id โดยเฉพาะ กันไม่ให้ลบ product ที่มีคำสั่งซื้อ (แม้แต่ที่ยัง pending)
        // ผูกอยู่ได้เลย ตัดปัญหา settlePaidOrder ไปเจอ product ที่หายไปกลางทางตอนออเดอร์เก่านั้นจ่ายเงินสำเร็จ
        await pool.query("DELETE FROM tb_products WHERE prod_id = ?", [req.params.id]);

        // ลบไฟล์รูปหน้าปกทิ้งด้วย ไม่ให้ค้างอยู่ใน uploads/ เปล่าๆ หลังลบ product
        if (rows[0]?.prod_cover_url) {
            await fs.unlink(resolveUploadPath(rows[0].prod_cover_url)).catch(() => {});
        }

        res.status(204).end();
    } catch (err) {
        if (err.code === "ER_ROW_IS_REFERENCED_2" || err.code === "ER_ROW_IS_REFERENCED") {
            return res.status(409).json({ message: "ไม่สามารถลบชุดข้อสอบนี้ได้ เพราะมีสิทธิ์การเข้าถึง คำสั่งซื้อ หรือประวัติการทำข้อสอบผูกอยู่" });
        }
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

module.exports = { getAll, getOne, create, update, remove, uploadCover, preview };
