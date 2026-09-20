const bcrypt = require("bcryptjs");
const crypto = require("node:crypto");
const pool = require("../config/db");
const { generateId } = require("../utils/generateId");
const { signToken } = require("../utils/jwt");
const { saveAvatarForCustomer } = require("./customer.controller");
const { createSession, listSessions, revokeSession, revokeSessionByJti, revokeAllSessions } = require("../utils/customerSession");
const { sendMail } = require("../utils/mailer");
const { buildPasswordResetEmail, buildRegisterOtpEmail } = require("../utils/emailTemplates");
const { exchangeCodeForProfile, signSignupToken, verifySignupToken } = require("../utils/googleAuth");
const { recordCustomerLogin, listCustomerLoginLogs } = require("../utils/customerLoginLog");
// กติกา OTP (อายุ/จำนวนครั้ง/ใช้ครั้งเดียว) ย้ายไปไว้ที่เดียวแล้ว ใช้ร่วมกับลืมรหัสผ่านฝั่งแอดมิน
const { issueOtp, consumeOtp, markOtpUsed, OTP_TTL_MINUTES } = require("../utils/emailOtp");

const RESET_TOKEN_TTL_MINUTES = 60;
const RESET_MAX_REQUESTS_PER_HOUR = 3; // ต่อ 1 บัญชี — กันคนกดรัวจนเมลของลูกค้าเต็มและกันเปลืองโควตา SMTP

/* ─────────────────── สมัครสมาชิก: ขอรหัส OTP → ยืนยันอีเมล → สร้างบัญชี ─────────────────── */

// รหัส 6 หลักแบบสุ่มเท่ากันทุกค่า — ใช้ crypto.randomInt ไม่ใช่ Math.random เพราะอันหลังเดาลำดับถัดไปได้
// ถ้ารู้ค่าก่อนหน้า (ไม่ใช่ CSPRNG) padStart กัน 6 หลักที่ขึ้นต้นด้วย 0 หายไปตอนแปลงเป็นสตริง
const generateOtp = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");

// ขอรหัสยืนยันอีเมลก่อนสมัคร — จุดประสงค์คือกันคนกรอกอีเมลผิด/มั่วแล้วสมัครผ่านไปได้ ซึ่งทำให้ลูกค้าคนนั้น
// ไม่ได้ทั้งใบเสร็จและลิงก์ตั้งรหัสผ่านใหม่ตลอดไปโดยไม่มีใครรู้ตัว
//
// ต่างจาก forgot-password ตรงที่ **ตอบตรงๆ ว่าอีเมลนี้ถูกใช้แล้ว** ได้ ไม่ถือว่าเป็นการเปิดเผยข้อมูล
// เพราะ endpoint สมัครสมาชิกเดิมก็ตอบ 409 แบบเดียวกันอยู่แล้ว (ถ้าปิดบังตรงนี้ ผู้ใช้จะงงว่าทำไมกรอกรหัส
// ถูกแล้วยังสมัครไม่ได้ กลายเป็นเพิ่มงานแอดมินโดยไม่ได้ความปลอดภัยเพิ่มจริง)
async function requestRegisterOtp(req, res, next) {
    try {
        const cus_email = String(req.body?.cus_email ?? "").trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cus_email)) {
            return res.status(400).json({ message: "รูปแบบอีเมลไม่ถูกต้อง" });
        }

        const [existing] = await pool.query("SELECT cus_id FROM tb_customers WHERE cus_email = ?", [cus_email]);
        if (existing[0]) {
            return res.status(409).json({ message: "อีเมลนี้ถูกใช้งานแล้ว กรุณาเข้าสู่ระบบหรือใช้อีเมลอื่น" });
        }

        const { code, expiresMinutes } = await issueOtp({ email: cus_email, purpose: "register" });

        const { subject, html } = buildRegisterOtpEmail({ code, expiresMinutes });
        await sendMail({ to: cus_email, subject, html });

        res.json({ message: `ส่งรหัสยืนยันไปที่ ${cus_email} แล้ว รหัสมีอายุ ${expiresMinutes} นาที` });
    } catch (err) {
        // 429 จาก issueOtp (ขอรหัสถี่เกินไป) ส่งข้อความเดิมกลับไปให้ผู้ใช้เห็น
        if (err.status) return res.status(err.status).json({ message: err.message });
        next(err);
    }
}

