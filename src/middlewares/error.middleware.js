const crypto = require("crypto");
const pool = require("../config/db");
const { generateId } = require("../utils/generateId");
const { clientKey } = require("./rateLimit.middleware");

function notFound(req, res) {
    res.status(404).json({ message: "ไม่พบ endpoint นี้" });
}

// เก็บ error ที่หลุดมาถึงตรงนี้ลงฐานข้อมูลด้วย (2026-09-20) — เดิมมีแต่ console.error ซึ่งบน production
// หายเข้าไปใน log ของ Passenger ที่ไม่มีใครเปิดดู พอลูกค้าแจ้งปัญหาย้อนหลังจึงสืบไม่ได้เลย
//
// **เขียนลง DB ต้องไม่ทำให้ error handler พังเอง** — ถ้า DB เองคือสิ่งที่ล่ม การ insert จะล้มด้วย
// จึงหุ้ม try/catch แล้วตอบผู้ใช้ไปตามปกติเสมอ (fire-and-forget ไม่ await)
//
// เก็บเฉพาะ 5xx — 4xx คือการใช้งานผิดปกติทั่วไป (กรอกข้อมูลไม่ครบ/ไม่มีสิทธิ์) ซึ่งมีใน audit log แล้ว
// ถ้าเก็บด้วยตารางนี้จะเต็มไปด้วยเรื่องที่ไม่ใช่ความผิดปกติของระบบ จนของจริงจมหาย
function recordError(err, req, status) {
    if (status < 500) return;
    const message = String(err?.message ?? err ?? "unknown error").slice(0, 500);
    const stack = err?.stack ? String(err.stack).slice(0, 5000) : null;
    // จัดกลุ่ม error เดิมซ้ำๆ ด้วยข้อความ + บรรทัดแรกของ stack (ไม่รวมค่าที่เปลี่ยนทุกครั้ง เช่น id)
    const fingerprint = crypto.createHash("sha256")
        .update(`${message}|${(stack ?? "").split("\n")[1] ?? ""}`)
        .digest("hex").slice(0, 64);

    (async () => {
        try {
            await pool.query(
                `INSERT INTO tb_error_logs
                    (err_id, err_user_id, err_method, err_path, err_status, err_message, err_stack, err_fingerprint, err_ip)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    await generateId("tb_error_logs", "ERR"),
                    req.user?.user_id ?? null,
                    req.method,
                    req.originalUrl?.split("?")[0]?.slice(0, 255) ?? null,
                    // IP จริงของผู้ใช้ ไม่ใช่ IP ของเซิร์ฟเวอร์ Next — คำขอฝั่งลูกค้าวิ่งผ่าน Next ก่อนเสมอ
                    // ถ้าอ่าน req.ip ตรงๆ error ทุกก้อนจากฝั่งลูกค้าจะมี IP เดียวกันหมดจนไล่ไม่ได้ว่าใครเจอ
                    status, message, stack, fingerprint, clientKey(req)?.slice(0, 45) ?? null,
                ]
            );
        } catch (writeErr) {
            console.error("error log write failed:", writeErr.message);
        }
    })();
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
    console.error(err);
    const status = err.status ?? 500;
    recordError(err, req, status);
    res.status(status).json({ message: err.message ?? "เกิดข้อผิดพลาดที่เซิร์ฟเวอร์" });
}

module.exports = { notFound, errorHandler };
