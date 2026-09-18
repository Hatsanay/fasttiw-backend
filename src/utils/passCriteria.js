// เกณฑ์ผ่าน — ที่เดียวของทั้งระบบ (2026-09-18)
//
// ใช้ร่วมกัน 3 ที่: เกณฑ์ของชุดข้อสอบ (tb_products), เกณฑ์รายวิชาของชุด (tb_product_topic_pass_criteria)
// และสนามสอบเสมือน (tb_mock_exams / tb_mock_exam_sections) — กติกาต้องเหมือนกันเป๊ะทุกที่ ถ้าแยกกันเขียน
// วันไหนแก้ที่เดียว ลูกค้าจะเจอ "ผ่าน" ในหน้าหนึ่งแต่ "ไม่ผ่าน" ในอีกหน้าด้วยตัวเลขชุดเดียวกัน
//
// กำหนดได้ 2 แบบ ใส่อย่างใดอย่างหนึ่ง:
//   percent = % จำนวนเต็ม 1-100
//   min     = ขั้นต่ำ — "จำนวนข้อ" (จำนวนเต็ม) ถ้าไม่ใช้ระบบคะแนน / "คะแนน" (ทศนิยม 2 ตำแหน่ง) ถ้าใช้
//             สนามสอบหลายแห่งประกาศเกณฑ์เป็นจำนวนข้อ แปลงเป็น % เองแล้วปัดเศษเพี้ยนได้

const isBlank = (v) => v === undefined || v === null || v === "";
const normalizePassValue = (v) => (isBlank(v) ? null : Number(v));
const MAX_PASS_MIN = 99999.99;

function validatePassPercent(value) {
    if (isBlank(value)) return null;
    const num = Number(value);
    if (!Number.isInteger(num) || num < 1 || num > 100) return "แบบ % ต้องเป็นจำนวนเต็ม 1-100 หรือเว้นว่างถ้าไม่ตั้งเกณฑ์";
    return null;
}

// คืน error message หรือ null — label บอกว่าเกณฑ์ไหนผิด ("เกณฑ์ผ่านรวม" / "เกณฑ์ผ่านรายวิชา")
function validatePassCriterion({ percent, min }, scored, label) {
    if (!isBlank(percent) && !isBlank(min)) return `${label}: เลือกกำหนดเป็น % หรือขั้นต่ำอย่างใดอย่างหนึ่ง`;
    const percentError = validatePassPercent(percent);
    if (percentError) return `${label}: ${percentError}`;
    if (isBlank(min)) return null;
    const num = Number(min);
    if (!Number.isFinite(num) || num <= 0 || num > MAX_PASS_MIN) return `${label}: ขั้นต่ำต้องมากกว่า 0`;
    if (!scored && !Number.isInteger(num)) return `${label}: จำนวนข้อขั้นต่ำต้องเป็นจำนวนเต็ม`;
    if (scored && Math.abs(Math.round(num * 100) - num * 100) > 1e-6) return `${label}: คะแนนขั้นต่ำมีทศนิยมได้ไม่เกิน 2 ตำแหน่ง`;
    return null;
}

// แถวใน DB (สองคอลัมน์) → เกณฑ์ที่เอาไปตัดสินได้ · null = ไม่ได้ตั้งเกณฑ์
const toCriterion = (percent, min) =>
    percent != null ? { percent: Number(percent) } : min != null ? { min: Number(min) } : null;

// ตัดสินว่าผ่านไหม — unit "points" (ชุดที่ใช้ระบบคะแนน) หรือ "questions"
// pass_percent ที่คืนไปคือ **ตำแหน่งเส้นเกณฑ์บนแถบ (0-100)** ไม่ใช่ข้อความที่ต้องเอาไปโชว์เมื่อ mode = "min"
// ใบที่มีข้อน้อยกว่าขั้นต่ำ (แอดมินลดข้อทีหลัง) ต้องการ = ขั้นต่ำเดิม ไม่ตัดลง — ผ่านไม่ได้ ตรงกับเกณฑ์ที่ประกาศไว้
function judgeAgainstPass(criterion, unit, have, outOf) {
    const round2 = (n) => Math.round(n * 100) / 100;
    let required;
    if (criterion.min != null) {
        required = unit === "points" ? round2(criterion.min) : Math.ceil(criterion.min - 1e-9);
    } else if (unit === "points") {
        required = round2((criterion.percent / 100) * outOf);
    } else {
        required = Math.ceil((criterion.percent / 100) * outOf - 1e-9); // 60% ของ 15 ข้อ = 9 ข้อ, ของ 16 ข้อ = 10 ข้อ (ปัดขึ้น)
    }
    const passed = unit === "points" ? have + 1e-9 >= required : have >= required;
    return {
        mode: criterion.min != null ? "min" : "percent",
        pass_percent: criterion.min != null
            ? (outOf > 0 ? Math.min(100, Math.round((required / outOf) * 1000) / 10) : 100)
            : criterion.percent,
        passed,
        unit,
        required,
        have: round2(have),
        out_of: round2(outOf),
        gap: passed ? 0 : round2(required - have),
    };
}

module.exports = { isBlank, normalizePassValue, validatePassPercent, validatePassCriterion, toCriterion, judgeAgainstPass };