// สมัครสมาชิกเอง (ต่างจาก customer.controller.js create() ที่แอดมินกดสร้างให้ทางแชท) —
// ลูกค้าตั้งรหัสผ่านเองตั้งแต่แรก จึงไม่ต้อง cus_must_change_password = TRUE เหมือนฝั่งแอดมินสร้างให้
//
// **บังคับต้องมี OTP ที่ยืนยันอีเมลแล้วเสมอ** — เช็คที่นี่ไม่ใช่แค่ที่หน้าเว็บ ไม่งั้นใครยิง API ตรงๆ
// ก็ข้ามการยืนยันอีเมลได้หมด (การเช็คฝั่ง frontend อย่างเดียวไม่ใช่การป้องกัน)
async function register(req, res, next) {
    try {
        const { cus_username, cus_email, cus_password, cus_fname, cus_lname, cus_phone, pdpa_consent, otp } = req.body ?? {};

        if (!cus_username || !cus_email || !cus_password) {
            return res.status(400).json({ message: "กรุณากรอกชื่อผู้ใช้ อีเมล และรหัสผ่าน" });
        }
        if (cus_password.length < 8) {
            return res.status(400).json({ message: "รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร" });
        }
        if (!pdpa_consent) {
            return res.status(400).json({ message: "กรุณายอมรับนโยบายความเป็นส่วนตัวก่อนสมัครสมาชิก" });
        }
        if (!otp) {
            return res.status(400).json({ message: "กรุณากรอกรหัสยืนยันที่ส่งไปทางอีเมล" });
        }

        const email = String(cus_email).trim();
        const otpId = await consumeOtp({ email, purpose: "register", code: otp });

        const cus_id = await generateId("tb_customers", "CUS");
        const passwordHash = await bcrypt.hash(cus_password, 10);

        await pool.query(
            `INSERT INTO tb_customers
                (cus_id, cus_username, cus_email, cus_password, cus_fname, cus_lname, cus_phone,
                 cus_must_change_password, cus_pdpa_consented_at, cus_signup_via)
             VALUES (?, ?, ?, ?, ?, ?, ?, FALSE, NOW(), 'web')`,
            [cus_id, cus_username, email, passwordHash, cus_fname || null, cus_lname || null, cus_phone || null]
        );

        // ตัดรหัสทิ้งหลังสร้างบัญชีสำเร็จเท่านั้น — ถ้าสร้างไม่ผ่าน (เช่นชื่อผู้ใช้ซ้ำ) รหัสเดิมยังใช้ได้อยู่
        // ผู้ใช้จะได้แค่แก้ชื่อผู้ใช้แล้วกดสมัครใหม่ ไม่ต้องไปขอรหัสใหม่ทางอีเมลอีกรอบ
        await markOtpUsed(otpId);

        // สมัครเองไม่ต้องผ่านขั้นตอนเปลี่ยนรหัส/เติมข้อมูลบังคับ (mcp = false ตั้งแต่แรก)
        const jti = await createSession(cus_id, req.headers["user-agent"]);
        const token = signToken({ cus_id, mcp: false, jti });
        recordCustomerLogin(req, { customerId: cus_id, identifier: cus_username, action: "register" });
        res.status(201).json({ token });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ message: err.message });
        if (err.code === "ER_DUP_ENTRY") {
            return res.status(409).json({ message: "ชื่อผู้ใช้หรืออีเมลนี้ถูกใช้งานแล้ว" });
        }
        next(err);
    }
}

async function login(req, res, next) {
    try {
        const { cus_username, cus_password } = req.body ?? {};
        if (!cus_username || !cus_password) {
            return res.status(400).json({ message: "กรุณากรอกชื่อผู้ใช้และรหัสผ่าน" });
        }

        const [rows] = await pool.query(
            `SELECT cus_id, cus_password, cus_status, cus_must_change_password FROM tb_customers
             WHERE cus_username = ? OR cus_email = ?`,
            [cus_username, cus_username]
        );
        const customer = rows[0];
        if (!customer || customer.cus_status !== "active") {
            // บันทึกด้วยแม้บัญชีไม่มีอยู่จริง — การไล่เดาชื่อผู้ใช้คือสิ่งที่อยากเห็นย้อนหลัง
            recordCustomerLogin(req, { customerId: customer?.cus_id ?? null, identifier: cus_username, action: "login_failed" });
            return res.status(401).json({ message: "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง" });
        }

        const passwordOk = await bcrypt.compare(cus_password, customer.cus_password);
        if (!passwordOk) {
            recordCustomerLogin(req, { customerId: customer.cus_id, identifier: cus_username, action: "login_failed" });
            return res.status(401).json({ message: "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง" });
        }

        recordCustomerLogin(req, { customerId: customer.cus_id, identifier: cus_username, action: "login" });
        res.json({ token: await issueLoginToken(customer, req.headers["user-agent"]) });
    } catch (err) {
        next(err);
    }
}

