const { findFeature, listFeatures, getFeatureStates, setFeatureEnabled } = require("../utils/featureFlags");
const { setAudit } = require("../middlewares/auditLog.middleware");

// เปิด/ปิดฟีเจอร์ของระบบ — ตรรกะทั้งหมดอยู่ที่ utils/featureFlags.js ไฟล์นี้แค่รับ-ส่ง HTTP

// GET /V1/feature-flags — หน้าตั้งค่า (สิทธิ์ featureFlags)
async function list(req, res, next) {
    try {
        res.json({ features: await listFeatures() });
    } catch (err) {
        next(err);
    }
}

// PUT /V1/feature-flags/:key  { enabled: boolean }
async function update(req, res, next) {
    try {
        const feature = findFeature(req.params.key);
        if (!feature) return res.status(404).json({ message: "ไม่พบฟีเจอร์นี้ในระบบ" });

        // รับเฉพาะ boolean จริง — "false" (สตริง) ถ้าแปลงด้วย !! จะกลายเป็นเปิด ซึ่งตรงข้ามกับที่ตั้งใจ
        const { enabled } = req.body ?? {};
        if (typeof enabled !== "boolean") {
            return res.status(400).json({ message: "ต้องระบุ enabled เป็น true หรือ false" });
        }

        await setFeatureEnabled(feature.key, enabled, {
            userId: req.user?.user_id ?? null,
            name: req.auditUser?.name || req.auditUser?.email || null,
        });
        setAudit(req, `${enabled ? "เปิด" : "ปิด"}ใช้งานฟีเจอร์ "${feature.name}"`);

        const updated = (await listFeatures()).find((f) => f.key === feature.key);
        res.json({ message: `${enabled ? "เปิด" : "ปิด"}ใช้งาน "${feature.name}" แล้ว`, feature: updated });
    } catch (err) {
        next(err);
    }
}

// GET /V1/feature-flags/state — { key: boolean } สำหรับหน้าเว็บแอดมินทุกคนที่ล็อกอิน (ใช้ซ่อน/แสดงเมนู-ปุ่ม)
// ไม่ต้องมีสิทธิ์ featureFlags — คนที่ไม่มีสิทธิ์ตั้งค่าก็ต้องรู้ว่าฟีเจอร์เปิดอยู่ไหม
async function states(req, res, next) {
    try {
        res.json(await getFeatureStates());
    } catch (err) {
        next(err);
    }
}

// GET /V1/store/feature-flags — สาธารณะ ส่งเฉพาะฟีเจอร์ที่ exposeToStore
async function storeStates(req, res, next) {
    try {
        res.json(await getFeatureStates({ audience: "store" }));
    } catch (err) {
        next(err);
    }
}

module.exports = { list, update, states, storeStates };
