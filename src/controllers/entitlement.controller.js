const pool = require("../config/db");
const { generateId, generateIds } = require("../utils/generateId");
const { findValidCoupon, incrementUsage } = require("./coupon.controller");
const { getEffectivePrice } = require("../utils/pricing");

// grantProduct — จุดเดียวที่ให้สิทธิ์เข้าถึง product กับ customer (ตาม CLAUDE.md ข้อ 2)
// ทุกช่องทางขาย (manual/payment/renewal) ต้องเรียกผ่านฟังก์ชันนี้เท่านั้น ไม่ insert tb_entitlements ตรงๆ ที่อื่น
// ไม่เช็คซ้ำว่า customer ถือ product นี้อยู่แล้วหรือไม่ เพราะ schema ตั้งใจไม่ unique (customer, product)
// เพื่อรองรับการต่ออายุ/ซื้อซ้ำ — ปล่อยให้มีหลายแถวได้ตามการออกแบบเดิม
async function grantProduct(customerId, productId, grantedById, durationMonths, grantedVia = "manual") {
    const ent_id = await generateId("tb_entitlements", "ENT");
    const expiresSql = durationMonths ? "DATE_ADD(NOW(), INTERVAL ? MONTH)" : "NULL";
    const params = [ent_id, customerId, productId, grantedVia, grantedById];
    if (durationMonths) params.push(durationMonths);

    await pool.query(
        `INSERT INTO tb_entitlements
            (ent_id, ent_customer_id, ent_product_id, ent_granted_via, ent_granted_by_id, ent_expires_at)
         VALUES (?, ?, ?, ?, ?, ${expiresSql})`,
        params
    );
    return ent_id;
}

// ใช้เฉพาะฝั่งลูกค้าเช็คเอาท์เอง (ไม่ใช่แอดมิน grant มือ) — ถ้าลูกค้ายังถือสิทธิ์ product นี้อยู่จริง
// (active ไม่หมดอายุ) ให้ "ต่ออายุ" จากวันหมดอายุเดิมแทนสร้างแถวใหม่ซ้ำ กันรู้สึกเสียเงินฟรีตอนซื้อซ้ำ/
// ซื้อผ่าน package ที่มี product ที่ถืออยู่แล้ว (ตามที่ตกลงไว้ในแผนงาน) — ไม่แตะ lifetime (expires_at
// เป็น NULL) เด็ดขาดไม่ว่าทางใด เพราะเป็นสิทธิ์ที่ดีที่สุดอยู่แล้ว ไม่มีทางทำให้ดีขึ้นกว่านี้
async function grantOrRenewProduct(customerId, productId, grantedById, durationMonths, grantedVia = "payment") {
    const hasAccess = await hasActiveEntitlement(customerId, productId);
    if (!hasAccess) {
        return grantProduct(customerId, productId, grantedById, durationMonths, grantedVia);
    }

    const [rows] = await pool.query(
        `SELECT ent_id, ent_expires_at FROM tb_entitlements
         WHERE ent_customer_id = ? AND ent_product_id = ? AND ent_status = 'active'
           AND (ent_expires_at IS NULL OR ent_expires_at > NOW())
         ORDER BY ent_expires_at IS NULL DESC, ent_expires_at DESC LIMIT 1`,
        [customerId, productId]
    );
    const existing = rows[0];

    if (existing.ent_expires_at === null) {
        return existing.ent_id; // lifetime อยู่แล้ว ไม่มีอะไรต้องทำ
    }
    if (!durationMonths) {
        // ของใหม่ให้ lifetime แต่ของเดิมมีวันหมดอายุ → อัปเกรดเป็น lifetime
        await pool.query("UPDATE tb_entitlements SET ent_expires_at = NULL WHERE ent_id = ?", [existing.ent_id]);
        return existing.ent_id;
    }

    await pool.query(
        "UPDATE tb_entitlements SET ent_expires_at = DATE_ADD(ent_expires_at, INTERVAL ? MONTH) WHERE ent_id = ?",
        [durationMonths, existing.ent_id]
    );
    return existing.ent_id;
}