// ออก token ล็อกอินให้บัญชีที่ยืนยันตัวตนผ่านแล้ว — จุดกลางเดียวของทั้งรหัสผ่านและ Google
// ให้ทุกทางได้ session/อุปกรณ์/last_login แบบเดียวกันเป๊ะ ไม่มีทางไหนหลุดโควตา 2 อุปกรณ์
//
// mcp (must_change_password) ฝังไว้ใน token เลย — ฝั่ง frontend อ่านได้โดยไม่ต้องยิง API
// เพิ่ม (ตาม pattern optimistic check เดียวกับที่ proxy.ts ใช้) พอทำ onboarding เสร็จค่อยออก
// token ใหม่ให้ (ดู completeOnboarding ด้านล่าง)
// login ใหม่แต่ละครั้ง = อุปกรณ์ใหม่ 1 slot (จำกัดพร้อมกันได้ 2 เครื่อง เกินโควตาเตะเครื่องเก่าสุดออก)
async function issueLoginToken(customer, userAgent) {
    await pool.query("UPDATE tb_customers SET cus_last_login_at = NOW() WHERE cus_id = ?", [customer.cus_id]);
    const jti = await createSession(customer.cus_id, userAgent);
    return signToken({ cus_id: customer.cus_id, mcp: !!customer.cus_must_change_password, jti });
}

/* ─────────────────── เข้าสู่ระบบด้วย Google ─────────────────── */

const CUSTOMER_LOGIN_COLUMNS = "cus_id, cus_status, cus_must_change_password, cus_google_sub";

// หาบัญชีที่ตรงกับบัญชี Google นี้ — ผูกด้วย sub ก่อนเสมอ (ถาวร ไม่เปลี่ยน) ถ้าไม่เจอค่อยหาจากอีเมล
// เพื่อเชื่อมบัญชีเดิมที่สมัครด้วยรหัสผ่าน (ตัดสินใจร่วมกับผู้ใช้ 2026-09-12: เชื่อมอัตโนมัติ เพราะ Google
// ยืนยันแล้วว่าเป็นเจ้าของอีเมลนี้จริง — exchangeCodeForProfile ปฏิเสธอีเมลที่ยังไม่ยืนยันไปแล้ว)
async function findCustomerForGoogle(profile) {
    const [bySub] = await pool.query(`SELECT ${CUSTOMER_LOGIN_COLUMNS} FROM tb_customers WHERE cus_google_sub = ?`, [profile.sub]);
    if (bySub[0]) return bySub[0];

    // cus_email เป็น utf8mb4_unicode_ci เทียบแบบไม่สนตัวพิมพ์เล็ก-ใหญ่อยู่แล้ว
    const [byEmail] = await pool.query(`SELECT ${CUSTOMER_LOGIN_COLUMNS} FROM tb_customers WHERE cus_email = ?`, [profile.email]);
    const customer = byEmail[0];
    if (!customer) return null;

    // อีเมลตรงแต่บัญชีนี้ผูกกับ Google คนละบัญชีไว้แล้ว (เช่น เจ้าของย้ายอีเมลไปบัญชี Google ใหม่) — ไม่เขียนทับ
    // เงียบๆ เพราะจะทำให้บัญชี Google เดิมเข้าไม่ได้โดยไม่มีใครรู้ ให้ใช้รหัสผ่านแทน
    if (customer.cus_google_sub && customer.cus_google_sub !== profile.sub) {
        throw Object.assign(new Error("อีเมลนี้เชื่อมกับบัญชี Google อื่นไว้แล้ว กรุณาเข้าสู่ระบบด้วยชื่อผู้ใช้และรหัสผ่าน"), { status: 409 });
    }
    return customer;
}

// ล็อกอินบัญชีที่หาเจอ (และผูก Google ให้ถ้ายังไม่เคยผูก) — ใช้ทั้งตอนล็อกอินปกติและตอนกดสร้างบัญชีแล้ว
// พบว่ามีบัญชีเกิดขึ้นระหว่างทาง
async function loginWithGoogle(req, customer, profile) {
    // ต่างจากล็อกอินด้วยรหัสผ่านที่ตอบกลางๆ "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง" — ที่นี่ผู้ใช้พิสูจน์ตัวตนกับ Google
    // แล้ว บอกตรงๆ ว่าบัญชีถูกระงับได้โดยไม่เปิดเผยอะไรเพิ่ม และช่วยให้เขาไปติดต่อแอดมินได้ถูกทาง
    if (customer.cus_status !== "active") {
        throw Object.assign(new Error("บัญชีนี้ถูกระงับการใช้งาน กรุณาติดต่อแอดมิน"), { status: 403 });
    }
    if (!customer.cus_google_sub) {
        // WHERE ... IS NULL กันสอง request เชื่อมพร้อมกันเขียนทับกัน
        await pool.query("UPDATE tb_customers SET cus_google_sub = ? WHERE cus_id = ? AND cus_google_sub IS NULL", [profile.sub, customer.cus_id]);
    }
    recordCustomerLogin(req, { customerId: customer.cus_id, identifier: profile.email, action: "login_google" });
    return issueLoginToken(customer, req.headers["user-agent"]);
}

