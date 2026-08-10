// Express ตั้ง ETag ให้ res.json() ทุกอันโดย default — endpoint ที่ client poll ซ้ำๆ (เช่น แชท) พอค่าที่คืน
// เหมือนเดิมกับรอบก่อนหน้า เบราว์เซอร์จะส่ง If-None-Match แล้วได้ 304 กลับมาแทน ซึ่งจริงๆ ไม่มีปัญหา
// (304 แปลว่าค่าที่ client มีอยู่แล้วยังตรงกับปัจจุบันจริง ไม่มีทางค้างข้อมูลเก่าได้ เพราะ query สดใหม่ทุก
// ครั้งอยู่ดี) แต่เพื่อไม่ให้พฤติกรรม caching ของ ETag เข้ามาเกี่ยวข้องกับ endpoint แบบ live-poll โดยไม่ตั้งใจ
// เลย ให้ปิดชัดเจนไปเลยด้วย middleware ตัวนี้
function noStore(req, res, next) {
    res.set("Cache-Control", "no-store");
    next();
}

module.exports = { noStore };
