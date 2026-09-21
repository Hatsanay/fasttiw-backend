// ถามผลสอบจริงหลังวันสอบ แล้วเก็บเป็นข้อมูลที่เอาไปใช้ได้ (2026-09-20)
// ดูเหตุผลเต็มที่ database/query/create_exam_outcomes.sql
//
// ของสำคัญ 3 อย่างที่ข้อมูลชุดนี้ตอบให้ได้ และไม่มีข้อมูลอื่นในระบบตอบได้เลย:
//   1. เนื้อหาของเราตรงสนามจริงไหม (ได้คะแนนดีในระบบ แต่สอบตก = ความยาก/แนวเราเพี้ยน)
//   2. อัตราผ่านจริงเท่าไหร่ → ถึงจะกล้าประกาศการันตี "ไม่ผ่าน = ต่ออายุฟรี" โดยรู้ต้นทุน
//   3. ตัวเลขกับเสียงลูกค้าจริงสำหรับหน้าเว็บ
const crypto = require("crypto");
const pool = require("../config/db");
const { generateId } = require("../utils/generateId");
const { sendMail } = require("../utils/mailer");
const { buildExamOutcomeEmail } = require("../utils/emailTemplates");

// ต้องมีผู้ตอบถึงเกณฑ์ก่อนถึงจะเอาตัวเลขขึ้นหน้าเว็บได้ (ตัดสินใจร่วมกับผู้ใช้ 2026-09-20)
// "ผ่าน 100% จาก 2 คน" ไม่ได้แปลว่าอะไรเลย และถ้าโดนจับได้จะเสียความน่าเชื่อถือมากกว่าที่ได้มา
const MIN_RESPONSES_FOR_PUBLIC = 10;

// เพดานอีเมลต่อคนต่อรอบ (นับรวมฉบับแรก) — ถามซ้ำได้ 2 ครั้งแล้วหยุด ไม่ว่าจะตอบหรือไม่
const MAX_EMAILS_PER_OUTCOME = 3;

const hashToken = (token) => crypto.createHash("sha256").update(token).digest("hex");

function storeUrl() {
    return (process.env.STORE_URL || "http://localhost:3001").replace(/\/$/, "");
}

// ชื่อย่อเป็นค่าเริ่มต้นของ "ชื่อที่จะแสดง" — คนส่วนใหญ่กดยินยอมโดยไม่ได้คิดเรื่องชื่อ
// ถ้าเอาชื่อเต็มไปขึ้นหน้าเว็บเลยจะเกินความคาดหมายของเจ้าตัว (PDPA คือความคาดหมายที่สมเหตุสมผล ไม่ใช่แค่ checkbox)
function defaultDisplayName(customer) {
    const first = (customer.cus_fname ?? "").trim();
    const last = (customer.cus_lname ?? "").trim();
    if (first) return last ? `${first} ${last.charAt(0)}.` : first;
    return customer.cus_username ?? "ลูกค้า";
}

/* ══════════════ ฝั่งแอดมิน: รอบสอบ ══════════════ */

async function listRounds(req, res, next) {
    try {
        const [rows] = await pool.query(
            `SELECT r.*,
                    COUNT(o.eo_id) AS invited,
                    SUM(o.eo_outcome IS NOT NULL) AS answered,
                    SUM(o.eo_outcome = 'passed') AS passed,
                    SUM(o.eo_outcome = 'failed') AS failed,
                    SUM(o.eo_outcome = 'pending_result') AS pending_result
             FROM tb_exam_rounds r
             LEFT JOIN tb_exam_outcomes o ON o.eo_round_id = r.er_id
             GROUP BY r.er_id
             ORDER BY r.er_exam_date DESC`
        );
        res.json({ data: rows.map(withRoundSummary) });
    } catch (err) {
        next(err);
    }
}

// สรุปตัวเลขให้เป็นชุดเดียวกันทุกที่ (หน้ารายการ/หน้ารายรอบ/หน้าเว็บสาธารณะ) — ถ้าคำนวณแยกกัน
// วันหนึ่งสองหน้าจะบอกคนละเลขแล้วไม่มีใครรู้ว่าอันไหนถูก
function withRoundSummary(row) {
    const answered = Number(row.answered) || 0;
    const passed = Number(row.passed) || 0;
    const failed = Number(row.failed) || 0;
    // ฐานของ "อัตราผ่าน" คือคนที่รู้ผลแล้วเท่านั้น — คนที่ตอบว่ายังไม่ประกาศผลยังไม่นับ
    const decided = passed + failed;
    return {
        ...row,
        invited: Number(row.invited) || 0,
        answered,
        passed,
        failed,
        pending_result: Number(row.pending_result) || 0,
        decided,
        pass_rate: decided > 0 ? Math.round((passed / decided) * 100) : null,
        // บอกตรงๆ ว่าพอเอาขึ้นหน้าเว็บได้หรือยัง แอดมินจะได้ไม่ต้องเดา
        publishable: decided >= MIN_RESPONSES_FOR_PUBLIC,
        min_responses_for_public: MIN_RESPONSES_FOR_PUBLIC,
    };
}