// ชื่อผู้ใช้อัตโนมัติจากส่วนหน้าของอีเมล — ลูกค้าที่สมัครผ่าน Google ไม่ต้องตั้งเอง (ไม่ได้ใช้ล็อกอินอยู่แล้ว)
// แต่คอลัมน์บังคับ NOT NULL UNIQUE และแอดมินใช้ค้นหาลูกค้า จึงควรเป็นคำที่อ่านออก ไม่ใช่เลขสุ่มล้วน
function usernameCandidate(email, withSuffix) {
    const base = email.split("@")[0].toLowerCase().replace(/[^a-z0-9._]/g, "").slice(0, 40) || "user";
    return withSuffix ? `${base}${crypto.randomInt(1000, 10000)}` : base;
}

async function createGoogleCustomer(profile) {
    const cus_id = await generateId("tb_customers", "CUS");
    // รหัสผ่านสุ่ม 256 บิตที่ไม่มีใครรู้ — คอลัมน์บังคับ NOT NULL และทำให้ล็อกอินด้วยรหัสผ่านไม่ได้ในทางปฏิบัติ
    // ถ้าลูกค้าอยากมีรหัสผ่านทีหลังกด "ลืมรหัสผ่าน" ได้ปกติ (ดู database/query/alter_customers_add_google_sub.sql)
    const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 10);
    const fname = (profile.given_name || profile.name || "").slice(0, 50) || null;
    const lname = (profile.family_name || "").slice(0, 50) || null;

    // ชื่อผู้ใช้ชนกันได้ (อีเมลคนละโดเมนแต่ส่วนหน้าเหมือนกัน) — ลองชื่อเปล่าก่อน ชนแล้วค่อยต่อท้ายตัวเลขสุ่ม
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            await pool.query(
                `INSERT INTO tb_customers
                    (cus_id, cus_username, cus_email, cus_password, cus_google_sub, cus_fname, cus_lname,
                     cus_must_change_password, cus_pdpa_consented_at, cus_signup_via)
                 VALUES (?, ?, ?, ?, ?, ?, ?, FALSE, NOW(), 'google')`,
                [cus_id, usernameCandidate(profile.email, attempt > 0), profile.email, passwordHash, profile.sub, fname, lname]
            );
            return { cus_id, cus_status: "active", cus_must_change_password: 0, cus_google_sub: profile.sub };
        } catch (err) {
            if (err.code === "ER_DUP_ENTRY" && /uq_cus_username/.test(err.sqlMessage ?? "")) continue;
            throw err;
        }
    }
    throw new Error("สร้างชื่อผู้ใช้ที่ไม่ซ้ำไม่สำเร็จ");
}

// ขั้นที่ 1 — รับ code จาก callback ของ Google (ส่งต่อมาจากเซิร์ฟเวอร์ Next)
// บัญชีเดิม → ล็อกอินเลย / ลูกค้าใหม่ → ยังไม่สร้างบัญชี คืน signup_token ให้ไปกดยอมรับ PDPA ก่อน
// (ตัดสินใจร่วมกับผู้ใช้: ขอความยินยอมแบบติ๊กเองเหมือนหน้าสมัครปกติ และไม่มีบัญชีค้างครึ่งๆ ถ้าปิดหน้าไป)
async function googleLogin(req, res, next) {
    try {
        const { code, code_verifier, redirect_uri } = req.body ?? {};
        const profile = await exchangeCodeForProfile({ code, codeVerifier: code_verifier, redirectUri: redirect_uri });

        const customer = await findCustomerForGoogle(profile);
        if (!customer) {
            return res.json({ needs_signup: true, signup_token: signSignupToken(profile) });
        }
        res.json({ token: await loginWithGoogle(req, customer, profile) });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ message: err.message });
        next(err);
    }
}

