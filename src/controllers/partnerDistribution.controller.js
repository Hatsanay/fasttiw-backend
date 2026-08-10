const pool = require("../config/db");
const { generateId, generateIds } = require("../utils/generateId");
const reportController = require("./report.controller");
const settingsController = require("./settings.controller");

async function getAll(req, res, next) {
    try {
        const limit = Number(req.query.limit) || 10;
        const offset = Number(req.query.offset) || 0;
        const search = `%${req.query.search ?? ""}%`;

        const conditions = ["CONCAT(u.user_fname, ' ', u.user_lname) LIKE ?"];
        const params = [search];
        if (req.query.status === "pending" || req.query.status === "paid") {
            conditions.push("d.dist_status = ?"); params.push(req.query.status);
        }
        const whereClause = conditions.join(" AND ");

        const [rows] = await pool.query(
            `SELECT d.dist_id, d.dist_partner_id, CONCAT(u.user_fname, ' ', u.user_lname) AS partner_fullname,
                    d.dist_allocation_id, d.dist_amount, d.dist_tax_percent, d.dist_tax_amount,
                    d.dist_note, d.dist_status, d.dist_paid_at, d.dist_created_at
             FROM tb_partner_distributions d
             JOIN tb_users u ON u.user_id = d.dist_partner_id
             WHERE ${whereClause}
             ORDER BY d.dist_id DESC
             LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );
        const [[{ total }]] = await pool.query(
            `SELECT COUNT(*) AS total FROM tb_partner_distributions d
             JOIN tb_users u ON u.user_id = d.dist_partner_id
             WHERE ${whereClause}`,
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
            `SELECT d.dist_id, d.dist_partner_id, CONCAT(u.user_fname, ' ', u.user_lname) AS partner_fullname,
                    d.dist_amount, d.dist_note, d.dist_status, d.dist_paid_at, d.dist_created_at
             FROM tb_partner_distributions d
             JOIN tb_users u ON u.user_id = d.dist_partner_id
             WHERE d.dist_id = ?`,
            [req.params.id]
        );
        if (!rows[0]) return res.status(404).json({ message: "ไม่พบรายการจ่ายส่วนแบ่งนี้" });
        res.json(rows[0]);
    } catch (err) {
        next(err);
    }
}

async function validateDistribution({ dist_partner_id, dist_amount }) {
    if (!dist_partner_id) return "กรุณาเลือกหุ้นส่วน";
    const amount = Number(dist_amount);
    if (!Number.isFinite(amount) || amount <= 0) return "จำนวนเงินต้องมากกว่า 0";

    const [rows] = await pool.query("SELECT user_is_partner FROM tb_users WHERE user_id = ?", [dist_partner_id]);
    if (!rows[0] || !rows[0].user_is_partner) return "ผู้ใช้ที่เลือกไม่ใช่หุ้นส่วน";
    return null;
}

async function create(req, res, next) {
    try {
        const body = req.body ?? {};
        const error = await validateDistribution(body);
        if (error) return res.status(400).json({ message: error });

        const dist_id = await generateId("tb_partner_distributions", "PDT");
        await pool.query(
            `INSERT INTO tb_partner_distributions (dist_id, dist_partner_id, dist_amount, dist_note, dist_created_by_id)
             VALUES (?, ?, ?, ?, ?)`,
            [dist_id, body.dist_partner_id, body.dist_amount, body.dist_note || null, req.user.user_id]
        );

        res.status(201).json({ dist_id });
    } catch (err) {
        next(err);
    }
}

async function update(req, res, next) {
    try {
        const [existing] = await pool.query("SELECT dist_status, dist_allocation_id FROM tb_partner_distributions WHERE dist_id = ?", [req.params.id]);
        if (!existing[0]) return res.status(404).json({ message: "ไม่พบรายการจ่ายส่วนแบ่งนี้" });
        if (existing[0].dist_status === "paid") {
            return res.status(400).json({ message: "รายการนี้จ่ายไปแล้ว แก้ไขไม่ได้" });
        }
        // รายการที่มาจาก "จัดสรรกำไร" อย่างเป็นทางการ แก้ไขทีละคนแยกไม่ได้ เพราะจะทำให้ยอดรวมไม่ตรงกับ
        // ที่ประกาศไว้ใน tb_profit_allocations (เงินปันผลรวมที่หารตามสัดส่วนหุ้นของหุ้นส่วนทุกคนพร้อมกัน)
        if (existing[0].dist_allocation_id) {
            return res.status(400).json({ message: "รายการนี้มาจากการจัดสรรกำไร แก้ไขทีละรายการแยกไม่ได้" });
        }

        const body = req.body ?? {};
        const error = await validateDistribution(body);
        if (error) return res.status(400).json({ message: error });

        await pool.query(
            "UPDATE tb_partner_distributions SET dist_partner_id = ?, dist_amount = ?, dist_note = ? WHERE dist_id = ?",
            [body.dist_partner_id, body.dist_amount, body.dist_note || null, req.params.id]
        );

        res.json({ message: "แก้ไขรายการจ่ายส่วนแบ่งสำเร็จ" });
    } catch (err) {
        next(err);
    }
}

async function remove(req, res, next) {
    try {
        const [existing] = await pool.query("SELECT dist_status, dist_allocation_id FROM tb_partner_distributions WHERE dist_id = ?", [req.params.id]);
        if (!existing[0]) return res.status(404).json({ message: "ไม่พบรายการจ่ายส่วนแบ่งนี้" });
        if (existing[0].dist_status === "paid") {
            return res.status(400).json({ message: "รายการนี้จ่ายไปแล้ว ลบไม่ได้" });
        }
        if (existing[0].dist_allocation_id) {
            return res.status(400).json({ message: "รายการนี้มาจากการจัดสรรกำไร ลบทีละรายการแยกไม่ได้" });
        }

        await pool.query("DELETE FROM tb_partner_distributions WHERE dist_id = ?", [req.params.id]);
        res.status(204).end();
    } catch (err) {
        next(err);
    }
}

// กด "จ่ายแล้ว" — แค่ล็อกสถานะ (แก้ไข/ลบไม่ได้อีก) ไม่สร้างรายการค่าใช้จ่ายใดๆ ทั้งสิ้น เพราะเงินก้อนนี้
// เป็นการแบ่งกำไรที่ทำได้แล้วออกไป ไม่ใช่ต้นทุนดำเนินธุรกิจ (ดูคอมเมนต์อธิบายเต็มๆ ใน
// database/query/create_partner_distributions.sql) — claim ด้วย atomic UPDATE...WHERE status!='paid'
// กันกด "จ่ายแล้ว" ซ้ำพร้อมกัน (ดับเบิลคลิก/เปิดสองแท็บ) เหมือน pattern เดียวกับ settlePaidOrder/payroll
async function markPaid(req, res, next) {
    try {
        const [claim] = await pool.query(
            "UPDATE tb_partner_distributions SET dist_status = 'paid', dist_paid_at = NOW() WHERE dist_id = ? AND dist_status != 'paid'",
            [req.params.id]
        );
        if (claim.affectedRows === 0) {
            const [existing] = await pool.query("SELECT dist_id FROM tb_partner_distributions WHERE dist_id = ?", [req.params.id]);
            if (!existing[0]) return res.status(404).json({ message: "ไม่พบรายการจ่ายส่วนแบ่งนี้" });
            return res.status(400).json({ message: "รายการนี้จ่ายไปแล้ว" });
        }

        res.json({ message: "บันทึกการจ่ายส่วนแบ่งกำไรสำเร็จ" });
    } catch (err) {
        next(err);
    }
}

// ─── จัดสรรกำไรอย่างเป็นทางการ (ทุนสำรองตามกฎหมาย + ประกาศจ่ายปันผลตามสัดส่วนหุ้น + ภาษีหัก ณ ที่จ่าย) ──
// คำนวณกำไรของงวดที่เลือก (ใช้ computeNetProfit ตัวเดียวกับหน้ารายงาน กันสูตรเพี้ยนไม่ตรงกัน) แยกฟังก์ชัน
// คำนวณ (calculateAllocation) ออกจากฟังก์ชันบันทึกจริง เพื่อให้มี "preview" ดูตัวเลขก่อนยืนยันได้โดยไม่
// ต้องสร้างแถวจริงใน DB ก่อน (คำนวณเพดานทุนสำรองต้องอิงยอดสะสมจริงจาก DB ฝั่ง client เดายอดเองไม่ได้
// แม่นเท่าเซิร์ฟเวอร์ จึงต้องมี endpoint คำนวณแยกจากการ commit จริง)
async function calculateAllocation(periodFrom, periodTo) {
    const config = await settingsController.getDividendConfig();
    if (!config.registeredCapital || config.registeredCapital <= 0) {
        const err = new Error("กรุณาตั้งค่าทุนจดทะเบียนที่หน้าตั้งค่าก่อนจัดสรรกำไร (ใช้คำนวณเพดานทุนสำรอง)");
        err.status = 400;
        throw err;
    }

    const net = await reportController.computeNetProfit(periodFrom || null, periodTo || null);
    const periodProfit = net.profit;

    const [partners] = await pool.query(
        `SELECT user_id, CONCAT(user_fname, ' ', user_lname) AS fullname, user_partner_share_percent AS share_percent
         FROM tb_users WHERE user_is_partner = TRUE`
    );
    if (partners.length === 0) {
        const err = new Error("ยังไม่มีหุ้นส่วนในระบบ");
        err.status = 400;
        throw err;
    }
    const totalSharePercent = partners.reduce((sum, p) => sum + Number(p.share_percent ?? 0), 0);

    // เรียก computeRetainedEarnings() ครั้งเดียว เอาทั้งยอดทุนสำรองสะสม/เพดานทุนสำรอง (ใช้คำนวณ actualReserve
    // ด้านล่าง) และกำไรสะสมคงเหลือ (ใช้เช็คว่าพอจัดสรรรอบใหม่ไหม) มาจากจุดเดียวกันเป๊ะ — ห้ามคำนวณ reserveCap/
    // totalReserve แยกเองอีกจุด (เคยเป็นแบบนั้นมาก่อน คือ query SUM(alloc_reserve_amount) และคูณ 0.1 ซ้ำเองในนี้)
    // เพราะจะกลายเป็นสูตรเดียวกันที่เขียนไว้ 2 ที่ ถ้าใครแก้สูตรจุดหนึ่งแล้วลืมอีกจุดจะเพี้ยนไม่ตรงกันแบบเงียบๆ
    // (บั๊กคลาสเดียวกับที่เจอใน partnerShare()/getRetainedEarnings() ที่ไม่ได้คูณ % จ่ายปันผลก่อน)
    const {
        totalReserve: currentReserveBalance, reserveCap, retainedEarnings: availableBeforeThis,
    } = await reportController.computeRetainedEarnings();

    // เพดานทุนสำรอง = 10% ของทุนจดทะเบียนตามกฎหมาย — กันไม่ให้กันทุนสำรองเกินเพดานที่กฎหมายกำหนด
    // (ปันผลยังคำนวณตามปกติเต็ม % แม้ทุนสำรองจะชนเพดานแล้วก็ตาม)
    const remainingRoom = Math.max(0, reserveCap - currentReserveBalance);
    const requestedReserve = Math.max(0, (config.legalReservePercent / 100) * periodProfit);
    const actualReserve = Math.min(requestedReserve, remainingRoom);

    // สูตรเดียวกันเป๊ะกับ partnerShare()/getRetainedEarnings() ที่หน้ารายงาน (reportController.calculateDividendAmount)
    // ห้ามคำนวณแยกในนี้อีก เพราะเคยเป็นแบบนั้นมาก่อนแล้วจุดอื่นลืมคูณ % ปันผลตาม (ดูคอมเมนต์เต็มๆ ที่ report.controller.js)
    const dividendAmount = reportController.calculateDividendAmount(periodProfit, config.dividendPercent);

    // เช็คว่ากำไรสะสมคงเหลือ "จริง" (สะสมทั้งหมด หักทุนสำรอง/ปันผลที่จัดสรรไปแล้วก่อนหน้า) พอสำหรับก้อนใหม่
    // ที่กำลังจะกันทุนสำรอง+ประกาศจ่ายปันผลนี้ไหม — periodProfit คำนวณจากช่วงเวลาที่แอดมินเลือกเองแยกต่างหาก
    // ทุกครั้ง ไม่มีการจดจำว่าช่วงไหนถูกจัดสรรไปแล้วบ้าง ถ้าแอดมินเลือกช่วงเวลาที่ทับซ้อนกับการจัดสรรครั้งก่อน
    // (เช่น กด "ทั้งหมดตั้งแต่เริ่ม" ซ้ำสองครั้ง) periodProfit จะนับกำไรก้อนเดิมซ้ำ แล้วจะจัดสรรทับซ้อนของเดิม
    // ทันทีโดยไม่มีอะไรเตือนเลยถ้าไม่เช็คตรงนี้ — บล็อกไว้ก่อนดีกว่าปล่อยให้กำไรสะสม/ยอดปันผลเพี้ยนไปเงียบๆ
    if (actualReserve + dividendAmount > availableBeforeThis) {
        const err = new Error(
            `กำไรสะสมคงเหลือไม่พอสำหรับการจัดสรรนี้ (ต้องการกันทุนสำรอง+ปันผลรวม ${(actualReserve + dividendAmount).toFixed(2)} บาท ` +
            `แต่กำไรสะสมคงเหลือมีแค่ ${availableBeforeThis.toFixed(2)} บาท) — อาจเกิดจากเลือกช่วงเวลาที่ทับซ้อนกับการจัดสรรครั้งก่อนหน้า กรุณาตรวจสอบช่วงเวลาที่เลือก`
        );
        err.status = 400;
        throw err;
    }

    const distributions = partners.map((p) => {
        const sharePercent = Number(p.share_percent ?? 0);
        const grossAmount = dividendAmount * (sharePercent / 100);
        const taxAmount = grossAmount * (config.withholdingTaxPercent / 100);
        return {
            user_id: p.user_id, fullname: p.fullname, share_percent: sharePercent,
            gross_amount: grossAmount, tax_amount: taxAmount, net_amount: grossAmount - taxAmount,
        };
    });

    return { config, periodProfit, actualReserve, requestedReserve, dividendAmount, distributions, totalSharePercent };
}

function buildAllocationResponse(calc) {
    return {
        period_profit: calc.periodProfit,
        reserve_percent: calc.config.legalReservePercent,
        reserve_amount: calc.actualReserve,
        reserve_capped: calc.actualReserve < calc.requestedReserve,
        dividend_percent: calc.config.dividendPercent,
        dividend_amount: calc.dividendAmount,
        withholding_tax_percent: calc.config.withholdingTaxPercent,
        total_share_percent: calc.totalSharePercent,
        distributions: calc.distributions,
    };
}

// preview อย่างเดียว ไม่บันทึกอะไรลง DB เลย — ให้แอดมินดูตัวเลขก่อนกดยืนยันจริง
async function previewAllocation(req, res, next) {
    try {
        const calc = await calculateAllocation(req.query.period_from, req.query.period_to);
        res.json(buildAllocationResponse(calc));
    } catch (err) {
        if (err.status) return res.status(err.status).json({ message: err.message });
        next(err);
    }
}

// บันทึกจริง — คำนวณซ้ำอีกครั้งฝั่งเซิร์ฟเวอร์ตอนกดยืนยัน (ไม่เชื่อตัวเลข preview ที่ client เก็บไว้ก่อนหน้า
// เผื่อมีการขายเพิ่ม/ตั้งค่าเปลี่ยนระหว่างที่แอดมินกำลังดู preview อยู่) แล้วสร้าง 1 แถวใน
// tb_profit_allocations + 1 แถวต่อหุ้นส่วนใน tb_partner_distributions พร้อมกันในทรานแซกชันเดียว
async function createAllocation(req, res, next) {
    const conn = await pool.getConnection();
    try {
        const { period_from, period_to, note } = req.body ?? {};
        const calc = await calculateAllocation(period_from, period_to);

        const alloc_id = await generateId("tb_profit_allocations", "ALC");
        const distIds = await generateIds("tb_partner_distributions", "PDT", calc.distributions.length);

        await conn.beginTransaction();
        await conn.query(
            `INSERT INTO tb_profit_allocations
                (alloc_id, alloc_period_from, alloc_period_to, alloc_period_profit, alloc_reserve_percent, alloc_reserve_amount,
                 alloc_dividend_percent, alloc_dividend_amount, alloc_note, alloc_created_by_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                alloc_id, period_from || null, period_to || null, calc.periodProfit,
                calc.config.legalReservePercent, calc.actualReserve, calc.config.dividendPercent, calc.dividendAmount,
                note || null, req.user.user_id,
            ]
        );

        const distributions = [];
        for (let i = 0; i < calc.distributions.length; i++) {
            const d = calc.distributions[i];
            await conn.query(
                `INSERT INTO tb_partner_distributions
                    (dist_id, dist_partner_id, dist_allocation_id, dist_amount, dist_tax_percent, dist_tax_amount, dist_note, dist_created_by_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [distIds[i], d.user_id, alloc_id, d.gross_amount, calc.config.withholdingTaxPercent, d.tax_amount, note || null, req.user.user_id]
            );
            distributions.push({ dist_id: distIds[i], ...d });
        }

        await conn.commit();
        res.status(201).json({ alloc_id, ...buildAllocationResponse(calc), distributions });
    } catch (err) {
        await conn.rollback();
        if (err.status) return res.status(err.status).json({ message: err.message });
        next(err);
    } finally {
        conn.release();
    }
}

async function getAllocations(req, res, next) {
    try {
        const limit = Number(req.query.limit) || 10;
        const offset = Number(req.query.offset) || 0;

        const [rows] = await pool.query(
            `SELECT alloc_id, alloc_period_from, alloc_period_to, alloc_period_profit, alloc_reserve_percent,
                    alloc_reserve_amount, alloc_dividend_percent, alloc_dividend_amount, alloc_note, alloc_created_at
             FROM tb_profit_allocations ORDER BY alloc_id DESC LIMIT ? OFFSET ?`,
            [limit, offset]
        );
        const [[{ total }]] = await pool.query("SELECT COUNT(*) AS total FROM tb_profit_allocations");

        res.json({ data: rows, total });
    } catch (err) {
        next(err);
    }
}

module.exports = { getAll, getOne, create, update, remove, markPaid, previewAllocation, createAllocation, getAllocations };
