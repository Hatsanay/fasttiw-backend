const bcrypt = require("bcryptjs");
const pool = require("../config/db");
const { signToken } = require("../utils/jwt");
const { generateId } = require("../utils/generateId");
const { issueOtp, consumeOtp, markOtpUsed } = require("../utils/emailOtp");
const { sendMail } = require("../utils/mailer");
const { buildStaffResetOtpEmail, buildStaff2faEmail } = require("../utils/emailTemplates");
const { signToken: signJwt, verifyToken } = require("../utils/jwt");
const { createSession, revokeSessionByJti, revokeAllSessions } = require("../utils/userSession");
// IP จริงของคนที่กดปุ่ม ไม่ใช่ IP ของเซิร์ฟเวอร์ Next — ทุกคำขอของแอดมินวิ่งผ่าน Next ก่อนเสมอ
// (เชื่อ header x-client-ip ก็ต่อเมื่อ x-internal-secret ตรงเท่านั้น ดู rateLimit.middleware.js)
const { clientKey } = require("../middlewares/rateLimit.middleware");

const OTP_PURPOSE = "staff_reset";
// ข้อความเดียวที่ตอบกลับเสมอไม่ว่าอีเมลนั้นจะมีบัญชีจริงหรือไม่ — กันคนใช้หน้านี้ไล่เช็คว่าอีเมลไหนเป็น
// บัญชีหลังบ้าน (account enumeration) ซึ่งเป็นข้อมูลตั้งต้นชั้นดีของคนที่จะมาไล่เดารหัสผ่านต่อ
const SAME_ANSWER = "ถ้าอีเมลนี้เป็นบัญชีผู้ใช้งานระบบ เราได้ส่งรหัสยืนยันไปให้แล้ว กรุณาตรวจกล่องจดหมาย (รวมถึงอีเมลขยะ)";