async function createRound(req, res, next) {
    try {
        const { er_name, er_exam_date, er_result_date } = req.body ?? {};
        if (!er_name || !er_exam_date) {
            return res.status(400).json({ message: "กรุณากรอกชื่อรอบสอบและวันสอบ" });
        }
        const er_id = await generateId("tb_exam_rounds", "ERD");
        await pool.query(
            "INSERT INTO tb_exam_rounds (er_id, er_name, er_exam_date, er_result_date) VALUES (?, ?, ?, ?)",
            [er_id, String(er_name).trim(), er_exam_date, er_result_date || null]
        );
        res.status(201).json({ er_id, message: "สร้างรอบสอบแล้ว" });
    } catch (err) {
        next(err);
    }
}

async function updateRound(req, res, next) {
    try {
        const { er_name, er_exam_date, er_result_date, er_status } = req.body ?? {};
        const fields = [];
        const params = [];
        if (er_name !== undefined) { fields.push("er_name = ?"); params.push(String(er_name).trim()); }
        if (er_exam_date !== undefined) { fields.push("er_exam_date = ?"); params.push(er_exam_date); }
        if (er_result_date !== undefined) { fields.push("er_result_date = ?"); params.push(er_result_date || null); }
        if (er_status !== undefined) {
            if (!["open", "closed"].includes(er_status)) return res.status(400).json({ message: "สถานะไม่ถูกต้อง" });
            fields.push("er_status = ?"); params.push(er_status);
        }
        if (!fields.length) return res.status(400).json({ message: "ไม่มีข้อมูลที่จะแก้ไข" });

        const [result] = await pool.query(`UPDATE tb_exam_rounds SET ${fields.join(", ")} WHERE er_id = ?`, [...params, req.params.id]);
        if (!result.affectedRows) return res.status(404).json({ message: "ไม่พบรอบสอบนี้" });
        res.json({ message: "บันทึกแล้ว" });
    } catch (err) {
        next(err);
    }
}

// ลบได้เฉพาะรอบที่ยังไม่มีใครตอบ — คำตอบของลูกค้าคือข้อมูลที่ขอมาแล้วขอใหม่ไม่ได้
// (หลักการเดียวกับสนามสอบเสมือนที่มีคนสอบแล้วลบไม่ได้) ปิดรอบแทนได้เสมอ
async function deleteRound(req, res, next) {
    try {
        const [[{ answered }]] = await pool.query(
            "SELECT COUNT(*) AS answered FROM tb_exam_outcomes WHERE eo_round_id = ? AND eo_outcome IS NOT NULL",
            [req.params.id]
        );
        if (answered > 0) {
            return res.status(400).json({ message: `รอบนี้มีคำตอบของลูกค้าแล้ว ${answered} รายการ ลบไม่ได้ — ใช้ "ปิดรอบ" แทน` });
        }
        const [result] = await pool.query("DELETE FROM tb_exam_rounds WHERE er_id = ?", [req.params.id]);
        if (!result.affectedRows) return res.status(404).json({ message: "ไม่พบรอบสอบนี้" });
        res.json({ message: "ลบรอบสอบแล้ว" });
    } catch (err) {
        next(err);
    }
}

