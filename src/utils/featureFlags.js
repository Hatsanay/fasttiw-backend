const pool = require("../config/db");

// เปิด/ปิดฟีเจอร์ของระบบ (2026-09-27) — เมนู "ตั้งค่าระบบ > เปิดใช้งานระบบ" ฝั่งแอดมิน
//
// ── วิธีเพิ่มฟีเจอร์ที่เปิด/ปิดได้ ──────────────────────────────────────────────────────────────
// 1. เพิ่มรายการใน FEATURES ด้านล่าง (key ห้ามเปลี่ยนหลัง deploy — เป็นตัวผูกกับสถานะที่แอดมินเลือกไว้ใน DB)
// 2. ฝั่ง backend: route ใช้ `requireFeature("key")` (ปิดอยู่ = 404 เหมือนไม่มี endpoint นี้) หรือเช็คเองด้วย
//    `await isFeatureEnabled("key")` · **ต้องเช็คที่ backend เสมอ** ซ่อนแค่ปุ่มบนหน้าเว็บ = ยิง API ตรงก็ใช้ได้
// 3. ฝั่งลูกค้า (tiwwai-store): ตั้ง `exposeToStore: true` แล้วใช้ `isFeatureEnabled("key")` จาก lib/publicData.ts
//    ฝั่งแอดมิน: `useFeatureEnabled("key")` จาก app/lib/features.ts
// 4. เลิกใช้ flag แล้ว (ฟีเจอร์เปิดถาวร) ให้ลบทั้งรายการนี้และจุดที่เช็ค — แถวค้างใน DB ถูกเมินเฉยๆ ไม่ต้องลบ
//
// **ทำไมรายชื่ออยู่ในโค้ด ไม่ใช่ใน DB**: โค้ดของฟีเจอร์ต้องเช็คด้วย key อยู่แล้ว ชื่อ/คำอธิบาย/ค่าเริ่มต้นจึงควรมา
// พร้อมโค้ดใน deploy เดียวกัน · ถ้าอยู่ใน DB ต้องจำรัน SQL เพิ่มแถวทุกครั้ง ลืมเมื่อไหร่ฟีเจอร์หายจากหน้าตั้งค่า
// และ deploy โค้ดก่อน/หลังรัน SQL ไม่พร้อมกันก็พังได้ — แบบนี้ DB เก็บแค่ "แอดมินเลือกอะไรไว้"
//
// **ฟีเจอร์ใหม่ให้ defaultEnabled: false เสมอ** — deploy ขึ้นไปแล้วยังไม่มีใครเห็นจนกว่าแอดมินจะกดเปิดเอง
// ซึ่งคือเหตุผลที่มีเมนูนี้ (deploy โค้ดได้ก่อน เปิดให้ลูกค้าใช้ทีหลังเมื่อพร้อม และปิดทันทีได้ถ้ามีปัญหา)
const FEATURES = [
    {
        key: "landing_flow_demo",
        name: "ภาพเคลื่อนไหวขั้นตอนการใช้งาน (หน้าแรก)",
        description:
            "section ในหน้าแรกที่เล่นทุกขั้นตอนบนหน้าจอมือถือจำลอง ตั้งแต่เลือกชุดข้อสอบ เข้าสู่ระบบ ชำระเงิน ทำข้อสอบ จนถึงสรุปผล\n" +
            "เปิด = แทนที่ส่วน \"เริ่มเตรียมสอบได้ทันที\" (3 ขั้นตอนแบบภาพนิ่ง) · ปิด = กลับไปเป็นแบบเดิม · หน้าแรกเปลี่ยนตามภายใน ~1 นาที",
        defaultEnabled: false,
        exposeToStore: true,
    },
    {
        key: "paper_exam",
        name: "ระบบสอบกระดาษ + สแกนกระดาษคำตอบ",
        description:
            "ลูกค้าพิมพ์ชุดข้อสอบกับกระดาษคำตอบไปทำ แล้วถ่ายรูป/สแกนอัตโนมัติด้วยมือถือให้ระบบตรวจ ได้คะแนนและเฉลยเหมือนทำออนไลน์\n" +
            "เปิด = ปุ่ม \"สอบแบบกระดาษ\" ขึ้นในคลังข้อสอบของลูกค้า + section แนะนำระบบบนหน้าแรก · " +
            "ปิด = ลูกค้าเข้าหน้าพวกนี้ไม่ได้ (ใบสอบและผลที่ตรวจไปแล้วยังอยู่ครบ ผลสอบยังเปิดดูได้จากประวัติ)",
        defaultEnabled: false,
        exposeToStore: true,
    },
    {
        key: "paper_lab",
        name: "หน้าทดสอบความแม่นของการสแกน (สำหรับทีมงาน)",
        description:
            "หน้า /paper/lab + แผ่นทดสอบ /api/paper/test-sheet — พิมพ์แผ่นทดสอบที่รู้คำตอบ ฝน แล้วถ่ายรูปส่งเข้าหน้านี้ เพื่อวัดว่าระบบอ่านถูกแค่ไหน\n" +
            "ไม่ใช่หน้าของลูกค้า · เปิดเฉพาะตอนทดสอบ แล้วปิดกลับ · เปิดอยู่ก็ต้องล็อกอินก่อนถึงเข้าได้",
        defaultEnabled: false,
        exposeToStore: true,
    },
    // ตัวอย่างรูปแบบ:
    // {
    //     key: "mock_exam_v2",
    //     name: "สนามสอบเสมือน รุ่นใหม่",
    //     description: "สิ่งที่ลูกค้าจะเห็นเมื่อเปิด และผลกระทบถ้าปิดกลางคัน",
    //     defaultEnabled: false,
    //     exposeToStore: true,   // หน้าเว็บลูกค้าต้องรู้สถานะไหม (false = ส่งให้เฉพาะหลังบ้าน)
    // },
];