async function writeLoginLog({ user_id, email, fullname, action, req }) {
    const log_id = await generateId("tb_login_logs", "LOG");
    await pool.query(
        `INSERT INTO tb_login_logs
            (log_id, log_user_id, log_email, log_fullname, log_action, log_ip_address, log_user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [log_id, user_id ?? null, email, fullname ?? null, action, clientKey(req)?.slice(0, 45) ?? null, req.headers["user-agent"] ?? null]
    );
}

async function login(req, res, next) {
    try {
        const { user_email, user_password } = req.body;
        if (!user_email || !user_password) {
            return res.status(400).json({ message: "กรุณากรอกอีเมลและรหัสผ่าน" });
        }

        const [rows] = await pool.query(
            `SELECT user_id, user_password, user_role_id, user_status, user_fname, user_lname, user_2fa_enabled
             FROM tb_users WHERE user_email = ?`,
            [user_email]
        );
        const user = rows[0];
        const fullname = user ? `${user.user_fname} ${user.user_lname}` : null;

        if (!user || user.user_status !== "active") {
            await writeLoginLog({ user_id: user?.user_id, email: user_email, fullname, action: "login_failed", req });
            return res.status(401).json({ message: "อีเมลหรือรหัสผ่านไม่ถูกต้อง" });
        }

        const passwordOk = await bcrypt.compare(user_password, user.user_password);
        if (!passwordOk) {
            await writeLoginLog({ user_id: user.user_id, email: user_email, fullname, action: "login_failed", req });
            return res.status(401).json({ message: "อีเมลหรือรหัสผ่านไม่ถูกต้อง" });
        }

        await pool.query("UPDATE tb_users SET user_last_login_at = NOW() WHERE user_id = ?", [
            user.user_id,
        ]);
        await writeLoginLog({ user_id: user.user_id, email: user_email, fullname, action: "login", req });

        // เปิด 2FA ไว้ → ยังไม่ออก token ให้ ส่งรหัสไปอีเมลแล้วให้ไปยืนยันที่ /auth/login/2fa ก่อน
        if (user.user_2fa_enabled) return sendLoginChallenge(req, res, user);

        // ผูก token กับ session ใน DB เพื่อให้เพิกถอนได้ทีหลัง (ดู utils/userSession.js)
        const jti = await createSession(user.user_id, { deviceInfo: req.headers["user-agent"], ip: clientKey(req) });
        const token = signToken({ user_id: user.user_id, user_role_id: user.user_role_id, jti });
        res.json({ token });
    } catch (err) {
        next(err);
    }
}

/* ─────────────────── ยืนยันตัวตนสองชั้น (2FA) ของระบบหลังบ้าน (2026-09-20) ───────────────────
 * **ผู้ใช้เปิด/ปิดเองได้รายคน** ค่าเริ่มต้นคือปิด — คนที่ใช้อยู่เดิมล็อกอินเหมือนเดิมทุกประการ
 *
 * flow: อีเมล+รหัสผ่านถูก → (ถ้าเปิด 2FA) ส่ง OTP ทางอีเมล + คืน challenge_token → กรอกรหัส → ได้ token จริง
 *
 * challenge_token ใช้ JWT_SECRET ตัวเดียวกันได้อย่างปลอดภัย เพราะ **ไม่มี jti** — เอาไปใช้เป็น token
 * ล็อกอินไม่ได้ (requireAuth เช็คว่าต้องมี session จริงใน DB เสมอ) และบังคับ purpose: "staff_2fa" อีกชั้น
 * (ตรรกะเดียวกับ signup_token ของฝั่งลูกค้า ดู CLAUDE.md ข้อ 6.5)
 */
const TWO_FA_PURPOSE = "staff_2fa";
const CHALLENGE_TTL = "10m";

async function sendLoginChallenge(req, res, user) {
    const email = req.body.user_email;
    try {
        const { code, expiresMinutes } = await issueOtp({ email, purpose: TWO_FA_PURPOSE });
        const { subject, html } = buildStaff2faEmail({ code, expiresMinutes, fullname: fullnameOf(user), ip: clientKey(req) });
        await sendMail({ to: email, subject, html });
    } catch (err) {
        // ขอรหัสถี่เกินไป (429) — บอกตรงๆ ไม่งั้นผู้ใช้ค้างอยู่หน้ากรอกรหัสโดยไม่รู้ว่าทำไมเมลไม่มา
        if (err.status) return res.status(err.status).json({ message: err.message });
        throw err;
    }
    const challenge_token = signJwt({ user_id: user.user_id, purpose: TWO_FA_PURPOSE }, CHALLENGE_TTL);
    res.json({ require_2fa: true, challenge_token, message: `ส่งรหัสยืนยันไปที่ ${email} แล้ว` });
}

// POST /auth/login/2fa { challenge_token, otp } → ได้ token จริง
async function verifyLogin2fa(req, res, next) {
    try {
        const { challenge_token, otp } = req.body ?? {};
        if (!challenge_token || !otp) return res.status(400).json({ message: "กรุณากรอกรหัสยืนยัน" });

        let payload;
        try {
            payload = verifyToken(challenge_token);
        } catch {
            return res.status(401).json({ message: "หมดเวลายืนยันแล้ว กรุณาเข้าสู่ระบบใหม่" });
        }
        if (payload.purpose !== TWO_FA_PURPOSE) return res.status(401).json({ message: "คำขอไม่ถูกต้อง" });

        const [rows] = await pool.query(
            "SELECT user_id, user_email, user_role_id, user_status, user_fname, user_lname FROM tb_users WHERE user_id = ?",
            [payload.user_id]
        );
        const user = rows[0];
        if (!user || user.user_status !== "active") return res.status(401).json({ message: "บัญชีนี้ใช้งานไม่ได้" });

        const otpId = await consumeOtp({ email: user.user_email, purpose: TWO_FA_PURPOSE, code: String(otp).trim() });
        await markOtpUsed(otpId);

        await pool.query("UPDATE tb_users SET user_last_login_at = NOW() WHERE user_id = ?", [user.user_id]);
        await writeLoginLog({ user_id: user.user_id, email: user.user_email, fullname: fullnameOf(user), action: "login", req });

        const jti = await createSession(user.user_id, { deviceInfo: req.headers["user-agent"], ip: clientKey(req) });
        res.json({ token: signToken({ user_id: user.user_id, user_role_id: user.user_role_id, jti }) });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ message: err.message });
        next(err);
    }
}

// PUT /auth/2fa { enabled, otp? } — เปิดต้องยืนยันด้วยรหัสที่ส่งไปอีเมลก่อน (พิสูจน์ว่าเข้าอีเมลได้จริง
// ไม่งั้นเปิดแล้วล็อกตัวเองออกจากระบบถาวร) · ปิดได้เลยเพราะคนที่กดปิดต้องล็อกอินอยู่แล้ว
async function setTwoFactor(req, res, next) {
    try {
        const enabled = !!req.body?.enabled;
        const [rows] = await pool.query(
            "SELECT user_id, user_email, user_fname, user_lname, user_2fa_enabled FROM tb_users WHERE user_id = ?",
            [req.user.user_id]
        );
        const user = rows[0];
        if (!user) return res.status(404).json({ message: "ไม่พบผู้ใช้งาน" });

        if (!enabled) {
            await pool.query("UPDATE tb_users SET user_2fa_enabled = FALSE WHERE user_id = ?", [user.user_id]);
            return res.json({ enabled: false, message: "ปิดการยืนยันสองชั้นแล้ว" });
        }

        const otp = req.body?.otp ? String(req.body.otp).trim() : null;
        if (!otp) {
            // ขั้นแรก: ส่งรหัสไปให้ก่อน แล้วให้เรียกซ้ำพร้อม otp
            try {
                const { code, expiresMinutes } = await issueOtp({ email: user.user_email, purpose: TWO_FA_PURPOSE });
                const { subject, html } = buildStaff2faEmail({ code, expiresMinutes, fullname: fullnameOf(user), ip: clientKey(req) });
                await sendMail({ to: user.user_email, subject, html });
            } catch (err) {
                if (err.status) return res.status(err.status).json({ message: err.message });
                throw err;
            }
            return res.json({ enabled: false, otp_sent: true, message: `ส่งรหัสยืนยันไปที่ ${user.user_email} แล้ว` });
        }

        const otpId = await consumeOtp({ email: user.user_email, purpose: TWO_FA_PURPOSE, code: otp });
        await markOtpUsed(otpId);
        await pool.query("UPDATE tb_users SET user_2fa_enabled = TRUE WHERE user_id = ?", [user.user_id]);
        res.json({ enabled: true, message: "เปิดการยืนยันสองชั้นแล้ว ครั้งต่อไปจะต้องกรอกรหัสจากอีเมลตอนเข้าสู่ระบบ" });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ message: err.message });
        next(err);
    }
}

async function logout(req, res, next) {
    try {
        const [rows] = await pool.query(
            "SELECT user_email, user_fname, user_lname FROM tb_users WHERE user_id = ?",
            [req.user.user_id]
        );
        const user = rows[0];
        await writeLoginLog({
            user_id: req.user.user_id,
            email: user?.user_email ?? "",
            fullname: user ? `${user.user_fname} ${user.user_lname}` : null,
            action: "logout",
            req,
        });
        // ลบ session ของอุปกรณ์นี้ — เดิม logout เขียนแค่ log ตัว token ยังใช้งานต่อได้จนหมดอายุ
        // (กดออกจากระบบบนเครื่องคนอื่นแล้วไม่ได้ตัดสิทธิ์จริง ซึ่งขัดกับสิ่งที่ผู้ใช้เข้าใจ)
        await revokeSessionByJti(req.user.jti);
        res.json({ message: "ออกจากระบบสำเร็จ" });
    } catch (err) {
        next(err);
    }
}

async function verifyPermission(req, res, next) {
    try {
        const user_role_id = req.query.user_role_id;
        const [rows] = await pool.query(
            "SELECT role_permission FROM tb_roles WHERE role_id = ?",
            [user_role_id]
        );
        if (!rows[0]) return res.status(404).json({ message: "ไม่พบสิทธิ์นี้" });

        res.json({ role_permission: rows[0].role_permission });
    } catch (err) {
        next(err);
    }
}

/* ─────────────────── ลืมรหัสผ่านของผู้ใช้งานระบบหลังบ้าน (2026-09-20) ───────────────────
 * ส่ง **รหัส OTP 6 หลัก** ทางอีเมล (ผู้ใช้สั่งให้เป็นแบบนี้) ต่างจากฝั่งลูกค้าที่ส่งลิงก์ที่มี token
 * ยังอยู่ในกฎข้อ 7 ของ CLAUDE.md เพราะสิ่งที่ส่งไปคือรหัสยืนยันชั่วคราว **ไม่ใช่รหัสผ่าน**
 * กติกา OTP (อายุ 10 นาที / ขอได้ 5 ครั้งต่อชั่วโมงต่ออีเมล / กรอกผิดได้ 5 ครั้ง / ใช้ได้ครั้งเดียว)
 * อยู่ที่ utils/emailOtp.js ที่เดียว ใช้ร่วมกับ OTP ตอนสมัครสมาชิกของลูกค้า
 */

const fullnameOf = (user) => `${user.user_fname} ${user.user_lname}`.trim();

async function forgotPassword(req, res, next) {
    try {
        const email = String(req.body?.user_email ?? "").trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({ message: "รูปแบบอีเมลไม่ถูกต้อง" });
        }

        const [rows] = await pool.query(
            "SELECT user_id, user_fname, user_lname, user_status FROM tb_users WHERE user_email = ?",
            [email]
        );
        const user = rows[0];
        // บัญชีที่ถูกปิดใช้งานก็ไม่ส่งรหัสให้ — คนที่ถูกปลดออกแล้วไม่ควรตั้งรหัสใหม่กลับเข้ามาได้เอง
        if (!user || user.user_status !== "active") return res.json({ message: SAME_ANSWER });

        const { code, expiresMinutes } = await issueOtp({ email, purpose: OTP_PURPOSE });
        const { subject, html } = buildStaffResetOtpEmail({ code, expiresMinutes, fullname: fullnameOf(user) });
        await sendMail({ to: email, subject, html });
        await writeLoginLog({ user_id: user.user_id, email, fullname: fullnameOf(user), action: "reset_requested", req });

        res.json({ message: SAME_ANSWER });
    } catch (err) {
        // 429 (ขอรหัสถี่เกินไป) ต้องบอกตรงๆ ไม่งั้นผู้ใช้กดขอแล้วเงียบ ไม่รู้ว่าทำไมเมลไม่มา
        if (err.status) return res.status(err.status).json({ message: err.message });
        next(err);
    }
}

async function resetPassword(req, res, next) {
    try {
        const email = String(req.body?.user_email ?? "").trim();
        const otp = String(req.body?.otp ?? "").trim();
        const newPassword = String(req.body?.new_password ?? "");

        if (!email || !otp) return res.status(400).json({ message: "กรุณากรอกอีเมลและรหัสยืนยัน" });
        if (newPassword.length < 8) return res.status(400).json({ message: "รหัสผ่านใหม่ต้องมีอย่างน้อย 8 ตัวอักษร" });

        const [rows] = await pool.query(
            "SELECT user_id, user_fname, user_lname, user_status FROM tb_users WHERE user_email = ?",
            [email]
        );
        const user = rows[0];
        // ตรงนี้บอกได้ว่าไม่พบบัญชี เพราะกว่าจะมาถึงขั้นนี้ต้องถือรหัสที่ส่งไปอีเมลนั้นอยู่แล้ว
        if (!user || user.user_status !== "active") {
            return res.status(400).json({ message: "ไม่พบบัญชีผู้ใช้งานของอีเมลนี้" });
        }

        const otpId = await consumeOtp({ email, purpose: OTP_PURPOSE, code: otp });

        const passwordHash = await bcrypt.hash(newPassword, 10);
        // user_must_change_password = FALSE เพราะเจ้าตัวเพิ่งตั้งรหัสเอง ไม่ใช่รหัสชั่วคราวที่แอดมิน gen ให้
        await pool.query(
            "UPDATE tb_users SET user_password = ?, user_must_change_password = FALSE WHERE user_id = ?",
            [passwordHash, user.user_id]
        );
        // เตะทุกอุปกรณ์ที่ล็อกอินค้างอยู่ — เหตุผลที่ต้องรีเซ็ตรหัสมักคือสงสัยว่าบัญชีถูกคนอื่นเข้าถึง
        // ถ้าไม่เตะออก การตั้งรหัสใหม่จะไม่ได้ตัดคนร้ายออกจริง เพราะ token ใบเดิมยังใช้ได้อีกถึง 30 วัน
        await revokeAllSessions(user.user_id);
        // ตัดรหัสทิ้งหลังตั้งรหัสผ่านสำเร็จแล้วเท่านั้น (ถ้าตัดก่อนแล้วขั้นตอนหลังล้ม ผู้ใช้ต้องขอรหัสใหม่ทั้งที่กรอกถูก)
        await markOtpUsed(otpId);
        await writeLoginLog({ user_id: user.user_id, email, fullname: fullnameOf(user), action: "reset_password", req });

        // ไม่ล็อกอินให้อัตโนมัติ — ให้กลับไปเข้าสู่ระบบด้วยรหัสใหม่เอง (กติกาเดียวกับฝั่งลูกค้า)
        res.json({ message: "ตั้งรหัสผ่านใหม่สำเร็จ กรุณาเข้าสู่ระบบด้วยรหัสผ่านใหม่" });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ message: err.message });
        next(err);
    }
}

module.exports = { login, logout, verifyPermission, forgotPassword, resetPassword, verifyLogin2fa, setTwoFactor };