// ขั้นที่ 2 (เฉพาะลูกค้าใหม่) — กดยอมรับนโยบายความเป็นส่วนตัวแล้วสร้างบัญชี
// ไม่ต้องใช้ OTP เหมือนสมัครปกติ เพราะ Google ยืนยันความเป็นเจ้าของอีเมลให้แล้ว (email_verified)
async function googleSignupComplete(req, res, next) {
    try {
        const { signup_token, pdpa_consent } = req.body ?? {};
        const profile = verifySignupToken(signup_token);
        if (!pdpa_consent) {
            return res.status(400).json({ message: "กรุณายอมรับนโยบายความเป็นส่วนตัวก่อนสมัครสมาชิก" });
        }

        const userAgent = req.headers["user-agent"];
        // หาใหม่อีกรอบก่อนสร้าง — ระหว่างที่ผู้ใช้อ่านหน้ายอมรับ PDPA อาจมีบัญชีเกิดขึ้นแล้ว (กดสองแท็บพร้อมกัน /
        // สมัครด้วยรหัสผ่านอีกแท็บ) ถ้ามีแล้วล็อกอินเข้าบัญชีนั้นแทน ไม่สร้างซ้ำ
        const existing = await findCustomerForGoogle(profile);
        if (existing) return res.json({ token: await loginWithGoogle(req, existing, profile) });

        try {
            const created = await createGoogleCustomer(profile);
            recordCustomerLogin(req, { customerId: created.cus_id, identifier: profile.email, action: "register" });
            res.status(201).json({ token: await issueLoginToken(created, userAgent) });
        } catch (err) {
            // ชนที่อีเมล/sub = อีกแท็บเพิ่งสร้างสำเร็จไปก่อนหน้าเสี้ยววินาที — ล็อกอินเข้าบัญชีนั้นแทน
            if (err.code !== "ER_DUP_ENTRY") throw err;
            const raced = await findCustomerForGoogle(profile);
            if (!raced) throw err;
            res.json({ token: await loginWithGoogle(req, raced, profile) });
        }
    } catch (err) {
        if (err.status) return res.status(err.status).json({ message: err.message });
        next(err);
    }
}

/* ─────────────────── ลืมรหัสผ่าน: ขอลิงก์ → ตั้งรหัสใหม่ ─────────────────── */

// เก็บลง DB เป็นแฮชเสมอ ไม่เก็บ token ตัวจริง — ตัวจริงมีอยู่ที่เดียวคือในอีเมลของลูกค้า
const hashToken = (token) => crypto.createHash("sha256").update(token).digest("hex");

function storeUrl() {
    return (process.env.STORE_URL || "http://localhost:3001").replace(/\/$/, "");
}

// ขอลิงก์ตั้งรหัสผ่านใหม่ — ตอบข้อความเดียวกันเสมอไม่ว่าอีเมลนั้นจะมีบัญชีอยู่จริงหรือไม่ (และไม่ว่าจะโดน
// จำกัดจำนวนครั้งหรือไม่) เพราะถ้าตอบต่างกันจะกลายเป็นเครื่องมือให้คนไล่เดาว่าอีเมลไหนเป็นลูกค้าเราบ้าง
// (account enumeration) ซึ่งเป็นข้อมูลที่ไม่ควรเปิดเผย
async function forgotPassword(req, res, next) {
    try {
        const email = String(req.body?.cus_email ?? "").trim();
        if (!email) return res.status(400).json({ message: "กรุณากรอกอีเมล" });

        const generic = { message: "ถ้าอีเมลนี้มีบัญชีอยู่ในระบบ เราส่งลิงก์ตั้งรหัสผ่านใหม่ไปให้แล้ว กรุณาตรวจสอบกล่องจดหมาย" };

        const [rows] = await pool.query(
            `SELECT cus_id, cus_username, cus_email, cus_fname, cus_lname
             FROM tb_customers WHERE cus_email = ? AND cus_status = 'active'`,
            [email]
        );
        const customer = rows[0];
        if (!customer) return res.json(generic);

        const [recent] = await pool.query(
            "SELECT COUNT(*) AS n FROM tb_password_resets WHERE pr_customer_id = ? AND pr_created_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)",
            [customer.cus_id]
        );
        if (recent[0].n >= RESET_MAX_REQUESTS_PER_HOUR) return res.json(generic);

        // ลิงก์เก่าที่ยังไม่ได้ใช้ถือว่าใช้ไม่ได้แล้วทันทีที่ขอใหม่ — ให้มีลิงก์ที่ใช้ได้แค่ฉบับล่าสุดฉบับเดียว
        // ลดพื้นที่เสี่ยงถ้าเมลเก่าหลุดไปอยู่ในมือคนอื่น
        await pool.query(
            "UPDATE tb_password_resets SET pr_used_at = NOW() WHERE pr_customer_id = ? AND pr_used_at IS NULL",
            [customer.cus_id]
        );

        const token = crypto.randomBytes(32).toString("hex"); // 256 บิต เดาไม่ได้ในทางปฏิบัติ
        const pr_id = await generateId("tb_password_resets", "PRS");
        await pool.query(
            `INSERT INTO tb_password_resets (pr_id, pr_customer_id, pr_token_hash, pr_expires_at)
             VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE))`,
            [pr_id, customer.cus_id, hashToken(token), RESET_TOKEN_TTL_MINUTES]
        );

        const { subject, html } = buildPasswordResetEmail({
            customer,
            resetUrl: `${storeUrl()}/reset-password?token=${token}`,
            expiresMinutes: RESET_TOKEN_TTL_MINUTES,
        });
        await sendMail({ to: customer.cus_email, subject, html });

        // เก็บกวาด token ที่หมดอายุนานแล้วไปด้วยเลย (ตารางนี้โตช้ามาก ไม่คุ้มที่จะตั้ง job แยกอีกตัว)
        await pool.query("DELETE FROM tb_password_resets WHERE pr_expires_at < DATE_SUB(NOW(), INTERVAL 7 DAY)");

        res.json(generic);
    } catch (err) {
        next(err);
    }
}

