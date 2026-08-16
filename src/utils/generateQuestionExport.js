const ExcelJS = require("exceljs");
const {
    CHOICE_COLUMNS, WRONG_REASON_COLUMNS, QUESTION_IMAGE_COLUMN, CHOICE_IMAGE_COLUMNS, QUESTION_PASSAGE_COLUMN, MAX_CHOICES,
} = require("./parseQuestionFile");

// ลำดับคอลัมน์ต้องตรงกับ generateQuestionTemplate.js เป๊ะ เพื่อให้ไฟล์ export กลับเข้า parseQuestionFile.js
// ได้ทันทีโดยไม่ต้องแก้อะไร (export แล้ว import ซ้ำ = ต้อง round-trip ได้)
const HEADER_COLUMNS = [
    QUESTION_PASSAGE_COLUMN, QUESTION_IMAGE_COLUMN, "คำถาม", "วิธีคิด", "ข้อที่ถูก", "หมวดหมู่",
    ...Array.from({ length: MAX_CHOICES }, (_, i) => [CHOICE_IMAGE_COLUMNS[i], CHOICE_COLUMNS[i], WRONG_REASON_COLUMNS[i]]).flat(),
];

// เลขคอลัมน์ (1-based) -> ตัวอักษรคอลัมน์ Excel เช่น 1->A, 24->X, 27->AA — ใช้ประกอบ range string ตอนวางรูป
// (ไฟล์นี้มีแค่ 24 คอลัมน์เลยไม่มีทางเกิน Z จริงๆ แต่เขียนให้ถูกทั่วไปไว้เผื่อ HEADER_COLUMNS ขยายในอนาคต)
function columnLetter(colIndex) {
    let letter = "";
    let n = colIndex;
    while (n > 0) {
        const rem = (n - 1) % 26;
        letter = String.fromCharCode(65 + rem) + letter;
        n = Math.floor((n - 1) / 26);
    }
    return letter;
}

// ตอน import บทความร่วมจะถูกรวมเข้า ques_text ถาวรเป็น `${passage}\n\n${questionText}` (ดู parseQuestionFile.js)
// ไม่มีตาราง/คอลัมน์ไหนเก็บ "กลุ่ม" แยกไว้จริงๆ — export จึงต้องเดากลุ่มคืนจากรูปแบบข้อความเอง: ข้อที่ "เรียงติดกัน"
// (เรียงตาม ques_order อยู่แล้วตอนส่งเข้ามา) ตั้งแต่ 2 ข้อขึ้นไปที่มี prefix ก่อน "\n\n" แรกเหมือนกันเป๊ะ ถือว่าเคย
// merge มาด้วยกัน — ใช้ ≥2 ข้อเป็นเงื่อนไขเพราะการ merge เซลล์จริงใน Excel ก็ต้องคลุมอย่างน้อย 2 แถวเสมออยู่แล้ว
// (merge เซลล์เดียวไม่มีความหมาย) กันเคสข้อเดี่ยวที่บังเอิญมีบรรทัดว่างอยู่ในคำถามเองไปโดนเข้าใจผิดว่าเป็นกลุ่ม
function detectPassageGroups(questions) {
    const groups = [];
    let i = 0;
    while (i < questions.length) {
        const splitAt = questions[i].questionText.indexOf("\n\n");
        if (splitAt === -1) { i++; continue; }

        const passage = questions[i].questionText.slice(0, splitAt);
        if (!passage.trim()) { i++; continue; }

        const prefix = `${passage}\n\n`;
        let j = i + 1;
        while (j < questions.length && questions[j].questionText.startsWith(prefix)) j++;

        if (j - i >= 2) {
            groups.push({ start: i, end: j - 1, passage });
            i = j;
        } else {
            i++;
        }
    }
    return groups;
}

