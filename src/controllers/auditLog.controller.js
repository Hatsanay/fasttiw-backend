// อ่าน audit log (2026-09-20) — **อ่านอย่างเดียว ไม่มี endpoint แก้/ลบ โดยตั้งใจ**
// ร่องรอยที่ลบได้จากในระบบเองไม่ใช่ร่องรอย: คนที่ทำอะไรไม่ถูกต้องจะลบทิ้งเป็นอย่างแรก
// (ถ้าวันหนึ่งข้อมูลเยอะเกินไป ให้ตัดรอบเก่าด้วยสคริปต์ฝั่ง DB ที่ต้องเข้าเซิร์ฟเวอร์ ไม่ใช่ปุ่มในหน้าเว็บ)
const pool = require("../config/db");
const { listSessions, revokeSessionByJti } = require("../utils/userSession");

async function getAuditLogs(req, res, next) {
    try {
        const limit = Math.min(Number(req.query.limit) || 20, 100);
        const offset = Number(req.query.offset) || 0;

        const conditions = [];
        const params = [];
        if (req.query.user_id) { conditions.push("aud_user_id = ?"); params.push(req.query.user_id); }
        if (req.query.entity) { conditions.push("aud_entity = ?"); params.push(req.query.entity); }
        if (req.query.method) { conditions.push("aud_method = ?"); params.push(req.query.method); }
        // ดูเฉพาะที่ล้มเหลว — เวลาสอบสวนมักเริ่มจาก "มีใครพยายามทำอะไรที่ถูกปฏิเสธบ้าง"
        if (req.query.failed === "1") conditions.push("aud_status >= 400");
        if (req.query.date_from) { conditions.push("aud_created_at >= ?"); params.push(`${req.query.date_from} 00:00:00`); }
        if (req.query.date_to) { conditions.push("aud_created_at <= ?"); params.push(`${req.query.date_to} 23:59:59`); }
        if (req.query.search) {
            conditions.push("(aud_path LIKE ? OR aud_summary LIKE ? OR aud_user_email LIKE ? OR aud_entity_id LIKE ?)");
            const like = `%${req.query.search}%`;
            params.push(like, like, like, like);
        }
        const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

        const [rows] = await pool.query(
            `SELECT aud_id, aud_user_id, aud_user_email, aud_user_name, aud_method, aud_path,
                    aud_entity, aud_entity_id, aud_summary, aud_payload, aud_status, aud_ip, aud_created_at
             FROM tb_audit_logs ${whereClause}
             ORDER BY aud_created_at DESC, aud_id DESC
             LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );
        const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM tb_audit_logs ${whereClause}`, params);

        // รายชื่อกลุ่มข้อมูล/ผู้ใช้ที่มีจริงใน log — ให้หน้าเว็บทำตัวกรองได้โดยไม่ต้องเดาเอง
        const [entities] = await pool.query(
            "SELECT aud_entity, COUNT(*) AS n FROM tb_audit_logs WHERE aud_entity IS NOT NULL GROUP BY aud_entity ORDER BY n DESC"
        );
        res.json({ data: rows, total, entities: entities.map((e) => e.aud_entity) });
    } catch (err) {
        next(err);
    }
}

// ── อุปกรณ์ที่ล็อกอินอยู่ (ของตัวเอง) ─────────────────────────────────────────────
// เดิมมีแต่ข้อมูลใน tb_user_sessions แต่ไม่มีหน้าจอให้ดู — เจ้าตัวจึงไม่มีทางรู้ว่ามีเครื่องแปลกปลอม
// ค้างอยู่ไหม ทั้งที่นี่คือสัญญาณแรกสุดที่บอกว่าบัญชีถูกยึด
async function getMySessions(req, res, next) {
    try {
        const rows = await listSessions(req.user.user_id);
        res.json({
            data: rows.map((r) => ({
                usess_id: r.usess_id,
                device_info: r.usess_device_info,
                ip: r.usess_ip,
                created_at: r.usess_created_at,
                last_seen_at: r.usess_last_seen_at,
                // บอกว่าอันไหนคือเครื่องที่กำลังใช้อยู่ — กันเผลอเตะตัวเองออก
                is_current: r.usess_jti === req.user.jti,
            })),
        });
    } catch (err) {
        next(err);
    }
}

async function revokeMySession(req, res, next) {
    try {
        const rows = await listSessions(req.user.user_id);
        const target = rows.find((r) => r.usess_id === req.params.id);
        // เช็คว่าเป็นของตัวเองจริง — ไม่งั้นเดา id แล้วเตะ session ของคนอื่นได้
        if (!target) return res.status(404).json({ message: "ไม่พบอุปกรณ์นี้" });
        if (target.usess_jti === req.user.jti) {
            return res.status(400).json({ message: "นี่คือเครื่องที่กำลังใช้อยู่ ใช้ปุ่มออกจากระบบแทน" });
        }
        await revokeSessionByJti(target.usess_jti);
        res.json({ message: "ตัดการเชื่อมต่อของอุปกรณ์นั้นแล้ว" });
    } catch (err) {
        next(err);
    }
}

