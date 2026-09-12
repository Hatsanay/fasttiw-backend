const crypto = require("node:crypto");
const pool = require("../config/db");

// สถิติผู้เยี่ยมชมเว็บฝั่งลูกค้า — นับแบบไม่ใช้ cookie และไม่เก็บ IP (ตัดสินใจร่วมกับผู้ใช้ 2026-09-12)
//
// "คน" = hash(เกลือรายวัน + IP + user-agent) เกลือสุ่มใหม่ทุกวันแล้วลบของเก่า — ย้อนกลับเป็นตัวบุคคลไม่ได้
// และตามคนข้ามวันไม่ได้ จำนวนคนรายวันจึงแม่น ส่วนรายเดือน/ปีคือผลรวมคนรายวัน (ดู database/query/create_page_views.sql)

/* ───────────── วันที่ตามเวลาไทย ───────────── */

// ไทยไม่มี daylight saving — บวก 7 ชม. คงที่ได้เลย ไม่ต้องพึ่ง timezone ของเครื่องหรือของ MySQL
// (เซิร์ฟเวอร์ production อาจเป็น UTC ถ้าใช้ CURDATE() ของ DB คนที่เข้าเว็บตอนตี 1-7 โมงเช้าจะถูกนับเป็นเมื่อวาน)
function bangkokDate(ms = Date.now()) {
    return new Date(ms + 7 * 3600 * 1000).toISOString().slice(0, 10);
}

/* ───────────── เกลือรายวัน ───────────── */

let saltCache = { date: null, value: null };

async function getDailySalt(date = bangkokDate()) {
    if (saltCache.date === date) return saltCache.value;

    // INSERT IGNORE + อ่านกลับ — ถ้าสอง request แรกของวันมาพร้อมกัน จะได้เกลือตัวเดียวกันแน่นอน (PK ชนกัน)
    await pool.query("INSERT IGNORE INTO tb_visit_salts (salt_date, salt_value) VALUES (?, ?)", [date, crypto.randomBytes(32).toString("hex")]);
    const [[row]] = await pool.query("SELECT salt_value FROM tb_visit_salts WHERE salt_date = ?", [date]);
    // ลบเกลือของวันก่อนๆ ทิ้งทันที — หัวใจของการไม่ระบุตัวตน: ไม่มีเกลือ = ไม่มีทางคำนวณ hash เก่าซ้ำเพื่อจับคู่คนได้
    await pool.query("DELETE FROM tb_visit_salts WHERE salt_date < ?", [date]);

    saltCache = { date, value: row.salt_value };
    return row.salt_value;
}

function visitorHash(salt, ip, userAgent) {
    return crypto.createHash("sha256").update(`${salt}|${ip}|${userAgent}`).digest("hex").slice(0, 32);
}

/* ───────────── คัดบอทออก ───────────── */

// ตัวนับฝั่งหน้าเว็บทำงานผ่าน JavaScript บอทส่วนใหญ่จึงไม่ถูกนับอยู่แล้ว — ตัวนี้กันพวกที่รัน JS ได้
// (headless browser, ตัวดึงพรีวิวลิงก์ของโซเชียล, ตัวตรวจความเร็วเว็บ)
const BOT_UA = /bot|crawl|spider|slurp|facebookexternalhit|facebookcatalog|embedly|preview|lighthouse|pagespeed|headless|phantomjs|puppeteer|playwright|selenium|python|curl|wget|axios|node-fetch|undici|go-http|java\/|okhttp|scrapy|httpclient|monitor|uptime/i;

function isBot(userAgent) {
    return !userAgent || userAgent.length < 10 || BOT_UA.test(userAgent);
}

/* ───────────── อุปกรณ์ ───────────── */

function deviceType(userAgent) {
    const ua = userAgent || "";
    if (/iPad|Tablet|PlayBook|Silk|(Android(?!.*Mobile))/i.test(ua)) return "tablet";
    if (/Mobi|iPhone|iPod|Android|Windows Phone|BlackBerry|Opera Mini/i.test(ua)) return "mobile";
    return "desktop";
}

/* ───────────── มาจากไหน ───────────── */

