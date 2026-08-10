const pool = require("../config/db");
const { generateId, generateIds } = require("../utils/generateId");

const PAYROLL_EXPENSE_CATEGORY_ID = "EXC202607240000006"; // "เงินเดือนพนักงาน" — seed ไว้ตอน migration แล้ว

async function getAll(req, res, next) {
    try {
        const limit = Number(req.query.limit) || 10;
        const offset = Number(req.query.offset) || 0;
        const search = `%${req.query.search ?? ""}%`;

        const conditions = ["CONCAT(u.user_fname, ' ', u.user_lname) LIKE ?"];
        const params = [search];
        if (req.query.year) { conditions.push("p.pay_period_year = ?"); params.push(Number(req.query.year)); }
        if (req.query.month) { conditions.push("p.pay_period_month = ?"); params.push(Number(req.query.month)); }
        if (req.query.status === "pending" || req.query.status === "paid") {
            conditions.push("p.pay_status = ?"); params.push(req.query.status);
        }
        const whereClause = conditions.join(" AND ");

        const [rows] = await pool.query(
            `SELECT p.pay_id, p.pay_staff_id, CONCAT(u.user_fname, ' ', u.user_lname) AS staff_fullname,
                    p.pay_period_month, p.pay_period_year, p.pay_base_salary, p.pay_bonus, p.pay_allowance,
                    p.pay_social_security, p.pay_withholding_tax, p.pay_other_deduction, p.pay_net_amount,
                    p.pay_source, p.pay_status, p.pay_paid_at, p.pay_created_at
             FROM tb_payrolls p
             JOIN tb_users u ON u.user_id = p.pay_staff_id
             WHERE ${whereClause}
             ORDER BY p.pay_period_year DESC, p.pay_period_month DESC, p.pay_id DESC
             LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );
        const [[{ total }]] = await pool.query(
            `SELECT COUNT(*) AS total FROM tb_payrolls p
             JOIN tb_users u ON u.user_id = p.pay_staff_id
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
            `SELECT p.pay_id, p.pay_staff_id, CONCAT(u.user_fname, ' ', u.user_lname) AS staff_fullname,
                    p.pay_period_month, p.pay_period_year, p.pay_base_salary, p.pay_bonus, p.pay_allowance,
                    p.pay_social_security, p.pay_withholding_tax, p.pay_other_deduction, p.pay_net_amount,
                    p.pay_note, p.pay_status, p.pay_paid_at, p.pay_created_at
             FROM tb_payrolls p
             JOIN tb_users u ON u.user_id = p.pay_staff_id
             WHERE p.pay_id = ?`,
            [req.params.id]
        );
        if (!rows[0]) return res.status(404).json({ message: "ไม่พบรายการเงินเดือนนี้" });
        res.json(rows[0]);
    } catch (err) {
        next(err);
    }
}

// คำนวณยอดสุทธิเอง ไม่เชื่อเลขที่ frontend ส่งมา (เหมือนหลักการเดียวกับยอดขาย — เงินจริงต้องคิดฝั่ง backend)
function calculateNet({ pay_base_salary, pay_bonus, pay_allowance, pay_social_security, pay_withholding_tax, pay_other_deduction }) {
    const base = Number(pay_base_salary) || 0;
    const bonus = Number(pay_bonus) || 0;
    const allowance = Number(pay_allowance) || 0;
    const ss = Number(pay_social_security) || 0;
    const tax = Number(pay_withholding_tax) || 0;
    const other = Number(pay_other_deduction) || 0;
    return base + bonus + allowance - ss - tax - other;
}

