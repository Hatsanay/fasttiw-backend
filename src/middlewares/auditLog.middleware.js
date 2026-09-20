// บันทึกทุกคำขอที่เปลี่ยนข้อมูลของฝั่งแอดมิน (audit log, 2026-09-20)
//
// ทำเป็น middleware ตัวเดียวแทนการไล่ใส่ทีละ controller โดยตั้งใจ:
//   - ครอบคลุม 100% ตั้งแต่วันแรก ไม่มีจุดตกหล่นเพราะลืมใส่ และ endpoint ใหม่ถูกบันทึกเองอัตโนมัติ
//   - ถ้าไล่ใส่ทีละจุด (60+ endpoint) วันหนึ่งจะมีคนเพิ่ม endpoint ใหม่โดยไม่ได้ใส่ แล้วไม่มีใครรู้จนสายเกินไป
// ข้อแลกเปลี่ยน: ได้ "ใครยิงอะไรไปที่ไหน ผลเป็นอย่างไร" ไม่ใช่ diff ก่อน/หลังของทุกฟิลด์ — controller ที่
// อยากให้อ่านง่ายกว่านั้นใส่ req.audit.summary เองได้ (ดู setAudit)
//
// **ไม่บันทึก**: GET (ไม่เปลี่ยนข้อมูล ปริมาณมหาศาล), endpoint ของลูกค้า (/store/*), และ /auth/* ที่มี
// รหัสผ่าน/OTP อยู่ในตัว body — พวกนั้นมี tb_login_logs บันทึกแยกอยู่แล้ว
const pool = require("../config/db");
const { generateId } = require("../utils/generateId");
const { clientKey } = require("./rateLimit.middleware");

// ฟิลด์ที่ห้ามเก็บลง log เด็ดขาด — log ถูกเปิดดูโดยแอดมินหลายคนและถูก backup ออกไปนอกเครื่อง
const SECRET_KEYS = /password|token|otp|secret|authorization|cookie|new_password|temp_password/i;
const MAX_PAYLOAD_CHARS = 4000; // กัน log บวมจากคำขอที่แนบข้อมูลก้อนใหญ่ (เช่น นำเข้าคำถามทีละร้อยข้อ)
const SKIP_PREFIXES = ["/V1/auth/", "/V1/store/"];

function redact(value, depth = 0) {
    if (value === null || value === undefined) return value;
    if (depth > 4) return "[ลึกเกินไป]";
    if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
    if (typeof value === "object") {
        const out = {};
        for (const [key, v] of Object.entries(value)) {
            out[key] = SECRET_KEYS.test(key) ? "[ปิดบัง]" : redact(v, depth + 1);
        }
        return out;
    }
    if (typeof value === "string" && value.length > 500) return `${value.slice(0, 500)}…`;
    return value;
}

// เดา "กลุ่มข้อมูล" จาก path เช่น /api/V1/products/PRD.../status → products
// ใช้แค่กรองในหน้าแอดมินให้ง่ายขึ้น ไม่ได้เอาไปตัดสินใจอะไร ผิดบ้างไม่เสียหาย
// ต้องข้าม prefix "api" และเลขเวอร์ชัน ("V1") ก่อนเสมอ — path ที่ middleware เห็นคือ originalUrl เต็ม
function guessEntity(path) {
    const parts = path.split("/").filter(Boolean); // ["api","V1","products","PRD..."]
    const start = parts.findIndex((p) => !/^api$/i.test(p) && !/^v\d+$/i.test(p));
    return start === -1 ? null : parts[start];
}
const looksLikeId = (s) => /^[A-Z]{3}\d{10,}$/.test(s ?? "");
function guessEntityId(req) {
    const fromParams = req.params?.id ?? req.params?.productId ?? req.params?.questionId;
    if (fromParams) return String(fromParams).slice(0, 18);
    const last = req.path.split("/").filter(Boolean).pop();
    return looksLikeId(last) ? last : null;
}

/** ให้ controller ใส่คำอธิบายที่คนอ่านรู้เรื่องเพิ่มได้ เช่น setAudit(req, "ยกเลิกสิทธิ์ + คืนเงินผ่าน Stripe") */
function setAudit(req, summary, extra = {}) {
    req.audit = { ...(req.audit ?? {}), summary, ...extra };
}

function auditLog(req, res, next) {
    const isMutation = !["GET", "HEAD", "OPTIONS"].includes(req.method);
    const skipped = SKIP_PREFIXES.some((p) => req.originalUrl.startsWith(`/api${p}`));
    if (!isMutation || skipped) return next();

    // เก็บ body ไว้ตั้งแต่ตอนนี้ — controller บางตัวแก้ req.body ระหว่างทาง
    const payloadSource = { ...(req.body ?? {}) };
    if (req.file) payloadSource.__file = { name: req.file.originalname, size: req.file.size };

    res.on("finish", async () => {
        try {
            let payload = JSON.stringify(redact(payloadSource));
            if (payload.length > MAX_PAYLOAD_CHARS) payload = JSON.stringify({ __truncated: true, size: payload.length });

            const audit = req.audit ?? {};
            await pool.query(
                `INSERT INTO tb_audit_logs
                    (aud_id, aud_user_id, aud_user_email, aud_user_name, aud_method, aud_path,
                     aud_entity, aud_entity_id, aud_summary, aud_payload, aud_status, aud_ip, aud_user_agent)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    await generateId("tb_audit_logs", "AUD"),
                    req.user?.user_id ?? null,
                    req.auditUser?.email ?? null,
                    req.auditUser?.name ?? null,
                    req.method,
                    req.originalUrl.split("?")[0].slice(0, 255),
                    audit.entity ?? guessEntity(req.originalUrl.split("?")[0]),
                    audit.entityId ?? guessEntityId(req),
                    audit.summary ?? null,
                    payload,
                    res.statusCode,
                    // กติกาเดียวกับ rate limit/error log — เชื่อ x-client-ip ก็ต่อเมื่อ secret ตรงเท่านั้น
                    clientKey(req)?.slice(0, 45) ?? null,
                    (req.headers["user-agent"] ?? "").slice(0, 255) || null,
                ]
            );
        } catch (err) {
            // ห้ามทำให้คำขอของผู้ใช้พังเพราะบันทึก log ไม่สำเร็จ — งานหลักจบไปแล้วตอน finish
            console.error("audit log failed:", err.message);
        }
    });

    next();
}

module.exports = { auditLog, setAudit, redact };