// เช็คว่า customer ถือสิทธิ์ product นี้อยู่จริงหรือไม่ ณ ตอนนี้ — ใช้ predicate เดียวกับที่ schema
// กำหนดไว้ (create_products_exams.sql ข้อ 5): status='active' AND (expires_at IS NULL OR expires_at > NOW())
// จุดเดียวที่ทุก endpoint ฝั่งลูกค้า (เริ่มทำข้อสอบ, ดูรีวิว ฯลฯ) ต้องเรียกเช็คก่อนเสมอ
async function hasActiveEntitlement(customerId, productId) {
    const [rows] = await pool.query(
        `SELECT 1 FROM tb_entitlements
         WHERE ent_customer_id = ? AND ent_product_id = ? AND ent_status = 'active'
           AND (ent_expires_at IS NULL OR ent_expires_at > NOW())
         LIMIT 1`,
        [customerId, productId]
    );
    return rows.length > 0;
}

// คิดส่วนลดจากราคารวม — สูตรเดียวกับที่ GrantProductsModal โชว์ให้แอดมินดูตอนเลือกชุดข้อสอบ
// (fixed ตัดที่ subtotal กันติดลบ) ต้องคำนวณซ้ำฝั่ง backend เพราะเป็นตัวเลขที่จะบันทึกเป็นรายได้จริง
// ห้ามเชื่อเลขที่ frontend ส่งมาเด็ดขาด
function calculateDiscount(subtotal, coupon) {
    if (!coupon) return 0;
    if (coupon.cpn_discount_type === "percent") return subtotal * (Number(coupon.cpn_discount_value) / 100);
    return Math.min(subtotal, Number(coupon.cpn_discount_value));
}

// ค่าคอมของ item หนึ่ง — คำนวณจากยอดหลังหักส่วนลดของ item นั้น (item_total) ไม่ใช่ราคาเต็ม
// เพราะเป็นเงินที่ลูกค้าจ่ายจริง fixed capped ที่ item_total กันจ่ายค่าคอมเกินยอดขายจริง
function calculateItemCommission(itemTotal, product) {
    if (!product.prod_commission_staff_id || !product.prod_commission_type || !product.prod_commission_value) {
        return 0;
    }
    if (product.prod_commission_type === "percent") {
        return itemTotal * (Number(product.prod_commission_value) / 100);
    }
    return Math.min(itemTotal, Number(product.prod_commission_value));
}

// บันทึกรายได้ทันทีที่ grant สิทธิ์สำเร็จ — ผูกรายได้กับการขายจริงโดยตรงตามที่ตกลงกันไว้ (ไม่ใช่ auto
// จากระบบ checkout เพราะยังไม่มี) ราคาคำนวณจาก tb_products.prod_price ณ เวลา grant จริง ไม่ใช่ราคาที่
// frontend ส่งมา กันแก้ตัวเลขรายได้ผ่าน request body ได้
//
// tb_sales เก็บยอดรวมทั้งออเดอร์ (หัวบิล) ส่วน tb_sale_items แยกเป็นบรรทัดต่อ product เพื่อคำนวณ
// "รายได้/กำไร/ค่าคอมต่อโปรดัก" ได้ทีหลัง — ส่วนลดของออเดอร์เฉลี่ยลงแต่ละ item ตามสัดส่วนราคา
// (เช่น product ราคาแพงกว่าได้ส่วนลดสัมบูรณ์มากกว่า แต่สัดส่วน % เท่ากันทุก item)
// gatewayFee: ค่าธรรมเนียม payment gateway ที่ถูกหักจริง (0 = ไม่ได้ผ่าน gateway เช่น grant มือ)
// discountOverride: ถ้าไม่ใช่ null ใช้แทน calculateDiscount(subtotal, coupon) ตรงๆ — จำเป็นสำหรับออเดอร์
// ที่มาจากแพ็กเกจ เพราะส่วนลดแพ็กเกจไม่ได้ผูกกับ coupon เลย (ord_coupon_id เป็น NULL) คำนวณจาก
// subtotal - pkg_price ไว้แล้วตั้งแต่ตอน checkout() ต้องส่งค่านั้นมาตรงนี้ ไม่งั้นส่วนลดจะหายไปเงียบๆ
// packageId: แพ็กเกจต้นทางถ้าออเดอร์นี้มาจากการซื้อแพ็กเกจ (metadata เฉยๆ ไม่กระทบยอดเงิน) — null สำหรับ
// grant มือ/ซื้อ product เดี่ยว
async function recordSale(customerId, productIds, coupon, createdById, gatewayFee = 0, discountOverride = null, packageId = null) {
    const [products] = await pool.query(
        `SELECT prod_id, prod_price, prod_is_free, prod_commission_staff_id, prod_commission_type, prod_commission_value
         FROM tb_products WHERE prod_id IN (?)`,
        [productIds]
    );
    const productById = {};
    for (const p of products) productById[p.prod_id] = p;

    // ใช้ getEffectivePrice() เสมอ ไม่อ่าน prod_price ตรงๆ — product ที่ prod_is_free=TRUE ต้องนับเป็น 0
    // ไม่ว่า prod_price จะตั้งไว้เป็นเท่าไหร่ (เช่น ตั้งไว้โชว์ "ปกติ 299 บาท ฟรี!")
    const subtotal = productIds.reduce((sum, id) => sum + getEffectivePrice(productById[id]), 0);
    const discount = discountOverride !== null ? discountOverride : calculateDiscount(subtotal, coupon);
    const total = Math.max(0, subtotal - discount);

    const sale_id = await generateId("tb_sales", "SAL");
    await pool.query(
        `INSERT INTO tb_sales
            (sale_id, sale_customer_id, sale_subtotal, sale_discount, sale_total, sale_gateway_fee, sale_coupon_id, sale_package_id, sale_product_count, sale_created_by_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [sale_id, customerId, subtotal, discount, total, gatewayFee, coupon?.cpn_id ?? null, packageId, productIds.length, createdById]
    );

    const itemIds = await generateIds("tb_sale_items", "SIT", productIds.length);
    for (let i = 0; i < productIds.length; i++) {
        const product = productById[productIds[i]];
        const price = getEffectivePrice(product);
        // เฉลี่ยส่วนลดตามสัดส่วนราคา — ถ้า subtotal เป็น 0 (ราคาทุก product เป็น 0 หรือแจกฟรีหมด) ไม่ต้องหารด้วย 0
        const itemDiscount = subtotal > 0 ? discount * (price / subtotal) : 0;
        const itemTotal = Math.max(0, price - itemDiscount);
        const commissionAmount = calculateItemCommission(itemTotal, product ?? {});

        await pool.query(
            `INSERT INTO tb_sale_items
                (si_id, si_sale_id, si_product_id, si_price, si_discount, si_total, si_commission_staff_id, si_commission_amount)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                itemIds[i], sale_id, productIds[i], price, itemDiscount, itemTotal,
                product?.prod_commission_staff_id ?? null, commissionAmount,
            ]
        );
    }

    return sale_id;
}

