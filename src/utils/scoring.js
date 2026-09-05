const pool = require("../config/db");

// ระบบคะแนน — เปิด/ปิดได้รายชุดข้อสอบ
//
// tb_products.prod_total_score เป็น NULL แปลว่า "ชุดนี้ไม่ใช้ระบบคะแนน" ผลสอบจะคิดเป็น % จากจำนวนข้อถูก
// เหมือนเดิมทุกประการ (พฤติกรรมดั้งเดิมของระบบ) ส่วนชุดที่ตั้งคะแนนเต็มไว้จะคิดจากคะแนนรายข้อแทน
//
// กติกาเดียวที่บังคับคือ **ผลรวมคะแนนของข้อที่ active ต้องไม่เกินคะแนนเต็ม** (น้อยกว่าได้ ไม่บังคับให้เท่ากัน
// เพราะแอดมินยังทยอยเพิ่มข้อไม่ครบ) — นับเฉพาะข้อ active เพราะข้อ inactive ไม่ถูกดึงเข้าข้อสอบอยู่แล้ว
//
// ต้องเช็คที่ backend เสมอ ไม่ใช่แค่หน้าเว็บ เพราะถ้าเช็คแค่ฝั่ง frontend ใครยิง API ตรงก็ข้ามได้หมด
// (หลักการเดียวกับ OTP ตอนสมัครสมาชิก) และต้องเช็คครบ 4 ทาง: สร้างคำถาม / แก้คำถาม / นำเข้าไฟล์ /
// **ลดคะแนนเต็มของชุดลงจนต่ำกว่าผลรวมที่มีอยู่แล้ว** — ทางที่ 4 เป็นทางที่มักถูกลืม

const MAX_TOTAL_SCORE = 10000;
const MAX_QUESTION_SCORE = 1000;

const isBlank = (v) => v === undefined || v === null || v === "";

// ตัวเลขคะแนนต้องเป็นทศนิยมไม่เกิน 2 ตำแหน่ง ให้ตรงกับ DECIMAL(x,2) ใน DB — ถ้าปล่อยให้ส่ง 0.005 เข้ามา
// MySQL จะปัดเก็บเงียบๆ แล้วผลรวมที่คำนวณตอน validate กับที่เก็บจริงจะไม่ตรงกัน
const hasTooManyDecimals = (value) => Math.round(value * 100) !== value * 100;

/** คะแนนเต็มของชุดข้อสอบ — ไม่บังคับ ว่าง = ไม่ใช้ระบบคะแนน */
function validateTotalScore(value) {
    if (isBlank(value)) return null;
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) return "คะแนนเต็มต้องเป็นตัวเลขมากกว่า 0 (เว้นว่างถ้าไม่ใช้ระบบคะแนน)";
    if (num > MAX_TOTAL_SCORE) return `คะแนนเต็มต้องไม่เกิน ${MAX_TOTAL_SCORE}`;
    if (hasTooManyDecimals(num)) return "คะแนนเต็มมีทศนิยมได้ไม่เกิน 2 ตำแหน่ง";
    return null;
}

/** คะแนนรายข้อ — ไม่ส่งมา = 1 คะแนน (ค่า default เดียวกับที่ตั้งไว้ระดับ DB) */
function validateQuestionScore(value) {
    if (isBlank(value)) return null;
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) return "คะแนนของข้อต้องเป็นตัวเลขมากกว่า 0";
    if (num > MAX_QUESTION_SCORE) return `คะแนนของข้อต้องไม่เกิน ${MAX_QUESTION_SCORE}`;
    if (hasTooManyDecimals(num)) return "คะแนนของข้อมีทศนิยมได้ไม่เกิน 2 ตำแหน่ง";
    return null;
}

const normalizeTotalScore = (value) => (isBlank(value) ? null : Number(value));
const normalizeQuestionScore = (value) => (isBlank(value) ? 1 : Number(value));

/**
 * ผลรวมคะแนนของข้อ active ในชุดข้อสอบ
 * @param {string[]} excludeQuestionIds ข้อที่กำลังแก้อยู่ (จะเอาค่าใหม่ไปแทน จึงไม่ควรนับของเดิมซ้ำ)
 */
async function sumActiveQuestionScore(productId, { conn = pool, excludeQuestionIds = [] } = {}) {
    const params = [productId];
    let sql = "SELECT COALESCE(SUM(ques_score), 0) AS used FROM tb_questions WHERE ques_product_id = ? AND ques_status = 'active'";
    if (excludeQuestionIds.length > 0) {
        sql += " AND ques_id NOT IN (?)";
        params.push(excludeQuestionIds);
    }
    const [[row]] = await conn.query(sql, params);
    return Number(row.used);
}

/**
 * เช็คว่าคะแนนที่กำลังจะเพิ่มเข้าไปทำให้ผลรวมเกินคะแนนเต็มไหม
 * คืน error message (ภาษาไทย พร้อมตัวเลขให้แอดมินรู้ว่าเหลือเท่าไร) หรือ null ถ้าผ่าน
 *
 * totalScore: ส่งมาเองได้ตอนแอดมินกำลังแก้คะแนนเต็ม (ยังไม่ถูกบันทึกลง DB) ถ้าไม่ส่งจะอ่านจาก DB
 */
async function checkScoreBudget({ productId, conn = pool, addScore = 0, excludeQuestionIds = [], totalScore }) {
    let limit = totalScore;
    if (limit === undefined) {
        const [[product]] = await conn.query("SELECT prod_total_score FROM tb_products WHERE prod_id = ?", [productId]);
        limit = product ? product.prod_total_score : null;
    }
    if (limit === null || limit === undefined) return null; // ชุดนี้ไม่ใช้ระบบคะแนน ไม่ต้องเช็คอะไร

    const limitNum = Number(limit);
    const used = await sumActiveQuestionScore(productId, { conn, excludeQuestionIds });
    // ปัดที่ 2 ตำแหน่งก่อนเทียบ กันเศษทศนิยมของ floating point ทำให้ 100.00 ถูกมองว่าเกิน 100
    const totalAfter = Math.round((used + Number(addScore)) * 100) / 100;
    if (totalAfter > limitNum) {
        const remaining = Math.round((limitNum - used) * 100) / 100;
        return `คะแนนรวมทุกข้อจะเกินคะแนนเต็มของชุดข้อสอบ (เต็ม ${limitNum} คะแนน ใช้ไปแล้ว ${used} เหลือ ${remaining})`;
    }
    return null;
}

module.exports = {
    MAX_TOTAL_SCORE,
    MAX_QUESTION_SCORE,
    validateTotalScore,
    validateQuestionScore,
    normalizeTotalScore,
    normalizeQuestionScore,
    sumActiveQuestionScore,
    checkScoreBudget,
};
