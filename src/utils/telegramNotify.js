// แจ้งเตือนแอดมินทาง Telegram เมื่อลูกค้า/ผู้เยี่ยมชมส่งข้อความในแชทหน้าเว็บ (2026-09-12)
//
// ส่งทางเดียว — ตอบกลับใน Telegram จะไม่ไปถึงลูกค้า ต้องกดลิงก์ไปตอบที่หน้าแอดมิน /chat
//
// degrade อย่างปลอดภัยเหมือน Stripe/SMTP: ไม่ตั้ง TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_IDS = ไม่ส่งเงียบๆ
// และ **ห้ามทำให้การส่งแชทของลูกค้าช้าหรือพัง** — ผู้เรียกไม่ต้อง await, ทุก error ถูกกลืนแล้ว log แทน
//
// ⚠ token ของ bot อยู่ใน URL ของ API (api.telegram.org/bot<TOKEN>/...) ห้าม log URL หรือ error ดิบของ fetch
// ที่อาจแนบ URL มาเด็ดขาด — log เฉพาะคำอธิบายจาก Telegram เท่านั้น

const QUIET_WINDOW_MS = 5 * 60 * 1000; // ตัดสินใจร่วมกับผู้ใช้: แจ้งครั้งแรก แล้วเงียบ 5 นาทีต่อห้อง
const STAFF_ACTIVE_MS = 2 * 60 * 1000; // แอดมินเพิ่งตอบในห้องนี้ = กำลังคุยอยู่ ไม่ต้องแจ้ง
const PREVIEW_CHARS = 200;
const REQUEST_TIMEOUT_MS = 5000;

function config() {
    const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
    const chatIds = (process.env.TELEGRAM_CHAT_IDS ?? process.env.TELEGRAM_CHAT_ID ?? "")
        .split(",").map((s) => s.trim()).filter(Boolean);
    return token && chatIds.length ? { token, chatIds } : null;
}

const isTelegramConfigured = () => !!config();

/* ───────────── ตัดสินใจว่าจะแจ้งไหม ───────────── */

// เวลาที่แจ้งห้องนั้นล่าสุด — เก็บในหน่วยความจำ (backend เป็น process เดียว เหตุผลเดียวกับ rate limit)
// restart แล้วหายไป = อาจแจ้งเกินมา 1 ครั้งเท่านั้น ไม่คุ้มเพิ่มคอลัมน์ในฐานข้อมูล
const lastNotifiedAt = new Map();

// unreadCount = จำนวนข้อความที่ยังไม่อ่าน "รวมข้อความนี้แล้ว" (1 = ข้อความแรกหลังแอดมินเปิดอ่านล่าสุด)
// lastStaffReplyAt = เวลาที่แอดมินตอบในห้องนี้ล่าสุด (null = ไม่เคยตอบ)
function shouldNotify({ convId, unreadCount, lastStaffReplyAt, now = Date.now() }) {
    // แอดมินกำลังคุยสดอยู่ — เปิดหน้าแชทอยู่แล้ว การเด้ง Telegram ทุกข้อความของลูกค้ามีแต่รบกวน
    if (lastStaffReplyAt && now - new Date(lastStaffReplyAt).getTime() < STAFF_ACTIVE_MS) return false;
    // ข้อความแรกหลังแอดมินอ่านล่าสุด (หรือห้องใหม่) — แจ้งทันที ไม่สนช่วงเงียบ
    if (unreadCount <= 1) return true;
    // ลูกค้าพิมพ์ต่อหลายข้อความระหว่างที่ยังไม่มีใครอ่าน — แจ้งซ้ำได้เมื่อพ้นช่วงเงียบแล้วเท่านั้น
    const last = lastNotifiedAt.get(convId);
    return !last || now - last >= QUIET_WINDOW_MS;
}

/* ───────────── หน้าตาข้อความ ───────────── */

// parse_mode HTML ของ Telegram — ข้อความลูกค้าต้อง escape เสมอ ไม่งั้นลูกค้าพิมพ์ "<b>" หรือ "&" แล้ว
// Telegram ปฏิเสธทั้งข้อความ (ส่งแจ้งเตือนไม่ออกเงียบๆ) หรือแย่กว่านั้นคือแทรกลิงก์หลอกลวงเข้ามาในแจ้งเตือนได้
const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function preview(text) {
    const chars = Array.from(String(text ?? "").trim()); // นับทีละตัวอักษรจริง ไม่ตัดกลางอีโมจิ/สระ
    if (chars.length <= PREVIEW_CHARS) return chars.join("");
    return chars.slice(0, PREVIEW_CHARS).join("") + "…";
}

