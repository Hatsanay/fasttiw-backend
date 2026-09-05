const pool = require("../config/db");
const settingsController = require("./settings.controller");

// คำนวณกำไรสุทธิรวมทั้งบริษัทของช่วงเวลาหนึ่ง — ใช้ร่วมกันทั้ง summary() (แสดงในรายงาน) และ
// partnerShare() (เอาไปคูณสัดส่วนหุ้นแบ่งให้หุ้นส่วนแต่ละคน) กันคำนวณสูตรเพี้ยนไม่ตรงกันระหว่าง 2 หน้า
// รายได้อิงจาก tb_sales.sale_created_at (เวลาที่ grant สิทธิ์จริง) ส่วนค่าใช้จ่ายอิงจาก tb_expenses.exp_date
// (วันที่ค่าใช้จ่ายเกิดขึ้นจริงตามที่แอดมินระบุ ไม่ใช่วันที่บันทึกเข้าระบบ) — คนละความหมายของ "วันที่" ตั้งใจ
async function computeNetProfit(from, to) {
    const saleConditions = [];
    const saleParams = [];
    if (from) { saleConditions.push("sale_created_at >= ?"); saleParams.push(`${from} 00:00:00`); }
    if (to) { saleConditions.push("sale_created_at <= ?"); saleParams.push(`${to} 23:59:59`); }
    const saleWhereClause = saleConditions.length ? `WHERE ${saleConditions.join(" AND ")}` : "";

    const expenseConditions = [];
    const expenseParams = [];
    if (from) { expenseConditions.push("exp_date >= ?"); expenseParams.push(from); }
    if (to) { expenseConditions.push("exp_date <= ?"); expenseParams.push(to); }
    const expenseWhereClause = expenseConditions.length ? `WHERE ${expenseConditions.join(" AND ")}` : "";

    const [[saleAgg]] = await pool.query(
        `SELECT COALESCE(SUM(sale_total), 0) AS revenue, COALESCE(SUM(sale_gateway_fee), 0) AS gateway_fee, COUNT(*) AS sale_count
         FROM tb_sales ${saleWhereClause}`,
        saleParams
    );
    // ค่าคอมต้องหักออกจากกำไรภาพรวมด้วย ไม่งั้นกำไรที่โชว์จะสูงเกินจริง (เป็นเงินที่ต้องจ่ายพนักงานอยู่ดี
    // แค่ยังไม่ได้แยกเป็นรายจ่ายทั่วไป) — join ผ่าน tb_sales เพื่อกรองตาม sale_created_at ช่วงเดียวกับรายได้
    const [[commissionAgg]] = await pool.query(
        `SELECT COALESCE(SUM(si.si_commission_amount), 0) AS commission
         FROM tb_sale_items si
         JOIN tb_sales s ON s.sale_id = si.si_sale_id
         ${saleWhereClause.replace(/sale_created_at/g, "s.sale_created_at")}`,
        saleParams
    );
    const [[expenseAgg]] = await pool.query(
        `SELECT COALESCE(SUM(exp_amount), 0) AS expenses, COUNT(*) AS expense_count FROM tb_expenses ${expenseWhereClause}`,
        expenseParams
    );

    const revenue = Number(saleAgg.revenue);
    const commission = Number(commissionAgg.commission);
    const expenses = Number(expenseAgg.expenses);
    const gatewayFee = Number(saleAgg.gateway_fee);

    return {
        revenue, expenses, commission, gateway_fee: gatewayFee,
        profit: revenue - expenses - commission - gatewayFee,
        sale_count: saleAgg.sale_count, expense_count: expenseAgg.expense_count,
    };
}

// สรุปรายได้/ค่าใช้จ่าย/กำไร กรองตามช่วงเวลาได้ (ไม่ใส่ from/to = ทั้งหมดตั้งแต่เริ่มระบบ)
async function summary(req, res, next) {
    try {
        const { from, to } = req.query;
        const net = await computeNetProfit(from, to);

        const expenseConditions = [];
        const expenseParams = [];
        if (from) { expenseConditions.push("exp_date >= ?"); expenseParams.push(from); }
        if (to) { expenseConditions.push("exp_date <= ?"); expenseParams.push(to); }
        const expenseWhereClause = expenseConditions.length ? `WHERE ${expenseConditions.join(" AND ")}` : "";

        const [expenseByCategory] = await pool.query(
            `SELECT ec.excat_id, ec.excat_name, SUM(e.exp_amount) AS total
             FROM tb_expenses e
             JOIN tb_expense_categories ec ON ec.excat_id = e.exp_category_id
             ${expenseWhereClause}
             GROUP BY ec.excat_id, ec.excat_name
             ORDER BY total DESC`,
            expenseParams
        );

        res.json({ ...net, expense_by_category: expenseByCategory });
    } catch (err) {
        next(err);
    }
}

