// client เรียก Stripe ผ่าน SDK ทางการ (ต่างจาก omiseClient.js เดิมที่เขียน fetch() เองเพราะ Omise มีแค่
// 2 endpoint) — ใช้ SDK ตัวนี้เพราะ Stripe เองแนะนำให้ verify webhook signature ผ่าน stripe.webhooks.constructEvent()
// เท่านั้น (มี tolerance กัน replay attack ในตัว ซึ่งเขียนเองแล้วเสี่ยงพลาดจุดเล็กๆ ได้ง่ายกว่า)
//
// รายละเอียด API อ้างอิงจาก docs.stripe.com ตรวจสอบสดตอนเขียนโค้ดนี้ (ไม่ใช่เดาจากความจำ):
//   - PromptPay: amount เป็นหน่วยสตางค์ (บาท x 100) — THB เป็น currency แบบ 2 ทศนิยมปกติเหมือน USD ไม่ใช่
//     zero-decimal แบบ JPY (ยืนยันจาก docs.stripe.com/currencies ที่มี "10 THB" อยู่ในลิสต์ minimum charge
//     แบบ 2 ทศนิยม ไม่ได้อยู่ในลิสต์ zero-decimal ที่ทำเป็นลิงก์แยก)
//   - สร้าง+ยืนยัน PaymentIntent พร้อมกันได้ในคำขอเดียวด้วย confirm=true (เหมือน Omise สร้าง+ยิง charge ทีเดียว)
//   - รูป QR อยู่ที่ paymentIntent.next_action.promptpay_display_qr_code.image_url_png (ยืนยันจาก
//     stripe-java PaymentIntent.NextAction.PromptpayDisplayQrCode: getImageUrlPng/getImageUrlSvg/
//     getHostedInstructionsUrl/getData — ไม่มี field วันหมดอายุเลยสักตัว ต่างจาก Omise ที่มี charge.expires_at
//     ให้ตรงๆ — PromptPay ใน Stripe ไม่มี payment_method_options[promptpay][expires_after_seconds] แบบที่ Pix มี
//     ด้วย จึงต้องกำหนด TTL เอง (ดู PROMPTPAY_QR_TTL_MS ใน store.controller.js) แล้วให้ jobs/orderExpirySweep.js
//     เป็นคนยกเลิก PaymentIntent ที่ค้างเกินเวลาแทน
//   - return_url ไม่จำเป็นสำหรับ PromptPay (เอกสารระบุชัดว่า "This parameter is only used for cards and other
//     redirect-based payment methods" — PromptPay แสดง QR ไม่ redirect จึงไม่ต้องส่ง)
//   - webhook event ที่ต้องฟังคือ payment_intent.succeeded, field เทียบยอดเงินคือ .amount/.currency (lowercase)
const Stripe = require("stripe");

function getClient() {
    if (!process.env.STRIPE_SECRET_KEY) return null;
    return new Stripe(process.env.STRIPE_SECRET_KEY);
}

function isConfigured() {
    return !!process.env.STRIPE_SECRET_KEY;
}

// amountSatang: จำนวนเงินหน่วยสตางค์ (คำนวณจากบาท x 100 ที่ชั้นเรียกใช้ ไม่ทำใน client นี้ กันปัดเศษซ้ำซ้อน)
// email: บังคับต้องมี — ทดสอบจริงแล้วเจอ Stripe error "Missing required param: billing_details[email]"
// ถ้าไม่ส่ง (Stripe ใช้อีเมลนี้ติดต่อลูกค้าเวลาต้องคืนเงิน PromptPay)
async function createPromptPayIntent({ amountSatang, orderId, email }) {
    const stripe = getClient();
    if (!stripe) {
        const err = new Error("ยังไม่ได้ตั้งค่า STRIPE_SECRET_KEY");
        err.code = "STRIPE_NOT_CONFIGURED";
        throw err;
    }
    return stripe.paymentIntents.create({
        amount: amountSatang,
        currency: "thb",
        // ต้องระบุ payment_method_types ตรงๆ (ไม่ปล่อยให้ Stripe ใช้ automatic payment methods ของบัญชี) —
        // ทดสอบจริงแล้วพบว่าถ้าไม่ระบุ Stripe จะ error ขอ return_url เพราะเข้าใจว่าอาจมี payment method อื่น
        // ที่เปิดไว้ในบัญชี (Dashboard) ที่ต้อง redirect ปนอยู่ด้วย ทั้งที่เราตั้งใจใช้แค่ promptpay อย่างเดียว
        payment_method_types: ["promptpay"],
        payment_method_data: { type: "promptpay", billing_details: { email } },
        confirm: true,
        metadata: { order_id: orderId }, // ผูกข้อมูลอ้างอิงไว้เผื่อ debug — จุดจับคู่ order จริงคือ ord_omise_charge_id ใน DB
    });
}

