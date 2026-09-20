// ตัวตรวจว่า "IP จริงของคนใช้งาน" เดินทางมาถึง backend หรือไม่ (2026-09-20)
//
// ทำไมต้องมี: คำขอทุกอันวิ่งผ่านเซิร์ฟเวอร์ Next ก่อนเสมอ backend จึงเห็น IP ของ Next (บ่อยครั้งเป็น
// 127.0.0.1 เพราะอยู่เครื่องเดียวกัน) — ต้องมี nginx ใส่ x-forwarded-for ให้ Next แล้ว Next ส่งต่อมาทาง
// x-client-ip + x-internal-secret อีกทอด ถ้าขาดขั้นไหนขั้นหนึ่ง IP ใน log จะเหมือนกันหมดทุกแถว
// เวลาแก้ปัญหาบน production การเดาว่าขาดขั้นไหนเสียเวลากว่าการเปิดดูตรงๆ มาก
//
// **ไม่คืนค่า secret ออกไปเด็ดขาด** — บอกแค่ว่า "ตั้งไว้ไหม" และ "ตรงไหม" เป็น true/false
const { clientKey } = require("../middlewares/rateLimit.middleware");

function getClientIpDiagnostics(req, res) {
    const secret = process.env.INTERNAL_PROXY_SECRET;
    const forwarded = req.headers["x-client-ip"];

    res.json({
        // IP ที่ backend เห็นเองจาก TCP (ปกติคือเซิร์ฟเวอร์ Next)
        backend_remote_addr: req.ip,
        // header ที่ Next ควรแนบมาให้
        has_x_client_ip: !!forwarded,
        x_client_ip: forwarded ?? null,
        internal_secret_configured_on_backend: !!secret,
        internal_secret_matched: !!secret && req.headers["x-internal-secret"] === secret,
        // ค่าที่ระบบจะเอาไปบันทึกลง log จริง
        resolved_ip: clientKey(req),
    });
}

module.exports = { getClientIpDiagnostics };