// ส่วนแบ่งกำไรของหุ้นส่วนแต่ละคน = "เงินปันผลที่จะประกาศจ่ายจริงตามนโยบาย" (กำไรสุทธิของช่วงเวลา × % จ่ายปันผล
// ที่ตั้งไว้ที่หน้าตั้งค่าการจัดสรรกำไร) × สัดส่วนหุ้นของแต่ละคน — ไม่ใช่กำไรสุทธิทั้งก้อนคูณสัดส่วนหุ้นตรงๆ
// เพราะบริษัทไม่ได้จ่ายกำไร 100% ออกเป็นปันผลเสมอไป (กันไว้เป็นทุนสำรองตามกฎหมายส่วนหนึ่ง + เก็บเป็นกำไรสะสม
// ส่วนที่เหลือ ตามนโยบายเดียวกับที่ calculateAllocation ใช้จริงตอนกด "จัดสรรกำไร") ต้องใช้สูตรเดียวกันเป๊ะ
// ไม่งั้นหน้านี้จะโชว์ตัวเลขที่หุ้นส่วนไม่มีทางได้รับจริงตามนโยบายบริษัท — ไม่ได้บังคับผลรวมสัดส่วนของทุกคน
// ต้องเท่ากับ 100 พอดี (เตือนใน response เฉยๆ ให้แอดมินไปจัดการเอง)
async function partnerShare(req, res, next) {
    try {
        const { from, to } = req.query;
        const net = await computeNetProfit(from, to);
        const config = await settingsController.getDividendConfig();
        const dividendAmount = calculateDividendAmount(net.profit, config.dividendPercent);

        const [partners] = await pool.query(
            `SELECT user_id, CONCAT(user_fname, ' ', user_lname) AS fullname, user_partner_share_percent AS share_percent
             FROM tb_users WHERE user_is_partner = TRUE ORDER BY user_partner_share_percent DESC`
        );

        const totalSharePercent = partners.reduce((sum, p) => sum + Number(p.share_percent ?? 0), 0);
        const data = partners.map((p) => ({
            user_id: p.user_id,
            fullname: p.fullname,
            share_percent: Number(p.share_percent ?? 0),
            share_amount: dividendAmount * (Number(p.share_percent ?? 0) / 100),
        }));

        res.json({
            profit: net.profit, dividend_percent: config.dividendPercent, dividend_amount: dividendAmount,
            total_share_percent: totalSharePercent, partners: data,
        });
    } catch (err) {
        next(err);
    }
}

// สูตร "เงินปันผลรวมที่จะประกาศจ่ายจริง" = กำไร × % จ่ายปันผลที่ตั้งไว้ที่หน้าตั้งค่าการจัดสรรกำไร (ไม่ใช่
// กำไรทั้งก้อน เพราะบริษัทไม่ได้จ่ายกำไรออกเป็นปันผล 100% เสมอไป — กันไว้เป็นทุนสำรอง/กำไรสะสมส่วนหนึ่งด้วย)
// ใช้ร่วมกันทุกจุดที่ต้องโชว์ "หุ้นส่วนจะได้ปันผลเท่าไหร่" (partnerShare, getRetainedEarnings.by_partner,
// และ partnerDistribution.controller.js: calculateAllocation ตอนจัดสรรจริง) ห้ามคำนวณแยกเอง เพราะเคยเจอบั๊ก
// มาแล้วที่จุดหนึ่งคูณ % ปันผลแต่อีกจุดลืมคูณ ทำให้โชว์ตัวเลขที่หุ้นส่วนไม่มีทางได้รับจริงตามนโยบายบริษัท
function calculateDividendAmount(profit, dividendPercent) {
    return Math.max(0, (dividendPercent / 100) * profit);
}

// เงื่อนไข "นับว่าจ่ายส่วนแบ่งกำไรออกจากกำไรสะสมแล้ว" (ดูเหตุผลเต็มๆ ที่คอมเมนต์เหนือ getRetainedEarnings
// ด้านล่าง) — ใช้ตัวแปรเดียวกันทั้งยอดรวม (computeRetainedEarnings) และต่อรายหุ้นส่วน (getRetainedEarnings)
// กันเขียนเงื่อนไขเดียวกันซ้ำ 2 จุดแล้วแก้ไม่ครบพร้อมกัน (บั๊กคลาสเดียวกับที่เจอใน partnerShare()/
// theoretical_share ที่ไม่ได้คูณ % จ่ายปันผลก่อน และ reserveCap ที่เคยคำนวณซ้ำเองใน calculateAllocation)
const DIST_COUNTED_WHERE = "(d.dist_status = 'paid' OR d.dist_allocation_id IS NOT NULL)";