function validatePayroll(body) {
    const { pay_staff_id, pay_period_month, pay_period_year, pay_base_salary } = body;
    if (!pay_staff_id) return "กรุณาเลือกพนักงาน";
    const month = Number(pay_period_month);
    if (!Number.isInteger(month) || month < 1 || month > 12) return "เดือนไม่ถูกต้อง";
    const year = Number(pay_period_year);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) return "ปีไม่ถูกต้อง";
    if (!Number.isFinite(Number(pay_base_salary)) || Number(pay_base_salary) <= 0) return "เงินเดือนพื้นฐานต้องมากกว่า 0";
    // ยอดสุทธิติดลบไม่ได้ — ถ้าปล่อยผ่านจะไปสร้างรายจ่ายติดลบตอน markPaid (ลดยอดรายจ่ายรวมของบริษัท
    // ทำให้กำไรสุทธิสูงเกินจริงทั้งระบบ) มักเกิดจากกรอกยอดหักผิด (เช่น พิมพ์เกินเลขศูนย์)
    if (calculateNet(body) < 0) return "ยอดสุทธิติดลบ (รายการหักรวมกันมากกว่าเงินเดือน+โบนัส+เบี้ยเลี้ยง) กรุณาตรวจสอบตัวเลขก่อนบันทึก";
    return null;
}

