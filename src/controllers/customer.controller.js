const bcrypt = require("bcryptjs");
const sharp = require("sharp");
const fs = require("fs/promises");
const path = require("path");
const pool = require("../config/db");
const { generateId } = require("../utils/generateId");
const { generateTempPassword } = require("../utils/generatePassword");
const { AVATAR_DIR, resolveUploadPath } = require("../utils/uploads");

async function getAll(req, res, next) {
    try {
        const limit = Number(req.query.limit) || 10;
        const offset = Number(req.query.offset) || 0;
        const search = `%${req.query.search ?? ""}%`;

        const [rows] = await pool.query(
            `SELECT cus_id, cus_username,
                    CASE WHEN cus_fname IS NOT NULL THEN CONCAT(cus_fname, ' ', cus_lname) ELSE NULL END AS cus_fullname,
                    cus_email, cus_phone, cus_status, cus_must_change_password,
                    cus_created_at, cus_updated_at
             FROM tb_customers
             WHERE cus_username LIKE ? OR cus_fname LIKE ? OR cus_lname LIKE ? OR cus_email LIKE ?
             ORDER BY cus_id DESC
             LIMIT ? OFFSET ?`,
            [search, search, search, search, limit, offset]
        );
        const [[{ total }]] = await pool.query(
            `SELECT COUNT(*) AS total FROM tb_customers
             WHERE cus_username LIKE ? OR cus_fname LIKE ? OR cus_lname LIKE ? OR cus_email LIKE ?`,
            [search, search, search, search]
        );

        res.json({ data: rows, total });
    } catch (err) {
        next(err);
    }
}

async function getOne(req, res, next) {
    try {
        const [rows] = await pool.query(
            `SELECT cus_id, cus_username, cus_fname, cus_lname, cus_email, cus_phone,
                    cus_avatar_url, cus_status, cus_must_change_password, cus_created_at, cus_updated_at
             FROM tb_customers WHERE cus_id = ?`,
            [req.params.id]
        );
        if (!rows[0]) return res.status(404).json({ message: "ไม่พบลูกค้า" });
        res.json(rows[0]);
    } catch (err) {
        next(err);
    }
}