// helper กลาง — คำนวณกำไรสะสมคงเหลือ ณ ตอนนี้ (กำไรสุทธิสะสมทั้งหมด หักทุนสำรองสะสม หักเงินปันผล/ส่วนแบ่ง
// ที่นับว่าจ่ายออกแล้ว) ใช้ร่วมกันทั้ง getRetainedEarnings (แสดงผลหน้ารายงาน) และ
// partnerDistribution.controller.js: calculateAllocation (เช็คว่ากำไรสะสมพอสำหรับการจัดสรรครั้งใหม่ไหม
// ก่อนจะกันทุนสำรอง/ประกาศจ่ายปันผลซ้อนทับของเดิม) กันคำนวณสูตรเพี้ยนไม่ตรงกันระหว่าง 2 จุด
async function computeRetainedEarnings() {
    const net = await computeNetProfit(null, null);

    const [[reserveAgg]] = await pool.query(
        "SELECT COALESCE(SUM(alloc_reserve_amount), 0) AS total_reserve FROM tb_profit_allocations"
    );
    const totalReserve = Number(reserveAgg.total_reserve);

    const [[distAgg]] = await pool.query(
        `SELECT COALESCE(SUM(dist_amount), 0) AS total_distributed FROM tb_partner_distributions d WHERE ${DIST_COUNTED_WHERE}`
    );
    const totalDistributed = Number(distAgg.total_distributed);

    const [[capRow]] = await pool.query(
        "SELECT setting_value FROM tb_settings WHERE setting_key = 'registered_capital'"
    );
    const registeredCapital = Number(capRow?.setting_value ?? 0) || 0;
    const reserveCap = registeredCapital * 0.1;

    return {
        totalProfit: net.profit,
        totalReserve,
        reserveCap,
        reserveRemaining: Math.max(0, reserveCap - totalReserve),
        totalDistributed,
        retainedEarnings: net.profit - totalReserve - totalDistributed,
    };
}

// กำไรสะสมของบริษัท = กำไรสุทธิสะสมทั้งหมดตั้งแต่เริ่มกิจการ (computeNetProfit(null,null) ไม่กรองช่วงเวลา)
// หักด้วย (1) ทุนสำรองตามกฎหมายที่กันไว้สะสม (tb_profit_allocations.alloc_reserve_amount ทุกแถว) และ
// (2) เงินปันผล/ส่วนแบ่งกำไรที่ "นับว่าจ่ายออกจากกำไรสะสมแล้ว" — ตัวเลขนี้ไม่ขึ้นกับ from/to เพราะกำไร
// สะสมโดยนิยามคือยอดสะสมทั้งหมด ไม่ใช่ของช่วงเวลาใดช่วงเวลาหนึ่ง — เงินจ่ายส่วนแบ่งไม่ใช่รายจ่าย (ไม่ผ่าน
// tb_expenses เลย) ดูเหตุผลเต็มๆ ใน database/query/create_partner_distributions.sql กันหักซ้ำสอง
//
// เงื่อนไข "นับว่าจ่ายแล้ว" ต่างกัน 2 กรณีตั้งใจ:
//   - รายการที่มาจาก "จัดสรรกำไร" อย่างเป็นทางการ (dist_allocation_id ไม่ใช่ NULL) → นับทันทีตอนประกาศ/
//     สร้างรายการ ไม่ต้องรอกด "จ่ายแล้ว" เพราะการประกาศจ่ายปันผลคือจุดที่กำไรสะสมถูกหักออกตามหลักบัญชี
//     สถานะ pending/paid ของรายการนี้แค่ track ว่าโอนเงินเข้าบัญชีหุ้นส่วนจริงหรือยัง ไม่กระทบกำไรสะสมแล้ว
//   - รายการที่พิมพ์เองแบบ manual (dist_allocation_id เป็น NULL) → ยังนับเฉพาะตอน dist_status='paid'
//     เหมือนพฤติกรรมเดิมที่ทดสอบผ่านไปแล้ว เพราะไม่มีขั้นตอน "ประกาศอย่างเป็นทางการ" แยกจากการจ่ายจริง
async function getRetainedEarnings(req, res, next) {
    try {
        const {
            totalProfit, totalReserve, reserveCap, reserveRemaining, totalDistributed, retainedEarnings,
        } = await computeRetainedEarnings();
        const config = await settingsController.getDividendConfig();
        const dividendAmount = calculateDividendAmount(totalProfit, config.dividendPercent);

        const [partners] = await pool.query(
            `SELECT u.user_id, CONCAT(u.user_fname, ' ', u.user_lname) AS fullname, u.user_partner_share_percent AS share_percent,
                    COALESCE((SELECT SUM(d.dist_amount) FROM tb_partner_distributions d
                              WHERE d.dist_partner_id = u.user_id
                                AND ${DIST_COUNTED_WHERE}), 0) AS total_paid
             FROM tb_users u WHERE u.user_is_partner = TRUE ORDER BY u.user_partner_share_percent DESC`
        );

        res.json({
            total_profit: totalProfit,
            total_reserve: totalReserve,
            reserve_cap: reserveCap,
            reserve_remaining: reserveRemaining,
            total_distributed: totalDistributed,
            retained_earnings: retainedEarnings,
            dividend_percent: config.dividendPercent,
            by_partner: partners.map((p) => ({
                user_id: p.user_id,
                fullname: p.fullname,
                share_percent: Number(p.share_percent ?? 0),
                theoretical_share: dividendAmount * (Number(p.share_percent ?? 0) / 100),
                total_paid: Number(p.total_paid),
            })),
        });
    } catch (err) {
        next(err);
    }
}