async function create(req, res, next) {
    try {
        const body = req.body ?? {};
        const error = validatePayroll(body);
        if (error) return res.status(400).json({ message: error });

        const pay_id = await generateId("tb_payrolls", "PAY");
        const netAmount = calculateNet(body);

        await pool.query(
            `INSERT INTO tb_payrolls
                (pay_id, pay_staff_id, pay_period_month, pay_period_year, pay_base_salary, pay_bonus,
                 pay_allowance, pay_social_security, pay_withholding_tax, pay_other_deduction, pay_net_amount,
                 pay_note, pay_created_by_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                pay_id, body.pay_staff_id, body.pay_period_month, body.pay_period_year, body.pay_base_salary,
                body.pay_bonus || 0, body.pay_allowance || 0, body.pay_social_security || 0,
                body.pay_withholding_tax || 0, body.pay_other_deduction || 0, netAmount,
                body.pay_note || null, req.user.user_id,
            ]
        );

        res.status(201).json({ pay_id });
    } catch (err) {
        if (err.code === "ER_DUP_ENTRY") {
            return res.status(409).json({ message: "พนักงานคนนี้มีรายการเงินเดือนของเดือนนี้อยู่แล้ว" });
        }
        if (err.code === "ER_NO_REFERENCED_ROW_2" || err.code === "ER_NO_REFERENCED_ROW") {
            return res.status(400).json({ message: "ไม่พบพนักงานที่เลือก" });
        }
        next(err);
    }
}

async function update(req, res, next) {
    try {
        const [existing] = await pool.query("SELECT pay_status FROM tb_payrolls WHERE pay_id = ?", [req.params.id]);
        if (!existing[0]) return res.status(404).json({ message: "ไม่พบรายการเงินเดือนนี้" });
        if (existing[0].pay_status === "paid") {
            return res.status(400).json({ message: "รายการนี้จ่ายไปแล้ว แก้ไขไม่ได้" });
        }

        const body = req.body ?? {};
        const error = validatePayroll(body);
        if (error) return res.status(400).json({ message: error });

        const netAmount = calculateNet(body);

        await pool.query(
            `UPDATE tb_payrolls SET
                pay_staff_id = ?, pay_period_month = ?, pay_period_year = ?, pay_base_salary = ?,
                pay_bonus = ?, pay_allowance = ?, pay_social_security = ?, pay_withholding_tax = ?,
                pay_other_deduction = ?, pay_net_amount = ?, pay_note = ?
             WHERE pay_id = ?`,
            [
                body.pay_staff_id, body.pay_period_month, body.pay_period_year, body.pay_base_salary,
                body.pay_bonus || 0, body.pay_allowance || 0, body.pay_social_security || 0,
                body.pay_withholding_tax || 0, body.pay_other_deduction || 0, netAmount,
                body.pay_note || null, req.params.id,
            ]
        );

        res.json({ message: "แก้ไขรายการเงินเดือนสำเร็จ" });
    } catch (err) {
        if (err.code === "ER_DUP_ENTRY") {
            return res.status(409).json({ message: "พนักงานคนนี้มีรายการเงินเดือนของเดือนนี้อยู่แล้ว" });
        }
        if (err.code === "ER_NO_REFERENCED_ROW_2" || err.code === "ER_NO_REFERENCED_ROW") {
            return res.status(400).json({ message: "ไม่พบพนักงานที่เลือก" });
        }
        next(err);
    }
}

async function remove(req, res, next) {
    try {
        const [existing] = await pool.query("SELECT pay_status FROM tb_payrolls WHERE pay_id = ?", [req.params.id]);
        if (!existing[0]) return res.status(404).json({ message: "ไม่พบรายการเงินเดือนนี้" });
        if (existing[0].pay_status === "paid") {
            return res.status(400).json({ message: "รายการนี้จ่ายไปแล้ว ลบไม่ได้" });
        }

        await pool.query("DELETE FROM tb_payrolls WHERE pay_id = ?", [req.params.id]);
        res.status(204).end();
    } catch (err) {
        next(err);
    }
}

// สร้างรายจ่ายอัตโนมัติ 1 แถวสำหรับ 1 รายการเงินเดือนที่เพิ่งจ่าย — จุดเดียวที่ทั้ง markPaid (จ่ายทีละคน)
// และ batchPay (จ่ายหลายคนพร้อมกัน) เรียกใช้ กันสูตร/ข้อความ note เพี้ยนไม่ตรงกันระหว่าง 2 ทาง (เหมือนหลักการ
// เดียวกับ computeNetProfit/calculateAllocation ที่แชร์กันระหว่างหลายจุดเรียกในระบบนี้)
// รับ exp_id ที่ generate มาแล้วจากภายนอก (ไม่ generate เองในนี้) เพื่อให้ batchPay ขอ id เป็นชุดเดียวล่วงหน้าได้
async function insertPayrollExpense(conn, { exp_id, pay_net_amount, staff_fullname, pay_period_month, pay_period_year, created_by_id }) {
    const today = new Date().toISOString().slice(0, 10);
    await conn.query(
        `INSERT INTO tb_expenses (exp_id, exp_category_id, exp_amount, exp_note, exp_date, exp_created_by_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
            exp_id, PAYROLL_EXPENSE_CATEGORY_ID, pay_net_amount,
            `เงินเดือน ${staff_fullname} เดือน ${pay_period_month}/${pay_period_year}`,
            today, created_by_id,
        ]
    );
}

// กด "จ่ายแล้ว" — ล็อกรายการ (แก้ไข/ลบไม่ได้อีก) และสร้างรายจ่ายอัตโนมัติ 1 แถวใน tb_expenses หมวด
// "เงินเดือนพนักงาน" ให้ยอดเงินเดือนไปโผล่ในรายงานกำไร/ขาดทุนด้วยโดยอัตโนมัติ ไม่ต้องพึ่งการบันทึกมือซ้ำ
//
// claim ด้วย UPDATE...WHERE pay_status != 'paid' ก่อนเสมอ (เหมือน settlePaidOrder ฝั่ง store) กันกด
// "จ่ายแล้ว" ซ้ำพร้อมกัน (ดับเบิลคลิก/เปิดสองแท็บ) สร้างรายจ่ายซ้ำสอง — เดิม SELECT เช็คสถานะแยกจาก
// INSERT/UPDATE ทีหลัง มีช่องว่างเวลาให้ทั้งสอง request เห็น pending พร้อมกันได้ พร้อมห่อ transaction
// เดียวกับ INSERT รายจ่าย กันกรณี INSERT ล้มเหลวแล้วเหลือ pay_status='paid' ที่ไม่มีรายจ่ายจริงผูกอยู่
//
// claim ก่อนต้อง "ยังไม่" ใส่ pay_expense_id (แยกเป็น UPDATE รอบสองหลัง INSERT tb_expenses สำเร็จ) เพราะ
// pay_expense_id มี FK อ้างอิง tb_expenses.exp_id — ถ้าใส่ค่าตั้งแต่รอบแรกก่อนแถวรายจ่ายมีอยู่จริง
// FK constraint จะ error ทันที (ลองแล้วเจอจริงตอนทดสอบ ER_NO_REFERENCED_ROW_2)
async function markPaid(req, res, next) {
    const conn = await pool.getConnection();
    try {
        const [rows] = await pool.query(
            `SELECT p.pay_id, p.pay_net_amount, p.pay_period_month, p.pay_period_year,
                    CONCAT(u.user_fname, ' ', u.user_lname) AS staff_fullname
             FROM tb_payrolls p JOIN tb_users u ON u.user_id = p.pay_staff_id
             WHERE p.pay_id = ?`,
            [req.params.id]
        );
        const payroll = rows[0];
        if (!payroll) return res.status(404).json({ message: "ไม่พบรายการเงินเดือนนี้" });

        const exp_id = await generateId("tb_expenses", "EXP");

        await conn.beginTransaction();
        const [claim] = await conn.query(
            "UPDATE tb_payrolls SET pay_status = 'paid', pay_paid_at = NOW() WHERE pay_id = ? AND pay_status != 'paid'",
            [req.params.id]
        );
        if (claim.affectedRows === 0) {
            await conn.rollback();
            return res.status(400).json({ message: "รายการนี้จ่ายไปแล้ว" });
        }

        await insertPayrollExpense(conn, {
            exp_id, pay_net_amount: payroll.pay_net_amount, staff_fullname: payroll.staff_fullname,
            pay_period_month: payroll.pay_period_month, pay_period_year: payroll.pay_period_year,
            created_by_id: req.user.user_id,
        });
        await conn.query("UPDATE tb_payrolls SET pay_expense_id = ? WHERE pay_id = ?", [exp_id, req.params.id]);
        await conn.commit();

        res.json({ message: "บันทึกการจ่ายเงินเดือนสำเร็จ" });
    } catch (err) {
        await conn.rollback();
        next(err);
    } finally {
        conn.release();
    }
}

// roster ของพนักงานที่ "จ่ายเงินเดือนผ่านระบบได้" (user_base_salary ไม่ NULL, user_status='active') สำหรับ
// งวดที่ระบุ พร้อม annotate ว่าใครมีรายการ tb_payrolls ของงวดนั้นแล้วหรือยัง (ไม่ว่าจะมาจากทางไหน/สถานะไหน)
// ใช้ร่วมกันทั้ง getRunStatus (โหลด checklist ตอนเปิดโมดัล) และ batchPay (สรุปผลท้ายสุดหลังจ่าย) กันตัวเลข
// "จ่ายแล้วกี่คน/ค้างเท่าไหร่" ของ 2 จุดเพี้ยนไม่ตรงกัน (เหมือนหลักการเดียวกับ computeRetainedEarnings)
async function buildRunStatus(month, year) {
    const [employees] = await pool.query(
        `SELECT u.user_id, CONCAT(u.user_fname, ' ', u.user_lname) AS fullname, u.user_base_salary,
                p.pay_id, p.pay_net_amount, p.pay_status, p.pay_paid_at
         FROM tb_users u
         LEFT JOIN tb_payrolls p
                ON p.pay_staff_id = u.user_id AND p.pay_period_year = ? AND p.pay_period_month = ?
         WHERE u.user_status = 'active' AND u.user_base_salary IS NOT NULL
         ORDER BY u.user_fname, u.user_lname`,
        [year, month]
    );

    const paid = employees.filter((e) => e.pay_status === "paid");
    // "ค้างจ่าย" = ยังไม่มีแถว หรือมีแถวแต่ยังไม่ paid (เช่น pending ที่สร้างไว้ผ่านฟอร์มสร้างเดี่ยว) — ยอดค้าง
    // ของคนที่ยังไม่มีแถวเลยใช้ user_base_salary เป็นตัวเลขประมาณการ (ยังไม่รู้ว่าจะหักเท่าไหร่จนกว่าจะสร้างจริง)
    // ของคนที่มีแถว pending อยู่แล้วใช้ pay_net_amount จริงที่คำนวณไว้แล้ว
    const owed = employees.filter((e) => e.pay_status !== "paid");

    return {
        employees: employees.map((e) => ({
            user_id: e.user_id, fullname: e.fullname, user_base_salary: Number(e.user_base_salary),
            payroll: e.pay_id
                ? { pay_id: e.pay_id, pay_net_amount: Number(e.pay_net_amount), pay_status: e.pay_status, pay_paid_at: e.pay_paid_at }
                : null,
        })),
        summary: {
            eligible_count: employees.length,
            paid_count: paid.length,
            paid_amount: paid.reduce((sum, e) => sum + Number(e.pay_net_amount), 0),
            owed_count: owed.length,
            owed_amount: owed.reduce((sum, e) => sum + Number(e.pay_id ? e.pay_net_amount : e.user_base_salary), 0),
        },
    };
}

async function getRunStatus(req, res, next) {
    try {
        const month = Number(req.query.month);
        const year = Number(req.query.year);
        if (!Number.isInteger(month) || month < 1 || month > 12) return res.status(400).json({ message: "เดือนไม่ถูกต้อง" });
        if (!Number.isInteger(year) || year < 2000 || year > 2100) return res.status(400).json({ message: "ปีไม่ถูกต้อง" });

        const result = await buildRunStatus(month, year);
        res.json({ period: { month, year }, ...result });
    } catch (err) {
        next(err);
    }
}

// จ่ายเงินเดือนหลายคนพร้อมกันในคลิกเดียว — สร้าง+จ่ายทันทีไม่มีสถานะ pending คั่นกลาง (ต่างจากฟอร์มสร้างเดี่ยว)
// แต่ละคนเป็น transaction อิสระของตัวเอง (ใช้ connection เดียวกันตลอดคำขอ แต่ begin/commit/rollback แยกทีละคน
// ไม่ห่อทั้ง batch เป็น transaction เดียว) เพราะยอดสุทธิของแต่ละคนไม่เกี่ยวข้องกันทางคณิตศาสตร์เลย (ต่างจาก
// createAllocation ที่ N แถวเป็นสัดส่วนของก้อนเงินปันผลก้อนเดียวกัน) — 1 คนล้มเหลว (เช่น ชนกับแถวที่มีอยู่แล้ว
// จาก uq_pay_staff_period) ต้อง "ไม่" ทำให้อีก N-1 คนที่ผ่านแล้วถูก rollback ไปด้วย เพราะ requirement ของ
// ฟีเจอร์นี้ต้องการสรุป "จ่ายแล้วกี่คน ค้างกี่คน" เป็นผลลัพธ์ปกติของการ submit ครั้งเดียว ไม่ใช่ error state —
// จับ error ทุกชนิดต่อคน (ไม่ใช่แค่ ER_DUP_ENTRY) แล้วบันทึกเป็น "skipped" พร้อมเหตุผล เพื่อให้ response ตรงกับ
// สถานะจริงใน DB เสมอ (paid ทุกคนที่ตอบกลับมาต้องจ่ายจริง ไม่มีคนไหนถูกนับผิดฝั่งเพราะ error กลางทาง)
//
// ยอดเงินเดือนพื้นฐาน "อ่านสดจาก DB เสมอ" (ไม่เชื่อค่าที่ client แนบมา แม้จะมาจาก run-status ที่เพิ่งโหลดก็ตาม)
// กันกรณีแก้เงินเดือนพื้นฐานในโปรไฟล์ระหว่างที่โมดัลเปิดค้างอยู่แล้วยิงยอดเก่าเข้ามา — client ส่งมาแค่ deduction
// amount/reason ต่อคนเท่านั้น
async function batchPay(req, res, next) {
    try {
        const { period_month, period_year, items } = req.body ?? {};
        const month = Number(period_month);
        const year = Number(period_year);
        if (!Number.isInteger(month) || month < 1 || month > 12) return res.status(400).json({ message: "เดือนไม่ถูกต้อง" });
        if (!Number.isInteger(year) || year < 2000 || year > 2100) return res.status(400).json({ message: "ปีไม่ถูกต้อง" });
        if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ message: "กรุณาเลือกพนักงานอย่างน้อย 1 คน" });

        const staffIds = [...new Set(items.map((i) => i?.pay_staff_id).filter(Boolean))];
        const [staffRows] = staffIds.length
            ? await pool.query(
                `SELECT user_id, CONCAT(user_fname,' ',user_lname) AS fullname, user_base_salary, user_status
                 FROM tb_users WHERE user_id IN (?)`,
                [staffIds]
            )
            : [[]];
        const staffById = Object.fromEntries(staffRows.map((s) => [s.user_id, s]));

        const skipped = [];
        const candidates = [];
        for (const item of items) {
            const staff = staffById[item?.pay_staff_id];
            const fullname = staff?.fullname ?? String(item?.pay_staff_id ?? "");
            if (!staff) {
                skipped.push({ pay_staff_id: item?.pay_staff_id ?? null, fullname, reason_code: "not_found", message: "ไม่พบพนักงานนี้" });
                continue;
            }
            if (staff.user_status !== "active" || staff.user_base_salary === null) {
                skipped.push({ pay_staff_id: staff.user_id, fullname, reason_code: "not_eligible", message: "ไม่ใช่พนักงานที่รับเงินเดือนผ่านระบบนี้ หรือถูกปิดใช้งานแล้ว" });
                continue;
            }
            const body = {
                pay_staff_id: staff.user_id, pay_period_month: month, pay_period_year: year,
                pay_base_salary: Number(staff.user_base_salary), pay_bonus: 0, pay_allowance: 0,
                pay_social_security: 0, pay_withholding_tax: 0,
                pay_other_deduction: Number(item?.deduction_amount) || 0,
            };
            const error = validatePayroll(body); // ใช้ฟังก์ชันเดิมเป๊ะ กันสูตร validate เพี้ยนสองจุด
            if (error) {
                skipped.push({ pay_staff_id: staff.user_id, fullname, reason_code: "invalid", message: error });
                continue;
            }
            candidates.push({
                staff, fullname, body,
                deduction_reason: String(item?.deduction_reason ?? "").trim().slice(0, 255) || null,
            });
        }

        const paid = [];
        if (candidates.length > 0) {
            const payIds = await generateIds("tb_payrolls", "PAY", candidates.length);
            const expIds = await generateIds("tb_expenses", "EXP", candidates.length);
            const conn = await pool.getConnection();
            try {
                for (let i = 0; i < candidates.length; i++) {
                    const { staff, fullname, body, deduction_reason } = candidates[i];
                    const pay_id = payIds[i];
                    const exp_id = expIds[i];
                    const netAmount = calculateNet(body);
                    try {
                        await conn.beginTransaction();
                        await conn.query(
                            `INSERT INTO tb_payrolls
                                (pay_id, pay_staff_id, pay_period_month, pay_period_year, pay_base_salary, pay_bonus,
                                 pay_allowance, pay_social_security, pay_withholding_tax, pay_other_deduction, pay_net_amount,
                                 pay_note, pay_source, pay_status, pay_paid_at, pay_created_by_id)
                             VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, ?, ?, ?, 'batch', 'paid', NOW(), ?)`,
                            [pay_id, staff.user_id, month, year, body.pay_base_salary, body.pay_other_deduction, netAmount, deduction_reason, req.user.user_id]
                        );
                        await insertPayrollExpense(conn, {
                            exp_id, pay_net_amount: netAmount, staff_fullname: fullname,
                            pay_period_month: month, pay_period_year: year, created_by_id: req.user.user_id,
                        });
                        await conn.query("UPDATE tb_payrolls SET pay_expense_id = ? WHERE pay_id = ?", [exp_id, pay_id]);
                        await conn.commit();
                        paid.push({ pay_id, pay_staff_id: staff.user_id, fullname, pay_net_amount: netAmount, exp_id });
                    } catch (err) {
                        await conn.rollback();
                        if (err.code === "ER_DUP_ENTRY") {
                            skipped.push({ pay_staff_id: staff.user_id, fullname, reason_code: "already_exists", message: "มีรายการเงินเดือนของงวดนี้อยู่แล้ว" });
                        } else {
                            skipped.push({ pay_staff_id: staff.user_id, fullname, reason_code: "error", message: "เกิดข้อผิดพลาดไม่คาดคิด กรุณาลองใหม่รายการนี้อีกครั้ง" });
                        }
                        // ไม่ throw ต่อ — คนอื่นในชุดต้องยังประมวลผลต่อได้ตามหลักการ partial-success ของฟีเจอร์นี้
                    }
                }
            } finally {
                conn.release();
            }
        }

        const { employees, summary } = await buildRunStatus(month, year); // อ่านสดจาก DB จริงหลัง batch จบทั้งหมด
        res.json({ period: { month, year }, paid, skipped, employees, summary });
    } catch (err) {
        next(err);
    }
}

module.exports = { getAll, getOne, create, update, remove, markPaid, getRunStatus, batchPay };