async function getRound(req, res, next) {
    try {
        const [[round]] = await pool.query(
            `SELECT r.*,
                    COUNT(o.eo_id) AS invited,
                    SUM(o.eo_outcome IS NOT NULL) AS answered,
                    SUM(o.eo_outcome = 'passed') AS passed,
                    SUM(o.eo_outcome = 'failed') AS failed,
                    SUM(o.eo_outcome = 'pending_result') AS pending_result
             FROM tb_exam_rounds r
             LEFT JOIN tb_exam_outcomes o ON o.eo_round_id = r.er_id
             WHERE r.er_id = ?
             GROUP BY r.er_id`,
            [req.params.id]
        );
        if (!round) return res.status(404).json({ message: "ไม่พบรอบสอบนี้" });

        const [outcomes] = await pool.query(
            `SELECT o.eo_id, o.eo_outcome, o.eo_score, o.eo_comment, o.eo_publish_consent, o.eo_display_name,
                    o.eo_approved, o.eo_opted_out, o.eo_reminders_sent, o.eo_last_sent_at, o.eo_answered_at,
                    c.cus_id, c.cus_username, c.cus_email,
                    CASE WHEN c.cus_fname IS NOT NULL THEN CONCAT(c.cus_fname, ' ', c.cus_lname) ELSE NULL END AS cus_fullname
             FROM tb_exam_outcomes o
             JOIN tb_customers c ON c.cus_id = o.eo_customer_id
             WHERE o.eo_round_id = ?
             ORDER BY o.eo_answered_at IS NULL, o.eo_answered_at DESC, o.eo_created_at DESC`,
            [req.params.id]
        );
        res.json({ round: withRoundSummary(round), outcomes });
    } catch (err) {
        next(err);
    }
}

/* ══════════════ ส่งคำถาม ══════════════ */

// สร้างแถว + ส่งอีเมลให้ลูกค้ากลุ่มที่เลือก — ใช้ร่วมกันทั้งตอนแอดมินกดเองและตอน job ส่งอัตโนมัติ
// ส่งทีละคนและกลืน error ของแต่ละฉบับ: เมลเสียคนเดียวต้องไม่ทำให้อีก 200 คนไม่ได้รับ
async function inviteCustomers(roundId, customerIds) {
    const [[round]] = await pool.query("SELECT * FROM tb_exam_rounds WHERE er_id = ?", [roundId]);
    if (!round) throw Object.assign(new Error("ไม่พบรอบสอบนี้"), { status: 404 });
    if (round.er_status !== "open") throw Object.assign(new Error("รอบสอบนี้ปิดรับคำตอบแล้ว"), { status: 400 });

    let sent = 0, skipped = 0, failed = 0;
    for (const cusId of customerIds) {
        const [[customer]] = await pool.query(
            "SELECT cus_id, cus_username, cus_email, cus_fname, cus_lname FROM tb_customers WHERE cus_id = ?", [cusId]
        );
        // ไม่มีอีเมล = ส่งไม่ได้ ข้ามไปเงียบๆ (บัญชีที่แอดมินสร้างจากแชทเพจบางคนยังไม่มีอีเมล)
        if (!customer?.cus_email) { skipped++; continue; }

        const [[existing]] = await pool.query(
            "SELECT eo_id, eo_reminders_sent, eo_opted_out FROM tb_exam_outcomes WHERE eo_round_id = ? AND eo_customer_id = ?",
            [roundId, cusId]
        );
        if (existing && (existing.eo_opted_out || existing.eo_reminders_sent >= MAX_EMAILS_PER_OUTCOME)) { skipped++; continue; }

        // token ใหม่ทุกครั้งที่ส่ง — ลิงก์เก่าในเมลฉบับก่อนจะใช้ไม่ได้ ทำให้มีลิงก์ที่ใช้ได้ชุดเดียวเสมอ
        const token = crypto.randomBytes(32).toString("hex");
        let outcomeId = existing?.eo_id;
        if (existing) {
            await pool.query(
                "UPDATE tb_exam_outcomes SET eo_token_hash = ?, eo_reminders_sent = eo_reminders_sent + 1, eo_last_sent_at = NOW() WHERE eo_id = ?",
                [hashToken(token), existing.eo_id]
            );
        } else {
            outcomeId = await generateId("tb_exam_outcomes", "EOC");
            await pool.query(
                `INSERT INTO tb_exam_outcomes (eo_id, eo_round_id, eo_customer_id, eo_token_hash, eo_display_name, eo_reminders_sent, eo_last_sent_at)
                 VALUES (?, ?, ?, ?, ?, 1, NOW())`,
                [outcomeId, roundId, cusId, hashToken(token), defaultDisplayName(customer)]
            );
        }

        const { subject, html } = buildExamOutcomeEmail({
            customer,
            roundName: round.er_name,
            examDate: round.er_exam_date,
            answerUrl: `${storeUrl()}/exam-result?token=${token}`,
            isReminder: !!existing,
        });
        try {
            await sendMail({ to: customer.cus_email, subject, html });
            sent++;
        } catch (err) {
            // แถวถูกสร้างไว้แล้ว ส่งซ้ำรอบหน้าได้ — ไม่ rollback เพราะเมลอาจส่งออกไปแล้วจริงก็ได้
            console.error("[exam-outcome] ส่งอีเมลไม่สำเร็จ:", err.message);
            failed++;
        }
    }
    return { sent, skipped, failed };
}

