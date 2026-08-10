function notFound(req, res) {
    res.status(404).json({ message: "ไม่พบ endpoint นี้" });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
    console.error(err);
    const status = err.status ?? 500;
    res.status(status).json({ message: err.message ?? "เกิดข้อผิดพลาดที่เซิร์ฟเวอร์" });
}

module.exports = { notFound, errorHandler };
