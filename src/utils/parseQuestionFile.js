const ExcelJS = require("exceljs");
const { Readable } = require("stream");

const MAX_CHOICES = 6;
const CHOICE_COLUMNS = Array.from({ length: MAX_CHOICES }, (_, i) => `ตัวเลือก${i + 1}`);
const WRONG_REASON_COLUMNS = Array.from({ length: MAX_CHOICES }, (_, i) => `เหตุผลผิด${i + 1}`);
const QUESTION_IMAGE_COLUMN = "รูปคำถาม";
const CHOICE_IMAGE_COLUMNS = Array.from({ length: MAX_CHOICES }, (_, i) => `รูปตัวเลือก${i + 1}`);
const QUESTION_PASSAGE_COLUMN = "บทความร่วม";
const REQUIRED_COLUMNS = ["คำถาม", "ข้อที่ถูก", "ตัวเลือก1", "ตัวเลือก2"];

async function loadWorkbook(buffer, filename) {
    const workbook = new ExcelJS.Workbook();
    if (/\.csv$/i.test(filename ?? "")) {
        await workbook.csv.read(Readable.from(buffer));
    } else {
        await workbook.xlsx.load(buffer);
    }
    return workbook;
}

// ดึงรูปที่แอดมินแทรกไว้ในไฟล์ .xlsx จับคู่กับ "เซลล์" (แถว+คอลัมน์) ที่รูปวางทับอยู่ (CSV เป็น plain text
// ฝังรูปไม่ได้ getImages()/media จะว่างเปล่าเสมอ ไม่ error) ใช้ตำแหน่งมุมบนซ้ายของรูป (nativeRow/nativeCol,
// 0-indexed) เป็นตัวกำหนดว่าอยู่เซลล์ไหน — คอลัมน์รูปแยกเป็นคนละคอลัมน์จากคอลัมน์ข้อความเสมอ (ดู
// QUESTION_IMAGE_COLUMN/CHOICE_IMAGE_COLUMNS) เพื่อไม่ให้รูปบังข้อความหรือทำให้แถวรกตอนกรอกข้อมูล
// ถ้าหลายรูปทับเซลล์เดียวกัน รูปที่มาทีหลังใน array จะทับรูปก่อนหน้า (ไม่ error)
function extractImagesByCell(worksheet, media) {
    const byCell = {};
    for (const img of worksheet.getImages()) {
        const source = media[img.imageId];
        if (!source?.buffer) continue;
        const excelRow = Math.floor(img.range.tl.nativeRow) + 1;
        const excelCol = Math.floor(img.range.tl.nativeCol) + 1;
        byCell[`${excelRow}:${excelCol}`] = { buffer: source.buffer, extension: source.extension };
    }
    return byCell;
}

// resolveMerge: อ่านค่าจากเซลล์บนสุดของกลุ่ม merge แทนตัวเอง ถ้าเซลล์นี้ถูก merge ไว้ (isMerged/master ของ
// ExcelJS — ยืนยันด้วย script ทดสอบจริงแล้วว่า master.value/master.row เป็นค่าที่ใช้ได้เสมอ) ใช้เฉพาะคอลัมน์
// "บทความร่วม" เท่านั้น (ดู QUESTION_PASSAGE_COLUMN) คอลัมน์อื่นไม่แตะพฤติกรรมเดิม กันกรณี merge เผลอที่คอลัมน์
// อื่นไปบดบังข้อมูลที่ตั้งใจกรอกแยกรายแถว
function cellText(row, colIndex, { resolveMerge = false } = {}) {
    if (!colIndex) return "";
    let cell = row.getCell(colIndex);
    if (resolveMerge && cell.isMerged) cell = cell.master;
    const value = cell.value;
    if (value == null) return "";

    let text;
    if (typeof value === "object") {
        if ("richText" in value) text = value.richText.map((t) => t.text).join("");
        else if ("text" in value) text = String(value.text);
        else if ("result" in value) text = String(value.result);
        else text = "";
    } else {
        text = String(value);
    }
    return text.trim();
}