// รายได้/ค่าคอม/ค่าใช้จ่าย/กำไร แยกตาม product — เฉพาะ product ที่มีความเคลื่อนไหวจริงในช่วงเวลานั้น
// (มีขายหรือมีรายจ่ายผูกอยู่) กันตารางยาวเป็นหางว่าวด้วย product ที่ยอด 0 ทั้งหมด
// รายได้/ค่าคอมอิงจาก tb_sale_items (แยกต่อบรรทัดต่อ product อยู่แล้วตั้งแต่ตอนบันทึกการขาย)
// ค่าใช้จ่ายอิงจาก tb_expenses.exp_product_id (เฉพาะรายจ่ายที่ผูกกับ product ใดผูกหนึ่งเท่านั้น
// ไม่รวมรายจ่ายทั่วไปที่ exp_product_id เป็น NULL) — กำไรต่อ product ไม่ได้หักรายจ่ายทั่วไปมาเฉลี่ยด้วย
// เพราะการปันส่วนรายจ่ายทั่วไปลง product เป็นเรื่อง policy ที่ซับซ้อนกว่านี้ ไม่ทำใน MVP
async function byProduct(req, res, next) {
    try {
        const { from, to } = req.query;

        const saleConditions = [];
        const saleParams = [];
        if (from) { saleConditions.push("s.sale_created_at >= ?"); saleParams.push(`${from} 00:00:00`); }
        if (to) { saleConditions.push("s.sale_created_at <= ?"); saleParams.push(`${to} 23:59:59`); }
        const saleWhereClause = saleConditions.length ? `WHERE ${saleConditions.join(" AND ")}` : "";

        const expenseConditions = ["e.exp_product_id IS NOT NULL"];
        const expenseParams = [];
        if (from) { expenseConditions.push("e.exp_date >= ?"); expenseParams.push(from); }
        if (to) { expenseConditions.push("e.exp_date <= ?"); expenseParams.push(to); }
        const expenseWhereClause = `WHERE ${expenseConditions.join(" AND ")}`;

        const [revenueRows] = await pool.query(
            `SELECT si.si_product_id AS prod_id, p.prod_name,
                    SUM(si.si_total) AS revenue, SUM(si.si_commission_amount) AS commission
             FROM tb_sale_items si
             JOIN tb_sales s ON s.sale_id = si.si_sale_id
             JOIN tb_products p ON p.prod_id = si.si_product_id
             ${saleWhereClause}
             GROUP BY si.si_product_id, p.prod_name`,
            saleParams
        );

        const [expenseRows] = await pool.query(
            `SELECT e.exp_product_id AS prod_id, p.prod_name, SUM(e.exp_amount) AS expenses
             FROM tb_expenses e
             JOIN tb_products p ON p.prod_id = e.exp_product_id
             ${expenseWhereClause}
             GROUP BY e.exp_product_id, p.prod_name`,
            expenseParams
        );

        const byProductMap = {};
        for (const row of revenueRows) {
            byProductMap[row.prod_id] = {
                prod_id: row.prod_id, prod_name: row.prod_name,
                revenue: Number(row.revenue), commission: Number(row.commission), expenses: 0,
            };
        }
        for (const row of expenseRows) {
            if (!byProductMap[row.prod_id]) {
                byProductMap[row.prod_id] = {
                    prod_id: row.prod_id, prod_name: row.prod_name, revenue: 0, commission: 0, expenses: 0,
                };
            }
            byProductMap[row.prod_id].expenses = Number(row.expenses);
        }

        const data = Object.values(byProductMap)
            .map((p) => ({ ...p, profit: p.revenue - p.expenses - p.commission }))
            .sort((a, b) => b.revenue - a.revenue);

        res.json({ data });
    } catch (err) {
        next(err);
    }
}

