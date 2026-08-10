const pool = require("../config/db");

function getDateYYYYMMDD() {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    return `${yyyy}${mm}${dd}`;
}

// รูปแบบ id: PREFIX + yyyymmdd + running 7 หลัก เช่น ROL202607170000002 (prefix 3 ตัว รวมเป็น 18 ตัวพอดี)
// running รีเซ็ตใหม่ทุกวัน โดยเทียบ date ของ max_id แถวล่าสุดใน tb_maxID กับวันนี้
// ล็อกแถวด้วย FOR UPDATE ในทรานแซกชันเดียวกัน กันสอง request ชนกันได้ id ซ้ำ (รวมถึงตอนรีเซ็ตข้ามวันด้วย)
//
// จองเป็น "ชุด" (count ไอดีรวด) แทนที่จะ query ทีละอันต่อ round-trip — ตอน import/สร้างพร้อมกันหลายร้อย
// แถว (เช่น คำถาม+ตัวเลือกจาก CSV) ถ้าเรียกทีละ 1 จะเสีย connection+transaction overhead คูณ N รอบ
// ช้ามาก (วัดจริง 500 คำถาม ~2000 ไอดี ใช้เวลา 36 วิ) จองเป็นชุดเดียวจบใน 1 round-trip แล้วคำนวณเลขรันต่อฝั่ง JS แทน
async function generateIds(maxTable, prefix, count) {
    const date = getDateYYYYMMDD();
    const conn = await pool.getConnection();

    try {
        await conn.beginTransaction();

        const [rows] = await conn.query(
            "SELECT max_id FROM tb_maxID WHERE max_table = ? FOR UPDATE",
            [maxTable]
        );

        const lastId = rows[0]?.max_id;
        const lastDate = lastId?.slice(prefix.length, prefix.length + 8);
        const startRunning = lastDate === date
            ? parseInt(lastId.slice(prefix.length + 8), 10) + 1
            : 1;

        const ids = Array.from({ length: count }, (_, i) =>
            prefix + date + String(startRunning + i).padStart(7, "0")
        );

        await conn.query(
            `INSERT INTO tb_maxID (max_table, max_id) VALUES (?, ?)
             ON DUPLICATE KEY UPDATE max_id = VALUES(max_id)`,
            [maxTable, ids[ids.length - 1]]
        );

        await conn.commit();
        return ids;
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

async function generateId(maxTable, prefix) {
    const [id] = await generateIds(maxTable, prefix, 1);
    return id;
}

module.exports = { generateId, generateIds };
