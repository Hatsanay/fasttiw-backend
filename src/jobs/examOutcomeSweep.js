// ส่งคำถาม "ผลสอบเป็นยังไง" อัตโนมัติ (2026-09-20) — ดูเหตุผลของระบบที่ examOutcome.controller.js
//
// ทำงาน 2 อย่าง:
//   1. ลูกค้าที่ตั้งวันสอบไว้เอง (cus_exam_date) แล้ววันสอบผ่านไปแล้ว → จับเข้ารอบสอบที่วันตรงกันแล้วส่งให้
//   2. คนที่ยังไม่ตอบ หรือตอบว่า "ยังไม่ประกาศผล" → ถามซ้ำเมื่อถึงวันประกาศผล (หรือครบ 21 วัน) สูงสุด 3 ฉบับ
//
// **ทั้งสองอย่างส่งผ่าน inviteCustomers() ตัวเดียวกับที่แอดมินกดส่งเอง** — เพดานอีเมล/การข้ามคนที่กดไม่รับ
// จึงบังคับใช้ที่เดียว ไม่มีทางที่ช่องทางอัตโนมัติจะหลุดกติกาไปคนละแบบกับช่องทางที่แอดมินกด
const pool = require("../config/db");
const { inviteCustomers } = require("../controllers/examOutcome.controller");

const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000; // ทุก 6 ชั่วโมง — งานนี้ไม่ต้องไว ขอแค่ไม่ลืม
const DAYS_AFTER_EXAM = 1;   // ถามครั้งแรกหลังวันสอบ (ตอนนี้ยังไม่รู้ผล แต่ได้ความรู้สึกสดๆ + ได้คนที่ผลออกเร็ว)
const REMIND_AFTER_DAYS = 21; // ถามซ้ำถ้ายังไม่มีวันประกาศผลระบุไว้

async function sweepExamOutcomes() {
    try {
        // ── 1. ลูกค้าที่ตั้งวันสอบเอง ──
        // จับเข้ารอบที่ er_exam_date ตรงกับวันสอบที่ลูกค้าตั้งไว้เป๊ะ — ถ้าไม่มีรอบที่ตรงก็ไม่ส่ง
        // (เดาเองว่า "น่าจะรอบนี้" แล้วส่งผิดรอบ ทำให้ตัวเลขของรอบนั้นเพี้ยนโดยไม่มีใครรู้)
        const [autoTargets] = await pool.query(
            `SELECT r.er_id, c.cus_id
             FROM tb_customers c
             JOIN tb_exam_rounds r ON r.er_exam_date = c.cus_exam_date AND r.er_status = 'open'
             LEFT JOIN tb_exam_outcomes o ON o.eo_round_id = r.er_id AND o.eo_customer_id = c.cus_id
             WHERE c.cus_exam_date IS NOT NULL
               AND c.cus_exam_date <= DATE_SUB(CURDATE(), INTERVAL ? DAY)
               AND c.cus_email IS NOT NULL AND c.cus_email <> ''
               AND o.eo_id IS NULL`,
            [DAYS_AFTER_EXAM]
        );
        const byRound = new Map();
        for (const row of autoTargets) {
            if (!byRound.has(row.er_id)) byRound.set(row.er_id, []);
            byRound.get(row.er_id).push(row.cus_id);
        }

        // ── 2. คนที่ควรถามซ้ำ ──
        const [remindTargets] = await pool.query(
            `SELECT o.eo_round_id, o.eo_customer_id
             FROM tb_exam_outcomes o
             JOIN tb_exam_rounds r ON r.er_id = o.eo_round_id
             WHERE r.er_status = 'open'
               AND o.eo_opted_out = 0
               AND o.eo_reminders_sent < 3
               AND (o.eo_outcome IS NULL OR o.eo_outcome = 'pending_result')
               AND (
                     (r.er_result_date IS NOT NULL AND r.er_result_date <= CURDATE()
                      AND (o.eo_last_sent_at IS NULL OR o.eo_last_sent_at < r.er_result_date))
                  OR (o.eo_last_sent_at IS NOT NULL AND o.eo_last_sent_at <= DATE_SUB(NOW(), INTERVAL ? DAY))
               )`,
            [REMIND_AFTER_DAYS]
        );
        for (const row of remindTargets) {
            if (!byRound.has(row.eo_round_id)) byRound.set(row.eo_round_id, []);
            byRound.get(row.eo_round_id).push(row.eo_customer_id);
        }

        let total = 0;
        for (const [roundId, customerIds] of byRound) {
            const result = await inviteCustomers(roundId, [...new Set(customerIds)]);
            total += result.sent;
        }
        if (total > 0) console.log(`[exam-outcome-sweep] ส่งอีเมลถามผลสอบ ${total} ฉบับ`);
    } catch (err) {
        // งานเบื้องหลังล้มต้องไม่ทำให้ backend ตาย — log ไว้แล้วรอรอบถัดไป
        console.error("[exam-outcome-sweep] เกิดข้อผิดพลาด:", err.message);
    }
}

function startExamOutcomeSweep() {
    // หน่วงตอน startup 1 นาที: ไม่ให้ไปแย่งทรัพยากรกับตอนแอปเพิ่งขึ้น และกันส่งซ้ำถ้ามีการ restart รัวๆ
    setTimeout(sweepExamOutcomes, 60 * 1000);
    setInterval(sweepExamOutcomes, SWEEP_INTERVAL_MS);
}

module.exports = { startExamOutcomeSweep, sweepExamOutcomes };