// จัดอันดับ product ตามจำนวนครั้งที่ถูก grant สิทธิ์จริง (นับจาก tb_sale_items ซึ่งเป็นบัญชีรายได้ตัวจริง
// ไม่ใช่ tb_orders ที่มีแค่ฝั่งลูกค้าเช็คเอาท์เอง ไม่รวมการ grant มือของแอดมิน) — ใช้ endpoint เดียวรองรับทั้ง
// widget "คนใช้ฟรีไปกี่ข้อสอบ" และ "คนซื้อจ่ายเงินไปกี่ข้อสอบ" ผ่าน query param is_free แทนที่จะเขียน query
// เกือบเหมือนกันซ้ำ 2 ฟังก์ชัน (บั๊กคลาสเดียวกับที่เจอมาแล้วในเซสชันนี้ — สูตร/query ซ้ำกัน 2 จุดแล้วแก้ไม่ครบ
// พร้อมกัน) is_free ไม่ส่งมา = ไม่กรอง (รวมทั้งฟรีและจ่ายเงิน)
async function getProductRanking(req, res, next) {
    try {
        const { is_free, from, to, category_id } = req.query;
        const conditions = [];
        const params = [];
        if (is_free === "true") conditions.push("p.prod_is_free = TRUE");
        else if (is_free === "false") conditions.push("p.prod_is_free = FALSE");
        if (from) { conditions.push("s.sale_created_at >= ?"); params.push(`${from} 00:00:00`); }
        if (to) { conditions.push("s.sale_created_at <= ?"); params.push(`${to} 23:59:59`); }
        if (category_id) { conditions.push("p.prod_category_id = ?"); params.push(category_id); }
        const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

        const [rows] = await pool.query(
            `SELECT p.prod_id, p.prod_name, COUNT(*) AS claim_count, SUM(si.si_total) AS revenue
             FROM tb_sale_items si
             JOIN tb_sales s ON s.sale_id = si.si_sale_id
             JOIN tb_products p ON p.prod_id = si.si_product_id
             ${whereClause}
             GROUP BY p.prod_id, p.prod_name
             ORDER BY claim_count DESC`,
            params
        );

        const ranking = rows.map((r) => ({
            prod_id: r.prod_id, prod_name: r.prod_name, claim_count: r.claim_count, revenue: Number(r.revenue),
        }));
        res.json({
            total_count: ranking.reduce((sum, r) => sum + r.claim_count, 0),
            total_revenue: ranking.reduce((sum, r) => sum + r.revenue, 0),
            ranking,
        });
    } catch (err) {
        next(err);
    }
}

// จัดอันดับแพ็กเกจตามจำนวนครั้งที่ถูกซื้อจริง — นับจาก tb_sales.sale_package_id (metadata ที่ propagate มาจาก
// tb_orders.ord_package_id ตอน settlePaidOrder เรียก recordSale ดู entitlement.controller.js) กรองเฉพาะ
// sale ที่มาจากการซื้อแพ็กเกจจริง (sale_package_id IS NOT NULL) — ไม่รวมการซื้อ product เดี่ยว
// category_id: 1 แพ็กเกจมีได้หลายหมวดหมู่ปนกัน (ผ่าน product ย่อยในแพ็กเกจ) นิยาม "แพ็กเกจอยู่ในหมวดหมู่นี้"
// คือ "มีชุดข้อสอบในหมวดนั้นรวมอยู่อย่างน้อย 1 ชุด" (ยืนยันกับผู้ใช้แล้ว) ใช้ EXISTS แทน JOIN ธรรมดา กัน 1
// แพ็กเกจถูกนับซ้ำหลายแถวถ้ามี product มากกว่า 1 ชุดในหมวดหมู่เดียวกัน
async function getPackageRanking(req, res, next) {
    try {
        const { from, to, category_id } = req.query;
        const conditions = ["s.sale_package_id IS NOT NULL"];
        const params = [];
        if (from) { conditions.push("s.sale_created_at >= ?"); params.push(`${from} 00:00:00`); }
        if (to) { conditions.push("s.sale_created_at <= ?"); params.push(`${to} 23:59:59`); }
        if (category_id) {
            conditions.push(
                `EXISTS (SELECT 1 FROM tb_package_items pi JOIN tb_products p ON p.prod_id = pi.pki_product_id
                         WHERE pi.pki_package_id = pkg.pkg_id AND p.prod_category_id = ?)`
            );
            params.push(category_id);
        }
        const whereClause = `WHERE ${conditions.join(" AND ")}`;

        const [rows] = await pool.query(
            `SELECT pkg.pkg_id, pkg.pkg_name, COUNT(*) AS purchase_count, SUM(s.sale_total) AS revenue
             FROM tb_sales s
             JOIN tb_packages pkg ON pkg.pkg_id = s.sale_package_id
             ${whereClause}
             GROUP BY pkg.pkg_id, pkg.pkg_name
             ORDER BY purchase_count DESC`,
            params
        );

        const ranking = rows.map((r) => ({
            pkg_id: r.pkg_id, pkg_name: r.pkg_name, purchase_count: r.purchase_count, revenue: Number(r.revenue),
        }));
        res.json({
            total_count: ranking.reduce((sum, r) => sum + r.purchase_count, 0),
            total_revenue: ranking.reduce((sum, r) => sum + r.revenue, 0),
            ranking,
        });
    } catch (err) {
        next(err);
    }
}

