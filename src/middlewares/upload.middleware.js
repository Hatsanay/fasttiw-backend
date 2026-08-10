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

module.exports = { uploadImage, uploadSpreadsheet };