// แถวบนสุดของกลุ่มที่ merge เซลล์คอลัมน์ "บทความร่วม" ไว้ร่วมกัน (หรือ null ถ้าแถวนี้ไม่ได้เป็นส่วนหนึ่งของ
// กลุ่มใดๆ) ใช้เป็น "รหัสกลุ่ม" กลายๆ — ทั้งข้อความบทความและรูปประกอบที่วางไว้ที่แถวบนสุดจะถูกดึงไปใช้กับ
// ทุกแถวในกลุ่มเดียวกันโดยอัตโนมัติ แอดมินจึงกรอกบทความ/แนบรูปครั้งเดียวที่แถวแรกของกลุ่ม แล้ว merge เซลล์
// คอลัมน์นี้คลุมแถวคำถามทั้งหมดที่ใช้บทความ/รูปร่วมกันได้เลย
function passageGroupFirstRow(row, passageColIndex) {
    if (!passageColIndex) return null;
    const cell = row.getCell(passageColIndex);
    return cell.isMerged ? cell.master.row : null;
}

// นำเข้าคำถามจากไฟล์ CSV/Excel — แถวแรกเป็นหัวตาราง คอลัมน์ที่รองรับ:
// คำถาม | วิธีคิด | ข้อที่ถูก | หมวดหมู่ (ไม่บังคับ) | ตัวเลือก1..6 | เหตุผลผิด1..6
// "หมวดหมู่" คืนเป็นชื่อ (string) เฉยๆ — resolve เป็น tpc_id (สร้างใหม่ถ้ายังไม่มี) ที่ชั้น controller
// เพราะ parser นี้ตั้งใจให้ไม่แตะฐานข้อมูลโดยตรง (pure function, เทสง่าย)
// รูปภาพประกอบโจทย์/ตัวเลือก (เฉพาะ .xlsx): แอดมินแทรกรูปทับคอลัมน์ "รูปคำถาม"/"รูปตัวเลือกN" (คนละ
// คอลัมน์กับคอลัมน์ข้อความ) ในแถวของคำถาม/ตัวเลือกที่ต้องการ ระบบจะจับคู่ให้อัตโนมัติ — คืนเป็น
// question.image / choice.image แบบ { buffer, extension } | null
// เติมตัวเลือกจากคอลัมน์ 1 ไล่ขึ้นไปโดยไม่เว้นช่องว่างระหว่างกลาง — "ข้อที่ถูก" อ้างอิงตำแหน่ง
// ในกลุ่มตัวเลือกที่ไม่ว่างเท่านั้น (ไม่ใช่เลขคอลัมน์ตายตัว) ผ่าน validation ทุกแถวก่อนถึงจะ insert (all-or-nothing)
async function parseQuestionFile(buffer, filename) {
    const workbook = await loadWorkbook(buffer, filename);
    const sheet = workbook.worksheets[0];
    if (!sheet || sheet.rowCount === 0) {
        return { questions: [], errors: ["ไม่พบข้อมูลในไฟล์"] };
    }

    const imagesByCell = extractImagesByCell(sheet, workbook.model.media ?? []);

    const colIndex = {};
    sheet.getRow(1).eachCell((cell, i) => {
        colIndex[String(cell.value ?? "").trim()] = i;
    });

    const missingCols = REQUIRED_COLUMNS.filter((c) => !colIndex[c]);
    if (missingCols.length > 0) {
        return { questions: [], errors: [`ไฟล์ขาดคอลัมน์ที่จำเป็น: ${missingCols.join(", ")}`] };
    }

    const questions = [];
    const errors = [];

    const passageColIndex = colIndex[QUESTION_PASSAGE_COLUMN];

    for (let r = 2; r <= sheet.rowCount; r++) {
        const row = sheet.getRow(r);
        const questionText = cellText(row, colIndex["คำถาม"]);
        const explanation = cellText(row, colIndex["วิธีคิด"]);
        const correctRaw = cellText(row, colIndex["ข้อที่ถูก"]);
        const topicName = cellText(row, colIndex["หมวดหมู่"]) || null;
        const sharedPassage = cellText(row, passageColIndex, { resolveMerge: true });
        const groupFirstRow = passageGroupFirstRow(row, passageColIndex);
        const rawChoices = CHOICE_COLUMNS.map((col, ci) => ({
            text: cellText(row, colIndex[col]),
            wrongReason: cellText(row, colIndex[WRONG_REASON_COLUMNS[ci]]),
            image: imagesByCell[`${r}:${colIndex[CHOICE_IMAGE_COLUMNS[ci]]}`] ?? null,
        }));

        const isBlankRow = !questionText && !correctRaw && rawChoices.every((c) => !c.text);
        if (isBlankRow) continue;

        if (!questionText) {
            errors.push(`แถวที่ ${r}: ไม่มีคำถาม`);
            continue;
        }

        // ต้องกรอกตัวเลือกต่อเนื่องกันจากคอลัมน์ 1 ห้ามเว้นช่องว่างคั่นกลาง (เช่น กรอกตัวเลือก1,3,4 แต่เว้น
        // ตัวเลือก2 ว่างไว้) เพราะขั้นตอนถัดไป (filter เอาตัวเลือกที่มีข้อความออกมา) จะบีบตำแหน่งตัวเลือกให้ชิด
        // กัน ทำให้ "ข้อที่ถูก" ที่แอดมินตั้งใจอ้างอิงเลขคอลัมน์เดิม (เช่น 3 หมายถึงตัวเลือก3) ไปตกกับตัวเลือก
        // ที่เลื่อนตำแหน่งมาแทนโดยไม่มีใครรู้ตัว — ต้องจับช่องว่างตรงกลางนี้ก่อนเสมอ ไม่ปล่อยให้เงียบ
        const firstEmptyIndex = rawChoices.findIndex((c) => !c.text);
        const hasGapBetweenChoices = firstEmptyIndex !== -1 && rawChoices.slice(firstEmptyIndex + 1).some((c) => c.text !== "");
        if (hasGapBetweenChoices) {
            errors.push(
                `แถวที่ ${r}: เว้นตัวเลือกที่ ${firstEmptyIndex + 1} ว่างไว้แต่มีตัวเลือกถัดไปกรอกอยู่ ` +
                `กรุณากรอกตัวเลือกต่อเนื่องกันตั้งแต่ตัวเลือก 1 ห้ามเว้นช่องว่างตรงกลาง (ไม่งั้น "ข้อที่ถูก" จะอ้างอิงผิดตัว)`
            );
            continue;
        }

        const choices = rawChoices.filter((c) => c.text !== "");
        if (choices.length < 2) {
            errors.push(`แถวที่ ${r}: ต้องมีตัวเลือกอย่างน้อย 2 ข้อ`);
            continue;
        }

        const correctIndex = parseInt(correctRaw, 10);
        if (!correctRaw || Number.isNaN(correctIndex) || correctIndex < 1 || correctIndex > choices.length) {
            errors.push(`แถวที่ ${r}: "ข้อที่ถูก" ต้องเป็นตัวเลข 1-${choices.length}`);
            continue;
        }

        // ถ้าแถวนี้อยู่ในกลุ่ม merge ของ "บทความร่วม" ให้เอารูปที่วางไว้ที่แถวบนสุดของกลุ่ม (รูปตาราง/กราฟ
        // ที่ใช้ร่วมกันทั้งกลุ่ม) มาก่อน ถ้าไม่มีรูปที่แถวบนสุด (กลุ่มนี้ใช้บทความข้อความล้วนๆ ไม่มีรูป) ค่อย fallback
        // ไปดูรูปที่วางไว้เฉพาะแถวของตัวเอง (เผื่อโจทย์ข้อนั้นมีรูปประกอบเพิ่มเติมนอกเหนือจากบทความร่วม)
        const questionImage =
            (groupFirstRow && imagesByCell[`${groupFirstRow}:${colIndex[QUESTION_IMAGE_COLUMN]}`]) ||
            imagesByCell[`${r}:${colIndex[QUESTION_IMAGE_COLUMN]}`] ||
            null;

        questions.push({
            questionText: sharedPassage ? `${sharedPassage}\n\n${questionText}` : questionText,
            explanation: explanation || null,
            topicName,
            image: questionImage,
            choices: choices.map((c, ci) => ({
                text: c.text,
                isCorrect: ci === correctIndex - 1,
                wrongReason: ci === correctIndex - 1 ? null : (c.wrongReason || null),
                image: c.image,
            })),
        });
    }

    return { questions, errors };
}

module.exports = {
    parseQuestionFile, MAX_CHOICES, CHOICE_COLUMNS, WRONG_REASON_COLUMNS, REQUIRED_COLUMNS,
    QUESTION_IMAGE_COLUMN, CHOICE_IMAGE_COLUMNS, QUESTION_PASSAGE_COLUMN,
};
