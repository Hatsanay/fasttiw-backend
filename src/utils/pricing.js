// ราคาจริงที่ต้องเรียกเก็บจาก product แถวหนึ่ง — จุดเดียวที่ตัดสินว่า prod_is_free ชนะ prod_price เสมอ
// ทุกที่ที่คิดเงินจริง (recordSale/checkout/getPublicPackages) ต้องเรียกผ่านฟังก์ชันนี้เท่านั้น ห้ามเขียน
// ternary `is_free ? 0 : Number(prod_price)` ซ้ำเองที่ไหนอีก — กันเผลอลืมจุดใดจุดหนึ่งแล้วไปเก็บเงินจริง
// จากราคา "ปกติ" ที่ตั้งไว้แค่โชว์ (เช่น "ปกติ 299 บาท ฟรี!") — รับ product row ทั้งก้อนแทนสองพารามิเตอร์แยก
// กันสลับลำดับ args ผิด
function getEffectivePrice(product) {
    if (!product) return 0;
    return product.prod_is_free ? 0 : Number(product.prod_price ?? 0);
}

module.exports = { getEffectivePrice };
