const pool = require("../config/db");
const { generateId } = require("../utils/generateId");

async function getAll(req, res, next) {
    try {
        const limit = Number(req.query.limit) || 10;
        const offset = Number(req.query.offset) || 0;
        const search = `%${req.query.search ?? ""}%`;
        // usable=true กรองเหลือแค่โค้ดที่ใช้ได้จริง ณ ตอนนี้ (active, ไม่หมดอายุ, ยังไม่ครบโควตา)
        // ใช้กับ dropdown เลือกโค้ดตอน grant สิทธิ์ ไม่อยากให้แอดมินเลือกโค้ดที่ตายไปแล้วได้
        const usableOnly = req.query.usable === "true";

        const conditions = ["cpn_code LIKE ?"];
        const params = [search];
        if (usableOnly) {
            conditions.push("cpn_status = 'active'");
            conditions.push("(cpn_expires_at IS NULL OR cpn_expires_at >= NOW())");
            conditions.push("(cpn_max_uses IS NULL OR cpn_used_count < cpn_max_uses)");
        }
        const whereClause = conditions.join(" AND ");

        const [rows] = await pool.query(
            `SELECT cpn_id, cpn_code, cpn_discount_type, cpn_discount_value, cpn_max_uses, cpn_used_count,
                    cpn_expires_at, cpn_status, cpn_created_at, cpn_updated_at
             FROM tb_coupons
             WHERE ${whereClause}
             ORDER BY cpn_id DESC
             LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );
        const [[{ total }]] = await pool.query(
            `SELECT COUNT(*) AS total FROM tb_coupons WHERE ${whereClause}`,
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
            `SELECT cpn_id, cpn_code, cpn_discount_type, cpn_discount_value, cpn_max_uses, cpn_used_count,
                    cpn_expires_at, cpn_status, cpn_created_at, cpn_updated_at
             FROM tb_coupons WHERE cpn_id = ?`,
            [req.params.id]
        );
        if (!rows[0]) return res.status(404).json({ message: "ไม่พบคูปองนี้" });
        res.json(rows[0]);
    } catch (err) {
        next(err);
    }
}

// ตรวจค่าที่ใช้ร่วมกันทั้ง create/update — คืน error message หรือ null ถ้าผ่าน
function validateCoupon({ cpn_code, cpn_discount_type, cpn_discount_value, cpn_max_uses }) {
    if (!cpn_code || !cpn_code.trim()) return "กรุณากรอกโค้ดคูปอง";
    if (cpn_discount_type !== "percent" && cpn_discount_type !== "fixed") return "ประเภทส่วนลดไม่ถูกต้อง";

    const value = Number(cpn_discount_value);
    if (!Number.isFinite(value) || value <= 0) return "มูลค่าส่วนลดต้องมากกว่า 0";
    if (cpn_discount_type === "percent" && value > 100) return "ส่วนลดแบบเปอร์เซ็นต์ต้องไม่เกิน 100";

    if (cpn_max_uses !== null && cpn_max_uses !== undefined && cpn_max_uses !== "") {
        const maxUses = Number(cpn_max_uses);
        if (!Number.isInteger(maxUses) || maxUses <= 0) return "จำนวนครั้งที่ใช้ได้ต้องเป็นจำนวนเต็มมากกว่า 0";
    }

    return null;
}

async function create(req, res, next) {
    try {
        const { cpn_code, cpn_discount_type, cpn_discount_value, cpn_max_uses, cpn_expires_at } = req.body ?? {};
        const error = validateCoupon(req.body ?? {});
        if (error) return res.status(400).json({ message: error });

        const cpn_id = await generateId("tb_coupons", "CPN");
        // normalize เป็นตัวพิมพ์ใหญ่เสมอ กันสร้างโค้ดซ้ำแค่ต่างเคส เช่น "SAVE10" กับ "save10"
        const code = cpn_code.trim().toUpperCase();

        await pool.query(
            `INSERT INTO tb_coupons (cpn_id, cpn_code, cpn_discount_type, cpn_discount_value, cpn_max_uses, cpn_expires_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [cpn_id, code, cpn_discount_type, cpn_discount_value, cpn_max_uses || null, cpn_expires_at || null]
        );

        res.status(201).json({ cpn_id, cpn_code: code });
    } catch (err) {
        if (err.code === "ER_DUP_ENTRY") {
            return res.status(409).json({ message: "โค้ดคูปองนี้ถูกใช้งานแล้ว" });
        }
        next(err);
    }
}

async function update(req, res, next) {
    try {
        const { cpn_code, cpn_discount_type, cpn_discount_value, cpn_max_uses, cpn_expires_at, cpn_status } = req.body ?? {};
        const error = validateCoupon(req.body ?? {});
        if (error) return res.status(400).json({ message: error });

        const code = cpn_code.trim().toUpperCase();

        await pool.query(
            `UPDATE tb_coupons SET
                cpn_code = ?, cpn_discount_type = ?, cpn_discount_value = ?,
                cpn_max_uses = ?, cpn_expires_at = ?, cpn_status = ?
             WHERE cpn_id = ?`,
            [
                code, cpn_discount_type, cpn_discount_value, cpn_max_uses || null, cpn_expires_at || null,
                cpn_status === "inactive" ? "inactive" : "active",
                req.params.id,
            ]
        );

        res.json({ message: "แก้ไขคูปองสำเร็จ" });
    } catch (err) {
        if (err.code === "ER_DUP_ENTRY") {
            return res.status(409).json({ message: "โค้ดคูปองนี้ถูกใช้งานแล้ว" });
        }
        next(err);
    }
}

async function remove(req, res, next) {
    try {
        await pool.query("DELETE FROM tb_coupons WHERE cpn_id = ?", [req.params.id]);
        res.status(204).end();
    } catch (err) {
        next(err);
    }
}

// ตรวจว่าโค้ดนี้ใช้ได้จริง ณ ตอนนี้ไหม (มีอยู่จริง, เปิดใช้งาน, ยังไม่หมดอายุ, ยังไม่ครบโควตา)
// เรียกใช้ทั้งจาก endpoint validate ตรงๆ และจาก entitlement.controller ตอน grant พร้อมใส่โค้ดส่วนลด
// คืน { coupon, error } เสมอ — coupon เป็น null เมื่อใช้ไม่ได้ พร้อม error อธิบายเหตุผล
async function findValidCoupon(code) {
    const [rows] = await pool.query(
        `SELECT cpn_id, cpn_code, cpn_discount_type, cpn_discount_value, cpn_max_uses, cpn_used_count, cpn_expires_at, cpn_status
         FROM tb_coupons WHERE cpn_code = ?`,
        [String(code).trim().toUpperCase()]
    );
    const coupon = rows[0];
    if (!coupon) return { coupon: null, error: "ไม่พบโค้ดคูปองนี้" };
    if (coupon.cpn_status !== "active") return { coupon: null, error: "โค้ดนี้ถูกปิดใช้งานแล้ว" };
    if (coupon.cpn_expires_at && new Date(coupon.cpn_expires_at) < new Date()) {
        return { coupon: null, error: "โค้ดนี้หมดอายุแล้ว" };
    }
    if (coupon.cpn_max_uses !== null && coupon.cpn_used_count >= coupon.cpn_max_uses) {
        return { coupon: null, error: "โค้ดนี้ถูกใช้ครบจำนวนที่กำหนดแล้ว" };
    }
    return { coupon, error: null };
}

async function validateCode(req, res, next) {
    try {
        const { coupon, error } = await findValidCoupon(req.params.code);
        if (!coupon) return res.status(400).json({ message: error });
        res.json({
            cpn_id: coupon.cpn_id,
            cpn_code: coupon.cpn_code,
            cpn_discount_type: coupon.cpn_discount_type,
            cpn_discount_value: coupon.cpn_discount_value,
        });
    } catch (err) {
        next(err);
    }
}

// UPDATE เดียวที่เช็คโควตาในคำสั่งเดียวกับการ +1 (atomic ระดับแถวใน InnoDB) — กัน race condition ตอนสอง
// คำสั่งซื้อที่ใช้โค้ดเดียวกันถูก settle ใกล้เคียงกัน ถ้าเรียกแยก SELECT เช็คโควตาแล้วค่อย UPDATE +1
// ทีหลัง (แบบเดิม) ทั้งสองคำสั่งอาจเห็นโควตาเหลือพร้อมกันแล้ว +1 ซ้อนกันจน cpn_used_count เกิน
// cpn_max_uses ได้ — คืน true/false บอกว่า +1 สำเร็จจริงไหม (false = โควตาเต็มไปแล้ว ณ ตอนนั้นเป๊ะๆ)
async function incrementUsage(cpnId) {
    const [result] = await pool.query(
        "UPDATE tb_coupons SET cpn_used_count = cpn_used_count + 1 WHERE cpn_id = ? AND (cpn_max_uses IS NULL OR cpn_used_count < cpn_max_uses)",
        [cpnId]
    );
    return result.affectedRows > 0;
}

module.exports = { getAll, getOne, create, update, remove, findValidCoupon, validateCode, incrementUsage };
