// ยิงอีเมลทดสอบ 1 ฉบับด้วยค่า SMTP ที่ตั้งไว้ใน .env — ใช้ตรวจว่าตั้งค่าถูกต้องแล้วหรือยัง
// โดยไม่ต้องรอให้มีลูกค้าจ่ายเงินจริงหรือกดลืมรหัสผ่านจริง
//
// รันด้วย:  npm run mail:test -- you@example.com
//           (ไม่ใส่อีเมลปลายทาง จะส่งกลับไปที่ SMTP_USER ของตัวเอง)
//
// ส่งด้วยเทมเพลตใบเสร็จตัวจริง (ข้อมูลสมมติ) ไม่ใช่ข้อความเปล่าๆ — จะได้เห็นด้วยว่าเลย์เอาต์/ฟอนต์ไทย/
// โลโก้ แสดงผลถูกต้องในกล่องจดหมายจริงของผู้ให้บริการที่เลือกใช้
require("dotenv").config();
const { sendMail, isConfigured, closeMailer } = require("../src/utils/mailer");
const { buildReceiptEmail } = require("../src/utils/emailTemplates");

const to = process.argv[2] || process.env.SMTP_USER;

async function main() {
    if (!isConfigured()) {
        console.error("✖ ยังไม่ได้ตั้งค่า SMTP ใน .env — ต้องมีครบทั้ง SMTP_HOST, SMTP_USER, SMTP_PASS");
        console.error("  ดูตัวอย่างค่าที่ต้องใส่ได้ที่ backend/.env.example");
        process.exitCode = 1;
        return;
    }
    if (!to) {
        console.error("✖ ไม่รู้ว่าจะส่งไปที่ไหน — ใส่อีเมลปลายทางต่อท้ายคำสั่ง หรือกำหนด SMTP_USER ใน .env");
        process.exitCode = 1;
        return;
    }

    console.log(`กำลังส่งอีเมลทดสอบ...`);
    console.log(`  เซิร์ฟเวอร์ : ${process.env.SMTP_HOST}:${process.env.SMTP_PORT || 587}`);
    console.log(`  ผู้ส่ง      : ${process.env.MAIL_FROM || process.env.SMTP_USER}`);
    console.log(`  ผู้รับ      : ${to}`);

    const { subject, html } = buildReceiptEmail({
        order: {
            ord_id: "ORDTEST-ทดสอบระบบ",
            ord_subtotal: 598,
            ord_discount: 100,
            ord_total: 498,
            ord_paid_at: new Date(),
            ord_omise_charge_id: "pi_test",
        },
        items: [
            { prod_name: "ตัวอย่างชุดข้อสอบ A (อีเมลทดสอบ)", oi_total: 299 },
            { prod_name: "ตัวอย่างชุดข้อสอบ B (อีเมลทดสอบ)", oi_total: 299 },
        ],
        customer: { cus_fname: "ทดสอบ", cus_lname: "ระบบอีเมล" },
        entitlements: [{ prod_name: "ตัวอย่างชุดข้อสอบ A (อีเมลทดสอบ)", ent_expires_at: null }],
    });

    const result = await sendMail({ to, subject: `[ทดสอบระบบ] ${subject}`, html });

    if (result.sent) {
        console.log("\n✓ ส่งสำเร็จ — ไปเช็คกล่องจดหมาย (ถ้าไม่เจอ ลองดูในโฟลเดอร์จดหมายขยะด้วย)");
    } else if (result.failed) {
        console.error(`\n✖ ส่งไม่สำเร็จ: ${result.error}`);
        console.error("  ดูตารางแก้ปัญหาตามรหัส error ได้ในคู่มือตั้งค่าอีเมล");
        process.exitCode = 1;
    }
}

main()
    .catch((err) => {
        console.error("✖ เกิดข้อผิดพลาด:", err.message);
        process.exitCode = 1;
    })
    .finally(closeMailer);