// รับ questions รูปแบบเดียวกับที่ parseQuestionFile.js คืนกลับมา (questionText, explanation, topicName,
// image: {buffer, extension} | null, choices: [{text, isCorrect, wrongReason, image}]) — เพื่อให้ export/import
// ใช้ shape ข้อมูลร่วมกัน พิสูจน์ความ round-trip ได้ตรงไปตรงมา ต้องเรียงตาม ques_order มาก่อนแล้ว (สำคัญมาก —
// การเดากลุ่มบทความร่วมอาศัยลำดับข้อที่ "ติดกัน" เป็นเงื่อนไขหลัก)
async function generateQuestionExport(questions) {
    const groups = detectPassageGroups(questions);
    const groupByIndex = new Map(); // index ข้อ -> { start, end, passage }
    groups.forEach((g) => {
        for (let k = g.start; k <= g.end; k++) groupByIndex.set(k, g);
    });

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("นำเข้าคำถาม");
    sheet.columns = HEADER_COLUMNS.map((h) => ({
        header: h,
        key: h,
        width: h === "คำถาม" || h === "วิธีคิด" ? 40 : h.startsWith("รูป") || h === QUESTION_PASSAGE_COLUMN ? 24 : 18,
    }));
    sheet.getRow(1).font = { bold: true };

    const passageColIndex = HEADER_COLUMNS.indexOf(QUESTION_PASSAGE_COLUMN) + 1;
    const quesImageColIndex = HEADER_COLUMNS.indexOf(QUESTION_IMAGE_COLUMN) + 1;
    const choiceImageColIndexes = CHOICE_IMAGE_COLUMNS.map((c) => HEADER_COLUMNS.indexOf(c) + 1);
    // คอลัมน์ที่มีโอกาสมีข้อความหลายบรรทัด (พิมพ์ผ่าน <textarea> ในฟอร์มแอดมิน หรือรวมบทความเข้ามา) — ต้องเปิด
    // wrapText เองเสมอ เพราะ Excel จะไม่ตีความ "\n" ที่ฝังอยู่ในค่าเซลล์เป็นการขึ้นบรรทัดใหม่ให้อัตโนมัติถ้าเซลล์
    // นั้นไม่ได้ตั้ง wrap text ไว้ (ไม่งั้นข้อความที่มีบรรทัดว่างจะรันติดกันเป็นบรรทัดเดียวตอนเปิดดูใน Excel จริง)
    const wrapColIndexes = [passageColIndex, HEADER_COLUMNS.indexOf("คำถาม") + 1, HEADER_COLUMNS.indexOf("วิธีคิด") + 1];

    // รอบที่ 1: เพิ่มทุกแถวให้ครบก่อน (ไม่ยุ่งกับรูปเลย) — ExcelJS มีพฤติกรรมแปลกที่ addImage() ระหว่างทางทำให้
    // เลขแถวของ addRow() ครั้งถัดไปกระโดดข้ามไป 1 (พิสูจน์แล้วด้วยการทดสอบจริง: สลับ addRow/addImage ในลูป
    // เดียวกันทำให้แถวที่ควรได้เลข 3 หายไปเฉยๆ กลายเป็นเลข 4 แทน) เก็บเลขแถวจริงของแต่ละข้อไว้ก่อน แล้วค่อยวาง
    // รูปทั้งหมดในรอบที่ 2 แยกต่างหาก หลังจากไม่มีการเรียก addRow() อีกแล้วจึงไม่มีทางเลขแถวเพี้ยนอีก
    const excelRowOf = []; // index ข้อ -> เลขแถว Excel จริง
    const strippedTextOf = new Map(); // index ข้อในกลุ่ม -> ข้อความเฉพาะข้อ (ตัดบทความร่วมออกแล้ว)
    groups.forEach((g) => {
        for (let k = g.start; k <= g.end; k++) {
            strippedTextOf.set(k, questions[k].questionText.slice(g.passage.length + 2));
        }
    });

    for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        const group = groupByIndex.get(i);
        const questionText = group ? strippedTextOf.get(i) : q.questionText;
        const correctIndex = q.choices.findIndex((c) => c.isCorrect) + 1;
        const rowValues = {
            [QUESTION_PASSAGE_COLUMN]: group && group.start === i ? group.passage : "",
            [QUESTION_IMAGE_COLUMN]: "",
            "คำถาม": questionText,
            "วิธีคิด": q.explanation ?? "",
            "ข้อที่ถูก": correctIndex,
            "หมวดหมู่": q.topicName ?? "",
        };
        CHOICE_COLUMNS.forEach((col, ci) => {
            rowValues[col] = q.choices[ci]?.text ?? "";
            rowValues[WRONG_REASON_COLUMNS[ci]] = q.choices[ci]?.wrongReason ?? "";
        });

        const row = sheet.addRow(HEADER_COLUMNS.map((h) => rowValues[h] ?? ""));
        excelRowOf[i] = row.number;
        wrapColIndexes.forEach((colIdx) => {
            row.getCell(colIdx).alignment = { wrapText: true, vertical: "top" };
        });
    }

    // รอบที่ 2: วางรูปทั้งหมดโดยอ้างอิงเลขแถวจริงที่เก็บไว้จากรอบที่ 1 (ไม่มี addRow() เหลือให้กระทบอีกแล้ว)
    for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        const group = groupByIndex.get(i);
        const r = excelRowOf[i];

        // รูปที่ใช้ร่วมกันทั้งกลุ่ม (ทุกข้อในกลุ่มมีรูป และเป็นรูปเดียวกันไบต์ต่อไบต์เป๊ะ — เทียบ buffer ตรงๆ)
        // วางแค่แถวแรกของกลุ่มพอ ไม่ต้องวางซ้ำทุกแถว เพราะแถวอื่นในกลุ่มจะถูก merge คลุมคอลัมน์ "บทความร่วม"
        // ไปด้วยอยู่แล้ว (สอดคล้องกับวิธีที่แอดมิน merge ตอน import — วางรูปแค่แถวบนสุดของกลุ่มเดียว)
        const isSharedGroupImage = group && isSameImageAcrossGroup(questions, group);
        const shouldPlaceQuestionImage = q.image && (!isSharedGroupImage || group.start === i);
        if (shouldPlaceQuestionImage) {
            const imgId = workbook.addImage({ buffer: q.image.buffer, extension: q.image.extension });
            const col = columnLetter(quesImageColIndex);
            sheet.addImage(imgId, `${col}${r}:${col}${r}`);
        }
        q.choices.forEach((c, ci) => {
            if (!c.image) return;
            const imgId = workbook.addImage({ buffer: c.image.buffer, extension: c.image.extension });
            const col = columnLetter(choiceImageColIndexes[ci]);
            sheet.addImage(imgId, `${col}${r}:${col}${r}`);
        });
    }

    // merge เซลล์คอลัมน์ "บทความร่วม" คลุมทุกแถวของแต่ละกลุ่มที่เดาออก — ให้ไฟล์นี้ import กลับเข้าไปได้แล้ว
    // สร้างกลุ่มเดิมขึ้นมาใหม่ทันที (parseQuestionFile.js อ่าน isMerged/master แบบเดียวกับตอน admin merge เอง)
    groups.forEach((g) => {
        const firstRow = excelRowOf[g.start];
        const lastRow = excelRowOf[g.end];
        sheet.mergeCells(firstRow, passageColIndex, lastRow, passageColIndex);
    });

    return workbook.xlsx.writeBuffer();
}

function isSameImageAcrossGroup(questions, group) {
    const first = questions[group.start].image;
    if (!first) return false;
    for (let k = group.start + 1; k <= group.end; k++) {
        const img = questions[k].image;
        if (!img || !img.buffer.equals(first.buffer)) return false;
    }
    return true;
}

module.exports = { generateQuestionExport };