// ใช้ใน href="..." — ต้องกัน " ด้วย (escapeHtml กันแค่ & < > ซึ่งพอสำหรับเนื้อความ แต่ไม่พอสำหรับค่าใน attribute)
const escapeAttr = (s) => escapeHtml(s).replace(/"/g, "&quot;");

// Telegram ตัดลิงก์ที่ชี้ไป "localhost" ทิ้งเงียบๆ (ส่งผ่านแต่กดไม่ได้) แต่ยอมรับ 127.0.0.1 ซึ่งคือเครื่องเดียวกัน
// ทดสอบกับ Telegram จริงแล้ว (2026-09-12): localhost → ไม่มีลิงก์ / 127.0.0.1 → กดได้
// มีผลเฉพาะตอนทดสอบบนเครื่อง — production เป็นโดเมน https ไม่ผ่านตรงนี้
function telegramLinkableUrl(url) {
    return url.replace(/^(https?:\/\/)localhost(?=[:/]|$)/i, "$1127.0.0.1");
}

function adminChatUrl(convId) {
    const base = (process.env.FRONTEND_URL || "http://localhost:3000").replace(/\/$/, "");
    return `${base}/chat?conv=${encodeURIComponent(convId)}`;
}

// วันเวลาที่ลูกค้าส่งข้อความ — ตรึงเวลาไทยเสมอ (เซิร์ฟเวอร์ production อาจเป็น UTC แล้วเวลาเพี้ยนไป 7 ชม.
// แบบเดียวกับที่ระวังในใบเสร็จอีเมล ดู CLAUDE.md ข้อ 6.1) ปีเป็น พ.ศ. ตามรูปแบบ th-TH
const SENT_AT_FORMAT = new Intl.DateTimeFormat("th-TH", {
    timeZone: "Asia/Bangkok", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
});
function formatSentAt(sentAt) {
    const d = sentAt ? new Date(sentAt) : new Date();
    return SENT_AT_FORMAT.format(Number.isNaN(d.getTime()) ? new Date() : d) + " น.";
}

function buildMessage({ convId, senderLabel, isCustomer, text, imageCount, unreadCount, sentAt }) {
    const lines = [
        `💬 <b>แชทใหม่จาก ${escapeHtml(senderLabel)}</b>${isCustomer ? "" : " (ยังไม่ได้เข้าสู่ระบบ)"}`,
        `🕒 ${formatSentAt(sentAt)}`,
    ];
    const body = preview(text);
    if (body) lines.push("", escapeHtml(body));
    if (imageCount > 0) lines.push(`📷 แนบรูป ${imageCount} รูป`);
    if (unreadCount > 1) lines.push("", `ยังไม่ได้อ่านรวม ${unreadCount} ข้อความ`);

    const url = adminChatUrl(convId);
    // production (https) ใช้ปุ่มกดใต้ข้อความ — กดง่ายที่สุดบนมือถือ
    // ตอนทดสอบบนเครื่อง (http) ใช้ลิงก์ในข้อความแทน เพราะปุ่มของ Telegram รับเฉพาะ https สาธารณะ
    const button = url.startsWith("https://") ? { inline_keyboard: [[{ text: "เปิดแชทนี้", url }]] } : null;
    lines.push("");
    if (!button) lines.push(`🔗 <a href="${escapeAttr(telegramLinkableUrl(url))}">เปิดแชทนี้</a>`);
    // ลิงก์แบบ <code> — Telegram คัดลอกให้ทันทีเมื่อแตะ (ผู้ใช้ขอให้ก๊อปลิงก์ได้) เอาไปวางในเบราว์เซอร์อื่น/ส่งต่อได้
    // ใช้ URL ตัวจริง (ไม่แปลง localhost เป็น 127.0.0.1) เพราะวางเองในเบราว์เซอร์ได้ปกติ และยังจำการเข้าสู่ระบบเดิมไว้
    lines.push(`📋 แตะเพื่อคัดลอกลิงก์: <code>${escapeHtml(url)}</code>`);
    return { text: lines.join("\n"), reply_markup: button };
}

/* ───────────── ส่ง ───────────── */

async function sendToTelegram(cfg, { text, reply_markup }) {
    const base = (process.env.TELEGRAM_API_BASE || "https://api.telegram.org").replace(/\/$/, "");
    const results = await Promise.allSettled(cfg.chatIds.map(async (chat_id) => {
        const res = await fetch(`${base}/bot${cfg.token}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id, text, parse_mode: "HTML", disable_web_page_preview: true, ...(reply_markup ? { reply_markup } : {}) }),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const data = await res.json().catch(() => ({}));
        if (!data.ok) throw new Error(`chat ${chat_id}: ${data.description ?? `HTTP ${res.status}`}`);
    }));
    for (const r of results) {
        // ไม่ log r.reason ทั้งก้อน (error ของ fetch อาจแนบ URL ที่มี token มาด้วย) — เอาแค่ข้อความ
        if (r.status === "rejected") console.error("[telegram] ส่งแจ้งเตือนไม่สำเร็จ:", String(r.reason?.name === "TimeoutError" ? "หมดเวลา" : r.reason?.message ?? r.reason).replace(/bot\d+:[\w-]+/g, "bot***"));
    }
    return results.some((r) => r.status === "fulfilled");
}

// จุดเรียกเดียวจาก chat.controller — ไม่ต้อง await (ไม่คืนค่าอะไรที่ผู้เรียกต้องใช้) ไม่ throw เด็ดขาด
async function notifyNewChatMessage({ convId, senderLabel, isCustomer, text, imageCount, unreadCount, lastStaffReplyAt, sentAt }) {
    try {
        const cfg = config();
        if (!cfg) return false;
        if (!shouldNotify({ convId, unreadCount, lastStaffReplyAt })) return false;
        // ตั้งเวลาก่อนส่ง (ไม่ใช่หลังส่งเสร็จ) กันสองข้อความที่เข้ามาพร้อมกันแจ้งซ้ำทั้งคู่
        lastNotifiedAt.set(convId, Date.now());
        return await sendToTelegram(cfg, buildMessage({ convId, senderLabel, isCustomer, text, imageCount, unreadCount, sentAt }));
    } catch (err) {
        console.error("[telegram] แจ้งเตือนผิดพลาด:", err.message);
        return false;
    }
}

module.exports = {
    notifyNewChatMessage, isTelegramConfigured,
    // สำหรับทดสอบ / สคริปต์ตั้งค่า
    shouldNotify, buildMessage, escapeHtml, preview, formatSentAt, sendToTelegram, config, lastNotifiedAt,
    QUIET_WINDOW_MS, STAFF_ACTIVE_MS,
};
