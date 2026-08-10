const path = require("path");

const UPLOADS_DIR = path.join(__dirname, "..", "..", "uploads");
// avatar ของ staff (tb_users) และลูกค้า (tb_customers) ใช้ folder ร่วมกัน เพราะแยก subfolder
// ตามประเภทไฟล์ ไม่ใช่ตาม entity — ทั้งคู่เป็นรูปโปรไฟล์แบบเดียวกัน (256x256 webp)
const AVATAR_DIR = path.join(UPLOADS_DIR, "avatars");

// คืน path ไฟล์จริงบน disk จาก url ที่เก็บใน DB เช่น "/uploads/avatars/xxx.webp" -> "<root>/uploads/avatars/xxx.webp"
// ต้องใช้ตัวนี้แทน path.basename(url) เฉยๆ ตอนจะลบไฟล์เก่าทิ้ง เพราะ url มี subfolder (avatars/, products/) ติดมาด้วย
// กัน path traversal ไว้ที่จุดเดียวนี้เผื่อมี url ที่หลุดรอดมาจากภายนอกโดยไม่ผ่าน validation ก่อน (เช่น
// "/uploads/../../.env") — ถ้า resolve แล้วไม่อยู่ใต้ UPLOADS_DIR จริงๆ ให้โยน error แทนที่จะคืน path นอกโฟลเดอร์
function resolveUploadPath(url) {
    const resolved = path.join(UPLOADS_DIR, url.replace(/^\/uploads\//, ""));
    if (resolved !== UPLOADS_DIR && !resolved.startsWith(UPLOADS_DIR + path.sep)) {
        throw new Error("ตำแหน่งไฟล์ไม่ถูกต้อง");
    }
    return resolved;
}

module.exports = { UPLOADS_DIR, AVATAR_DIR, resolveUploadPath };