// แยกยอดขายตาม "ช่องทาง" — แอดมินขายผ่านแชทแล้ว grant มือ vs ลูกค้ากดซื้อเองบนเว็บ
//
// ตัดสินจาก tb_sales.sale_created_by_id: มีค่า = staff คนนั้นเป็นคนกดให้สิทธิ์ (ดู createBatch ใน
// entitlement.controller.js ส่ง req.user.user_id เข้ามา), NULL = มาจาก settlePaidOrder ที่ webhook เรียก
// ซึ่งไม่มี user คนไหนกดเลย — ไม่ต้องเพิ่มคอลัมน์ใหม่ ข้อมูลนี้ถูกบันทึกไว้ตั้งแต่แรกแล้ว แค่ไม่เคยมีใครหยิบมาใช้
//
// ประโยชน์: ตอบคำถามว่าช่องทางไหนทำเงินได้มากกว่ากัน คุ้มไหมที่จะลงแรงกับ payment gateway ต่อ หรือควร
// ทุ่มไปทางขายผ่านแชท (ตาม CLAUDE.md ข้อ 3 ที่ตั้งใจเริ่มจากช่องทางแชทก่อนเพื่อพิสูจน์ยอดขายจริง)
async function getSalesByChannel(req, res, next) {
    try {
        const { from, to } = req.query;
        const conditions = [];
        const params = [];
        if (from) { conditions.push("sale_created_at >= ?"); params.push(`${from} 00:00:00`); }
        if (to) { conditions.push("sale_created_at <= ?"); params.push(`${to} 23:59:59`); }
        const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

        const [[row]] = await pool.query(
            `SELECT
                COALESCE(SUM(CASE WHEN sale_created_by_id IS NOT NULL THEN sale_total ELSE 0 END), 0) AS admin_revenue,
                SUM(sale_created_by_id IS NOT NULL) AS admin_count,
                COALESCE(SUM(CASE WHEN sale_created_by_id IS NULL THEN sale_total ELSE 0 END), 0) AS self_revenue,
                SUM(sale_created_by_id IS NULL) AS self_count,
                COALESCE(SUM(sale_gateway_fee), 0) AS gateway_fee
             FROM tb_sales ${whereClause}`,
            params
        );

        const adminRevenue = Number(row.admin_revenue);
        const selfRevenue = Number(row.self_revenue);
        const totalRevenue = adminRevenue + selfRevenue;

        res.json({
            total_revenue: totalRevenue,
            // ค่าธรรมเนียม gateway เกิดเฉพาะช่องทางซื้อเอง (grant มือส่ง gatewayFee = 0 เสมอ) แนบมาด้วยเพื่อให้
            // เทียบกันได้ว่าช่องทางเว็บเหลือเข้ากระเป๋าจริงเท่าไรหลังหักค่าธรรมเนียม
            gateway_fee: Number(row.gateway_fee),
            channels: [
                {
                    key: "admin",
                    label: "แอดมินให้สิทธิ์เอง",
                    revenue: adminRevenue,
                    sale_count: Number(row.admin_count),
                    share: totalRevenue > 0 ? Math.round((adminRevenue / totalRevenue) * 100) : 0,
                },
                {
                    key: "self",
                    label: "ลูกค้าซื้อเองบนเว็บ",
                    revenue: selfRevenue,
                    sale_count: Number(row.self_count),
                    share: totalRevenue > 0 ? Math.round((selfRevenue / totalRevenue) * 100) : 0,
                },
            ],
        });
    } catch (err) {
        next(err);
    }
}