// ให้สิทธิ์หลาย product พร้อมกันในคำขอเดียว — ใช้ตอนแอดมินเลือกชุดข้อสอบให้ลูกค้าใน modal
// (เช่น ตอนสร้างลูกค้าใหม่) durationMonths รับค่าได้ตามช่วงเดียวกับ validateEntitlementDuration ใน
// product.controller.js (จำนวนเต็ม 1-120 เดือน) ไม่ใช่ whitelist ตายตัวแค่ 3/6/12 อีกต่อไป — เพราะ
// GrantProductsModal auto-select ปุ่มให้ตรงกับค่า default ของ product ที่เลือก
// (prod_entitlement_duration_months) ซึ่งแอดมินตั้งเป็นเลขเดือนอะไรก็ได้ในช่วงนี้ (เช่น 9 เดือน) ถ้ายัง
// whitelist แค่ 3/6/12 ค่าที่ auto-select มาจะถูกปัดเป็น null (lifetime) ไปเงียบๆ ทั้งที่แอดมินไม่ได้ตั้งใจ —
// ค่านอกช่วง 1-120 หรือไม่ระบุมา ยังถือว่าไม่มีวันหมดอายุ (lifetime) เหมือนเดิม
// coupon_code ไม่บังคับ — ถ้าใส่มาต้องผ่าน findValidCoupon ก่อนถึงจะ grant แล้วนับการใช้งานครั้งเดียว
// ต่อคำขอ (ไม่ใช่ต่อ product) เพราะเป็นส่วนลดของทั้ง "ออเดอร์" ที่แอดมินคิดราคาให้ลูกค้าตอนขายผ่านแชท
async function createBatch(req, res, next) {
    try {
        const { product_ids, duration_months, coupon_code } = req.body ?? {};
        if (!Array.isArray(product_ids) || product_ids.length === 0) {
            return res.status(400).json({ message: "กรุณาเลือกชุดข้อสอบอย่างน้อย 1 ชุด" });
        }

        // claim โควตาคูปองตรงนี้เลย (ก่อน grant สิทธิ์ใดๆ ทั้งสิ้น) ไม่ใช่ทีหลังสุดก่อน recordSale แบบเดิม —
        // เดิม incrementUsage() คืนค่า false ได้ (ชนโควตาพอดีจากคำขอคู่แข่งที่ claim ไปก่อนเสี้ยววินาที) แต่
        // โค้ดทิ้งค่านั้นไปเฉยๆ แล้วยัง recordSale() ด้วยส่วนลดของคูปองเหมือนเดิม กลายเป็นบันทึกรายได้ต่ำกว่า
        // ความจริงสำหรับการขายที่ไม่ควรได้ส่วนลดแล้ว — ย้าย claim มาก่อน reject ทันทีถ้าชนโควตา กันไม่ให้มีการ
        // grant สิทธิ์/บันทึกยอดขายอะไรเกิดขึ้นเลยถ้าโควตาคูปองหมดไปแล้วจริงๆ ณ ตอนนั้น
        let coupon = null;
        if (coupon_code) {
            const result = await findValidCoupon(coupon_code);
            if (!result.coupon) return res.status(400).json({ message: result.error });
            coupon = result.coupon;
            const claimed = await incrementUsage(coupon.cpn_id);
            if (!claimed) return res.status(400).json({ message: "โค้ดนี้เพิ่งถูกใช้ครบจำนวนที่กำหนดไปแล้ว กรุณาลองใหม่หรือเลือกโค้ดอื่น" });
        }

        const durationValue = Number(duration_months);
        const durationMonths = Number.isInteger(durationValue) && durationValue >= 1 && durationValue <= 120 ? durationValue : null;

        // เช็คว่า product ทุกตัวมีอยู่จริงก่อน grant สักตัว — กัน loop ล้มกลางทาง (เช่น product_id ที่ถูกลบไป
        // ระหว่างที่แอดมินเปิดหน้าค้างไว้) ซึ่งจะทำให้ grant ไปแล้วบางตัวแต่ recordSale ไม่ทำงาน (ตอบ error
        // ทั้งที่สิทธิ์ถูกให้ไปแล้วจริงบางส่วน) เหมือน pattern เดียวกับ checkout() ใน store.controller.js
        const [existingProducts] = await pool.query("SELECT prod_id FROM tb_products WHERE prod_id IN (?)", [product_ids]);
        if (existingProducts.length !== product_ids.length) {
            return res.status(400).json({ message: "มีชุดข้อสอบบางรายการไม่พบในระบบ" });
        }

        for (const productId of product_ids) {
            await grantProduct(req.params.id, productId, req.user.user_id, durationMonths);
        }

        await recordSale(req.params.id, product_ids, coupon, req.user.user_id);

        res.status(201).json({ message: `ให้สิทธิ์สำเร็จ ${product_ids.length} ชุด` });
    } catch (err) {
        if (err.code === "ER_NO_REFERENCED_ROW_2" || err.code === "ER_NO_REFERENCED_ROW") {
            return res.status(400).json({ message: "ไม่พบลูกค้าหรือชุดข้อสอบที่เลือก" });
        }
        next(err);
    }
}

