const multer = require("multer");

// เก็บเป็น buffer ในหน่วยความจำแทนการเขียนไฟล์ดิบลงดิสก์ตรงๆ
// เพราะ controller ต้อง resize/compress ด้วย sharp ก่อนค่อยเขียนไฟล์จริง
const storage = multer.memoryStorage();

function imageFileFilter(req, file, cb) {
    if (!file.mimetype.startsWith("image/")) {
        return cb(new Error("อนุญาตเฉพาะไฟล์รูปภาพ"));
    }
    cb(null, true);
}

const uploadImage = multer({
    storage,
    fileFilter: imageFileFilter,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
});

// ไฟล์นำเข้าคำถาม (CSV/Excel) — เช็คทั้ง mimetype และนามสกุล เพราะเบราว์เซอร์/OS
// บางตัวส่ง mimetype ของ .csv มาไม่ตรง (เช่น text/plain, application/octet-stream)
const SPREADSHEET_MIMETYPES = [
    "text/csv",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];

function spreadsheetFileFilter(req, file, cb) {
    const okExt = /\.(csv|xlsx|xls)$/i.test(file.originalname);
    const okMime = SPREADSHEET_MIMETYPES.includes(file.mimetype);
    if (!okExt && !okMime) {
        return cb(new Error("อนุญาตเฉพาะไฟล์ CSV หรือ Excel (.csv, .xlsx, .xls)"));
    }
    cb(null, true);
}

const uploadSpreadsheet = multer({
    storage,
    fileFilter: spreadsheetFileFilter,
    limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
});

// ภาพกระดาษคำตอบที่สแกนส่งตรวจ (ระบบสอบกระดาษ — CLAUDE.md ข้อ 6.9) — หน้าเว็บส่งภาพที่ดึงตรงแล้ว ~200KB/หน้า
// จำกัดจำนวนไฟล์ไว้ด้วย (ชุด 1,000 ข้อ = 10 หน้า) เพราะ .any() ไม่มีเพดานเอง ยิงไฟล์ไม่อั้นจะกินหน่วยความจำ
const paperScanUpload = multer({
    storage,
    fileFilter: imageFileFilter,
    limits: { fileSize: 5 * 1024 * 1024, files: 20, fields: 5, fieldSize: 256 * 1024 },
}).any();

// error ของ multer ไม่มี status → errorHandler ตอบ 500 และเก็บลง error log — ที่นี่เป็นความผิดของคำขอ ตอบ 400
function uploadPaperScans(req, res, next) {
    paperScanUpload(req, res, (err) => {
        if (!err) return next();
        const message = err.code === "LIMIT_FILE_SIZE" ? "ไฟล์ภาพใหญ่เกินไป" : err.message || "ไฟล์ภาพไม่ถูกต้อง";
        res.status(400).json({ message: `${message} — สแกนใหม่อีกครั้ง` });
    });
}

module.exports = { uploadImage, uploadSpreadsheet, uploadPaperScans };