// อ่าน DB ทุกครั้งที่มีการเช็คจะเพิ่ม query ให้ทุก request ของฟีเจอร์นั้น — จำไว้ในหน่วยความจำแทน
// แก้จากหน้าตั้งค่า = ล้างทันที (backend เป็น process เดียว — ดูข้อ 6.3 ใน CLAUDE.md) · อายุ 30 วิ กันกรณีมีคน
// แก้ DB ตรงๆ
const CACHE_TTL_MS = 30_000;
let cache = null; // { at, rows: Map<key, row> }

function findFeature(key) {
    return FEATURES.find((f) => f.key === key) ?? null;
}

async function loadRows() {
    if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.rows;
    try {
        const [rows] = await pool.query(
            "SELECT ff_key, ff_enabled, ff_updated_by_name, ff_updated_at FROM tb_feature_flags"
        );
        cache = { at: Date.now(), rows: new Map(rows.map((r) => [r.ff_key, r])) };
        return cache.rows;
    } catch (err) {
        // อ่านไม่ได้ (DB ล่ม / ยังไม่ได้รัน migration) = ใช้ค่าเริ่มต้นในโค้ด ไม่ทำให้ทุกหน้าที่เช็ค flag พังตาม
        // ไม่จำผลที่ล้มไว้ รอบหน้าลองอ่านใหม่
        console.error("อ่าน tb_feature_flags ไม่ได้ ใช้ค่าเริ่มต้นแทน:", err.message);
        return new Map();
    }
}

function invalidateFeatureCache() {
    cache = null;
}

/** สถานะของทุกฟีเจอร์ในโค้ด + ใครเปลี่ยนล่าสุด — ใช้กับหน้าตั้งค่าของแอดมิน */
async function listFeatures() {
    const rows = await loadRows();
    return FEATURES.map((f) => {
        const row = rows.get(f.key);
        return {
            key: f.key,
            name: f.name,
            description: f.description ?? "",
            default_enabled: !!f.defaultEnabled,
            expose_to_store: !!f.exposeToStore,
            enabled: row ? !!row.ff_enabled : !!f.defaultEnabled,
            // null = แอดมินยังไม่เคยแตะ กำลังใช้ค่าเริ่มต้นอยู่
            updated_by_name: row?.ff_updated_by_name ?? null,
            updated_at: row?.ff_updated_at ?? null,
        };
    });
}

async function isFeatureEnabled(key) {
    const feature = findFeature(key);
    // key ที่ไม่มีในรายการ = พิมพ์ผิดหรือถูกลบไปแล้ว — ถือว่าปิด ปลอดภัยกว่าเปิดให้ของที่ไม่รู้จัก
    if (!feature) return false;
    const row = (await loadRows()).get(key);
    return row ? !!row.ff_enabled : !!feature.defaultEnabled;
}

/** { key: true/false } — `audience: "store"` ส่งเฉพาะตัวที่ exposeToStore (ชื่อฟีเจอร์ที่ยังไม่เปิดตัวไม่หลุดไปหน้าสาธารณะ) */
async function getFeatureStates({ audience = "all" } = {}) {
    const features = await listFeatures();
    return Object.fromEntries(
        features
            .filter((f) => audience !== "store" || f.expose_to_store)
            .map((f) => [f.key, f.enabled])
    );
}

/** by = { userId, name } — ชื่อเก็บเป็น snapshot ไว้ในแถว ลบผู้ใช้แล้วยังรู้ว่าใครเปิด/ปิด */
async function setFeatureEnabled(key, enabled, by) {
    await pool.query(
        `INSERT INTO tb_feature_flags (ff_key, ff_enabled, ff_updated_by, ff_updated_by_name)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE ff_enabled = VALUES(ff_enabled), ff_updated_by = VALUES(ff_updated_by),
                                 ff_updated_by_name = VALUES(ff_updated_by_name)`,
        [key, enabled ? 1 : 0, by?.userId ?? null, by?.name ?? null]
    );
    invalidateFeatureCache();
}

/** middleware: ฟีเจอร์ปิดอยู่ = 404 เหมือนไม่มี endpoint นี้ (ไม่บอกว่ามีฟีเจอร์ที่ยังไม่เปิดตัวซ่อนอยู่) */
function requireFeature(key) {
    return async function (req, res, next) {
        try {
            if (!(await isFeatureEnabled(key))) return res.status(404).json({ message: "ไม่พบหน้าที่ต้องการ" });
            next();
        } catch (err) {
            next(err);
        }
    };
}

module.exports = {
    FEATURES,
    findFeature,
    listFeatures,
    isFeatureEnabled,
    getFeatureStates,
    setFeatureEnabled,
    requireFeature,
    invalidateFeatureCache,
};
