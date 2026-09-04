const pool = require("../config/db");
const { generateId } = require("../utils/generateId");
const { findValidCoupon, incrementUsage } = require("./coupon.controller");
const { grantOrRenewProduct, calculateDiscount, recordSale } = require("./entitlement.controller");
const { fetchSampleQuestions, buildQuestionPayload } = require("./attempt.controller");
const stripeClient = require("../utils/stripeClient");
const settingsController = require("./settings.controller");
const { getEffectivePrice } = require("../utils/pricing");
const { sendMail } = require("../utils/mailer");
const { buildReceiptEmail } = require("../utils/emailTemplates");

// Stripe ไม่มี field วันหมดอายุ QR ของ PromptPay ให้เหมือน Omise (ตรวจสอบแล้วจาก docs.stripe.com — ไม่มี
// payment_method_options[promptpay][expires_after_seconds] แบบที่ Pix มี และ next_action.promptpay_display_qr_code
// ก็ไม่มี field หมดอายุเลย) จึงกำหนด TTL เองฝั่งเรา แล้วให้ jobs/orderExpirySweep.js เป็นคนยกเลิก PaymentIntent
// ที่ค้างเกินเวลาแทน (เช็คสถานะจริงกับ Stripe ก่อนยกเลิกทุกครั้ง กันเคส race ที่ลูกค้าเพิ่งจ่ายสำเร็จไปพอดี)
const PROMPTPAY_QR_TTL_MS = 60 * 60 * 1000; // 1 ชม. — ตัดสินใจร่วมกับผู้ใช้แล้ว (ไม่มีตัวเลขอ้างอิงจาก Stripe ให้ใช้)

const SAMPLE_QUESTION_COUNT = 10;