// ตั้งรหัสผ่านใหม่ด้วย token จากลิงก์ในอีเมล — token ใช้ได้ครั้งเดียวและมีอายุจำกัด
// ไม่ล็อกอินให้อัตโนมัติหลังตั้งรหัสสำเร็จ (บังคับให้พิมพ์รหัสใหม่ที่หน้า login อีกครั้ง) เพราะถ้าออก token
// ให้เลย เท่ากับใครก็ตามที่เปิดลิงก์จากเมลได้จะเข้าบัญชีได้ทันทีโดยไม่ต้องรู้รหัสผ่านที่เพิ่งตั้ง
async function resetPassword(req, res, next) {
    try {
        const token = String(req.body?.token ?? "");
        const new_password = String(req.body?.new_password ?? "");

        if (!token) return res.status(400).json({ message: "ลิงก์ไม่ถูกต้อง" });
        if (new_password.length < 8) return res.status(400).json({ message: "รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร" });

        const [rows] = await pool.query(
            `SELECT pr_id, pr_customer_id FROM tb_password_resets
             WHERE pr_token_hash = ? AND pr_used_at IS NULL AND pr_expires_at > NOW()`,
            [hashToken(token)]
        );
        const request = rows[0];
        if (!request) {
            return res.status(400).json({ message: "ลิงก์นี้หมดอายุหรือถูกใช้ไปแล้ว กรุณาขอลิงก์ใหม่อีกครั้ง" });
        }

        const passwordHash = await bcrypt.hash(new_password, 10);
        // mark ว่าใช้แล้วแบบ atomic (WHERE pr_used_at IS NULL) — ถ้ามีสอง request ยิงพร้อมกันด้วย token
        // เดียวกัน จะมีแค่อันเดียวที่ผ่าน อีกอันได้ affectedRows = 0 แล้วถูกปฏิเสธไป
        const [claim] = await pool.query(
            "UPDATE tb_password_resets SET pr_used_at = NOW() WHERE pr_id = ? AND pr_used_at IS NULL",
            [request.pr_id]
        );
        if (claim.affectedRows === 0) {
            return res.status(400).json({ message: "ลิงก์นี้ถูกใช้ไปแล้ว กรุณาขอลิงก์ใหม่อีกครั้ง" });
        }

        await pool.query("UPDATE tb_customers SET cus_password = ? WHERE cus_id = ?", [passwordHash, request.pr_customer_id]);

        // จงใจไม่แตะ cus_must_change_password — บัญชีที่แอดมินสร้างให้ยังต้องผ่านหน้า onboarding
        // (กรอกชื่อ-นามสกุล + ยอมรับ PDPA) อยู่ดี การตั้งรหัสผ่านผ่านลิงก์ไม่ได้เก็บข้อมูลพวกนั้น
        await revokeAllSessions(request.pr_customer_id);
        recordCustomerLogin(req, { customerId: request.pr_customer_id, action: "password_reset" });

        res.json({ message: "ตั้งรหัสผ่านใหม่เรียบร้อยแล้ว กรุณาเข้าสู่ระบบด้วยรหัสผ่านใหม่" });
    } catch (err) {
        next(err);
    }
}

async function getMe(req, res, next) {
    try {
        const [rows] = await pool.query(
            `SELECT cus_id, cus_username, cus_fname, cus_lname, cus_email, cus_phone,
                    cus_avatar_url, cus_must_change_password,
                    (cus_google_sub IS NOT NULL) AS google_linked
             FROM tb_customers WHERE cus_id = ?`,
            [req.customer.cus_id]
        );
        if (!rows[0]) return res.status(404).json({ message: "ไม่พบผู้ใช้งาน" });
        res.json(rows[0]);
    } catch (err) {
        next(err);
    }
}

async function uploadMyImage(req, res, next) {
    try {
        if (!req.file) return res.status(400).json({ message: "ไม่พบไฟล์รูปภาพ" });
        const cus_avatar_url = await saveAvatarForCustomer(req.customer.cus_id, req.file);
        res.json({ cus_avatar_url });
    } catch (err) {
        next(err);
    }
}

