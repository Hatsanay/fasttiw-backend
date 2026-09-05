const pool = require("../config/db");
const { generateId, generateIds } = require("../utils/generateId");
const { findValidCoupon, incrementUsage } = require("./coupon.controller");
const { getEffectivePrice } = require("../utils/pricing");
const stripeClient = require("../utils/stripeClient");

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
async function recordSale(customerId, productIds, coupon, createdById, gatewayFee = 0, discountOverride = null, packageId = null, orderId = null) {
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
            (sale_id, sale_customer_id, sale_order_id, sale_subtotal, sale_discount, sale_total, sale_gateway_fee, sale_coupon_id, sale_package_id, sale_product_count, sale_created_by_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [sale_id, customerId, orderId, subtotal, discount, total, gatewayFee, coupon?.cpn_id ?? null, packageId, productIds.length, createdById]
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

// อ่านวันหมดอายุของสิทธิ์ "ก่อน" จะ grant/ต่ออายุ — ต้องเรียกก่อนแตะ tb_entitlements เสมอ
// ค่านี้ถูกเก็บลง si_expires_before เพื่อให้ระบบคืนเงินในอนาคตถอยวันหมดอายุกลับจุดเดิมได้
// (ตัดสินใจร่วมกับผู้ใช้ 2026-09-06 ว่าคืนเงินการต่ออายุต้องถอยกลับ ไม่ใช่ยกเลิกสิทธิ์ทั้งใบ)
// productId ที่ยังไม่เคยมีสิทธิ์เลยจะไม่มีคีย์ใน Map = ซื้อครั้งแรก คืนเงินแล้วยกเลิกทั้งใบได้เลย
async function snapshotExpiries(customerId, productIds) {
    if (productIds.length === 0) return new Map();
    const [rows] = await pool.query(
        "SELECT ent_product_id, ent_expires_at FROM tb_entitlements WHERE ent_customer_id = ? AND ent_product_id IN (?)",
        [customerId, productIds]
    );
    return new Map(rows.map((r) => [r.ent_product_id, r.ent_expires_at]));
}

// ผูกสิทธิ์ที่เพิ่ง grant/ต่ออายุ เข้ากับรายการขายรายชิ้นของบิลที่เพิ่งบันทึก
//
// **ต้องรับ ent_id มาตรงๆ ห้ามจับคู่ด้วย (ลูกค้า + ชุดข้อสอบ)** — tb_entitlements ไม่มี unique ที่
// (customer, product) โดยตั้งใจ (ดูคอมเมนต์ของ grantProduct) ลูกค้า 1 คนจึงมีสิทธิ์ชุดเดียวกันได้หลายแถว
// จากการซื้อซ้ำ (ข้อมูลจริงตอนนี้มีถึง 3 แถวต่อคู่) ถ้าจับคู่ด้วย customer+product จะไปเขียนทับแถวเก่า
// ให้ชี้ไปบิลใหม่ทั้งหมด ทำให้ประวัติว่าสิทธิ์ใบไหนมาจากเงินก้อนไหนเพี้ยนทั้งชุด
//
// entIdByProduct: Map<productId, ent_id> ของสิทธิ์ที่เพิ่งถูกสร้าง/ต่ออายุในรอบนี้เท่านั้น
// expiresBefore:  Map<productId, วันหมดอายุก่อนรอบนี้> ใช้เขียน si_expires_before ไว้ถอยกลับตอนคืนเงิน
async function linkEntitlementsToSale(saleId, entIdByProduct, expiresBefore = new Map()) {
    if (entIdByProduct.size === 0) return;

    const [items] = await pool.query(
        "SELECT si_id, si_product_id FROM tb_sale_items WHERE si_sale_id = ?",
        [saleId]
    );

    for (const item of items) {
        const entId = entIdByProduct.get(item.si_product_id);
        if (entId) {
            await pool.query("UPDATE tb_entitlements SET ent_sale_item_id = ? WHERE ent_id = ?", [item.si_id, entId]);
        }
        const before = expiresBefore.get(item.si_product_id);
        if (before) {
            await pool.query("UPDATE tb_sale_items SET si_expires_before = ? WHERE si_id = ?", [before, item.si_id]);
        }
    }
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
        const { product_ids, package_id, duration_months, coupon_code } = req.body ?? {};

        // แพ็กเกจถูก "ขยาย" เป็นรายการ product ย่อยตรงนี้เลย แล้วไหลผ่าน flow เดิมทั้งหมดเหมือนให้สิทธิ์
        // รายชิ้น — ตรงกับหลักการใน CLAUDE.md ข้อ 2 ที่ว่าสิทธิ์ผูกกับ product เสมอ ไม่ใช่ package
        // (วิธีเดียวกับ checkout() ใน store.controller.js เป๊ะ ต่างกันแค่ที่นี่ไม่ผ่านการชำระเงิน)
        let productIds = Array.isArray(product_ids) ? [...product_ids] : [];
        let pkg = null;
        if (package_id) {
            // แพ็กเกจกับคูปองใช้พร้อมกันไม่ได้ (ข้อจำกัดเดียวกับฝั่งลูกค้าใน v1) — ส่วนลดแพ็กเกจคำนวณจาก
            // ราคาแพ็กเกจอยู่แล้ว ถ้าซ้อนคูปองเข้าไปอีกจะกลายเป็นลดสองชั้นโดยไม่มีใครตั้งใจ
            if (coupon_code) {
                return res.status(400).json({ message: "ใช้แพ็กเกจกับโค้ดส่วนลดพร้อมกันไม่ได้ กรุณาเลือกอย่างใดอย่างหนึ่ง" });
            }
            const [pkgRows] = await pool.query("SELECT pkg_id, pkg_price FROM tb_packages WHERE pkg_id = ?", [package_id]);
            if (!pkgRows[0]) return res.status(400).json({ message: "ไม่พบแพ็กเกจนี้" });
            pkg = pkgRows[0];

            const [itemRows] = await pool.query(
                "SELECT pki_product_id FROM tb_package_items WHERE pki_package_id = ?",
                [package_id]
            );
            if (itemRows.length === 0) {
                return res.status(400).json({ message: "แพ็กเกจนี้ยังไม่มีชุดข้อสอบอยู่ข้างใน" });
            }
            productIds = [...new Set([...productIds, ...itemRows.map((r) => r.pki_product_id)])];
        }

        if (productIds.length === 0) {
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
        const [existingProducts] = await pool.query(
            "SELECT prod_id, prod_price, prod_is_free FROM tb_products WHERE prod_id IN (?)",
            [productIds]
        );
        if (existingProducts.length !== productIds.length) {
            return res.status(400).json({ message: "มีชุดข้อสอบบางรายการไม่พบในระบบ" });
        }

        const expiresBefore = await snapshotExpiries(req.params.id, productIds);

        const entIdByProduct = new Map();
        for (const productId of productIds) {
            entIdByProduct.set(productId, await grantProduct(req.params.id, productId, req.user.user_id, durationMonths));
        }

        // ส่วนลดของแพ็กเกจไม่ได้ผูกกับคูปอง ต้องคำนวณเป็น (ราคารวมถ้าซื้อแยก - ราคาแพ็กเกจ) แล้วส่งเป็น
        // discountOverride ให้ recordSale เอง ไม่งั้นยอดขายที่บันทึกจะเป็นราคาเต็มทั้งที่ลูกค้าจ่ายราคาแพ็กเกจ
        // — สูตรเดียวกับ checkout() ฝั่งลูกค้าเป๊ะ (ใช้ getEffectivePrice เสมอ product ที่แจกฟรีนับเป็น 0)
        // ไม่ครอบ Math.max(0, ...) โดยตั้งใจ — ถ้าราคาแพ็กเกจสูงกว่าราคารวมถ้าซื้อแยก ส่วนลดจะติดลบ
        // (= ค่าเพิ่ม) แล้วยอดสุทธิจะออกมาเท่า pkg_price พอดี ราคาที่แอดมินตั้งไว้จึงเป็นตัวชี้ขาดเสมอ
        // ไม่ว่าจะสูงหรือต่ำกว่าผลรวม — ก่อนหน้านี้ครอบ max(0) ไว้ ทำให้แพ็กเกจที่ตั้งราคาสูงกว่าผลรวม
        // ถูกบันทึกยอดตามผลรวม (ต่ำกว่าราคาที่ตั้งไว้) เงียบๆ
        let discountOverride = null;
        if (pkg) {
            const subtotal = existingProducts.reduce((sum, p) => sum + getEffectivePrice(p), 0);
            discountOverride = subtotal - Number(pkg.pkg_price);
        }

        const saleId = await recordSale(req.params.id, productIds, coupon, req.user.user_id, 0, discountOverride, pkg?.pkg_id ?? null);
        await linkEntitlementsToSale(saleId, entIdByProduct, expiresBefore);

        res.status(201).json({
            message: pkg
                ? `ให้สิทธิ์จากแพ็กเกจสำเร็จ ${productIds.length} ชุด`
                : `ให้สิทธิ์สำเร็จ ${productIds.length} ชุด`,
            granted: productIds.length,
        });
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
            // ข้อมูลฝั่งเงินถูก join มาด้วย เพื่อให้หน้าเว็บรู้ว่า "ยกเลิกแบบไหนทำได้บ้าง" โดยไม่ต้องยิง API ซ้ำ
            //   sale_amount        ยอดที่จะถูกหักออกถ้าเลือกกลับรายการ (NULL = สิทธิ์เก่าที่ไม่ผูกกับบิล)
            //   can_refund_gateway จ่ายผ่านเว็บจริงไหม (มี PaymentIntent ให้สั่งคืนเงินอัตโนมัติ)
            //   rolls_back_to      ถ้าเป็นการต่ออายุ คืนเงินแล้วจะถอยวันหมดอายุกลับไปวันนี้ ไม่ใช่ยกเลิกทั้งใบ
            `SELECT e.ent_id, e.ent_customer_id, e.ent_product_id, p.prod_name, e.ent_granted_via,
                    e.ent_granted_at, e.ent_expires_at,
                    CASE
                        WHEN e.ent_status = 'revoked' THEN 'revoked'
                        WHEN e.ent_expires_at IS NOT NULL AND e.ent_expires_at < NOW() THEN 'expired'
                        ELSE 'active'
                    END AS effective_status,
                    si.si_total AS sale_amount,
                    si.si_expires_before AS rolls_back_to,
                    (o.ord_omise_charge_id IS NOT NULL) AS can_refund_gateway
             FROM tb_entitlements e
             JOIN tb_products p ON p.prod_id = e.ent_product_id
             LEFT JOIN tb_sale_items si ON si.si_id = e.ent_sale_item_id
             LEFT JOIN tb_sales s ON s.sale_id = si.si_sale_id
             LEFT JOIN tb_orders o ON o.ord_id = s.sale_order_id
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
// เหตุผลของการยกเลิกสิทธิ์ — ตัวที่กำหนดว่าระบบต้องทำอะไรกับ "เงิน" ต่อ (ตกลงกับผู้ใช้ 2026-09-06)
//
//   revoke_only     ยกเลิกเฉยๆ ไม่ยุ่งกับเงิน (ลูกค้าผิดกติกา/แชร์บัญชี — เงินที่รับมาแล้วไม่คืน)
//   wrong_grant     แอดมินกดให้ผิดคน ไม่เคยมีเงินไหลจริง — แค่กลับรายการที่บันทึกผิด
//   refund_bank     ลูกค้าขอคืนเงินที่โอนเข้าบัญชีธนาคาร — ระบบโอนคืนให้ไม่ได้ แอดมินต้องโอนเอง
//   refund_gateway  ลูกค้าขอคืนเงินที่จ่ายผ่านเว็บ — สั่ง Stripe คืนเงินจริงให้อัตโนมัติ
const REVOKE_REASONS = ["revoke_only", "wrong_grant", "refund_bank", "refund_gateway"];
const REASONS_THAT_REVERSE_REVENUE = ["wrong_grant", "refund_bank", "refund_gateway"];

// บันทึก "รายการกลับ" เป็นแถวยอดติดลบ ไม่ลบแถวเดิมทิ้ง
//
// เหตุผลที่ห้ามลบ: ระบบมี tb_profit_allocations / tb_partner_distributions ที่ปันผลให้หุ้นส่วนจากตัวเลข
// รายได้ไปแล้ว ถ้าลบแถวเงียบๆ ตัวเลขจะขัดกันเองโดยไม่มีร่องรอยว่าเกิดอะไรขึ้น — ทุกรายงานใช้ SUM(sale_total)
// อยู่แล้ว แถวติดลบจึงหักยอดออกให้เองอัตโนมัติโดยไม่ต้องแก้ query สักตัว
//
// กลับเฉพาะ "รายการรายชิ้น" ที่เกี่ยวข้อง ไม่ใช่ทั้งบิล — บิลเดียวมีได้หลายชุด ยกเลิกชุดเดียวต้องหักแค่ก้อนนั้น
// ค่าคอมของพนักงานก็ต้องกลับตามไปด้วย (ติดลบ) ไม่งั้นค่าคอมจากการขายที่ถูกยกเลิกจะค้างอยู่ในระบบ
async function reverseSaleItem(saleItem, reason, createdById) {
    const reversalSaleId = await generateId("tb_sales", "SAL");
    await pool.query(
        `INSERT INTO tb_sales
            (sale_id, sale_customer_id, sale_order_id, sale_subtotal, sale_discount, sale_total,
             sale_gateway_fee, sale_product_count, sale_reversal_of, sale_reason, sale_created_by_id)
         VALUES (?, ?, NULL, ?, ?, ?, 0, 1, ?, ?, ?)`,
        [
            reversalSaleId, saleItem.sale_customer_id,
            -Number(saleItem.si_price), -Number(saleItem.si_discount), -Number(saleItem.si_total),
            saleItem.si_sale_id, reason, createdById,
        ]
    );

    const [reversalItemId] = await generateIds("tb_sale_items", "SIT", 1);
    await pool.query(
        `INSERT INTO tb_sale_items
            (si_id, si_sale_id, si_product_id, si_price, si_discount, si_total, si_commission_staff_id, si_commission_amount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            reversalItemId, reversalSaleId, saleItem.si_product_id,
            -Number(saleItem.si_price), -Number(saleItem.si_discount), -Number(saleItem.si_total),
            saleItem.si_commission_staff_id, -Number(saleItem.si_commission_amount),
        ]
    );

    return { reversalSaleId, amount: Number(saleItem.si_total) };
}

// ยกเลิกสิทธิ์ — body.reason เป็นตัวกำหนดว่าจะยุ่งกับเงินด้วยไหม (ดู REVOKE_REASONS)
// ไม่ส่ง reason มา = revoke_only (พฤติกรรมเดิมก่อนมีระบบคืนเงิน) เพื่อไม่ให้ของเดิมที่เรียก endpoint นี้อยู่พัง
//
// ลำดับสำคัญ: คืนเงินจริงผ่าน Stripe ให้สำเร็จก่อน ค่อยแตะข้อมูลในระบบเรา ถ้า Stripe ล้มต้องไม่มีอะไร
// เปลี่ยนเลย ไม่งั้นตัวเลขจะบอกว่าคืนแล้วทั้งที่เงินยังอยู่กับเรา (แก้ยากกว่าตรงกันข้ามมาก)
async function revoke(req, res, next) {
    try {
        const reason = REVOKE_REASONS.includes(req.body?.reason) ? req.body.reason : "revoke_only";

        const [[ent]] = await pool.query(
            `SELECT e.ent_id, e.ent_status, e.ent_customer_id, e.ent_sale_item_id,
                    si.si_id, si.si_sale_id, si.si_product_id, si.si_price, si.si_discount, si.si_total,
                    si.si_commission_staff_id, si.si_commission_amount, si.si_expires_before,
                    s.sale_customer_id, s.sale_order_id, s.sale_gateway_fee,
                    o.ord_omise_charge_id
             FROM tb_entitlements e
             LEFT JOIN tb_sale_items si ON si.si_id = e.ent_sale_item_id
             LEFT JOIN tb_sales s ON s.sale_id = si.si_sale_id
             LEFT JOIN tb_orders o ON o.ord_id = s.sale_order_id
             WHERE e.ent_id = ?`,
            [req.params.id]
        );
        if (!ent) return res.status(404).json({ message: "ไม่พบสิทธิ์นี้" });
        if (ent.ent_status !== "active") return res.status(400).json({ message: "สิทธิ์นี้ถูกยกเลิกไปแล้ว" });

        const shouldReverse = REASONS_THAT_REVERSE_REVENUE.includes(reason);
        if (shouldReverse && !ent.si_id) {
            return res.status(400).json({
                message: "สิทธิ์นี้ไม่ได้ผูกกับรายการขายใดในระบบ (ให้ไว้ก่อนมีระบบบันทึกการขาย) จึงหักยอดออกอัตโนมัติไม่ได้ — เลือกยกเลิกเฉยๆ แทน",
            });
        }

        // 1) คืนเงินจริงผ่าน Stripe ก่อน (ถ้าเลือกแบบนั้น)
        let refundId = null;
        if (reason === "refund_gateway") {
            if (!ent.ord_omise_charge_id) {
                return res.status(400).json({ message: "รายการขายนี้ไม่มีข้อมูลการชำระเงินผ่านเว็บ ไม่สามารถสั่งคืนเงินอัตโนมัติได้" });
            }
            if (!stripeClient.isConfigured()) {
                return res.status(400).json({ message: "ยังไม่ได้ตั้งค่า Stripe บนเซิร์ฟเวอร์นี้ สั่งคืนเงินอัตโนมัติไม่ได้" });
            }
            try {
                const refund = await stripeClient.refundPaymentIntent(ent.ord_omise_charge_id, {
                    amountSatang: Math.round(Number(ent.si_total) * 100),
                    reason: "requested_by_customer",
                });
                refundId = refund.id;
            } catch (err) {
                return res.status(502).json({ message: `สั่งคืนเงินกับ Stripe ไม่สำเร็จ: ${err.message} — ยังไม่มีอะไรถูกเปลี่ยนในระบบ` });
            }
        }

        // 2) จัดการตัวสิทธิ์
        // ถ้ารายการขายนี้เป็นการต่ออายุ (มี si_expires_before) ให้ถอยวันหมดอายุกลับจุดเดิม ไม่ยกเลิกทั้งใบ
        // เพราะลูกค้าจ่ายเงินช่วงก่อนหน้ามาแล้วจริง การริบไปด้วยไม่ยุติธรรม (ตกลงกับผู้ใช้ 2026-09-06)
        const rolledBack = shouldReverse && !!ent.si_expires_before;
        if (rolledBack) {
            await pool.query("UPDATE tb_entitlements SET ent_expires_at = ? WHERE ent_id = ?", [ent.si_expires_before, ent.ent_id]);
        } else {
            await pool.query("UPDATE tb_entitlements SET ent_status = 'revoked' WHERE ent_id = ? AND ent_status = 'active'", [ent.ent_id]);
        }

        // 3) กลับรายการยอดขาย
        let reversal = null;
        if (shouldReverse) {
            reversal = await reverseSaleItem(ent, reason, req.user.user_id);
        }

        res.json({
            message: rolledBack ? "คืนเงินและถอยวันหมดอายุกลับจุดเดิมสำเร็จ" : "ยกเลิกสิทธิ์สำเร็จ",
            reason,
            rolled_back_to: rolledBack ? ent.si_expires_before : null,
            reversed_amount: reversal ? reversal.amount : null,
            stripe_refund_id: refundId,
            // ค่าธรรมเนียมที่ Stripe หักไปตอนรับเงินไม่ได้คืนกลับมาด้วย — แจ้งให้แอดมินรู้ว่าขาดทุนส่วนนี้จริง
            gateway_fee_not_returned: reason === "refund_gateway" ? Number(ent.sale_gateway_fee) : null,
            // แบบโอนธนาคารระบบทำแทนไม่ได้ ต้องเตือนให้แอดมินไปโอนคืนเอง
            needs_manual_transfer: reason === "refund_bank",
        });
    } catch (err) {
        next(err);
    }
}

// คืนสิทธิ์ที่ยกเลิกไปแล้วกลับมา — สำหรับเคสกดผิดปุ่ม ไม่ยุ่งกับเงินเลย
// (ถ้าเคยกลับรายการขายไปด้วย ต้องไปให้สิทธิ์ใหม่ผ่านหน้าเพิ่มสิทธิ์แทน เพื่อให้มีการบันทึกยอดขายใหม่ให้ตรง)
async function restore(req, res, next) {
    try {
        const [result] = await pool.query(
            "UPDATE tb_entitlements SET ent_status = 'active' WHERE ent_id = ? AND ent_status = 'revoked'",
            [req.params.id]
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: "ไม่พบสิทธิ์นี้ หรือสิทธิ์นี้ไม่ได้อยู่ในสถานะถูกยกเลิก" });
        }
        res.json({ message: "คืนสิทธิ์สำเร็จ" });
    } catch (err) {
        next(err);
    }
}