// ─── รายการชุดข้อสอบสาธารณะ (ไม่ auth) — บังคับ published เสมอ ไม่รับ status จาก query
// เหมือนฝั่งแอดมิน และไม่ส่งฟิลด์ค่าคอม (ข้อมูลภายในธุรกิจ ไม่ควรหลุดออกไปฝั่งลูกค้า) ─────────────
async function getPublicProducts(req, res, next) {
    try {
        const limit = Number(req.query.limit) || 12;
        const offset = Number(req.query.offset) || 0;
        const search = `%${req.query.search ?? ""}%`;
        const categoryId = req.query.category_id || null;
        const freeOnly = req.query.is_free === "true";

        const conditions = ["p.prod_status = 'published'", "p.prod_name LIKE ?"];
        const params = [search];
        if (categoryId) { conditions.push("p.prod_category_id = ?"); params.push(categoryId); }
        if (freeOnly) { conditions.push("p.prod_is_free = TRUE"); }
        const whereClause = conditions.join(" AND ");

        const [rows] = await pool.query(
            `SELECT p.prod_id, p.prod_name, p.prod_price, p.prod_compare_price, p.prod_is_free, p.prod_cover_url,
                    p.prod_category_id, c.cat_name AS prod_category_name,
                    (SELECT COUNT(*) FROM tb_questions q WHERE q.ques_product_id = p.prod_id AND q.ques_status = 'active') AS question_count
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

// ─── สินค้ายอดนิยมหน้า landing — เรียงตามจำนวนครั้งที่ถูกซื้อจริงจาก tb_sale_items (ไม่นับ
// entitlement ที่แอดมิน grant มือ เพราะนั่นไม่ใช่ "คนนิยมซื้อ") ถ้าสินค้าที่เคยขายได้มีไม่ครบ limit
// (ธุรกิจเพิ่งเริ่ม ยังไม่มีประวัติขายมากพอ) เติมที่เหลือด้วยสินค้าอื่นแบบสุ่มกันหน้าเว็บดูโล่งว่าง —
// ของที่เคยขายมาก่อนเสมอ เรียงมาก→น้อยก่อน ตามด้วยของสุ่มต่อท้าย ────────────────────────────────
async function getPopularProducts(req, res, next) {
    try {
        const limit = Number(req.query.limit) || 12;

        const [popular] = await pool.query(
            `SELECT p.prod_id, p.prod_name, p.prod_price, p.prod_compare_price, p.prod_is_free, p.prod_cover_url,
                    p.prod_category_id, c.cat_name AS prod_category_name,
                    (SELECT COUNT(*) FROM tb_questions q WHERE q.ques_product_id = p.prod_id AND q.ques_status = 'active') AS question_count,
                    COUNT(si.si_id) AS purchase_count
             FROM tb_products p
             LEFT JOIN tb_categories c ON c.cat_id = p.prod_category_id
             JOIN tb_sale_items si ON si.si_product_id = p.prod_id
             WHERE p.prod_status = 'published'
             GROUP BY p.prod_id
             ORDER BY purchase_count DESC, p.prod_id DESC
             LIMIT ?`,
            [limit]
        );

        let rows = popular;
        if (rows.length < limit) {
            const excludeIds = rows.map((r) => r.prod_id);
            const excludeClause = excludeIds.length ? "AND p.prod_id NOT IN (?)" : "";
            const [filler] = await pool.query(
                `SELECT p.prod_id, p.prod_name, p.prod_price, p.prod_compare_price, p.prod_is_free, p.prod_cover_url,
                        p.prod_category_id, c.cat_name AS prod_category_name,
                        (SELECT COUNT(*) FROM tb_questions q WHERE q.ques_product_id = p.prod_id AND q.ques_status = 'active') AS question_count
                 FROM tb_products p
                 LEFT JOIN tb_categories c ON c.cat_id = p.prod_category_id
                 WHERE p.prod_status = 'published' ${excludeClause}
                 ORDER BY RAND()
                 LIMIT ?`,
                excludeIds.length ? [excludeIds, limit - rows.length] : [limit - rows.length]
            );
            rows = [...rows, ...filler];
        }

        res.json({ data: rows });
    } catch (err) {
        next(err);
    }
}

// ─── หมวดหมู่ที่แอดมินติ๊กให้โชว์บนหน้า landing เท่านั้น (cat_show_on_landing) ต้อง active ด้วย
// และต้องมี product published ผูกอยู่จริงอย่างน้อย 1 ชิ้น กันโชว์หมวดว่างที่กดแล้วไม่มีอะไรให้ดู ────
async function getPublicCategories(req, res, next) {
    try {
        const [rows] = await pool.query(
            `SELECT c.cat_id, c.cat_name
             FROM tb_categories c
             WHERE c.cat_status = 'active' AND c.cat_show_on_landing = 1
               AND EXISTS (
                   SELECT 1 FROM tb_products p
                   WHERE p.prod_category_id = c.cat_id AND p.prod_status = 'published'
               )
             ORDER BY c.cat_id DESC`
        );
        res.json({ data: rows });
    } catch (err) {
        next(err);
    }
}

async function getPublicProduct(req, res, next) {
    try {
        const [rows] = await pool.query(
            `SELECT p.prod_id, p.prod_name, p.prod_description, p.prod_price, p.prod_compare_price, p.prod_is_free, p.prod_cover_url,
                    p.prod_exam_duration_minutes,
                    c.cat_name AS prod_category_name,
                    (SELECT COUNT(*) FROM tb_questions q WHERE q.ques_product_id = p.prod_id AND q.ques_status = 'active') AS question_count
             FROM tb_products p
             LEFT JOIN tb_categories c ON c.cat_id = p.prod_category_id
             WHERE p.prod_id = ? AND p.prod_status = 'published'`,
            [req.params.id]
        );
        if (!rows[0]) return res.status(404).json({ message: "ไม่พบชุดข้อสอบนี้" });
        res.json(rows[0]);
    } catch (err) {
        next(err);
    }
}

// ─── ตัวอย่างข้อสอบฟรีก่อนซื้อ (ไม่ auth) — เห็นเฉลยเต็มเพื่อให้ประเมินคุณภาพเฉลยได้จริงก่อนตัดสินใจซื้อ
// ตั้งใจไม่สุ่มลำดับคำถาม/ตัวเลือก (ต่างจากตอนทำข้อสอบจริง) เพราะไม่มีการให้คะแนน ไม่ต้องกันจำคำตอบ ─────
async function getSampleQuestions(req, res, next) {
    try {
        const [productRows] = await pool.query(
            "SELECT prod_id FROM tb_products WHERE prod_id = ? AND prod_status = 'published'",
            [req.params.id]
        );
        if (!productRows[0]) return res.status(404).json({ message: "ไม่พบชุดข้อสอบนี้" });

        const questionMap = await fetchSampleQuestions(req.params.id, SAMPLE_QUESTION_COUNT);
        const sampleIds = Object.keys(questionMap).sort();

        const questions = sampleIds.map((quesId) => {
            const question = questionMap[quesId];
            const choiceOrder = question.choices.map((c) => c.cho_id);
            return buildQuestionPayload(question, choiceOrder, null, true);
        });

        res.json({ data: questions });
    } catch (err) {
        next(err);
    }
}

// ─── รายการแพ็กเกจสาธารณะ (ไม่ auth) — คืนรายชื่อ product ที่รวมอยู่ + ราคาถ้าซื้อแยก เทียบราคาแพ็กเกจ
// ให้หน้าเว็บโชว์ "ประหยัด X บาท" ได้ตรงๆ ไม่ต้องคำนวณฝั่ง frontend ──────────────────────────
async function getPublicPackages(req, res, next) {
    try {
        const [packages] = await pool.query(
            "SELECT pkg_id, pkg_name, pkg_description, pkg_price, pkg_cover_url FROM tb_packages WHERE pkg_status = 'published' ORDER BY pkg_id DESC"
        );
        if (packages.length === 0) return res.json({ data: [] });

        const [items] = await pool.query(
            `SELECT pi.pki_package_id, p.prod_id, p.prod_name, p.prod_price, p.prod_is_free, p.prod_cover_url
             FROM tb_package_items pi JOIN tb_products p ON p.prod_id = pi.pki_product_id
             WHERE pi.pki_package_id IN (?) AND p.prod_status = 'published'`,
            [packages.map((p) => p.pkg_id)]
        );
        const itemsByPackage = {};
        for (const item of items) {
            (itemsByPackage[item.pki_package_id] ??= []).push(item);
        }

        const data = packages.map((pkg) => {
            const products = itemsByPackage[pkg.pkg_id] ?? [];
            // ใช้ getEffectivePrice() เหมือน recordSale()/checkout() — ถ้าแพ็กเกจมี product ที่แจกฟรีรวมอยู่
            // "ราคารวมแยกซื้อ"/"ประหยัด" ที่โชว์ลูกค้าต้องไม่นับราคาปกติของ item ฟรีนั้นเข้าไปด้วย
            const individualTotal = products.reduce((sum, p) => sum + getEffectivePrice(p), 0);
            return {
                pkg_id: pkg.pkg_id,
                pkg_name: pkg.pkg_name,
                pkg_description: pkg.pkg_description,
                pkg_price: pkg.pkg_price,
                pkg_cover_url: pkg.pkg_cover_url,
                individual_total: individualTotal,
                savings: Math.max(0, individualTotal - Number(pkg.pkg_price)),
                products: products.map((p) => ({ prod_id: p.prod_id, prod_name: p.prod_name, prod_price: p.prod_price, prod_is_free: !!p.prod_is_free, prod_cover_url: p.prod_cover_url })),
            };
        });

        res.json({ data });
    } catch (err) {
        next(err);
    }
}

// ─── เช็คเอาท์ — สร้างคำสั่งซื้อสถานะ pending เท่านั้น ยังไม่ให้สิทธิ์ ────────────────
// คำนวณราคา/ส่วนลดจาก DB เสมอ ห้ามเชื่อราคาที่ client ส่งมา (เหมือนหลักการเดียวกับ recordSale)
//
// package_id (ถ้ามี) จะถูก "ขยาย" เป็นรายการ product ย่อยตรงนี้เลย แล้วไหลผ่าน flow เดิมทั้งหมดเหมือน
// ซื้อ product ตรงๆ ทีละชิ้น — ต่างกันแค่ส่วนลดที่คำนวณจาก (ราคารวมแยกซื้อ - pkg_price) แล้ว prorate
// ลงแต่ละ item แบบเดียวกับส่วนลดคูปอง จึงไม่ต้องมีคอลัมน์/ตารางใหม่สำหรับ order_items ที่มาจาก package เลย
// (v1: package กับ coupon_code ใช้พร้อมกันในออเดอร์เดียวกันไม่ได้ — เลือกได้ทางใดทางหนึ่ง)
async function checkout(req, res, next) {
    try {
        const { product_ids = [], package_id, coupon_code } = req.body ?? {};

        let productIds = Array.isArray(product_ids) ? [...product_ids] : [];
        let pkg = null;
        if (package_id) {
            const [pkgRows] = await pool.query(
                "SELECT pkg_id, pkg_price FROM tb_packages WHERE pkg_id = ? AND pkg_status = 'published'",
                [package_id]
            );
            if (!pkgRows[0]) return res.status(400).json({ message: "ไม่พบแพ็กเกจนี้" });
            pkg = pkgRows[0];

            const [itemRows] = await pool.query(
                "SELECT pki_product_id FROM tb_package_items WHERE pki_package_id = ?",
                [package_id]
            );
            productIds = [...new Set([...productIds, ...itemRows.map((r) => r.pki_product_id)])];
        }

        if (productIds.length === 0) {
            return res.status(400).json({ message: "กรุณาเลือกชุดข้อสอบอย่างน้อย 1 ชุด" });
        }

        const [products] = await pool.query(
            `SELECT prod_id, prod_name, prod_price, prod_is_free FROM tb_products
             WHERE prod_id IN (?) AND prod_status = 'published'`,
            [productIds]
        );
        if (products.length !== productIds.length) {
            return res.status(400).json({ message: "มีชุดข้อสอบบางรายการไม่พร้อมขาย กรุณาลองใหม่" });
        }

        // getEffectivePrice() เสมอ — product ที่ prod_is_free=TRUE ต้องนับเป็น 0 ไม่ว่า prod_price จะตั้งไว้
        // เท่าไหร่ (สูตรเดียวกับ recordSale() ต้องตรงกันเป๊ะ ไม่งั้นยอดที่ลูกค้าเห็นตอน checkout กับยอดขาย
        // ที่บันทึกจริงตอน settlePaidOrder จะไม่ตรงกัน)
        const subtotal = products.reduce((sum, p) => sum + getEffectivePrice(p), 0);

        let coupon = null;
        let discount = 0;
        if (pkg) {
            discount = Math.max(0, subtotal - Number(pkg.pkg_price));
        } else if (coupon_code) {
            const result = await findValidCoupon(coupon_code);
            if (!result.coupon) return res.status(400).json({ message: result.error });
            coupon = result.coupon;
            discount = calculateDiscount(subtotal, coupon);
        }

        const total = Math.max(0, subtotal - discount);

        const ord_id = await generateId("tb_orders", "ORD");
        await pool.query(
            `INSERT INTO tb_orders (ord_id, ord_customer_id, ord_coupon_id, ord_package_id, ord_subtotal, ord_discount, ord_total)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [ord_id, req.customer.cus_id, coupon?.cpn_id ?? null, pkg?.pkg_id ?? null, subtotal, discount, total]
        );

        const priceByProduct = Object.fromEntries(products.map((p) => [p.prod_id, getEffectivePrice(p)]));
        const oiIdPrefix = "OIT";
        for (const productId of productIds) {
            const price = priceByProduct[productId];
            const itemDiscount = subtotal > 0 ? discount * (price / subtotal) : 0;
            const itemTotal = Math.max(0, price - itemDiscount);
            const oi_id = await generateId("tb_order_items", oiIdPrefix);
            await pool.query(
                `INSERT INTO tb_order_items (oi_id, oi_order_id, oi_product_id, oi_price, oi_discount, oi_total)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [oi_id, ord_id, productId, price, itemDiscount, itemTotal]
            );
        }

        // total = 0 เป๊ะ (คูปอง/ส่วนลดแพ็กเกจลดเต็มราคา) — ไม่มีอะไรต้องจ่ายจริง ปิดออเดอร์ให้เลยไม่ต้อง
        // รอ QR/webhook (ยังปลอดภัยตามกฎเหล็กข้อ 1 เพราะไม่ได้ "เชื่อ client ว่าจ่ายแล้ว" แค่คำนวณเองว่า
        // ยอดที่ต้องจ่ายจริงคือ 0 บาทจากราคา/ส่วนลดที่คำนวณฝั่ง server ทั้งหมด)
        let paymentPayload = {};
        if (total === 0) {
            await settlePaidOrder(ord_id);
        } else if (stripeClient.isConfigured()) {
            try {
                // PromptPay ของ Stripe บังคับต้องมี billing_details.email เสมอ (ทดสอบจริงแล้วเจอ error
                // "Missing required param: billing_details[email]" ถ้าไม่ส่ง) ใช้เพื่อให้ Stripe ติดต่อลูกค้า
                // กรณีต้องคืนเงิน (ดู docs.stripe.com/payments/promptpay#refunds) — สมัครสมาชิกบังคับกรอกอีเมล
                // อยู่แล้ว (ดู customerAuth.controller.js) จึงควรมีเสมอ แต่เผื่อ null (เช่น บัญชีที่แอดมินสร้างเอง)
                const [[customer]] = await pool.query("SELECT cus_email FROM tb_customers WHERE cus_id = ?", [req.customer.cus_id]);
                if (!customer?.cus_email) throw new Error("บัญชีนี้ยังไม่มีอีเมล กรุณาเพิ่มอีเมลในหน้าบัญชีก่อนชำระเงินผ่าน QR");

                const intent = await stripeClient.createPromptPayIntent({
                    amountSatang: Math.round(total * 100),
                    orderId: ord_id,
                    email: customer.cus_email,
                });
                const qrCode = intent?.next_action?.promptpay_display_qr_code;
                const qrImageUrl = qrCode?.image_url_png ?? null;
                // ไม่มี field วันหมดอายุจาก Stripe ให้เหมือน Omise — คำนวณเองด้วย TTL คงที่เสมอ (ดูคอมเมนต์
                // บนสุดของไฟล์นี้ที่ PROMPTPAY_QR_TTL_MS)
                const qrExpiresAt = new Date(Date.now() + PROMPTPAY_QR_TTL_MS);
                await pool.query(
                    "UPDATE tb_orders SET ord_omise_charge_id = ?, ord_qr_image_url = ?, ord_qr_expires_at = ? WHERE ord_id = ?",
                    [intent.id, qrImageUrl, qrExpiresAt, ord_id]
                );
                paymentPayload = { qr_image_url: qrImageUrl, qr_expires_at: qrExpiresAt };
            } catch (err) {
                // ออเดอร์ pending ถูกสร้างไปแล้ว แค่สร้าง QR ไม่สำเร็จ (เช่น Stripe ล่มชั่วคราว) — ไม่ throw
                // ทิ้งทั้ง checkout เพราะออเดอร์ยังใช้ต่อได้ผ่านหน้า "รอการยืนยัน" + แอดมิน manual confirm
                console.error("Stripe createPromptPayIntent failed:", err.message);
            }
        }
        // stripeClient ยังไม่ configure (ยังไม่ตั้งค่า STRIPE_SECRET_KEY) — ปล่อยผ่านเงียบๆ ไม่เรียก Stripe เลย
        // order ยังสร้างสำเร็จปกติ ค้างสถานะ pending รอ mock confirmPayment (ถ้าเปิดไว้ใน dev) หรือ
        // แอดมิน manual confirm แทน

        res.status(201).json({ ord_id, subtotal, discount, total, ...paymentPayload });
    } catch (err) {
        next(err);
    }
}

// ─── settlePaidOrder — logic กลางที่ "ยืนยันจ่ายเงินสำเร็จแล้วจริง" ต้องเรียกจุดเดียว (grant สิทธิ์ +
// บันทึกรายได้ + ปิดออเดอร์เป็น paid) ทั้ง confirmPayment (mock, customer เรียกเอง) และ webhook จริง
// ในอนาคต (handlePaymentWebhook ด้านล่าง) เรียกจุดนี้เหมือนกันเป๊ะ ต่างกันแค่ "ใครเป็นคนเรียก"
// ไม่เช็ค ord_customer_id ในนี้ตั้งใจ เพราะ webhook ไม่มี req.customer ให้เทียบ (ผู้เรียกต้องเช็คสิทธิ์เอง
// ก่อนเรียกฟังก์ชันนี้ถ้าจำเป็น เช่น confirmPayment เช็คความเป็นเจ้าของออเดอร์ก่อนเรียกแล้ว)
//
// idempotency: "claim ก่อนแล้วค่อยประมวลผล" — UPDATE...WHERE ord_status='pending' เป็น atomic operation
// เดียวระดับแถวใน InnoDB เอง (ไม่ต้องพึ่ง transaction ครอบ) ใช้ affectedRows ตัดสินว่า "เราเป็นคนแรกที่
// claim ออเดอร์นี้สำเร็จ" หรือไม่ ก่อนเดิมเช็คด้วย SELECT แยกจาก UPDATE ตอนจบ (คนละ query) มีช่องว่างเวลา
// (TOCTOU) ให้ webhook ยิงซ้ำพร้อมกัน 2 ครั้งเห็น ord_status='pending' พร้อมกันทั้งคู่แล้ว grant+บันทึกยอด
// ขาย "ซ้ำสอง" ได้ — ย้ายมา claim ด้วย UPDATE เดียวตั้งแต่ต้นฟังก์ชันปิดช่องนี้ได้เลยโดยไม่ต้องรีแฟกเตอร์
// grantOrRenewProduct/incrementUsage/recordSale ให้รับ transaction connection เพิ่ม
async function settlePaidOrder(orderId) {
    const [rows] = await pool.query(
        `SELECT ord_id, ord_customer_id, ord_coupon_id, ord_package_id, ord_subtotal, ord_total, ord_discount,
                ord_omise_charge_id
         FROM tb_orders WHERE ord_id = ?`,
        [orderId]
    );
    const order = rows[0];
    if (!order) {
        const err = new Error("ไม่พบคำสั่งซื้อนี้");
        err.status = 404;
        throw err;
    }

    const [claimResult] = await pool.query(
        "UPDATE tb_orders SET ord_status = 'paid', ord_paid_at = NOW() WHERE ord_id = ? AND ord_status = 'pending'",
        [order.ord_id]
    );
    if (claimResult.affectedRows === 0) {
        return { alreadySettled: true }; // ยิงซ้ำ (เช่น webhook retry) หรือ order ไม่ได้อยู่สถานะ pending แล้ว — ถือว่าสำเร็จเงียบๆ ไม่ทำซ้ำ
    }

    // join ดึง prod_entitlement_duration_months มาด้วย — ตั้งได้แยกรายชุดข้อสอบ (NULL = lifetime) เพื่อส่ง
    // เป็น durationMonths ให้ grantOrRenewProduct() แทนค่า null ตายตัวแบบเดิม (เดิม grant ฝั่งลูกค้าซื้อเอง
    // เป็น lifetime เสมอไม่ว่า product ไหน) — ไม่กระทบสิทธิ์เดิมที่ลูกค้าถืออยู่แล้วก่อนหน้านี้เลย
    // ดึง prod_name/oi_total มาด้วยเพื่อใช้ในใบเสร็จที่ส่งอีเมลท้ายฟังก์ชัน (query เดิมอยู่แล้ว ไม่ได้ยิงเพิ่ม)
    const [items] = await pool.query(
        `SELECT oi.oi_product_id, oi.oi_price, oi.oi_total, p.prod_name, p.prod_entitlement_duration_months
         FROM tb_order_items oi
         JOIN tb_products p ON p.prod_id = oi.oi_product_id
         WHERE oi.oi_order_id = ?`,
        [order.ord_id]
    );
    const productIds = items.map((i) => i.oi_product_id);

    let coupon = null;
    if (order.ord_coupon_id) {
        const [couponRows] = await pool.query("SELECT * FROM tb_coupons WHERE cpn_id = ?", [order.ord_coupon_id]);
        coupon = couponRows[0] ?? null;
    }

    const entitlementIds = [];
    for (const item of items) {
        const entId = await grantOrRenewProduct(order.ord_customer_id, item.oi_product_id, null, item.prod_entitlement_duration_months, "payment");
        if (entId) entitlementIds.push(entId);
    }
    if (coupon) await incrementUsage(coupon.cpn_id);

    // ค่าธรรมเนียม gateway หักเฉพาะออเดอร์ที่มี Stripe payment intent จริงเท่านั้น (เช็คจาก ord_omise_charge_id
    // ซึ่งยังคงชื่อคอลัมน์เดิมไว้ แต่เก็บ Stripe payment intent id แล้ว — ไม่ใช่ ord_total > 0) เพราะออเดอร์
    // อาจค้าง pending แบบมียอดเงินแต่ไม่เคยถูกส่งไป Stripe เลยก็ได้ (เช่น Stripe ล่มตอน checkout, หรือยังไม่ตั้งค่า
    // Stripe) ถ้าแอดมิน force-confirm ออเดอร์แบบนั้นทีหลังต้อง "ไม่" โดนหักค่าธรรมเนียมผี เพราะไม่มีการหักจริงเกิดขึ้นเลย
    const feePercent = await settingsController.getPaymentGatewayFeePercent();
    const gatewayFee = order.ord_omise_charge_id ? (Number(order.ord_total) * feePercent) / 100 : 0;

    // ส่ง ord_discount ที่ checkout() คำนวณไว้ถูกต้องอยู่แล้วเข้าไปตรงๆ (ครอบคลุมทั้งส่วนลดคูปองและ
    // ส่วนลดแพ็กเกจ) แทนที่จะปล่อยให้ recordSale คำนวณจาก coupon อย่างเดียว — เพราะออเดอร์จากแพ็กเกจ
    // ไม่มี ord_coupon_id เลย (เป็น NULL) ถ้าไม่ส่ง override ไป ส่วนลดแพ็กเกจจะหายไปเงียบๆ ตอนบันทึกยอดขาย
    await recordSale(order.ord_customer_id, productIds, coupon, null, gatewayFee, Number(order.ord_discount), order.ord_package_id);

    await sendReceiptEmail(order, items, entitlementIds);

    return { alreadySettled: false };
}

// ส่งใบเสร็จให้ลูกค้าหลัง settle สำเร็จ — อยู่หลัง claim แบบ atomic ของ settlePaidOrder เสมอ จึงส่งได้
// ครั้งเดียวต่อออเดอร์โดยอัตโนมัติ ไม่ว่า webhook จะยิงซ้ำกี่รอบ (ยิงซ้ำจะ return ที่ alreadySettled ไปก่อน
// ถึงบรรทัดนี้) — ครอบ try/catch ทั้งก้อนเพราะ **ห้ามให้การส่งอีเมลทำให้การให้สิทธิ์ล้ม** ลูกค้าจ่ายเงินแล้ว
// ต้องได้ของเสมอ ต่อให้ SMTP ล่มหรือยังไม่ได้ตั้งค่าก็ตาม (sendMail เองก็ไม่ throw อยู่แล้ว แต่ query
// ดึงข้อมูลลูกค้า/สิทธิ์ที่นี่ throw ได้)
async function sendReceiptEmail(order, items, entitlementIds) {
    try {
        const [customerRows] = await pool.query(
            "SELECT cus_email, cus_fname, cus_lname, cus_username FROM tb_customers WHERE cus_id = ?",
            [order.ord_customer_id]
        );
        const customer = customerRows[0];
        if (!customer?.cus_email) {
            console.warn(`[receipt] ออเดอร์ ${order.ord_id}: ลูกค้าไม่มีอีเมลในระบบ ข้ามการส่งใบเสร็จ`);
            return;
        }

        // อ่านวันหมดอายุจริงหลัง grant/ต่ออายุเสร็จแล้ว (ไม่คำนวณซ้ำเองที่นี่) เพื่อให้เลขในใบเสร็จตรงกับ
        // สิทธิ์จริงใน DB เสมอ รวมถึงเคสซื้อซ้ำที่เป็นการ "ต่ออายุ" จากวันหมดอายุเดิม ไม่ใช่นับใหม่จากวันนี้
        let entitlements = [];
        if (entitlementIds.length) {
            const [entRows] = await pool.query(
                `SELECT e.ent_expires_at, p.prod_name
                 FROM tb_entitlements e JOIN tb_products p ON p.prod_id = e.ent_product_id
                 WHERE e.ent_id IN (?)`,
                [entitlementIds]
            );
            entitlements = entRows;
        }

        // ord_paid_at เพิ่งถูกตั้งเป็น NOW() ใน UPDATE ด้านบน แต่ order object ในหน่วยความจำยังเป็นค่าก่อนหน้า
        // (NULL) — ส่งเวลาปัจจุบันเข้าไปแทน ตรงกับที่บันทึกลง DB ในวินาทีเดียวกัน
        const { subject, html } = buildReceiptEmail({
            order: { ...order, ord_paid_at: new Date() },
            items,
            customer,
            entitlements,
        });
        await sendMail({ to: customer.cus_email, subject, html });
    } catch (err) {
        console.error(`[receipt] ส่งใบเสร็จออเดอร์ ${order.ord_id} ไม่สำเร็จ:`, err.message);
    }
}

// ─── cancelOrder — logic กลางที่ "ยกเลิกคำสั่งซื้อที่ยังไม่จ่าย" ต้องเรียกจุดเดียว เหมือน settlePaidOrder
// ใช้ร่วมกันทั้งลูกค้ายกเลิกเอง (cancelMyOrder) และแอดมินยกเลิกจากหน้า /orders (order.controller.js)
// ไม่เช็ค ord_customer_id ในนี้ตั้งใจเหมือนกัน — ผู้เรียกต้องเช็คความเป็นเจ้าของออเดอร์เองก่อนถ้าจำเป็น
//
// สำคัญ: ต้องเช็คสถานะจริงกับ Stripe ก่อนยกเลิกเสมอ (ถ้ามี payment intent ผูกอยู่) กันเคส race ที่ลูกค้า
// กดยกเลิกพอดีจังหวะเดียวกับที่เพิ่งจ่ายสำเร็จจริง (สแกน QR ไปแล้วแต่ webhook ยังมาไม่ถึง) — ถ้ายกเลิกไปตรงๆ
// โดยไม่เช็ค จะเกิดเคสร้ายแรง: ลูกค้าจ่ายเงินจริงไปแล้ว (เงินออกจากบัญชีจริง) แต่ order ถูกยกเลิกไปก่อน พอ
// webhook มาถึงทีหลัง settlePaidOrder() จะเจอว่า ord_status ไม่ใช่ 'pending' แล้ว (alreadySettled เงียบๆ)
// ไม่ให้สิทธิ์อะไรเลย กลายเป็นลูกค้าเสียเงินฟรีไม่ได้อะไรตอบแทน — ถ้าเช็คแล้วเจอว่า Stripe บอกว่า succeeded
// จริง ต้อง settle ให้สิทธิ์แทนการยกเลิก แล้วแจ้ง error กลับไปว่ายกเลิกไม่ได้เพราะจ่ายสำเร็จไปแล้วพอดี
// (ใช้ pattern เดียวกับ jobs/orderExpirySweep.js ที่ตรวจสอบก่อนยกเลิกอัตโนมัติเป๊ะ)
async function cancelOrder(orderId) {
    const [rows] = await pool.query(
        "SELECT ord_id, ord_status, ord_total, ord_omise_charge_id FROM tb_orders WHERE ord_id = ?",
        [orderId]
    );
    const order = rows[0];
    if (!order) {
        const err = new Error("ไม่พบคำสั่งซื้อนี้");
        err.status = 404;
        throw err;
    }
    if (order.ord_status !== "pending") {
        const err = new Error("คำสั่งซื้อนี้ไม่ได้อยู่ในสถานะรอชำระเงินแล้ว ไม่สามารถยกเลิกได้");
        err.status = 400;
        throw err;
    }

    if (order.ord_omise_charge_id && stripeClient.isConfigured()) {
        const liveIntent = await stripeClient.getPaymentIntent(order.ord_omise_charge_id);
        if (liveIntent?.status === "succeeded") {
            const expectedSatang = Math.round(Number(order.ord_total) * 100);
            if (liveIntent.amount === expectedSatang) {
                await settlePaidOrder(order.ord_id);
            }
            const err = new Error("คำสั่งซื้อนี้ชำระเงินสำเร็จไปแล้วพอดี ไม่สามารถยกเลิกได้ กรุณารีเฟรชหน้าใหม่");
            err.status = 409;
            throw err;
        }
    }

    // atomic claim เหมือน settlePaidOrder — กันกดยกเลิกซ้ำ/ยกเลิกพร้อมกันหลาย request
    const [claimResult] = await pool.query(
        "UPDATE tb_orders SET ord_status = 'cancelled' WHERE ord_id = ? AND ord_status = 'pending'",
        [order.ord_id]
    );
    if (claimResult.affectedRows === 0) {
        const err = new Error("คำสั่งซื้อนี้ไม่ได้อยู่ในสถานะรอชำระเงินแล้ว ไม่สามารถยกเลิกได้");
        err.status = 400;
        throw err;
    }

    if (order.ord_omise_charge_id && stripeClient.isConfigured()) {
        await stripeClient.cancelPaymentIntent(order.ord_omise_charge_id);
    }

    return { cancelled: true };
}

// ลูกค้ายกเลิกคำสั่งซื้อของตัวเองที่ยังไม่จ่าย — ต้องเช็คความเป็นเจ้าของออเดอร์ก่อนเรียก cancelOrder() เสมอ
// (ต่างจาก settlePaidOrder ที่ webhook เรียกได้โดยไม่ผ่าน req.customer)
async function cancelMyOrder(req, res, next) {
    try {
        const [rows] = await pool.query(
            "SELECT ord_id FROM tb_orders WHERE ord_id = ? AND ord_customer_id = ?",
            [req.params.id, req.customer.cus_id]
        );
        if (!rows[0]) return res.status(404).json({ message: "ไม่พบคำสั่งซื้อนี้" });

        await cancelOrder(req.params.id);
        res.json({ message: "ยกเลิกคำสั่งซื้อสำเร็จ" });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ message: err.message });
        next(err);
    }
}

// ─── ยืนยันจ่ายเงิน — จุด "mock" สำหรับ dev/test เท่านั้น ตอบสำเร็จทันทีไม่เช็คอะไรจริง เปิดใช้ได้
// ก็ต่อเมื่อ ALLOW_MOCK_PAYMENT_CONFIRM=true **และ** ยังไม่ได้ตั้งค่า Stripe จริง (สองเงื่อนไขพร้อมกัน —
// กันหลุดไปใช้งานจริงโดยไม่ตั้งใจ) route ฝั่ง store.routes.js เช็คซ้ำอีกชั้นก่อนจะ mount route นี้ด้วย
// การ์อยู่ตรงนี้เป็น defense-in-depth เผื่อวันหลังมีคนย้าย/mount route ผิดที่
async function confirmPayment(req, res, next) {
    try {
        if (process.env.ALLOW_MOCK_PAYMENT_CONFIRM !== "true" || stripeClient.isConfigured()) {
            return res.status(404).json({ message: "ไม่พบ endpoint นี้" });
        }

        const [rows] = await pool.query(
            "SELECT ord_id FROM tb_orders WHERE ord_id = ? AND ord_customer_id = ?",
            [req.params.id, req.customer.cus_id]
        );
        if (!rows[0]) return res.status(404).json({ message: "ไม่พบคำสั่งซื้อนี้" });

        const result = await settlePaidOrder(req.params.id);
        if (result.alreadySettled) {
            return res.status(400).json({ message: "คำสั่งซื้อนี้ไม่ได้อยู่ในสถานะรอชำระเงิน" });
        }

        res.json({ message: "ชำระเงินสำเร็จ" });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ message: err.message });
        next(err);
    }
}

// ─── webhook จริงจาก Stripe — public endpoint, Stripe ยิงมาเอง ไม่มี customer token แนบมาด้วย ต้อง
// พิสูจน์ตัวตนด้วย signature แทน (ไม่ใช่ req.customer) ตามกฎเหล็กข้อ 2 ใน CLAUDE.md
//
// verify ผ่าน stripeClient.constructWebhookEvent() (ใช้ SDK ทางการแทนเขียน HMAC เอง — Stripe แนะนำแบบนี้
// เพราะ SDK มี timestamp tolerance กัน replay attack ในตัว) header คือ Stripe-Signature รูปแบบ
// "t=<timestamp>,v1=<signature>[,v0=...]" ต้องใช้ req.rawBody ที่เก็บไว้ใน app.js เป๊ะๆ เหมือนเดิม
// (ไม่ใช่ req.body ที่ parse แล้ว เพราะ re-serialize อาจได้ byte ไม่ตรงต้นฉบับ)
async function handlePaymentWebhook(req, res, next) {
    try {
        let event;
        try {
            event = stripeClient.constructWebhookEvent(req.rawBody, req.headers["stripe-signature"]);
        } catch (err) {
            return res.status(401).json({ message: "ลายเซ็นไม่ถูกต้อง" });
        }

        if (event.type !== "payment_intent.succeeded") {
            return res.json({ received: true }); // event อื่นที่ไม่เกี่ยวผลจ่ายเงิน (เช่น payment_intent.created) รับทราบเฉยๆ ไม่ต้องทำอะไร
        }
        const intentId = event.data?.object?.id;
        if (!intentId) return res.json({ received: true });

        // defense-in-depth: ไม่เชื่อ payload ใน webhook เฉยๆ re-fetch สถานะจริงจาก Stripe อีกที (กฎเหล็ก
        // ข้อ 2 บอกให้ verify signature อยู่แล้ว แต่ Stripe เองแนะนำให้ยืนยันซ้ำแบบนี้เผื่อ signature รั่ว)
        const liveIntent = await stripeClient.getPaymentIntent(intentId);
        if (!liveIntent) return res.status(502).json({ message: "ตรวจสอบสถานะกับ Stripe ไม่สำเร็จ" });
        if (liveIntent.status !== "succeeded") {
            return res.json({ received: true }); // ไม่น่าเกิดขึ้นเพราะ event นี้แปลว่า succeeded อยู่แล้ว แต่กันไว้เผื่อสถานะเปลี่ยนไปแล้วระหว่างทาง
        }

        const [rows] = await pool.query(
            "SELECT ord_id, ord_total FROM tb_orders WHERE ord_omise_charge_id = ?",
            [liveIntent.id]
        );
        const order = rows[0];
        if (!order) return res.status(404).json({ message: "ไม่พบคำสั่งซื้อที่ตรงกับ payment intent นี้" });

        // ยืนยันยอดเงินฝั่ง backend เสมอ (กฎเหล็กข้อ 4) — ห้ามเชื่อแค่ status ว่า "succeeded" เฉยๆ
        const expectedSatang = Math.round(Number(order.ord_total) * 100);
        if (liveIntent.amount !== expectedSatang || liveIntent.currency !== "thb") {
            return res.status(409).json({ message: "ยอดเงินไม่ตรงกับคำสั่งซื้อ" });
        }

        await settlePaidOrder(order.ord_id); // idempotent อยู่แล้ว (atomic claim) — webhook ยิงซ้ำได้ปลอดภัย
        res.json({ received: true });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ message: err.message });
        next(err);
    }
}

// รายการคำสั่งซื้อทั้งหมดของลูกค้าคนที่ login อยู่ — เดิมมีแต่ getOrder รายใบ ลูกค้าที่ปิดแท็บทิ้งไปแล้ว
// หาออเดอร์ตัวเองไม่เจอเลยถ้าไม่มีลิงก์เก็บไว้
//
// ดึงชื่อชุดข้อสอบมาด้วยแบบ query เดียว (GROUP_CONCAT) ไม่ยิงรายออเดอร์วนลูป — หน้าลิสต์อยากโชว์ว่า
// ออเดอร์นั้นซื้ออะไรบ้างโดยไม่ต้องกดเข้าไปดูทีละใบ ถ้ายิงทีละใบจะกลายเป็น N+1 query ทันทีที่ลูกค้ามี
// ประวัติเยอะ (ORDER BY oi_id ให้ลำดับชื่อคงที่ทุกครั้งที่โหลด ไม่สลับไปมา)
async function getMyOrders(req, res, next) {
    try {
        const limit = Math.min(Number(req.query.limit) || 20, 100);
        const offset = Number(req.query.offset) || 0;

        const [rows] = await pool.query(
            `SELECT o.ord_id, o.ord_subtotal, o.ord_discount, o.ord_total, o.ord_status,
                    o.ord_paid_at, o.ord_created_at, o.ord_qr_expires_at,
                    COUNT(oi.oi_id) AS item_count,
                    GROUP_CONCAT(p.prod_name ORDER BY oi.oi_id SEPARATOR ' | ') AS product_names
             FROM tb_orders o
             LEFT JOIN tb_order_items oi ON oi.oi_order_id = o.ord_id
             LEFT JOIN tb_products p ON p.prod_id = oi.oi_product_id
             WHERE o.ord_customer_id = ?
             GROUP BY o.ord_id
             ORDER BY o.ord_created_at DESC
             LIMIT ? OFFSET ?`,
            [req.customer.cus_id, limit, offset]
        );

        const [countRows] = await pool.query(
            "SELECT COUNT(*) AS total FROM tb_orders WHERE ord_customer_id = ?",
            [req.customer.cus_id]
        );

        const data = rows.map((row) => ({
            ...row,
            item_count: Number(row.item_count),
            product_names: row.product_names ? row.product_names.split(" | ") : [],
        }));

        res.json({ data, total: countRows[0].total });
    } catch (err) {
        next(err);
    }
}

async function getOrder(req, res, next) {
    try {
        const [rows] = await pool.query(
            `SELECT ord_id, ord_subtotal, ord_discount, ord_total, ord_status, ord_paid_at, ord_created_at,
                    ord_omise_charge_id, ord_qr_image_url, ord_qr_expires_at
             FROM tb_orders WHERE ord_id = ? AND ord_customer_id = ?`,
            [req.params.id, req.customer.cus_id]
        );
        let order = rows[0];
        if (!order) return res.status(404).json({ message: "ไม่พบคำสั่งซื้อนี้" });

        // self-heal: ลูกค้าเปิด/poll หน้านี้ตอนออเดอร์ยัง pending และมี payment intent ผูกอยู่แล้ว → เช็คสถานะจริง
        // กับ Stripe ตรงๆ อีกที เผื่อ webhook มาช้า/ตกหล่น (หรือ dev local ไม่มี public URL ให้ Stripe ยิงมาได้
        // เลย) — น่าเชื่อถือเท่า webhook เพราะเป็น backend ถาม Stripe เอง ไม่ใช่เชื่อ client จึงไม่ผิดกฎเหล็ก
        // ข้อ 1 (ที่ห้ามแค่ "เชื่อว่าลูกค้าจ่ายแล้วเพราะ redirect กลับมา" ไม่ได้ห้าม backend ไปเช็คเอง)
        if (order.ord_status === "pending" && order.ord_omise_charge_id && stripeClient.isConfigured()) {
            const liveIntent = await stripeClient.getPaymentIntent(order.ord_omise_charge_id);
            const expectedSatang = Math.round(Number(order.ord_total) * 100);
            if (liveIntent?.status === "succeeded" && liveIntent.amount === expectedSatang) {
                await settlePaidOrder(order.ord_id);
                order = { ...order, ord_status: "paid" };
            }
        }

        const [items] = await pool.query(
            `SELECT oi.oi_product_id, p.prod_name, oi.oi_price, oi.oi_discount, oi.oi_total
             FROM tb_order_items oi JOIN tb_products p ON p.prod_id = oi.oi_product_id
             WHERE oi.oi_order_id = ?`,
            [req.params.id]
        );

        res.json({ ...order, items });
    } catch (err) {
        next(err);
    }
}

async function getMyEntitlements(req, res, next) {
    try {
        const [rows] = await pool.query(
            `SELECT e.ent_id, e.ent_product_id, p.prod_name, p.prod_cover_url, e.ent_granted_at, e.ent_expires_at,
                    CASE
                        WHEN e.ent_status = 'revoked' THEN 'revoked'
                        WHEN e.ent_expires_at IS NOT NULL AND e.ent_expires_at < NOW() THEN 'expired'
                        ELSE 'active'
                    END AS effective_status
             FROM tb_entitlements e
             JOIN tb_products p ON p.prod_id = e.ent_product_id
             WHERE e.ent_customer_id = ?
             ORDER BY e.ent_granted_at DESC`,
            [req.customer.cus_id]
        );
        res.json({ data: rows });
    } catch (err) {
        next(err);
    }
}

module.exports = {
    getPublicProducts, getPublicProduct, getPopularProducts, getPublicCategories, getSampleQuestions, getPublicPackages, checkout, confirmPayment,
    handlePaymentWebhook, getOrder, getMyOrders, getMyEntitlements, cancelMyOrder,
    settlePaidOrder, cancelOrder, isPaymentGatewayConfigured: stripeClient.isConfigured,
};
