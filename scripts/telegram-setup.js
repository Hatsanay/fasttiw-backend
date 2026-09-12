// ตัวช่วยตั้งค่าแจ้งเตือนแชททาง Telegram — ใช้หลังสร้าง bot แล้ว ไม่ต้องไปงมหา chat id เอง
//
//   npm run telegram:setup           ตรวจ token + แสดงรายชื่อกลุ่ม/แชทที่ bot เห็น พร้อมบรรทัดที่ต้องใส่ใน .env
//   npm run telegram:setup -- test   ส่งข้อความทดสอบ (หน้าตาเดียวกับแจ้งเตือนจริง) ไปทุก chat ใน TELEGRAM_CHAT_IDS
//
// ขั้นตอนก่อนรัน:
//   1. ใน Telegram คุยกับ @BotFather → /newbot → ได้ token → ใส่ TELEGRAM_BOT_TOKEN ใน .env
//   2. เพิ่ม bot เข้ากลุ่มของแอดมิน (หรือกด Start ในแชทส่วนตัวกับ bot) แล้วพิมพ์อะไรก็ได้ 1 ข้อความในกลุ่มนั้น
//   3. รันสคริปต์นี้ — จะเห็น chat id ของกลุ่ม คัดลอกไปใส่ TELEGRAM_CHAT_IDS แล้วรีสตาร์ท backend
//
// ไม่พิมพ์ token ออกหน้าจอเด็ดขาด
require("dotenv").config();
const { buildMessage, sendToTelegram, config } = require("../src/utils/telegramNotify");

const API = (process.env.TELEGRAM_API_BASE || "https://api.telegram.org").replace(/\/$/, "");

async function call(token, method) {
    const res = await fetch(`${API}/bot${token}/${method}`, { signal: AbortSignal.timeout(10000) });
    return res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
}

async function main() {
    const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
    if (!token) {
        console.error("✖ ยังไม่ได้ตั้ง TELEGRAM_BOT_TOKEN ใน .env — สร้าง bot กับ @BotFather ใน Telegram ก่อน (ดูวิธีที่หัวไฟล์นี้)");
        process.exitCode = 1;
        return;
    }

    const me = await call(token, "getMe");
    if (!me.ok) {
        console.error(`✖ token ใช้ไม่ได้: ${me.description ?? "ไม่ทราบสาเหตุ"} — ตรวจว่าคัดลอกมาครบทั้งบรรทัด`);
        process.exitCode = 1;
        return;
    }
    console.log(`✓ token ใช้ได้ — bot ชื่อ @${me.result.username}`);

    if (process.argv[2] === "test") {
        const cfg = config();
        if (!cfg) {
            console.error("✖ ยังไม่ได้ตั้ง TELEGRAM_CHAT_IDS ใน .env — รัน npm run telegram:setup (ไม่ต้องใส่ test) เพื่อหา chat id ก่อน");
            process.exitCode = 1;
            return;
        }
        const ok = await sendToTelegram(cfg, buildMessage({
            convId: "CCVTEST",
            senderLabel: "ลูกค้าทดสอบ",
            isCustomer: true,
            text: "นี่คือข้อความทดสอบจากระบบแจ้งเตือนแชทของ Fasttiw — ถ้าเห็นข้อความนี้แปลว่าตั้งค่าเสร็จแล้ว",
            imageCount: 1,
            unreadCount: 1,
        }));
        console.log(ok ? `✓ ส่งข้อความทดสอบแล้ว (${cfg.chatIds.length} ปลายทาง) — ไปดูใน Telegram ได้เลย` : "✖ ส่งไม่สำเร็จ ดูสาเหตุด้านบน");
        if (!ok) process.exitCode = 1;
        return;
    }

    // หากลุ่ม/แชทที่ bot เห็นจากข้อความล่าสุด — Telegram เก็บไว้ให้ 24 ชม. ถ้าว่างให้พิมพ์ในกลุ่มใหม่อีกครั้ง
    const updates = await call(token, "getUpdates");
    if (!updates.ok) {
        // bot ที่เคยตั้ง webhook ไว้จะเรียก getUpdates ไม่ได้ — ระบบเราไม่ได้ใช้ webhook ของ Telegram
        console.error(`✖ อ่านข้อความล่าสุดไม่ได้: ${updates.description}`);
        process.exitCode = 1;
        return;
    }
    const chats = new Map();
    for (const u of updates.result) {
        const chat = (u.message ?? u.channel_post ?? u.my_chat_member ?? u.edited_message)?.chat;
        if (chat) chats.set(chat.id, chat);
    }
    if (chats.size === 0) {
        console.log("\nยังไม่เห็นแชทไหนเลย — เพิ่ม bot เข้ากลุ่ม (หรือกด Start ในแชทส่วนตัว) แล้วพิมพ์อะไรก็ได้ 1 ข้อความ จากนั้นรันใหม่");
        console.log("ถ้าเป็นกลุ่มแล้วยังไม่เห็น: ที่ @BotFather → /setprivacy → เลือก bot → Disable (ให้ bot อ่านข้อความในกลุ่มได้)");
        return;
    }
    console.log("\nแชทที่ bot เห็น:");
    for (const c of chats.values()) {
        const name = c.title ?? [c.first_name, c.last_name].filter(Boolean).join(" ") ?? c.username;
        const kind = c.type === "private" ? "แชทส่วนตัว" : c.type === "channel" ? "ช่อง" : "กลุ่ม";
        console.log(`  ${String(c.id).padEnd(16)} ${kind.padEnd(12)} ${name}`);
    }
    console.log("\nคัดลอก id ของแชทที่ต้องการไปใส่ใน backend/.env (หลายที่คั่นด้วย , ได้) เช่น:");
    console.log(`  TELEGRAM_CHAT_IDS=${[...chats.keys()][0]}`);
    console.log("แล้วรีสตาร์ท backend จากนั้นทดสอบด้วย: npm run telegram:setup -- test");
}

main().catch((err) => {
    console.error("✖ เชื่อมต่อ Telegram ไม่ได้:", err.name === "TimeoutError" ? "หมดเวลา" : err.message);
    process.exitCode = 1;
});