// แอดมินเลือกกลุ่ม: ทุกคนที่ถือสิทธิ์ชุดใดชุดหนึ่ง (product_id) หรือทุกคนที่มีสิทธิ์ที่ยังใช้ได้อยู่
async function inviteRound(req, res, next) {
    try {
        const { product_id, customer_ids } = req.body ?? {};
        let ids = Array.isArray(customer_ids) ? customer_ids : null;

        if (!ids) {
            const [rows] = await pool.query(
                `SELECT DISTINCT ent_customer_id FROM tb_entitlements
                 WHERE ent_status = 'active' ${product_id ? "AND ent_product_id = ?" : ""}`,
                product_id ? [product_id] : []
            );
            ids = rows.map((r) => r.ent_customer_id);
        }
        if (!ids.length) return res.status(400).json({ message: "ไม่มีลูกค้าที่เข้าเงื่อนไขให้ส่ง" });

        const result = await inviteCustomers(req.params.id, ids);
        res.json({ ...result, message: `ส่งอีเมลแล้ว ${result.sent} ฉบับ (ข้าม ${result.skipped} · ส่งไม่สำเร็จ ${result.failed})` });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ message: err.message });
        next(err);
    }
}

// อนุมัติ/ยกเลิกอนุมัติข้อความที่จะเอาขึ้นหน้าเว็บ — อนุมัติได้เฉพาะรายที่ลูกค้ายินยอมไว้จริงเท่านั้น
async function approveOutcome(req, res, next) {
    try {
        const approved = req.body?.approved === true;
        const [[row]] = await pool.query("SELECT eo_publish_consent FROM tb_exam_outcomes WHERE eo_id = ?", [req.params.id]);
        if (!row) return res.status(404).json({ message: "ไม่พบรายการนี้" });
        if (approved && !row.eo_publish_consent) {
            return res.status(400).json({ message: "ลูกค้ารายนี้ไม่ได้ยินยอมให้เผยแพร่ข้อความ" });
        }
        await pool.query("UPDATE tb_exam_outcomes SET eo_approved = ? WHERE eo_id = ?", [approved ? 1 : 0, req.params.id]);
        res.json({ message: approved ? "อนุมัติให้แสดงบนหน้าเว็บแล้ว" : "ยกเลิกการแสดงแล้ว" });
    } catch (err) {
        next(err);
    }
}

/* ══════════════ ฝั่งลูกค้า (ไม่ต้องล็อกอิน ใช้ token จากอีเมล) ══════════════ */

async function findByToken(token) {
    if (!token || typeof token !== "string") return null;
    const [[row]] = await pool.query(
        `SELECT o.*, r.er_name, r.er_exam_date, r.er_status, c.cus_fname, c.cus_lname, c.cus_username
         FROM tb_exam_outcomes o
         JOIN tb_exam_rounds r ON r.er_id = o.eo_round_id
         JOIN tb_customers c ON c.cus_id = o.eo_customer_id
         WHERE o.eo_token_hash = ?`,
        [hashToken(token)]
    );
    return row ?? null;
}

async function getMyOutcome(req, res, next) {
    try {
        const row = await findByToken(req.query.token);
        // ตอบข้อความเดียวกันทั้งกรณี token ผิดและ token หมดอายุ ไม่บอกว่าอันไหน
        if (!row) return res.status(404).json({ message: "ลิงก์นี้ใช้ไม่ได้แล้ว กรุณาตรวจอีเมลฉบับล่าสุด" });
        res.json({
            round_name: row.er_name,
            exam_date: row.er_exam_date,
            closed: row.er_status !== "open",
            name: [row.cus_fname, row.cus_lname].filter(Boolean).join(" ") || row.cus_username,
            // ตอบไปแล้วก็ยังเข้ามาแก้ได้ (ตอนแรกยังไม่ประกาศผล พอผลออกค่อยกลับมาอัปเดต)
            answered: row.eo_outcome
                ? {
                    outcome: row.eo_outcome,
                    score: row.eo_score,
                    comment: row.eo_comment,
                    publish_consent: !!row.eo_publish_consent,
                    display_name: row.eo_display_name,
                }
                : null,
            default_display_name: row.eo_display_name ?? defaultDisplayName(row),
        });
    } catch (err) {
        next(err);
    }
}

const VALID_OUTCOMES = ["passed", "failed", "pending_result", "absent"];