// แก้วันหมดอายุของสิทธิ์ — ใช้ตอนต่ออายุให้ลูกค้าเป็นกรณีพิเศษ หรือแก้วันที่กรอกผิด
// expires_at: "YYYY-MM-DD" หรือ null (= ไม่มีวันหมดอายุ) — ไม่ยุ่งกับยอดขายเลย เป็นการแก้สิทธิ์ล้วนๆ
async function updateExpiry(req, res, next) {
    try {
        const raw = req.body ? req.body.expires_at : undefined;
        let expiresAt = null;
        if (raw !== null && raw !== undefined && raw !== "") {
            const parsed = new Date(raw);
            if (Number.isNaN(parsed.getTime())) return res.status(400).json({ message: "รูปแบบวันที่ไม่ถูกต้อง" });
            expiresAt = raw;
        }

        const [result] = await pool.query(
            "UPDATE tb_entitlements SET ent_expires_at = ? WHERE ent_id = ?",
            [expiresAt, req.params.id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ message: "ไม่พบสิทธิ์นี้" });

        res.json({ message: expiresAt ? "แก้วันหมดอายุสำเร็จ" : "ตั้งเป็นไม่มีวันหมดอายุสำเร็จ" });
    } catch (err) {
        next(err);
    }
}

module.exports = {
    grantProduct, grantOrRenewProduct, createBatch, getByCustomer, getAll, revoke, restore, updateExpiry,
    linkEntitlementsToSale, snapshotExpiries, REVOKE_REASONS,
    hasActiveEntitlement, calculateDiscount, recordSale,
};
