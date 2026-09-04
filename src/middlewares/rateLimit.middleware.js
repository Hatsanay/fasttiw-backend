// จำกัดจำนวนครั้งที่ยิงเข้า endpoint เดียวกันจาก IP เดียวกัน — ใช้กับ endpoint สาธารณะที่เดารหัส/เดา
// token ได้ (login, register, ลืมรหัสผ่าน, ตั้งรหัสผ่านใหม่) ซึ่งเป็นด่านที่คนไล่ยิงรัวๆ ได้โดยไม่ต้อง login
//
// เก็บตัวนับไว้ในหน่วยความจำของ process ไม่ใช้ Redis — เพราะ backend รันเป็น process เดียว การเพิ่ม
// dependency ภายนอกแค่เพื่อฟีเจอร์นี้ไม่คุ้ม ข้อแลกเปลี่ยนที่ยอมรับ: ตัวนับรีเซ็ตเมื่อ restart และถ้าวันหนึ่ง
// scale เป็นหลาย process ต้องเปลี่ยนมาใช้ store กลาง (จุดที่ต้องแก้อยู่ในไฟล์นี้ไฟล์เดียว)
//
// **เรื่อง IP ที่ต้องเข้าใจก่อนแก้ไฟล์นี้** — ฝั่งลูกค้า (tiwwai-store) เรียก backend ผ่านเซิร์ฟเวอร์ Next
// ไม่ใช่จากเบราว์เซอร์ตรงๆ (Server Action / Route Handler อ่าน httpOnly cookie ฝั่ง server) ดังนั้น IP ที่
// backend เห็นคือ IP ของเซิร์ฟเวอร์ Next เหมือนกันหมดทุกคน ถ้านับตาม IP นั้นตรงๆ ลูกค้าทุกคนจะแชร์โควตา
// ก้อนเดียวกันแล้วล็อกกันเอง — จึงให้ Next ส่ง IP จริงของลูกค้ามาทาง header `x-client-ip` พร้อมกับ
// `x-internal-secret` เป็นตัวยืนยันว่ามาจากเซิร์ฟเวอร์เราจริง (ไม่งั้นใครก็ปลอม header นี้เพื่อหนีลิมิตได้)
const buckets = new Map(); // key -> { count, resetAt }
const PRUNE_THRESHOLD = 5000; // จำนวน key ที่ยอมให้ค้างก่อนกวาดของหมดอายุทิ้ง กันหน่วยความจำโตไม่มีเพดาน

function clientKey(req) {
    const secret = process.env.INTERNAL_PROXY_SECRET;
    const forwarded = req.headers["x-client-ip"];
    // เชื่อ IP ที่ส่งมาต่อเมื่อ secret ตรงเท่านั้น — ถ้าไม่ได้ตั้ง secret ไว้ ถือว่าไม่เชื่อ header ใดๆ
    if (secret && forwarded && req.headers["x-internal-secret"] === secret) {
        return String(forwarded).split(",")[0].trim();
    }
    return req.ip || req.socket?.remoteAddress || "unknown";
}

function prune(now) {
    for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(key);
    }
}

// windowMs: ความยาวหน้าต่างเวลา, max: จำนวนครั้งสูงสุดในหน้าต่างนั้น, name: ใช้แยก bucket ต่อ endpoint
function rateLimit({ windowMs, max, name, message }) {
    return (req, res, next) => {
        const now = Date.now();
        if (buckets.size > PRUNE_THRESHOLD) prune(now);

        const key = `${name}:${clientKey(req)}`;
        const bucket = buckets.get(key);

        if (!bucket || bucket.resetAt <= now) {
            buckets.set(key, { count: 1, resetAt: now + windowMs });
            return next();
        }

        bucket.count += 1;
        if (bucket.count > max) {
            const retryAfterSec = Math.ceil((bucket.resetAt - now) / 1000);
            res.set("Retry-After", String(retryAfterSec));
            return res.status(429).json({
                message: message || `ทำรายการถี่เกินไป กรุณารออีก ${Math.ceil(retryAfterSec / 60)} นาทีแล้วลองใหม่`,
            });
        }
        next();
    };
}

// เผื่อกรณีที่ต้องล้างตัวนับเอง (เทสต์) — ไม่ได้ใช้ในโค้ดจริง
function resetAll() {
    buckets.clear();
}

module.exports = { rateLimit, resetAll };
