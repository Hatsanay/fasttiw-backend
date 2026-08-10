const bcrypt = require("bcryptjs");
const pool = require("../config/db");
const { generateId } = require("../utils/generateId");
const { signToken } = require("../utils/jwt");
const { saveAvatarForCustomer } = require("./customer.controller");
const { createSession, listSessions, revokeSession, revokeSessionByJti } = require("../utils/customerSession");

// สมัครสมาชิกเอง (ต่างจาก customer.controller.js create() ที่แอดมินกดสร้างให้ทางแชท) —
// ลูกค้าตั้งรหัสผ่านเองตั้งแต่แรก จึงไม่ต้อง cus_must_change_password = TRUE เหมือนฝั่งแอดมินสร้างให้
async function register(req, res, next) {
    try {
        const { cus_username, cus_email, cus_password, cus_fname, cus_lname, cus_phone, pdpa_consent } = req.body ?? {};

        if (!cus_username || !cus_email || !cus_password) {
            return res.status(400).json({ message: "กรุณากรอกชื่อผู้ใช้ อีเมล และรหัสผ่าน" });
        }
        if (cus_password.length < 8) {
            return res.status(400).json({ message: "รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร" });
        }
        if (!pdpa_consent) {
            return res.status(400).json({ message: "กรุณายอมรับนโยบายความเป็นส่วนตัวก่อนสมัครสมาชิก" });
        }

        const cus_id = await generateId("tb_customers", "CUS");
        const passwordHash = await bcrypt.hash(cus_password, 10);

        await pool.query(
            `INSERT INTO tb_customers
                (cus_id, cus_username, cus_email, cus_password, cus_fname, cus_lname, cus_phone,
                 cus_must_change_password, cus_pdpa_consented_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, FALSE, NOW())`,
            [cus_id, cus_username, cus_email, passwordHash, cus_fname || null, cus_lname || null, cus_phone || null]
        );

        // สมัครเองไม่ต้องผ่านขั้นตอนเปลี่ยนรหัส/เติมข้อมูลบังคับ (mcp = false ตั้งแต่แรก)
        const jti = await createSession(cus_id, req.headers["user-agent"]);
        const token = signToken({ cus_id, mcp: false, jti });
        res.status(201).json({ token });
    } catch (err) {
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
            return res.status(401).json({ message: "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง" });
        }

        const passwordOk = await bcrypt.compare(cus_password, customer.cus_password);
        if (!passwordOk) {
            return res.status(401).json({ message: "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง" });
        }

        await pool.query("UPDATE tb_customers SET cus_last_login_at = NOW() WHERE cus_id = ?", [customer.cus_id]);

        // mcp (must_change_password) ฝังไว้ใน token เลย — ฝั่ง frontend อ่านได้โดยไม่ต้องยิง API
        // เพิ่ม (ตาม pattern optimistic check เดียวกับที่ proxy.ts ใช้) พอทำ onboarding เสร็จค่อยออก
        // token ใหม่ให้ (ดู completeOnboarding ด้านล่าง)
        // login ใหม่แต่ละครั้ง = อุปกรณ์ใหม่ 1 slot (จำกัดพร้อมกันได้ 2 เครื่อง เกินโควตาเตะเครื่องเก่าสุดออก)
        const jti = await createSession(customer.cus_id, req.headers["user-agent"]);
        const token = signToken({ cus_id: customer.cus_id, mcp: !!customer.cus_must_change_password, jti });
        res.json({ token });
    } catch (err) {
        next(err);
    }
}

async function getMe(req, res, next) {
    try {
        const [rows] = await pool.query(
            `SELECT cus_id, cus_username, cus_fname, cus_lname, cus_email, cus_phone,
                    cus_avatar_url, cus_must_change_password
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
        res.json({ message: "ออกจากระบบอุปกรณ์นั้นแล้ว" });
    } catch (err) {
        next(err);
    }
}

// ลบ session ของอุปกรณ์ปัจจุบันออกจาก DB จริงตอนกด logout — เดิมฝั่ง frontend มีแค่ clear cookie ฝั่ง
// ตัวเองเฉยๆ ไม่เคยบอก backend เลย ทำให้ session แถวนี้ยัง "active" ค้างอยู่ต่อไปจนกว่าจะโดน FIFO evict
// เอง (ตอนล็อกอินอุปกรณ์ที่ 3) ขัดกับจุดประสงค์ของฟีเจอร์จำกัด 2 อุปกรณ์ที่ควรว่างทันทีที่ logout จริง
async function logout(req, res, next) {
    try {
        await revokeSessionByJti(req.customer.cus_id, req.customer.jti);
        res.json({ message: "ออกจากระบบสำเร็จ" });
    } catch (err) {
        next(err);
    }
}

module.exports = {
    register, login, getMe, completeOnboarding, updateMyProfile, changeMyPassword, uploadMyImage,
    getMySessions, deleteMySession, logout,
};