// ใช้ re-verify สถานะ payment intent ตรงกับ Stripe เสมอ (defense-in-depth) ทั้งตอนรับ webhook, ตอน
// self-heal reconciliation, และตอน sweep ยกเลิกออเดอร์ที่ QR หมดอายุ — ไม่เชื่อแค่ payload/เวลาที่คำนวณเองอย่างเดียว
async function getPaymentIntent(paymentIntentId) {
    const stripe = getClient();
    if (!stripe) return null;
    try {
        return await stripe.paymentIntents.retrieve(paymentIntentId);
    } catch {
        return null;
    }
}

// ใช้ตอน sweep ยกเลิกออเดอร์ที่ QR หมดอายุตาม TTL ที่เรากำหนดเอง (ดู PROMPTPAY_QR_TTL_MS) — cancel ได้เฉพาะ
// PaymentIntent ที่ยังไม่ succeeded เท่านั้น (Stripe จะ error ถ้า cancel อันที่จ่ายไปแล้ว) ผู้เรียกต้องเช็ค
// สถานะจริงก่อนเรียกฟังก์ชันนี้เสมอ (ดู jobs/orderExpirySweep.js) กันเคส race ที่ลูกค้าเพิ่งจ่ายสำเร็จไปพอดี
async function cancelPaymentIntent(paymentIntentId) {
    const stripe = getClient();
    if (!stripe) return null;
    try {
        return await stripe.paymentIntents.cancel(paymentIntentId);
    } catch (err) {
        console.error("Stripe cancelPaymentIntent failed:", err.message);
        return null;
    }
}

// คืนเงินบางส่วน/ทั้งหมดของ PaymentIntent — ใช้ตอนแอดมินกดคืนเงินให้ลูกค้าที่ซื้อผ่านเว็บ
//
// amountSatang: ระบุได้เพื่อคืนเฉพาะบางรายการในบิล (Stripe รองรับ partial refund) ไม่ส่ง = คืนเต็มจำนวน
//
// **ค่าธรรมเนียมที่ Stripe หักไปตอนรับเงิน จะไม่ถูกคืนกลับมาพร้อมกัน** (นโยบายของ Stripe เอง) ฉะนั้นการคืนเงิน
// ทุกครั้งธุรกิจจะขาดทุนเท่าค่าธรรมเนียมก้อนนั้นเสมอ ชั้นเรียกใช้ต้องบันทึกส่วนนี้ให้ตรงเอง ไม่ใช่ทำเหมือน
// ไม่เคยเกิดอะไรขึ้น
//
// ไม่ swallow error เหมือน cancelPaymentIntent เพราะการคืนเงินเป็นการเคลื่อนไหวเงินจริง ถ้าล้มต้องรู้ทันที
// และต้องไม่บันทึกรายการกลับในระบบเรา (ไม่งั้นตัวเลขจะบอกว่าคืนแล้วทั้งที่เงินยังไม่ออก)
async function refundPaymentIntent(paymentIntentId, { amountSatang, reason } = {}) {
    const stripe = getClient();
    if (!stripe) {
        const err = new Error("ยังไม่ได้ตั้งค่า STRIPE_SECRET_KEY");
        err.code = "STRIPE_NOT_CONFIGURED";
        throw err;
    }
    return stripe.refunds.create({
        payment_intent: paymentIntentId,
        ...(amountSatang ? { amount: amountSatang } : {}),
        ...(reason ? { reason } : {}),
    });
}

// verify + parse webhook payload ในฟังก์ชันเดียว (stripe.webhooks.constructEvent throw เองถ้า signature ผิด
// ผู้เรียกต้อง try/catch) — ใช้ SDK แทนเขียน HMAC เองเพราะมี timestamp tolerance กัน replay attack ในตัว
function constructWebhookEvent(rawBody, signatureHeader) {
    const stripe = getClient();
    if (!stripe) {
        const err = new Error("ยังไม่ได้ตั้งค่า STRIPE_SECRET_KEY");
        err.code = "STRIPE_NOT_CONFIGURED";
        throw err;
    }
    return stripe.webhooks.constructEvent(rawBody, signatureHeader, process.env.STRIPE_WEBHOOK_SECRET);
}

module.exports = { isConfigured, createPromptPayIntent, getPaymentIntent, cancelPaymentIntent, refundPaymentIntent, constructWebhookEvent };
