// client บางๆ เรียก Omise (Opn Payments) API เอง ไม่ใช้ SDK omise-node เพราะใช้แค่ 2 endpoint
// (สร้าง charge / ดึงสถานะ charge) ไม่คุ้มเพิ่ม dependency — รายละเอียด API อ้างอิงจาก docs.omise.co
// ตรวจสอบสดในช่วงที่เขียนโค้ดนี้ (ไม่ใช่เดาจากความจำ):
//   - POST /charges ใช้ Basic Auth (username = secret key, password ว่าง)
//   - amount เป็นหน่วยสตางค์ (บาท x 100), currency ต้องเป็น "THB"
//   - PromptPay สร้าง+ยิง charge ในคำขอเดียวได้เลยด้วย source[type]=promptpay
//   - รูป QR อยู่ที่ charge.source.scannable_code.image.download_uri
//   - charge.status: pending/successful/failed/expired/reversed, charge.paid เป็น boolean แยกต่างหาก
const OMISE_API_BASE = process.env.OMISE_API_BASE || "https://api.omise.co";

function isConfigured() {
    return !!process.env.OMISE_SECRET_KEY;
}

function authHeader() {
    return "Basic " + Buffer.from(`${process.env.OMISE_SECRET_KEY}:`).toString("base64");
}

// amountSatang: จำนวนเงินหน่วยสตางค์ (คำนวณจากบาท x 100 ที่ชั้นเรียกใช้ ไม่ทำใน client นี้ กันปัดเศษซ้ำซ้อน)
async function createPromptPayCharge({ amountSatang, orderId }) {
    if (!isConfigured()) {
        const err = new Error("ยังไม่ได้ตั้งค่า OMISE_SECRET_KEY");
        err.code = "OMISE_NOT_CONFIGURED";
        throw err;
    }

    const body = new URLSearchParams({
        amount: String(amountSatang),
        currency: "THB",
        "source[type]": "promptpay",
        "metadata[order_id]": orderId, // ผูกข้อมูลอ้างอิงไว้เผื่อ debug — จุดจับคู่ order จริงคือ ord_omise_charge_id ใน DB
    });

    const res = await fetch(`${OMISE_API_BASE}/charges`, {
        method: "POST",
        headers: { Authorization: authHeader(), "Content-Type": "application/x-www-form-urlencoded" },
        body,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        const err = new Error(`Omise createCharge failed (${res.status}): ${data.message ?? "unknown error"}`);
        err.status = res.status;
        throw err;
    }
    return data;
}

// ใช้ re-verify สถานะ charge ตรงกับ Omise เสมอ (defense-in-depth) ทั้งตอนรับ webhook และตอน
// self-heal reconciliation — ไม่เชื่อแค่ payload ที่ส่งมาใน webhook request อย่างเดียว
async function getCharge(chargeId) {
    if (!isConfigured()) return null;
    const res = await fetch(`${OMISE_API_BASE}/charges/${chargeId}`, {
        headers: { Authorization: authHeader() },
    });
    if (!res.ok) return null;
    return res.json();
}

module.exports = { isConfigured, createPromptPayCharge, getCharge };