// อัตราแปลงจาก "เคยใช้สิทธิ์ฟรี" → "กลับมาซื้อแบบจ่ายเงินจริง" — free_claimer_count กรองตามช่วงเวลาที่เลือก
// (คนที่ใช้สิทธิ์ฟรีอย่างน้อย 1 ครั้งภายในช่วงนี้ ไม่จำเป็นต้องเป็นครั้งแรกที่เคยใช้สิทธิ์ฟรีเลยตลอดประวัติ — คนที่
// เคยใช้ฟรีมาก่อนหน้าช่วงนี้แล้วมาใช้ฟรีอีกครั้งในช่วงนี้ก็นับ) ส่วน converted_count เช็คการซื้อแบบจ่ายเงินของคนกลุ่มนั้น "ตลอดเวลา"
// ไม่จำกัดว่าซื้อก่อน/หลังช่วงที่เลือก (ตกลงกับผู้ใช้แล้วว่านิยามแบบนี้) นิยาม "จ่ายเงินจริง" ใช้ prod_is_free
// = FALSE ที่ตัว product เดียวกับที่ widget อันดับ product ใช้กรอง ไม่ใช้ si_total > 0 เพราะคูปองส่วนลด 100%
// ก็ยังนับว่า "ซื้อของที่ไม่ใช่ของฟรี" อยู่ดี (สม่ำเสมอกับนิยามฟรี/จ่ายเงินที่ใช้ทั้งระบบ)
async function getFreeToPaidConversion(req, res, next) {
    try {
        const { from, to } = req.query;
        const freeConditions = ["p.prod_is_free = TRUE"];
        const freeParams = [];
        if (from) { freeConditions.push("s.sale_created_at >= ?"); freeParams.push(`${from} 00:00:00`); }
        if (to) { freeConditions.push("s.sale_created_at <= ?"); freeParams.push(`${to} 23:59:59`); }

        const [freeClaimers] = await pool.query(
            `SELECT DISTINCT s.sale_customer_id
             FROM tb_sales s
             JOIN tb_sale_items si ON si.si_sale_id = s.sale_id
             JOIN tb_products p ON p.prod_id = si.si_product_id
             WHERE ${freeConditions.join(" AND ")}`,
            freeParams
        );
        const customerIds = freeClaimers.map((r) => r.sale_customer_id);

        let convertedCount = 0;
        if (customerIds.length > 0) {
            const [[convertedAgg]] = await pool.query(
                `SELECT COUNT(DISTINCT s.sale_customer_id) AS converted_count
                 FROM tb_sales s
                 JOIN tb_sale_items si ON si.si_sale_id = s.sale_id
                 JOIN tb_products p ON p.prod_id = si.si_product_id
                 WHERE p.prod_is_free = FALSE AND s.sale_customer_id IN (?)`,
                [customerIds]
            );
            convertedCount = Number(convertedAgg.converted_count);
        }

        const freeClaimerCount = customerIds.length;
        res.json({
            free_claimer_count: freeClaimerCount,
            converted_count: convertedCount,
            conversion_rate: freeClaimerCount > 0 ? (convertedCount / freeClaimerCount) * 100 : 0,
        });
    } catch (err) {
        next(err);
    }
}

// จำกัดช่วงสูงสุด 366 วัน กัน custom range ที่ผู้ใช้เลือกกว้างเกินไปชน cte_max_recursion_depth ของ MySQL
// (ค่า default 1000 — 366 วันยังห่างไกลเพดานนี้มาก) และกัน response ใหญ่เกินจำเป็นโดยไม่ตั้งใจ — ถ้ากว้างกว่า
// นั้นตัดให้เหลือ 366 วันล่าสุดนับจาก "to" แทนเงียบๆ (ยังแสดงข้อมูลจริงถูกต้องอยู่ แค่ตัดช่วงให้แคบลง)
// เทียบวันที่ล้วนๆ แบบ UTC midnight ไม่ได้อิงเวลาปัจจุบัน จึงไม่เจอปัญหา timezone เหมือนการคำนวณ "วันนี้"
function clampTrendRange(from, to) {
    if (!from || !to) return { from: null, to: null };
    const fromDate = new Date(`${from}T00:00:00Z`);
    const toDate = new Date(`${to}T00:00:00Z`);
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime()) || fromDate > toDate) {
        return { from: null, to: null };
    }
    const spanDays = Math.round((toDate - fromDate) / 86400000) + 1;
    if (spanDays > 366) {
        const cappedFrom = new Date(toDate);
        cappedFrom.setUTCDate(cappedFrom.getUTCDate() - 365);
        return { from: cappedFrom.toISOString().slice(0, 10), to };
    }
    return { from, to };
}

