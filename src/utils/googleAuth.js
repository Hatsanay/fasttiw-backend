const jwt = require("jsonwebtoken");
const { OAuth2Client } = require("google-auth-library");

// เข้าสู่ระบบด้วย Google — ใช้ Authorization Code flow + PKCE (มาตรฐานที่ Google แนะนำสำหรับเว็บที่มี server)
//
// แบ่งหน้าที่แบบนี้โดยตั้งใจ:
//   - เซิร์ฟเวอร์ Next (tiwwai-store) สร้าง state + code_verifier, พาผู้ใช้ไป Google, รับ code กลับมาที่ callback
//   - **backend เป็นคนแลก code เป็น token และตรวจลายเซ็น id_token เอง** — client secret อยู่ที่ backend ที่เดียว
//     และ backend ไม่เชื่ออีเมลที่ใครส่งมาบอกเด็ดขาด เชื่อเฉพาะสิ่งที่ตรวจลายเซ็นของ Google ผ่านแล้วเท่านั้น
//
// degrade อย่างปลอดภัยเหมือน Stripe/SMTP — ไม่ตั้ง GOOGLE_CLIENT_ID/SECRET ระบบไม่พัง แค่ปุ่ม Google ไม่ขึ้น
// และ endpoint ตอบ 503 ถ้ามีคนยิงตรง

const SIGNUP_TOKEN_TTL = "15m";
const SIGNUP_PURPOSE = "google_signup";

function isGoogleConfigured() {
    return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

// callback ที่ยอมรับ — ต้องตรงกับที่ลงทะเบียนไว้ใน Google Cloud Console อยู่แล้ว (Google ปฏิเสธเองถ้าไม่ตรง)
// แต่เช็คซ้ำฝั่งเราด้วย กันคนส่ง redirect_uri ของโดเมนอื่นที่ลงทะเบียนไว้ใน client เดียวกันมาปน
function allowedRedirectUris() {
    const store = (process.env.STORE_URL || "http://localhost:3001").replace(/\/$/, "");
    const extra = (process.env.GOOGLE_EXTRA_REDIRECT_URIS || "").split(",").map((s) => s.trim()).filter(Boolean);
    return [`${store}/api/auth/google/callback`, ...extra];
}

const fail = (status, message) => Object.assign(new Error(message), { status });

// แลก authorization code เป็นโปรไฟล์ที่ตรวจสอบแล้ว — คืนเฉพาะฟิลด์ที่ใช้จริง
async function exchangeCodeForProfile({ code, codeVerifier, redirectUri }) {
    if (!isGoogleConfigured()) throw fail(503, "ยังไม่ได้เปิดใช้การเข้าสู่ระบบด้วย Google");
    if (!code || !codeVerifier) throw fail(400, "ข้อมูลจาก Google ไม่ครบ กรุณาลองใหม่");
    if (!allowedRedirectUris().includes(redirectUri)) throw fail(400, "redirect_uri ไม่ถูกต้อง");

    const client = new OAuth2Client({
        clientId: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        redirectUri,
    });

    let idToken;
    try {
        const { tokens } = await client.getToken({ code, codeVerifier, redirect_uri: redirectUri });
        idToken = tokens.id_token;
    } catch {
        // code หมดอายุ (อายุไม่กี่นาที) / ถูกใช้ไปแล้ว / verifier ไม่ตรง — ทั้งหมดแก้ด้วยการกดใหม่
        throw fail(400, "ยืนยันตัวตนกับ Google ไม่สำเร็จ กรุณากดเข้าสู่ระบบด้วย Google อีกครั้ง");
    }
    if (!idToken) throw fail(400, "Google ไม่ได้ส่งข้อมูลยืนยันตัวตนกลับมา กรุณาลองใหม่");

    // ตรวจลายเซ็น + aud (ต้องออกให้ client ของเราเท่านั้น) + iss + exp — ทำโดยไลบรารีทางการของ Google
    // ไม่เขียนเอง เพราะพลาดจุดเดียว (เช่น ลืมเช็ค aud) = ใครก็เอา id_token ของแอปอื่นมาล็อกอินเป็นลูกค้าเราได้
    const ticket = await client.verifyIdToken({ idToken, audience: process.env.GOOGLE_CLIENT_ID });
    const p = ticket.getPayload() ?? {};

    if (!p.sub || !p.email) throw fail(400, "บัญชี Google นี้ไม่มีอีเมล ใช้เข้าสู่ระบบไม่ได้");
    // อีเมลที่ Google ยังไม่ได้ยืนยันห้ามใช้เด็ดขาด — เราเชื่อมบัญชีเดิมด้วยอีเมล (ตัดสินใจร่วมกับผู้ใช้)
    // ถ้ายอมรับอีเมลที่ยังไม่ยืนยัน ใครก็สร้างบัญชี Google ด้วยอีเมลของลูกค้าเราแล้วเข้าบัญชีเขาได้ทันที
    if (p.email_verified !== true) throw fail(400, "อีเมลของบัญชี Google นี้ยังไม่ได้ยืนยัน กรุณายืนยันอีเมลกับ Google ก่อน");

    return {
        sub: String(p.sub),
        email: String(p.email).trim().toLowerCase(),
        given_name: p.given_name ? String(p.given_name) : null,
        family_name: p.family_name ? String(p.family_name) : null,
        name: p.name ? String(p.name) : null,
    };
}

// token ชั่วคราวระหว่าง "ยืนยันกับ Google แล้ว" กับ "กดยอมรับ PDPA สร้างบัญชี" — ลูกค้าใหม่ยังไม่มีบัญชี
// จึงยังออก session ให้ไม่ได้ แต่ต้องจำไว้ว่า Google ยืนยันตัวตนนี้แล้ว (ไม่ให้ต้องกด Google ซ้ำ)
//
// ใช้ JWT_SECRET ตัวเดียวกับ token ลูกค้าได้อย่างปลอดภัย เพราะ:
//   1) ไม่มี cus_id/jti — requireCustomerAuth ปฏิเสธทันทีถ้าเอาไปใช้เป็น token ล็อกอิน
//   2) ฝั่งกลับกัน verifySignupToken บังคับ purpose — token ลูกค้าปกติเอามาสร้างบัญชีไม่ได้
function signSignupToken(profile) {
    return jwt.sign(
        { purpose: SIGNUP_PURPOSE, sub: profile.sub, email: profile.email, given_name: profile.given_name, family_name: profile.family_name, name: profile.name },
        process.env.JWT_SECRET,
        { expiresIn: SIGNUP_TOKEN_TTL }
    );
}

function verifySignupToken(token) {
    let payload;
    try {
        payload = jwt.verify(String(token ?? ""), process.env.JWT_SECRET);
    } catch {
        throw fail(400, "ขั้นตอนสมัครด้วย Google หมดเวลาแล้ว กรุณากดเข้าสู่ระบบด้วย Google อีกครั้ง");
    }
    if (payload.purpose !== SIGNUP_PURPOSE || !payload.sub || !payload.email) {
        throw fail(400, "ข้อมูลสมัครสมาชิกไม่ถูกต้อง กรุณากดเข้าสู่ระบบด้วย Google อีกครั้ง");
    }
    return payload;
}

module.exports = { isGoogleConfigured, exchangeCodeForProfile, signSignupToken, verifySignupToken, allowedRedirectUris };
