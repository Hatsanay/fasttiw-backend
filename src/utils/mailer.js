// ตัวส่งอีเมลของระบบ — ใช้ SMTP ผ่าน nodemailer (ไม่ผูกกับผู้ให้บริการเจ้าไหนเป็นพิเศษ ใช้ได้ทั้ง Gmail
// app password, Brevo, Amazon SES, Resend ฯลฯ แค่เปลี่ยนค่าใน .env) เหตุผลที่เลือก SMTP แทน SDK ของเจ้าใดเจ้าหนึ่ง:
// ย้ายผู้ให้บริการทีหลังไม่ต้องแก้โค้ดเลย ซึ่งสำคัญเพราะยังไม่ได้เลือกเจ้าถาวร
//
// **degrade อย่างปลอดภัยเหมือน stripeClient.js** — ถ้ายังไม่ได้ตั้งค่า SMTP ระบบต้องไม่พัง: sendMail() จะ
// log แล้ว return { skipped: true } เฉยๆ ไม่ throw เพราะจุดที่เรียกใช้ (settle ออเดอร์, ขอรีเซ็ตรหัสผ่าน)
// เป็นงานที่ "ห้ามล้มเพราะอีเมลส่งไม่ออก" — ลูกค้าจ่ายเงินแล้วต้องได้สิทธิ์เสมอ ต่อให้เมลใบเสร็จส่งไม่ได้ก็ตาม
const nodemailer = require("nodemailer");

let transporter = null;

function isConfigured() {
    return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

// สร้าง transporter ครั้งเดียวแล้วใช้ซ้ำ (pool: true) — เปิด/ปิด TCP ใหม่ทุกฉบับช้าและเปลืองโควตา
// ผู้ให้บริการบางเจ้า ส่วน secure จะ true เฉพาะพอร์ต 465 (SMTPS) พอร์ต 587 ใช้ STARTTLS ซึ่ง nodemailer
// จัดการให้เองเมื่อ secure = false
function getTransporter() {
    if (!isConfigured()) return null;
    if (transporter) return transporter;

    const port = Number(process.env.SMTP_PORT) || 587;
    transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port,
        secure: process.env.SMTP_SECURE === "true" || port === 465,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
        pool: true,
    });
    return transporter;
}

// ส่งอีเมล 1 ฉบับ — ไม่ throw ออกไปให้ผู้เรียกไม่ว่ากรณีใด (ดูเหตุผลหัวไฟล์) ผู้เรียกเช็คค่าที่คืนมาได้
// ถ้าอยากรู้ผล: { sent: true } / { skipped: true } / { failed: true, error }
async function sendMail({ to, subject, html, text }) {
    const tx = getTransporter();
    if (!tx) {
        console.warn(`[mailer] ยังไม่ได้ตั้งค่า SMTP — ข้ามการส่งอีเมล "${subject}" ถึง ${to}`);
        return { skipped: true };
    }
    try {
        await tx.sendMail({
            from: process.env.MAIL_FROM || process.env.SMTP_USER,
            replyTo: process.env.MAIL_REPLY_TO || undefined,
            to,
            subject,
            html,
            text: text || stripHtml(html),
        });
        return { sent: true };
    } catch (err) {
        console.error(`[mailer] ส่งอีเมล "${subject}" ถึง ${to} ไม่สำเร็จ:`, err.message);
        return { failed: true, error: err.message };
    }
}

// ข้อความสำรองสำหรับ client ที่ไม่เปิด HTML — ถอด tag แบบหยาบๆ พอ ไม่ต้องใช้ library เพิ่ม
function stripHtml(html) {
    const text = String(html || "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/td>/gi, "  ") // ช่องในแถวเดียวกันคั่นด้วยช่องว่าง ไม่ใช่ขึ้นบรรทัดใหม่ (ไม่งั้นราคาจะหลุดไปคนละบรรทัดกับชื่อรายการ)
        .replace(/<\/(p|tr|h[1-6]|div)>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"');

    // ตัดช่องว่างหัวท้ายรายบรรทัด แล้วยุบบรรทัดว่างที่ซ้อนกันให้เหลือบรรทัดเดียว — HTML ของอีเมลเป็น
    // table ซ้อนกันหลายชั้น ถ้าไม่ยุบจะได้ข้อความที่มีบรรทัดว่างคั่นแทบทุกบรรทัดจนอ่านไม่รู้เรื่อง
    const lines = text.split("\n").map((line) => line.replace(/[ \t]+/g, " ").trim());
    return lines.filter((line, i) => line || (i > 0 && lines[i - 1])).join("\n").trim();
}

// escape ค่าที่มาจากผู้ใช้/ฐานข้อมูลก่อนยัดลง HTML ของอีเมล (ชื่อชุดข้อสอบ ชื่อลูกค้า) — กันทั้ง markup พัง
// และกันเนื้อหาแปลกปลอมโผล่ในกล่องจดหมายของลูกค้า
function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// ปิด connection pool ของ SMTP — จำเป็นสำหรับสคริปต์/เทสต์ที่ต้องการให้ process จบเอง เพราะ pool:true
// เปิด socket ค้างไว้ใช้ซ้ำ ทำให้ event loop ไม่ว่างและ node ไม่ยอมออกจากโปรแกรม (ตัวเซิร์ฟเวอร์จริงรันยาว
// อยู่แล้วไม่ต้องเรียก)
function closeMailer() {
    if (transporter) {
        transporter.close();
        transporter = null;
    }
}

module.exports = { isConfigured, sendMail, closeMailer, escapeHtml, stripHtml };