// สร้างลูกค้าแบบกดปุ่มเดียว — ไม่บังคับกรอกอะไรเลย (ช่องทางขายผ่านแชทเพจไม่อยากเก็บข้อมูลลูกค้าตอนขาย)
// ได้ username (= cus_id ไปก่อน แก้เป็นชื่ออื่นทีหลังได้ที่หน้าแก้ไข) + รหัสผ่านชั่วคราวทันที เหมือน tb_users
// ข้อมูลส่วนตัว (ชื่อ/อีเมล) ให้ลูกค้ากรอกเองทีหลัง หรือแอดมินเติมทีหลังผ่านหน้าแก้ไขก็ได้
async function create(req, res, next) {
    try {
        const { cus_fname, cus_lname, cus_email, cus_phone } = req.body ?? {};

        const cus_id = await generateId("tb_customers", "CUS");
        const temp_password = generateTempPassword();
        const passwordHash = await bcrypt.hash(temp_password, 10);

        await pool.query(
            `INSERT INTO tb_customers
                (cus_id, cus_username, cus_email, cus_password, cus_fname, cus_lname, cus_phone)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [cus_id, cus_id, cus_email || null, passwordHash, cus_fname || null, cus_lname || null, cus_phone || null]
        );

        res.status(201).json({ cus_id, cus_username: cus_id, temp_password });
    } catch (err) {
        if (err.code === "ER_DUP_ENTRY") {
            return res.status(409).json({ message: "อีเมลนี้ถูกใช้งานแล้ว" });
        }
        next(err);
    }
}

async function update(req, res, next) {
    try {
        const { cus_username, cus_fname, cus_lname, cus_email, cus_phone, cus_status } = req.body;
        if (!cus_username || !cus_username.trim()) {
            return res.status(400).json({ message: "กรุณากรอก Username" });
        }

        await pool.query(
            `UPDATE tb_customers SET
                cus_username = ?, cus_fname = ?, cus_lname = ?, cus_email = ?, cus_phone = ?, cus_status = ?
             WHERE cus_id = ?`,
            [
                cus_username.trim(), cus_fname || null, cus_lname || null, cus_email || null, cus_phone || null,
                cus_status === "inactive" ? "inactive" : "active",
                req.params.id,
            ]
        );

        res.json({ message: "แก้ไขข้อมูลลูกค้าสำเร็จ" });
    } catch (err) {
        if (err.code === "ER_DUP_ENTRY") {
            return res.status(409).json({ message: "Username หรืออีเมลนี้ถูกใช้งานแล้ว" });
        }
        next(err);
    }
}

async function remove(req, res, next) {
    try {
        const [rows] = await pool.query("SELECT cus_avatar_url FROM tb_customers WHERE cus_id = ?", [
            req.params.id,
        ]);

        await pool.query("DELETE FROM tb_customers WHERE cus_id = ?", [req.params.id]);

        // ลบไฟล์รูปโปรไฟล์ทิ้งด้วย ไม่ให้ค้างอยู่ใน uploads/ เปล่าๆ หลังลบลูกค้า
        if (rows[0]?.cus_avatar_url) {
            await fs.unlink(resolveUploadPath(rows[0].cus_avatar_url)).catch(() => {});
        }

        res.status(204).end();
    } catch (err) {
        if (err.code === "ER_ROW_IS_REFERENCED_2" || err.code === "ER_ROW_IS_REFERENCED") {
            return res.status(409).json({ message: "ไม่สามารถลบลูกค้านี้ได้ เพราะมีสิทธิ์การเข้าถึงหรือประวัติการทำข้อสอบผูกอยู่" });
        }
        next(err);
    }
}

// รีเซ็ตรหัสผ่านชั่วคราวให้ลูกค้า — เหมือน user.controller.resetPassword ทุกประการ
async function resetPassword(req, res, next) {
    try {
        const temp_password = generateTempPassword();
        const passwordHash = await bcrypt.hash(temp_password, 10);

        const [result] = await pool.query(
            "UPDATE tb_customers SET cus_password = ?, cus_must_change_password = TRUE WHERE cus_id = ?",
            [passwordHash, req.params.id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ message: "ไม่พบลูกค้า" });

        res.json({ temp_password });
    } catch (err) {
        next(err);
    }
}

// เหมือน saveAvatarForUser ใน user.controller.js ทุกประการ — resize + บีบเป็น webp คุณภาพต่ำสุดที่ยังใช้
// เป็นรูปโปรไฟล์ได้ ให้ไฟล์เล็กที่สุด แล้วลบไฟล์เก่าทิ้งกันค้างใน uploads/ เปล่าๆ
async function saveAvatarForCustomer(customerId, file) {
    const [rows] = await pool.query("SELECT cus_avatar_url FROM tb_customers WHERE cus_id = ?", [
        customerId,
    ]);
    if (!rows[0]) {
        const err = new Error("ไม่พบลูกค้า");
        err.status = 404;
        throw err;
    }
    const oldAvatarUrl = rows[0].cus_avatar_url;

    await fs.mkdir(AVATAR_DIR, { recursive: true });

    const filename = `${Date.now()}-${Math.round(Math.random() * 1e9)}.webp`;
    await sharp(file.buffer)
        .resize(256, 256, { fit: "cover" })
        .webp({ quality: 70 })
        .toFile(path.join(AVATAR_DIR, filename));

    const cus_avatar_url = `/uploads/avatars/${filename}`;
    await pool.query("UPDATE tb_customers SET cus_avatar_url = ? WHERE cus_id = ?", [
        cus_avatar_url,
        customerId,
    ]);

    if (oldAvatarUrl) {
        await fs.unlink(resolveUploadPath(oldAvatarUrl)).catch(() => {});
    }

    return cus_avatar_url;
}

async function uploadImage(req, res, next) {
    try {
        if (!req.file) return res.status(400).json({ message: "ไม่พบไฟล์รูปภาพ" });
        const cus_avatar_url = await saveAvatarForCustomer(req.params.id, req.file);
        res.json({ cus_avatar_url });
    } catch (err) {
        next(err);
    }
}

module.exports = { getAll, getOne, create, update, remove, resetPassword, uploadImage, saveAvatarForCustomer };