async function submitMyOutcome(req, res, next) {
    try {
        const { token, outcome, score, comment, publish_consent, display_name } = req.body ?? {};
        const row = await findByToken(token);
        if (!row) return res.status(404).json({ message: "ลิงก์นี้ใช้ไม่ได้แล้ว กรุณาตรวจอีเมลฉบับล่าสุด" });
        if (row.er_status !== "open") return res.status(400).json({ message: "รอบสอบนี้ปิดรับคำตอบแล้ว ขอบคุณครับ" });
        if (!VALID_OUTCOMES.includes(outcome)) return res.status(400).json({ message: "กรุณาเลือกผลสอบ" });

        const consent = publish_consent === true;
        await pool.query(
            `UPDATE tb_exam_outcomes
             SET eo_outcome = ?, eo_score = ?, eo_comment = ?, eo_publish_consent = ?, eo_display_name = ?,
                 eo_answered_at = NOW(),
                 -- ถอนความยินยอมแล้วต้องหลุดจากหน้าเว็บทันที ไม่ต้องรอแอดมินมากด (PDPA)
                 eo_approved = IF(?, eo_approved, 0)
             WHERE eo_id = ?`,
            [
                outcome,
                score ? String(score).slice(0, 50) : null,
                comment ? String(comment).slice(0, 2000) : null,
                consent ? 1 : 0,
                display_name ? String(display_name).slice(0, 60) : row.eo_display_name,
                consent ? 1 : 0,
                row.eo_id,
            ]
        );
        res.json({ message: "บันทึกคำตอบแล้ว ขอบคุณมากครับ" });
    } catch (err) {
        next(err);
    }
}

async function optOut(req, res, next) {
    try {
        const row = await findByToken(req.body?.token);
        if (!row) return res.status(404).json({ message: "ลิงก์นี้ใช้ไม่ได้แล้ว" });
        await pool.query("UPDATE tb_exam_outcomes SET eo_opted_out = 1 WHERE eo_id = ?", [row.eo_id]);
        res.json({ message: "รับทราบแล้ว เราจะไม่ส่งอีเมลเรื่องนี้ถึงคุณอีก" });
    } catch (err) {
        next(err);
    }
}

/* ══════════════ ตัวเลขสาธารณะสำหรับหน้าเว็บ (เฟส 2 จะเอาไปแสดง) ══════════════ */

// **ซ่อนทั้งก้อนถ้าผู้ตอบยังไม่ถึงเกณฑ์** และคืน responses มาด้วยเสมอ เพื่อให้หน้าเว็บเขียนกำกับฐานได้
// (คนที่ไม่ผ่านมักไม่ตอบ — ถ้าไม่บอกว่า "จากผู้ตอบ N คน" จะกลายเป็นโฆษณาเกินจริง)
async function getPublicStats(req, res, next) {
    try {
        const [[stats]] = await pool.query(
            `SELECT COUNT(*) AS decided, SUM(o.eo_outcome = 'passed') AS passed
             FROM tb_exam_outcomes o
             JOIN tb_exam_rounds r ON r.er_id = o.eo_round_id
             WHERE o.eo_outcome IN ('passed','failed')`
        );
        const decided = Number(stats.decided) || 0;
        if (decided < MIN_RESPONSES_FOR_PUBLIC) {
            return res.json({ available: false, min_responses: MIN_RESPONSES_FOR_PUBLIC, testimonials: [] });
        }
        const passed = Number(stats.passed) || 0;

        const [testimonials] = await pool.query(
            `SELECT o.eo_display_name AS name, o.eo_comment AS comment, o.eo_outcome AS outcome, r.er_name AS round_name
             FROM tb_exam_outcomes o
             JOIN tb_exam_rounds r ON r.er_id = o.eo_round_id
             WHERE o.eo_approved = 1 AND o.eo_publish_consent = 1 AND o.eo_comment IS NOT NULL AND o.eo_comment <> ''
             ORDER BY o.eo_answered_at DESC
             LIMIT 12`
        );
        res.json({
            available: true,
            responses: decided,
            passed,
            pass_rate: Math.round((passed / decided) * 100),
            testimonials,
        });
    } catch (err) {
        next(err);
    }
}

module.exports = {
    listRounds, createRound, updateRound, deleteRound, getRound, inviteRound, approveOutcome,
    getMyOutcome, submitMyOutcome, optOut, getPublicStats,
    inviteCustomers, MIN_RESPONSES_FOR_PUBLIC, MAX_EMAILS_PER_OUTCOME,
};