// รายการสิทธิ์ทั้งหมดของลูกค้าคนหนึ่ง — ใช้โชว์ในหน้าแก้ไขลูกค้า/หน้าดูสิทธิ์ในอนาคต
async function getByCustomer(req, res, next) {
    try {
        const [rows] = await pool.query(
            `SELECT e.ent_id, e.ent_product_id, p.prod_name, e.ent_granted_via,
                    e.ent_granted_at, e.ent_expires_at, e.ent_status
             FROM tb_entitlements e
             JOIN tb_products p ON p.prod_id = e.ent_product_id
             WHERE e.ent_customer_id = ?
             ORDER BY e.ent_granted_at DESC`,
            [req.params.id]
        );
        res.json({ data: rows });
    } catch (err) {
        next(err);
    }
}

// ภาพรวมสิทธิ์ทั้งหมดของทุกลูกค้า — ใช้ในหน้าแอดมินดูว่าใครถือสิทธิ์อะไร หมดอายุเมื่อไหร่ (ตาม MVP checklist)
// จัดกลุ่มตามลูกค้า (แบ่งหน้าตามจำนวนลูกค้า ไม่ใช่จำนวนแถวสิทธิ์) เพื่อให้แยกรายคนได้ชัดเจนในหน้าเว็บ —
// ทำ 2 query: query แรกหาลูกค้าที่มีสิทธิ์ตรงเงื่อนไขค้นหา (แบ่งหน้า), query สองดึงสิทธิ์ทั้งหมดของ
// ลูกค้ากลุ่มนั้นมา group ใน JS แทนการ join ทีเดียวแล้ว paginate ที่ระดับแถวสิทธิ์ (จะทำให้สิทธิ์ของคนเดียวกัน
// หลุดไปคนละหน้าได้) — คำนวณ effective status เองแทนเชื่อ ent_status ตรงๆ เพราะไม่มี cron ไปคอย flip
// เป็น 'expired' เมื่อถึงเวลา (ent_status ใน DB จะค้างเป็น 'active' แม้เลยวันหมดอายุแล้ว จนกว่าจะถูก revoke)
async function getAll(req, res, next) {
    try {
        const limit = Number(req.query.limit) || 10;
        const offset = Number(req.query.offset) || 0;
        const search = `%${req.query.search ?? ""}%`;

        const [customerRows] = await pool.query(
            `SELECT DISTINCT c.cus_id, c.cus_username,
                    CASE WHEN c.cus_fname IS NOT NULL THEN CONCAT(c.cus_fname, ' ', c.cus_lname) ELSE NULL END AS cus_fullname
             FROM tb_customers c
             JOIN tb_entitlements e ON e.ent_customer_id = c.cus_id
             JOIN tb_products p ON p.prod_id = e.ent_product_id
             WHERE c.cus_username LIKE ? OR c.cus_fname LIKE ? OR c.cus_lname LIKE ? OR p.prod_name LIKE ?
             ORDER BY c.cus_id DESC
             LIMIT ? OFFSET ?`,
            [search, search, search, search, limit, offset]
        );
        const [[{ total }]] = await pool.query(
            `SELECT COUNT(DISTINCT c.cus_id) AS total
             FROM tb_customers c
             JOIN tb_entitlements e ON e.ent_customer_id = c.cus_id
             JOIN tb_products p ON p.prod_id = e.ent_product_id
             WHERE c.cus_username LIKE ? OR c.cus_fname LIKE ? OR c.cus_lname LIKE ? OR p.prod_name LIKE ?`,
            [search, search, search, search]
        );

        if (customerRows.length === 0) return res.json({ data: [], total });

        const customerIds = customerRows.map((c) => c.cus_id);
        const [entRows] = await pool.query(
            `SELECT e.ent_id, e.ent_customer_id, e.ent_product_id, p.prod_name, e.ent_granted_via,
                    e.ent_granted_at, e.ent_expires_at,
                    CASE
                        WHEN e.ent_status = 'revoked' THEN 'revoked'
                        WHEN e.ent_expires_at IS NOT NULL AND e.ent_expires_at < NOW() THEN 'expired'
                        ELSE 'active'
                    END AS effective_status
             FROM tb_entitlements e
             JOIN tb_products p ON p.prod_id = e.ent_product_id
             WHERE e.ent_customer_id IN (?)
             ORDER BY e.ent_granted_at DESC`,
            [customerIds]
        );

        const entitlementsByCustomer = {};
        for (const row of entRows) {
            if (!entitlementsByCustomer[row.ent_customer_id]) entitlementsByCustomer[row.ent_customer_id] = [];
            entitlementsByCustomer[row.ent_customer_id].push(row);
        }

        const data = customerRows.map((c) => ({
            cus_id: c.cus_id,
            cus_username: c.cus_username,
            cus_fullname: c.cus_fullname,
            entitlements: entitlementsByCustomer[c.cus_id] ?? [],
        }));

        res.json({ data, total });
    } catch (err) {
        next(err);
    }
}

// ยกเลิกสิทธิ์ก่อนกำหนด — แค่เปลี่ยนสถานะ ไม่ลบแถวทิ้ง เพราะเป็นประวัติทางธุรกิจ (ตาม CLAUDE.md เรื่อง entitlement)
async function revoke(req, res, next) {
    try {
        const [result] = await pool.query(
            "UPDATE tb_entitlements SET ent_status = 'revoked' WHERE ent_id = ? AND ent_status = 'active'",
            [req.params.id]
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: "ไม่พบสิทธิ์นี้ หรือถูกยกเลิกไปแล้ว" });
        }
        res.json({ message: "ยกเลิกสิทธิ์สำเร็จ" });
    } catch (err) {
        next(err);
    }
}

module.exports = {
    grantProduct, grantOrRenewProduct, createBatch, getByCustomer, getAll, revoke,
    hasActiveEntitlement, calculateDiscount, recordSale,
};
