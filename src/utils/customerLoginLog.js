// ประวัติการเข้าสู่ระบบของลูกค้า (2026-09-20) — ดู database/query/create_customer_login_logs.sql
//
// ใช้ร่วมกันทุกทางที่ลูกค้าเข้าสู่ระบบได้ (รหัสผ่าน / Google / สมัครใหม่) เขียนไว้ที่เดียวเพื่อให้ทุกทาง
// บันทึกเหมือนกันเสมอ — ถ้าไล่เขียนทีละที่ วันหนึ่งจะมีทางเข้าใหม่ที่ไม่ได้บันทึกแล้วไม่มีใครรู้
const pool = require("../config/db");
const { generateId } = require("./generateId");
const { clientKey } = require("../middlewares/rateLimit.middleware");

// **ห้ามทำให้การล็อกอินของลูกค้าช้าหรือพังเพราะบันทึก log ไม่สำเร็จ** — ลูกค้าจ่ายเงินมาเพื่อเข้ามาทำข้อสอบ
// ไม่ใช่เพื่อให้ระบบบันทึกสถิติ · จึงไม่ await และกลืน error ทิ้ง (หลักการเดียวกับแจ้งเตือน Telegram ข้อ 6.6)
function recordCustomerLogin(req, { customerId = null, identifier = null, action }) {
    (async () => {
        try {
            await pool.query(
                `INSERT INTO tb_customer_login_logs
                    (clog_id, clog_customer_id, clog_identifier, clog_action, clog_ip, clog_user_agent)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [
                    await generateId("tb_customer_login_logs", "CLG"),
                    customerId,
                    identifier ? String(identifier).slice(0, 255) : null,
                    action,
                    // IP จริงของลูกค้า ไม่ใช่ IP ของเซิร์ฟเวอร์ Next — กติกาเดียวกับ rate limit/ตัวนับผู้เยี่ยมชม
                    // (เชื่อ header x-client-ip ก็ต่อเมื่อ INTERNAL_PROXY_SECRET ตรงเท่านั้น)
                    clientKey(req)?.slice(0, 45) ?? null,
                    (req.headers?.["user-agent"] ?? "").slice(0, 255) || null,
                ]
            );
        } catch (err) {
            console.error("customer login log failed:", err.message);
        }
    })();
}

// ดึงประวัติของลูกค้าหนึ่งคน — ใช้ร่วมกันทั้งหน้าแอดมินและหน้าของลูกค้าเอง (ข้อมูลชุดเดียวกัน
// ต่างกันแค่จำนวนที่เอาไปแสดง) ถ้าเขียนแยกกัน วันหนึ่งสองหน้าจะแสดงคนละเรื่องโดยไม่มีใครตั้งใจ
async function listCustomerLoginLogs(customerId, { days = 30, limit = 100 } = {}) {
    const [rows] = await pool.query(
        `SELECT clog_id, clog_action, clog_identifier, clog_ip, clog_user_agent, clog_created_at
         FROM tb_customer_login_logs
         WHERE clog_customer_id = ? AND clog_created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
         ORDER BY clog_created_at DESC
         LIMIT ?`,
        [customerId, days, limit]
    );
    return rows;
}

// ตัดท้าย IP ออกหนึ่งชั้น (IPv4 = 3 ชุดแรก / IPv6 = 4 กลุ่มแรก) — มือถือเปลี่ยน IP เองตลอดเวลาแม้เป็น
// คนเดิมเครื่องเดิม ถ้านับ IP ดิบๆ ลูกค้าปกติคนหนึ่งจะดูเหมือนแชร์บัญชีทันที นับเป็น "ย่าน" จึงใกล้เคียง
// ความจริงมากกว่า (ยังไม่ใช่คำตอบตายตัว — เป็นแค่สัญญาณให้แอดมินไปดูต่อ)
function ipBlock(ip) {
    if (!ip) return null;
    if (ip.includes(":")) return ip.split(":").slice(0, 4).join(":");
    const parts = ip.split(".");
    return parts.length === 4 ? parts.slice(0, 3).join(".") : ip;
}

// จับกลุ่มอุปกรณ์แบบหยาบๆ จาก user-agent — เวอร์ชันเบราว์เซอร์ขยับเองทุกสองสามสัปดาห์
// ถ้านับ user-agent เต็มๆ เครื่องเดิมจะกลายเป็นหลายเครื่องเมื่อ Chrome อัปเดต
function deviceKey(ua) {
    if (!ua) return "unknown";
    const browser = /Edg\//.test(ua) ? "edge" : /Chrome\//.test(ua) ? "chrome" : /Firefox\//.test(ua) ? "firefox"
        : /Safari\//.test(ua) ? "safari" : "other";
    const os = /Windows/.test(ua) ? "windows" : /Android/.test(ua) ? "android" : /iPhone|iPad/.test(ua) ? "ios"
        : /Mac OS/.test(ua) ? "macos" : /Linux/.test(ua) ? "linux" : "other";
    return `${browser}:${os}`;
}

const LOGIN_ACTIONS = ["login", "login_google"];

// สัญญาณการแชร์บัญชี — CLAUDE.md ข้อ 7 ระบุว่าการแชร์บัญชีคือความเสี่ยงอันดับ 1 ของธุรกิจนี้ แต่เดิม
// แอดมินดูได้แค่ "ตอนนี้ล็อกอินอยู่กี่เครื่อง" ซึ่งไม่มีทางเกิน 2 เพราะโควตาจำกัดไว้เอง ต่อให้หมุนเวียนกันใช้ 10 คน
// ตัวเลขที่บอกอะไรได้จริงคือ "ย่าน IP กับอุปกรณ์ที่ต่างกันในช่วงเวลาหนึ่ง"
function summarizeSharing(rows, now = Date.now()) {
    const within = (days) => rows.filter(
        (r) => LOGIN_ACTIONS.includes(r.clog_action) && now - new Date(r.clog_created_at).getTime() <= days * 86400000
    );
    const count = (list, fn) => new Set(list.map(fn).filter(Boolean)).size;

    const d7 = within(7);
    const d30 = within(30);
    const summary = {
        logins_7d: d7.length,
        logins_30d: d30.length,
        ip_blocks_7d: count(d7, (r) => ipBlock(r.clog_ip)),
        ip_blocks_30d: count(d30, (r) => ipBlock(r.clog_ip)),
        devices_7d: count(d7, (r) => deviceKey(r.clog_user_agent)),
        devices_30d: count(d30, (r) => deviceKey(r.clog_user_agent)),
        failed_7d: rows.filter((r) => r.clog_action === "login_failed" && now - new Date(r.clog_created_at).getTime() <= 7 * 86400000).length,
    };
    // ต้องเข้าเงื่อนไขทั้งสองอย่างพร้อมกันถึงจะเตือน — ย่าน IP เยอะอย่างเดียวคือคนเดินทาง/ใช้มือถือ
    // และอุปกรณ์เยอะอย่างเดียวคือคนที่มีคอมกับมือถือ ทั้งคู่เป็นเรื่องปกติของลูกค้าจริง
    summary.sharing_suspected = summary.ip_blocks_7d >= 4 && summary.devices_30d >= 3;
    return summary;
}

module.exports = { recordCustomerLogin, listCustomerLoginLogs, summarizeSharing, ipBlock, deviceKey };