// รายการ error ล่าสุดของ backend — จัดกลุ่มตาม fingerprint ให้เห็นว่า "อันไหนเกิดซ้ำบ่อย" ก่อน
// เพราะเวลามีปัญหาจริง error ตัวเดียวกันมักเกิดเป็นร้อยแถว ถ้าไล่อ่านทีละแถวจะไม่เห็นภาพ
async function getErrorLogs(req, res, next) {
    try {
        const limit = Math.min(Number(req.query.limit) || 20, 100);
        const offset = Number(req.query.offset) || 0;
        const days = Math.min(Number(req.query.days) || 7, 90);

        const [rows] = await pool.query(
            `SELECT MIN(err_id) AS err_id, err_fingerprint, COUNT(*) AS occurrences,
                    MAX(err_created_at) AS last_seen, MIN(err_created_at) AS first_seen,
                    SUBSTRING_INDEX(GROUP_CONCAT(err_message ORDER BY err_created_at DESC SEPARATOR '||'), '||', 1) AS message,
                    SUBSTRING_INDEX(GROUP_CONCAT(COALESCE(err_path,'') ORDER BY err_created_at DESC SEPARATOR '||'), '||', 1) AS path,
                    SUBSTRING_INDEX(GROUP_CONCAT(COALESCE(err_stack,'') ORDER BY err_created_at DESC SEPARATOR '||'), '||', 1) AS stack
             FROM tb_error_logs
             WHERE err_created_at > DATE_SUB(NOW(), INTERVAL ? DAY)
             GROUP BY err_fingerprint
             ORDER BY last_seen DESC
             LIMIT ? OFFSET ?`,
            [days, limit, offset]
        );
        const [[{ total }]] = await pool.query(
            `SELECT COUNT(DISTINCT err_fingerprint) AS total FROM tb_error_logs
             WHERE err_created_at > DATE_SUB(NOW(), INTERVAL ? DAY)`,
            [days]
        );
        res.json({ data: rows.map((r) => ({ ...r, occurrences: Number(r.occurrences) })), total });
    } catch (err) {
        next(err);
    }
}

// ── ประวัติการเข้าสู่ระบบของลูกค้า (รวมทุกคน) ──────────────────────────────────────
// คู่กับหน้ารายลูกค้าที่ /customers (modal) — หน้านี้ตอบคำถามคนละข้อ: "ช่วงนี้มีอะไรผิดปกติบ้าง"
// เช่น มีใครโดนไล่เดารหัสผ่านอยู่ไหม ไม่ใช่ "ลูกค้าคนนี้ใช้จากที่ไหนบ้าง"
//
// ใช้สิทธิ์ auditLogs เดียวกับ audit log/error log — เป็นร่องรอยการใช้งานระบบเหมือนกัน
// และไม่ต้องเพิ่ม bit ใหม่ (ตำแหน่ง bit ผูกกับลำดับเมนูแบบหนึ่งต่อหนึ่ง เพิ่มทีต้องแก้ทั้งสองฝั่ง)
async function getCustomerLoginLogs(req, res, next) {
    try {
        const limit = Math.min(Number(req.query.limit) || 20, 100);
        const offset = Number(req.query.offset) || 0;

        const conditions = [];
        const params = [];
        if (req.query.action) { conditions.push("clog_action = ?"); params.push(req.query.action); }
        if (req.query.customer_id) { conditions.push("clog_customer_id = ?"); params.push(req.query.customer_id); }
        if (req.query.date_from) { conditions.push("clog_created_at >= ?"); params.push(`${req.query.date_from} 00:00:00`); }
        if (req.query.date_to) { conditions.push("clog_created_at <= ?"); params.push(`${req.query.date_to} 23:59:59`); }
        if (req.query.search) {
            // ค้นได้ทั้งจากตัวลูกค้าและจาก IP — ตอนสืบเรื่องน่าสงสัยมักเริ่มจาก IP ที่เห็นในแถวหนึ่ง
            conditions.push("(clog_identifier LIKE ? OR clog_ip LIKE ? OR c.cus_username LIKE ? OR c.cus_email LIKE ? OR CONCAT(c.cus_fname, ' ', c.cus_lname) LIKE ?)");
            const like = `%${req.query.search}%`;
            params.push(like, like, like, like, like);
        }
        const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

        const [rows] = await pool.query(
            `SELECT clog_id, clog_customer_id, clog_identifier, clog_action, clog_ip, clog_user_agent, clog_created_at,
                    c.cus_username, c.cus_email,
                    CASE WHEN c.cus_fname IS NOT NULL THEN CONCAT(c.cus_fname, ' ', c.cus_lname) ELSE NULL END AS cus_fullname
             FROM tb_customer_login_logs
             LEFT JOIN tb_customers c ON c.cus_id = clog_customer_id
             ${whereClause}
             ORDER BY clog_created_at DESC, clog_id DESC
             LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );
        const [[{ total }]] = await pool.query(
            `SELECT COUNT(*) AS total FROM tb_customer_login_logs
             LEFT JOIN tb_customers c ON c.cus_id = clog_customer_id ${whereClause}`,
            params
        );

        // สรุปช่วง 24 ชม. ล่าสุดไว้บนหัวตาราง — ตัวเลขที่บอกว่า "ตอนนี้มีอะไรผิดปกติไหม" โดยไม่ต้องไล่อ่านทีละแถว
        const [[summary]] = await pool.query(
            `SELECT
                COUNT(*) AS events_24h,
                SUM(clog_action IN ('login','login_google')) AS logins_24h,
                SUM(clog_action = 'login_failed') AS failed_24h,
                COUNT(DISTINCT CASE WHEN clog_action = 'login_failed' THEN clog_ip END) AS failed_ips_24h
             FROM tb_customer_login_logs
             WHERE clog_created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)`
        );

        res.json({
            data: rows,
            total,
            summary: {
                events_24h: Number(summary.events_24h) || 0,
                logins_24h: Number(summary.logins_24h) || 0,
                failed_24h: Number(summary.failed_24h) || 0,
                failed_ips_24h: Number(summary.failed_ips_24h) || 0,
            },
        });
    } catch (err) {
        next(err);
    }
}

module.exports = { getAuditLogs, getErrorLogs, getMySessions, revokeMySession, getCustomerLoginLogs };