// จบขั้นตอนบังคับตั้งรหัสผ่านใหม่ + เติมข้อมูลส่วนตัว ของบัญชีที่แอดมินสร้างให้ (ลูกค้าสมัครเองไม่ผ่านจุดนี้
// เพราะ cus_must_change_password = FALSE ตั้งแต่ register) — commit ทีเดียวทั้งรหัสผ่านและข้อมูล
// ไม่แยก 2 endpoint เพื่อกันเคส "เปลี่ยนรหัสแล้วแต่ปิดเบราว์เซอร์ก่อนกรอกข้อมูล" ค้างอยู่ครึ่งๆ กลางๆ
async function completeOnboarding(req, res, next) {
    try {
        const { new_password, cus_fname, cus_lname, cus_email, cus_phone, pdpa_consent } = req.body ?? {};

        if (!new_password || new_password.length < 8) {
            return res.status(400).json({ message: "รหัสผ่านใหม่ต้องมีอย่างน้อย 8 ตัวอักษร" });
        }
        if (!cus_fname || !cus_lname || !cus_email) {
            return res.status(400).json({ message: "กรุณากรอกชื่อ นามสกุล และอีเมล" });
        }
        if (!pdpa_consent) {
            return res.status(400).json({ message: "กรุณายอมรับนโยบายความเป็นส่วนตัวก่อนใช้งาน" });
        }

        const passwordHash = await bcrypt.hash(new_password, 10);
        await pool.query(
            `UPDATE tb_customers SET
                cus_password = ?, cus_fname = ?, cus_lname = ?, cus_email = ?, cus_phone = ?,
                cus_must_change_password = FALSE, cus_pdpa_consented_at = COALESCE(cus_pdpa_consented_at, NOW())
             WHERE cus_id = ?`,
            [passwordHash, cus_fname, cus_lname, cus_email, cus_phone || null, req.customer.cus_id]
        );

        // ออก token ใหม่ที่ mcp เป็น false แล้ว ให้ frontend เอาไปตั้ง cookie ทับของเดิม — ใช้ jti
        // เดิมต่อ (ไม่สร้าง session ใหม่) เพราะเป็นอุปกรณ์/session เดียวกันที่ล็อกอินค้างอยู่แล้ว
        const token = signToken({ cus_id: req.customer.cus_id, mcp: false, jti: req.customer.jti });
        res.json({ token });
    } catch (err) {
        if (err.code === "ER_DUP_ENTRY") {
            return res.status(409).json({ message: "อีเมลนี้ถูกใช้งานแล้ว" });
        }
        next(err);
    }
}

// แก้ไขข้อมูลส่วนตัวตามปกติ (ต่างจาก completeOnboarding ที่บังคับรวมกับเปลี่ยนรหัสผ่าน) —
// ใช้ตอนลูกค้าเข้ามาแก้ไขโปรไฟล์เองทีหลังจากหน้าบัญชีของฉัน
async function updateMyProfile(req, res, next) {
    try {
        const { cus_fname, cus_lname, cus_email, cus_phone } = req.body ?? {};
        if (!cus_fname || !cus_lname || !cus_email) {
            return res.status(400).json({ message: "กรุณากรอกชื่อ นามสกุล และอีเมล" });
        }

        await pool.query(
            "UPDATE tb_customers SET cus_fname = ?, cus_lname = ?, cus_email = ?, cus_phone = ? WHERE cus_id = ?",
            [cus_fname, cus_lname, cus_email, cus_phone || null, req.customer.cus_id]
        );

        res.json({ message: "แก้ไขข้อมูลส่วนตัวสำเร็จ" });
    } catch (err) {
        if (err.code === "ER_DUP_ENTRY") {
            return res.status(409).json({ message: "อีเมลนี้ถูกใช้งานแล้ว" });
        }
        next(err);
    }
}

// แก้เฉพาะชื่อ-นามสกุล — ใช้ที่หน้าต้อนรับหลังสมัครด้วย Google (/welcome) ซึ่งถามแค่ชื่อกับรูป
// แยกจาก updateMyProfile เพราะตัวนั้นบังคับส่งอีเมลมาด้วยทุกครั้ง ถ้าหน้าเว็บต้องอ่านอีเมลเดิมแล้วส่งกลับ
// ก็เสี่ยงเขียนทับค่าที่เพิ่งเปลี่ยนจากอีกแท็บโดยไม่ตั้งใจ
const NAME_MAX_LENGTH = 50; // ตรงกับ VARCHAR(50) ของ cus_fname/cus_lname — เกินแล้ว MySQL จะ error เป็น 500
async function updateMyName(req, res, next) {
    try {
        const cus_fname = String(req.body?.cus_fname ?? "").trim();
        const cus_lname = String(req.body?.cus_lname ?? "").trim();
        if (!cus_fname || !cus_lname) {
            return res.status(400).json({ message: "กรุณากรอกชื่อและนามสกุล" });
        }
        if (cus_fname.length > NAME_MAX_LENGTH || cus_lname.length > NAME_MAX_LENGTH) {
            return res.status(400).json({ message: `ชื่อและนามสกุลยาวได้ไม่เกิน ${NAME_MAX_LENGTH} ตัวอักษร` });
        }

        await pool.query("UPDATE tb_customers SET cus_fname = ?, cus_lname = ? WHERE cus_id = ?", [cus_fname, cus_lname, req.customer.cus_id]);
        res.json({ message: "บันทึกชื่อเรียบร้อยแล้ว" });
    } catch (err) {
        next(err);
    }
}

