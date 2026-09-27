const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const sharp = require("sharp");

// ที่เก็บภาพกระดาษคำตอบที่สแกนส่งตรวจ (ระบบสอบกระดาษ เฟส 2 — CLAUDE.md ข้อ 6.9)
//
// อยู่ใน backend/private/ ไม่ใช่ uploads/ โดยตั้งใจ — uploads/ ถูกเสิร์ฟ static (ใครมี URL ก็เปิดได้) แต่ภาพนี้มี
// ชื่อ-นามสกุลที่ลูกค้าเขียนไว้บนกระดาษ ต้องเปิดผ่าน endpoint ที่เช็คเจ้าของเท่านั้น · โฟลเดอร์อยู่ใน .gitignore
// deploy แบบ git pull จึงไม่ทับไฟล์บนเซิร์ฟเวอร์
const SCAN_DIR = path.join(__dirname, "..", "..", "private", "paper-scans");
const RETENTION_DAYS = 90;
// ภาพที่ดึงตรงแล้วจากหน้าเว็บกว้าง 1050px (5 px/มม.) — เพดานนี้กันคนยิงรูปใหญ่ผิดปกติเข้ามาเก็บ
const MAX_WIDTH = 1200;

/** แปลงภาพที่ได้รับเป็น webp ขาวดำขนาดคงที่ แล้วเขียนลงดิสก์ — คืนชื่อไฟล์ (ไม่มี path) */
async function saveScanImage(buffer, formId, page) {
    // re-encode ทุกไฟล์ด้วย sharp — ไฟล์ที่ไม่ใช่ภาพจริง throw ตรงนี้ (ผู้เรียกตอบ 400) และ metadata แปลกปลอมถูกทิ้ง
    const webp = await sharp(buffer)
        .resize({ width: MAX_WIDTH, withoutEnlargement: true })
        .grayscale()
        .webp({ quality: 60 })
        .toBuffer();
    await fs.mkdir(SCAN_DIR, { recursive: true });
    const name = `${formId}-p${page}-${crypto.randomBytes(6).toString("hex")}.webp`;
    await fs.writeFile(path.join(SCAN_DIR, name), webp);
    return name;
}

/** path เต็มของไฟล์ — ใช้ basename กันชื่อไฟล์ในฐานข้อมูลพาออกนอกโฟลเดอร์ (../) */
function scanPath(name) {
    return path.join(SCAN_DIR, path.basename(String(name)));
}

/** ลบไฟล์ — ไฟล์ที่ไม่มีอยู่แล้วถือว่าสำเร็จ (ลบซ้ำ/ถูก sweep ไปก่อน) */
async function deleteScanFiles(names) {
    await Promise.all(names.map((n) => fs.unlink(scanPath(n)).catch((err) => {
        if (err.code !== "ENOENT") console.error("[paper-scan] ลบไฟล์ไม่สำเร็จ:", path.basename(String(n)), err.message);
    })));
}

module.exports = { SCAN_DIR, RETENTION_DAYS, saveScanImage, scanPath, deleteScanFiles };