// แนวโน้มยอดขายรายวันตามช่วงเวลาที่เลือก (from/to จาก PeriodFilter ฝั่ง frontend — เดียวกับ widget อื่นๆ
// ในแดชบอร์ด ไม่ตายตัวที่ 30 วันล่าสุดเหมือนตอนแรก เพราะผู้ใช้ต้องการดูย้อนหลังไปช่วงอื่นได้ด้วย) ไม่ส่ง
// from/to มา = default 30 วันล่าสุด เติมวันที่ไม่มียอดขายด้วย revenue=0 ให้กราฟต่อเนื่อง (ไม่ขาดช่วง) —
// สร้างลำดับวันที่ทั้งหมดด้วย recursive CTE ฝั่ง SQL ล้วนๆ ไม่ loop ด้วย new Date() ฝั่ง JS เพราะ MySQL
// session ตั้ง time_zone เป็น '+07:00' ทุก connection อยู่แล้ว (ดู config/db.js) CURDATE()/DATE() จึงตรงกับ
// "วันนี้" ตามเวลาไทยเป๊ะ ถ้าคำนวณวันที่ฝั่ง JS ด้วย toISOString().slice(0,10) แทนจะเพี้ยนช่วงเที่ยงคืน-7โมง
// เช้าเวลาไทย (toISOString คืนวันที่ตาม UTC ซึ่งยังเป็น "เมื่อวาน" อยู่) — default ที่ไม่ได้ระบุ from/to จึง
// คำนวณด้วย DATE_SUB(CURDATE(), ...) ฝั่ง SQL ผ่าน COALESCE เช่นกัน ไม่ใช้ JS new Date() เลยแม้แต่ตอน default
// — ใช้ DATE_FORMAT คืนเป็น string ตรงๆ จาก SQL เลย กัน mysql2 แปลง DATE เป็น JS Date object แล้วโดนตีความ
// timezone ซ้ำอีกชั้น
async function getDailySalesTrend(req, res, next) {
    try {
        const { from, to } = clampTrendRange(req.query.from, req.query.to);

        const [rows] = await pool.query(
            `WITH RECURSIVE bounds AS (
                SELECT COALESCE(?, DATE_SUB(CURDATE(), INTERVAL 29 DAY)) AS d_from, COALESCE(?, CURDATE()) AS d_to
             ),
             date_seq AS (
                SELECT d_from AS d, d_to FROM bounds
                UNION ALL
                SELECT DATE_ADD(d, INTERVAL 1 DAY), d_to FROM date_seq WHERE d < d_to
             )
             SELECT DATE_FORMAT(ds.d, '%Y-%m-%d') AS sale_date,
                    COALESCE(SUM(s.sale_total), 0) AS revenue,
                    COUNT(s.sale_id) AS sale_count
             FROM date_seq ds
             LEFT JOIN tb_sales s ON DATE(s.sale_created_at) = ds.d
             GROUP BY ds.d
             ORDER BY ds.d`,
            [from, to]
        );

        res.json({
            data: rows.map((r) => ({ date: r.sale_date, revenue: Number(r.revenue), sale_count: r.sale_count })),
        });
    } catch (err) {
        next(err);
    }
}

// หมวดหมู่ขายดี จัดอันดับตามรายได้ — join ผ่าน tb_sale_items (บัญชีรายได้จริงต่อ product) ไป tb_products
// เพื่อดึงหมวดหมู่ product ที่ไม่มีหมวดหมู่ (prod_category_id เป็น NULL) จะไม่ถูกนับ (ตั้งใจ — INNER JOIN)
async function getTopCategories(req, res, next) {
    try {
        const { from, to } = req.query;
        const conditions = [];
        const params = [];
        if (from) { conditions.push("s.sale_created_at >= ?"); params.push(`${from} 00:00:00`); }
        if (to) { conditions.push("s.sale_created_at <= ?"); params.push(`${to} 23:59:59`); }
        const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

        const [rows] = await pool.query(
            `SELECT c.cat_id, c.cat_name, SUM(si.si_total) AS revenue, COUNT(*) AS sale_count
             FROM tb_sale_items si
             JOIN tb_sales s ON s.sale_id = si.si_sale_id
             JOIN tb_products p ON p.prod_id = si.si_product_id
             JOIN tb_categories c ON c.cat_id = p.prod_category_id
             ${whereClause}
             GROUP BY c.cat_id, c.cat_name
             ORDER BY revenue DESC`,
            params
        );

        res.json({
            data: rows.map((r) => ({
                cat_id: r.cat_id, cat_name: r.cat_name, revenue: Number(r.revenue), sale_count: r.sale_count,
            })),
        });
    } catch (err) {
        next(err);
    }
}

module.exports = {
    summary, byProduct, partnerShare, getRetainedEarnings,
    computeNetProfit, computeRetainedEarnings, calculateDividendAmount,
    getProductRanking, getPackageRanking, getFreeToPaidConversion, getDailySalesTrend, getTopCategories,
    getSalesByChannel,
};