// เรียงตามลำดับการตัดสิน: utm_source (ตั้งเองในลิงก์โฆษณา) > เบราว์เซอร์ในแอป > โดเมนต้นทาง > เข้าตรง
//
// ตรวจ "เบราว์เซอร์ในแอป" ด้วยเพราะ LINE และแอป Facebook มักไม่ส่ง referrer มาเลย ถ้าดูแค่ referrer
// ลูกค้าที่กดลิงก์จากแชท LINE/โพสต์เพจทั้งหมดจะไปกองอยู่ที่ "เข้าตรง" ทั้งที่เป็นช่องทางหลักของธุรกิจนี้
const SOURCE_RULES = [
    ["facebook", /(^|\.)(facebook\.com|fb\.com|fb\.me|messenger\.com)$/i, /FBAN|FBAV|FB_IAB|FBIOS|Messenger/i],
    ["instagram", /(^|\.)instagram\.com$/i, /Instagram/i],
    ["line", /(^|\.)(line\.me|line-apps\.com|lin\.ee)$/i, /Line\//],
    ["tiktok", /(^|\.)tiktok\.com$/i, /TikTok|musical_ly|BytedanceWebview/i],
    ["youtube", /(^|\.)(youtube\.com|youtu\.be)$/i, null],
    ["google", /(^|\.)google\.[a-z.]+$/i, null],
    ["search_other", /(^|\.)(bing\.com|yahoo\.com|duckduckgo\.com|baidu\.com|yandex\.[a-z]+)$/i, null],
];
const SOURCE_ALIASES = { fb: "facebook", ig: "instagram", "line.me": "line" };

function referrerHost(referrer) {
    if (!referrer) return null;
    try {
        return new URL(referrer).hostname.replace(/^www\./, "").toLowerCase().slice(0, 100) || null;
    } catch {
        return null;
    }
}

function classifySource({ referrer, utmSource, hasFbclid, userAgent, ownHosts = [] }) {
    const utm = String(utmSource ?? "").trim().toLowerCase().slice(0, 20);
    if (utm) return (SOURCE_ALIASES[utm] ?? utm.replace(/[^a-z0-9_-]/g, "")) || "other";
    if (hasFbclid) return "facebook";

    const ua = userAgent || "";
    for (const [name, , uaRule] of SOURCE_RULES) if (uaRule && uaRule.test(ua)) return name;

    const host = referrerHost(referrer);
    if (!host || ownHosts.includes(host)) return "direct";
    for (const [name, hostRule] of SOURCE_RULES) if (hostRule.test(host)) return name;
    return "other";
}

/* ───────────── path ───────────── */

// เก็บเฉพาะ path ไม่เคยเก็บ query string — /reset-password?token=... ถ้าเก็บทั้ง URL จะกลายเป็นว่าเรา
// เก็บ token ตั้งรหัสผ่านของลูกค้าไว้ในตารางสถิติที่แอดมินหลายคนเปิดดูได้
//
// ยุบหน้าที่มี id เฉพาะบุคคลให้เป็นกลุ่มเดียว (ใบทำข้อสอบ/คำสั่งซื้อ ของแต่ละคนไม่ควรโผล่เป็นหน้าแยกกันเป็นพัน
// แถวในรายงาน) แต่เก็บ id ชุดข้อสอบไว้ เพราะ "ชุดไหนคนดูเยอะ" คือข้อมูลที่อยากรู้จริง
const COLLAPSE = [
    [/^\/exam\/attempts\/[^/]+(\/review)?$/, (m) => `/exam/attempts/[id]${m[1] ?? ""}`],
    [/^\/orders\/[^/]+$/, () => "/orders/[id]"],
];

function normalizePath(raw) {
    let path = String(raw ?? "").split(/[?#]/)[0].trim();
    if (!path.startsWith("/") || path.startsWith("//") || path.startsWith("/api/")) return null;
    if (path.length > 1) path = path.replace(/\/+$/, "");
    for (const [re, to] of COLLAPSE) {
        const m = path.match(re);
        if (m) return to(m);
    }
    return path.slice(0, 255);
}

/* ───────────── ออนไลน์ตอนนี้ ───────────── */

// เก็บในหน่วยความจำ ไม่เขียนฐานข้อมูล — หน้าเว็บส่งสัญญาณ "ยังอยู่" ทุก 1 นาทีขณะเปิดแท็บอยู่ ถ้าเขียน DB
// ทุกครั้งจะเปลืองโดยไม่ได้ข้อมูลอะไรเพิ่ม (backend เป็น process เดียว — เหตุผลเดียวกับ rate limit)
// ข้อแลกเปลี่ยน: restart แล้วตัวเลขนี้เริ่มจาก 0 ใหม่ แต่ภายใน 1 นาทีก็กลับมาตรงเอง
//
// ต้องมีสัญญาณ "ยังอยู่" เพราะคนทำข้อสอบนั่งอยู่หน้าเดียวเป็นชั่วโมง ถ้านับแค่การเปิดหน้าใหม่
// ลูกค้ากลุ่มหลักของเว็บจะหายไปจากตัวเลข "ออนไลน์ตอนนี้" ทั้งที่กำลังใช้งานอยู่จริง
const ONLINE_WINDOW_MS = 2 * 60 * 1000;
const presence = new Map(); // visitor hash -> last seen ms

function touchPresence(hash, now = Date.now()) {
    presence.set(hash, now);
    if (presence.size > 20000) {
        for (const [key, at] of presence) if (now - at > ONLINE_WINDOW_MS) presence.delete(key);
    }
}

function countOnline(now = Date.now()) {
    let n = 0;
    for (const [key, at] of presence) {
        if (now - at <= ONLINE_WINDOW_MS) n++;
        else presence.delete(key);
    }
    return n;
}

module.exports = {
    bangkokDate, getDailySalt, visitorHash, isBot, deviceType, classifySource, referrerHost,
    normalizePath, touchPresence, countOnline, ONLINE_WINDOW_MS,
};