// เปลี่ยนรหัสผ่านตามใจสมัคร (ไม่บังคับ ต่างจาก completeOnboarding) — เชื่อ session ที่ login อยู่แล้ว
// เหมือน pattern changeOwnPassword ฝั่ง staff ไม่ต้องกรอกรหัสผ่านเดิมซ้ำ
async function changeMyPassword(req, res, next) {
    try {
        const { new_password } = req.body ?? {};
        if (!new_password || new_password.length < 8) {
            return res.status(400).json({ message: "รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร" });
        }

        const passwordHash = await bcrypt.hash(new_password, 10);
        await pool.query("UPDATE tb_customers SET cus_password = ? WHERE cus_id = ?", [passwordHash, req.customer.cus_id]);

        res.json({ message: "เปลี่ยนรหัสผ่านสำเร็จ" });
    } catch (err) {
        next(err);
    }
}

// รายการอุปกรณ์ที่ล็อกอินอยู่ตอนนี้ (สูงสุด 2 ตามโควตา) — ให้ผู้ใช้เตะอุปกรณ์อื่นออกเองได้จากหน้าบัญชี
// ประวัติการเข้าสู่ระบบของตัวเอง — ถ้ามีคนอื่นเข้าบัญชีได้ เจ้าตัวคือคนที่มีโอกาสเห็นก่อนใคร
// (แอดมินไม่ได้นั่งไล่ดูทุกบัญชี) รวมครั้งที่ล็อกอินไม่สำเร็จด้วย เพราะ "มีคนพยายามเข้า" คือสัญญาณเตือนตัวจริง
async function getMyLoginHistory(req, res, next) {
    try {
        const rows = await listCustomerLoginLogs(req.customer.cus_id, { days: 90, limit: 50 });
        res.json({
            data: rows.map((r) => ({
                id: r.clog_id, action: r.clog_action, ip: r.clog_ip,
                user_agent: r.clog_user_agent, created_at: r.clog_created_at,
            })),
        });
    } catch (err) {
        next(err);
    }
}

async function getMySessions(req, res, next) {
    try {
        const sessions = await listSessions(req.customer.cus_id);
        // ไม่ส่ง sess_jti กลับไปฝั่ง client (ค่าภายในไว้เทียบ is_current เท่านั้น ไม่ควรหลุดออกไปโดยไม่จำเป็น)
        const data = sessions.map(({ sess_jti, ...s }) => ({ ...s, is_current: sess_jti === req.customer.jti }));
        res.json({ data });
    } catch (err) {
        next(err);
    }
}

async function deleteMySession(req, res, next) {
    try {
        await revokeSession(req.customer.cus_id, req.params.id);
        recordCustomerLogin(req, { customerId: req.customer.cus_id, action: "device_revoked" });
        res.json({ message: "ออกจากระบบอุปกรณ์นั้นแล้ว" });
    } catch (err) {
        next(err);
    }
}

// ลบ session ของอุปกรณ์ปัจจุบันออกจาก DB จริงตอนกด logout — เดิมฝั่ง frontend มีแค่ clear cookie ฝั่ง
// ตัวเองเฉยๆ ไม่เคยบอก backend เลย ทำให้ session แถวนี้ยัง "active" ค้างอยู่ต่อไปจนกว่าจะโดน FIFO evict
// เอง (ตอนล็อกอินอุปกรณ์ที่ 3) ขัดกับจุดประสงค์ของฟีเจอร์จำกัด 2 อุปกรณ์ที่ควรว่างทันทีที่ logout จริง
async function logout(req, res, next) {
    recordCustomerLogin(req, { customerId: req.customer?.cus_id ?? null, action: "logout" });
    try {
        await revokeSessionByJti(req.customer.cus_id, req.customer.jti);
        res.json({ message: "ออกจากระบบสำเร็จ" });
    } catch (err) {
        next(err);
    }
}

module.exports = {
    register, login, getMe, completeOnboarding, updateMyProfile, changeMyPassword, uploadMyImage,
    getMySessions, getMyLoginHistory, deleteMySession, logout, forgotPassword, resetPassword, requestRegisterOtp,
    googleLogin, googleSignupComplete, updateMyName,
};
