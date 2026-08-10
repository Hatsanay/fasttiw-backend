const fs = require("fs/promises");
const path = require("path");
const sharp = require("sharp");
const pool = require("../config/db");
const { generateId } = require("../utils/generateId");
const { resolveUploadPath } = require("../utils/uploads");

const CHAT_ATTACHMENT_DIR = path.join(__dirname, "..", "..", "uploads", "chat-attachments");

// ─── ระบุตัวตนผู้ถามฝั่งลูกค้า — login แล้ว (req.customer จาก optionalCustomerAuth) ให้ยึด cus_id เป็นหลัก
// เสมอ ไม่สนใจ X-Guest-Id ที่อาจแนบมาด้วยก็ตาม (เผื่อ merge ไปแล้วแต่ browser ยังเก็บ guest id เก่าค้างอยู่)
// ยังไม่ login ต้องมี X-Guest-Id ถึงจะทำอะไรต่อได้ (ไม่งั้นไม่รู้ว่าเป็นการสนทนาของใคร)
function getRequesterIdentity(req) {
    const custId = req.customer?.cus_id ?? null;
    const guestId = req.headers["x-guest-id"] || null;
    return { custId, guestId };
}

function ownsConversation(conv, { custId, guestId }) {
    if (custId) return conv.conv_customer_id === custId;
    if (guestId) return !conv.conv_customer_id && conv.conv_guest_id === guestId;
    return false;
}

// หา/สร้างแชทของผู้ถามคนนี้ — จุดเดียวที่จัดการ "merge" แชทของผู้เยี่ยมชมเข้าบัญชีตอน login ระหว่างคุยอยู่:
// 1. login แล้วและมีแชทผูกบัญชีอยู่แล้ว -> ถ้ามี guestId แนบมาด้วยและมีแชทผู้เยี่ยมชม (ยังไม่ผูกใคร) ของ
//    guestId นั้นอยู่ ให้ย้ายข้อความทั้งหมดมารวมในแชทของบัญชีแล้วลบแชทผู้เยี่ยมชมทิ้ง (กันมีแชทค้าง 2 อัน)
// 2. login แล้วแต่ยังไม่เคยมีแชทของบัญชีนี้ -> ถ้ามีแชทผู้เยี่ยมชมของ guestId อยู่ ผูกเข้าบัญชีเลย (ไม่ต้องย้าย
//    ข้อความเพราะเป็นแถวเดียวกัน) ไม่มีก็สร้างใหม่
// 3. ยังไม่ login -> หา/สร้างแชทผู้เยี่ยมชมตาม guestId
// UNIQUE KEY บน conv_customer_id/conv_guest_id ป้องกัน race แทรกซ้ำซ้อน (จับ ER_DUP_ENTRY แล้ว query ซ้ำ)
async function ensureConversation({ custId, guestId }) {
    if (custId) {
        const [[ownConv]] = await pool.query("SELECT * FROM tb_chat_conversations WHERE conv_customer_id = ?", [custId]);
        if (ownConv) {
            if (guestId) {
                const [[guestConv]] = await pool.query(
                    "SELECT conv_id FROM tb_chat_conversations WHERE conv_guest_id = ? AND conv_customer_id IS NULL",
                    [guestId]
                );
                if (guestConv) {
                    await pool.query("UPDATE tb_chat_messages SET msg_conv_id = ? WHERE msg_conv_id = ?", [ownConv.conv_id, guestConv.conv_id]);
                    await pool.query("DELETE FROM tb_chat_conversations WHERE conv_id = ?", [guestConv.conv_id]);
                }
            }
            return ownConv;
        }
        if (guestId) {
            const [[guestConv]] = await pool.query(
                "SELECT * FROM tb_chat_conversations WHERE conv_guest_id = ? AND conv_customer_id IS NULL",
                [guestId]
            );
            if (guestConv) {
                await pool.query("UPDATE tb_chat_conversations SET conv_customer_id = ? WHERE conv_id = ?", [custId, guestConv.conv_id]);
                return { ...guestConv, conv_customer_id: custId };
            }
        }
        return insertConversation({ conv_customer_id: custId, conv_guest_id: null });
    }

    if (!guestId) {
        const err = new Error("ต้องมี guest id");
        err.status = 400;
        throw err;
    }
    const [[existing]] = await pool.query("SELECT * FROM tb_chat_conversations WHERE conv_guest_id = ?", [guestId]);
    if (existing) return existing;
    return insertConversation({ conv_customer_id: null, conv_guest_id: guestId });
}

async function insertConversation(fields) {
    const conv_id = await generateId("tb_chat_conversations", "CCV");
    try {
        await pool.query(
            "INSERT INTO tb_chat_conversations (conv_id, conv_customer_id, conv_guest_id) VALUES (?, ?, ?)",
            [conv_id, fields.conv_customer_id, fields.conv_guest_id]
        );
    } catch (err) {
        // ชนกับ request พร้อมกันที่กำลังสร้างแชทเดียวกันอยู่ (unique key) — คนที่ชนะไปแล้วมีแถวอยู่จริง หาแทน
        if (err.code === "ER_DUP_ENTRY") {
            const [[existing]] = await pool.query(
                fields.conv_customer_id
                    ? "SELECT * FROM tb_chat_conversations WHERE conv_customer_id = ?"
                    : "SELECT * FROM tb_chat_conversations WHERE conv_guest_id = ?",
                [fields.conv_customer_id ?? fields.conv_guest_id]
            );
            if (existing) return existing;
        }
        throw err;
    }
    const [[row]] = await pool.query("SELECT * FROM tb_chat_conversations WHERE conv_id = ?", [conv_id]);
    return row;
}

// POST /store/chat/conversation — หา/สร้างแชทของผู้ถามคนปัจจุบัน (ดูรายละเอียด merge ที่ ensureConversation)
async function ensureMyConversation(req, res, next) {
    try {
        const identity = getRequesterIdentity(req);
        const conv = await ensureConversation(identity);
        res.json({ conv_id: conv.conv_id, is_customer: !!conv.conv_customer_id });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ message: err.message });
        next(err);
    }
}

// GET /store/chat/conversation/:convId/messages — ฝั่งลูกค้าดึงข้อความของแชทตัวเอง (ไม่แตะ unread_count
// เพราะตัวนับนั้นนับ "ยังไม่อ่านโดยฝั่งแอดมิน" เท่านั้น ไม่เกี่ยวกับฝั่งลูกค้าอ่านข้อความตัวเอง)
async function getMyMessages(req, res, next) {
    try {
        const { convId } = req.params;
        const identity = getRequesterIdentity(req);
        const [[conv]] = await pool.query("SELECT * FROM tb_chat_conversations WHERE conv_id = ?", [convId]);
        if (!conv || !ownsConversation(conv, identity)) return res.status(404).json({ message: "ไม่พบแชทนี้" });

        const messages = await fetchMessages(convId, req.query.after);
        res.json({ messages });
    } catch (err) {
        next(err);
    }
}

async function fetchMessages(convId, afterMsgId) {
    const [rows] = afterMsgId
        ? await pool.query(
              `SELECT msg_id, msg_sender_type, msg_text, msg_image_urls, msg_created_at
               FROM tb_chat_messages WHERE msg_conv_id = ? AND msg_id > ? ORDER BY msg_id ASC`,
              [convId, afterMsgId]
          )
        : await pool.query(
              `SELECT msg_id, msg_sender_type, msg_text, msg_image_urls, msg_created_at
               FROM tb_chat_messages WHERE msg_conv_id = ? ORDER BY msg_id ASC`,
              [convId]
          );
    return rows;
}

const MAX_IMAGES_PER_MESSAGE = 6; // กันแนบรูปเยอะเกินไปต่อ 1 ข้อความ (ต้องตรงกับ .array("images", N) ที่ route)

async function resizeAndSaveAttachment(file) {
    await fs.mkdir(CHAT_ATTACHMENT_DIR, { recursive: true });
    const filename = `${Date.now()}-${Math.round(Math.random() * 1e9)}.webp`;
    await sharp(file.buffer)
        .resize(1200, 1200, { fit: "inside", withoutEnlargement: true })
        .webp({ quality: 80 })
        .toFile(path.join(CHAT_ATTACHMENT_DIR, filename));
    return `/uploads/chat-attachments/${filename}`;
}

// รับส่งข้อความ (ข้อความ/รูป (แนบได้หลายรูป) หรือทั้งคู่) — ใช้ร่วมกันทั้งฝั่งลูกค้า (sender_type='visitor')
// และฝั่งแอดมิน (sender_type='staff') ต่างกันแค่ใครเป็นเจ้าของแชทที่ต้องตรวจสอบ/ใครคือผู้ส่ง — ผู้เรียกส่ง
// staffId มาก็ต่อเมื่อเป็นฝั่งแอดมินเท่านั้น
async function insertMessage({ convId, senderType, staffId, text, files }) {
    const trimmedText = text?.trim() || null;
    const fileList = files ?? [];
    if (!trimmedText && fileList.length === 0) {
        const err = new Error("กรุณากรอกข้อความหรือแนบรูปอย่างน้อย 1 อย่าง");
        err.status = 400;
        throw err;
    }
    // resize ทุกไฟล์พร้อมกัน (แต่ละไฟล์อิสระต่อกัน ไม่ต้องรอทีละไฟล์) ก่อน insert ลง DB เสมอ (เหมือน pattern
    // เดิมของ resizeAndSaveFile ในระบบข่าวสาร — งานหนักไม่ควรถือ resource ของ DB ระหว่างทำ)
    const imageUrls = await Promise.all(fileList.map(resizeAndSaveAttachment));
    const msg_id = await generateId("tb_chat_messages", "CMG");
    try {
        await pool.query(
            `INSERT INTO tb_chat_messages (msg_id, msg_conv_id, msg_sender_type, msg_sender_staff_id, msg_text, msg_image_urls)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [msg_id, convId, senderType, staffId ?? null, trimmedText, imageUrls.length ? JSON.stringify(imageUrls) : null]
        );
    } catch (err) {
        await Promise.all(imageUrls.map((url) => fs.unlink(resolveUploadPath(url)).catch(() => {})));
        throw err;
    }
    if (senderType === "visitor") {
        await pool.query(
            "UPDATE tb_chat_conversations SET conv_last_message_at = NOW(), conv_unread_count = conv_unread_count + 1 WHERE conv_id = ?",
            [convId]
        );
    } else {
        await pool.query("UPDATE tb_chat_conversations SET conv_last_message_at = NOW() WHERE conv_id = ?", [convId]);
    }
    const [[row]] = await pool.query(
        "SELECT msg_id, msg_sender_type, msg_text, msg_image_urls, msg_created_at FROM tb_chat_messages WHERE msg_id = ?",
        [msg_id]
    );
    return row;
}

// POST /store/chat/conversation/:convId/messages — ฝั่งลูกค้าส่งข้อความ (multipart: text ไม่บังคับ, images
// แนบได้หลายไฟล์ ไม่บังคับ)
async function sendMyMessage(req, res, next) {
    try {
        const { convId } = req.params;
        const identity = getRequesterIdentity(req);
        const [[conv]] = await pool.query("SELECT * FROM tb_chat_conversations WHERE conv_id = ?", [convId]);
        if (!conv || !ownsConversation(conv, identity)) return res.status(404).json({ message: "ไม่พบแชทนี้" });

        const message = await insertMessage({ convId, senderType: "visitor", text: req.body.text, files: req.files });
        res.status(201).json({ message });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ message: err.message });
        next(err);
    }
}

// ─── ฝั่งแอดมิน — กล่องข้อความรวม ทุกคนที่มีสิทธิ์ chatManagement เห็น/ตอบได้ทุกแชท ────────────────────
// GET /chat/conversations — รายการแชททั้งหมด เรียงตามข้อความล่าสุด แสดงชื่อ+ป้าย "ลูกค้า"/"ผู้เยี่ยมชม"
// ให้แยกออกชัดเจน (conv_customer_id ไม่ NULL = ลูกค้าที่ login แล้ว)
async function listConversations(req, res, next) {
    try {
        const [rows] = await pool.query(`
            SELECT
                c.conv_id, c.conv_customer_id, c.conv_guest_id, c.conv_unread_count, c.conv_last_message_at,
                cus.cus_fname, cus.cus_lname, cus.cus_avatar_url,
                lm.msg_text AS last_msg_text, lm.msg_image_urls AS last_msg_image_urls, lm.msg_sender_type AS last_msg_sender_type
            FROM tb_chat_conversations c
            LEFT JOIN tb_customers cus ON cus.cus_id = c.conv_customer_id
            LEFT JOIN tb_chat_messages lm ON lm.msg_id = (
                SELECT msg_id FROM tb_chat_messages WHERE msg_conv_id = c.conv_id ORDER BY msg_id DESC LIMIT 1
            )
            ORDER BY c.conv_last_message_at DESC
        `);
        res.json({
            conversations: rows.map((r) => ({
                conv_id: r.conv_id,
                is_customer: !!r.conv_customer_id,
                customer_name: r.conv_customer_id ? `${r.cus_fname ?? ""} ${r.cus_lname ?? ""}`.trim() : null,
                customer_avatar_url: r.cus_avatar_url,
                guest_label: r.conv_customer_id ? null : `ผู้เยี่ยมชม #${r.conv_guest_id?.slice(0, 8) ?? "?"}`,
                unread_count: r.conv_unread_count,
                last_message_at: r.conv_last_message_at,
                last_message_preview: r.last_msg_text || (r.last_msg_image_urls?.length ? "📷 รูปภาพ" : ""),
                last_message_sender_type: r.last_msg_sender_type,
            })),
        });
    } catch (err) {
        next(err);
    }
}

// GET /chat/unread-count — ผลรวมข้อความที่ยังไม่ได้อ่านทุกแชทรวมกัน ใช้โชว์ badge ที่เมนู sidebar (แยก
// endpoint เบาๆ ต่างหากจาก listConversations เพราะ sidebar poll ถี่กว่าและอยากได้แค่ตัวเลขเดียว ไม่ต้อง
// join/คำนวณ preview ทุกแชทโดยไม่จำเป็น)
async function getUnreadCount(req, res, next) {
    try {
        const [[row]] = await pool.query("SELECT COALESCE(SUM(conv_unread_count), 0) AS unread_count FROM tb_chat_conversations");
        res.json({ unread_count: Number(row.unread_count) });
    } catch (err) {
        next(err);
    }
}

// GET /chat/conversations/:convId/messages — แอดมินเปิดอ่านแชท (แอดมินดูได้ทุกแชทไม่ต้องเช็คความเป็นเจ้าของ
// เหมือนฝั่งลูกค้า) การเปิดอ่านถือว่า "ทีม" อ่านแล้ว รีเซ็ต unread_count เป็น 0 (กล่องข้อความรวม ไม่แยกอ่าน
// ต่อพนักงาน)
async function getConversationMessages(req, res, next) {
    try {
        const { convId } = req.params;
        const [[conv]] = await pool.query(
            `SELECT c.conv_id, c.conv_customer_id, c.conv_guest_id, cus.cus_fname, cus.cus_lname
             FROM tb_chat_conversations c LEFT JOIN tb_customers cus ON cus.cus_id = c.conv_customer_id
             WHERE c.conv_id = ?`,
            [convId]
        );
        if (!conv) return res.status(404).json({ message: "ไม่พบแชทนี้" });

        const messages = await fetchMessages(convId, req.query.after);
        if (!req.query.after) {
            await pool.query("UPDATE tb_chat_conversations SET conv_unread_count = 0 WHERE conv_id = ?", [convId]);
        }
        res.json({
            conversation: {
                conv_id: conv.conv_id,
                is_customer: !!conv.conv_customer_id,
                customer_name: conv.conv_customer_id ? `${conv.cus_fname ?? ""} ${conv.cus_lname ?? ""}`.trim() : null,
                guest_label: conv.conv_customer_id ? null : `ผู้เยี่ยมชม #${conv.conv_guest_id?.slice(0, 8) ?? "?"}`,
            },
            messages,
        });
    } catch (err) {
        next(err);
    }
}

// POST /chat/conversations/:convId/messages — แอดมินตอบแชท (multipart: text ไม่บังคับ, images แนบได้
// หลายไฟล์ ไม่บังคับ)
async function replyToConversation(req, res, next) {
    try {
        const { convId } = req.params;
        const [[conv]] = await pool.query("SELECT conv_id FROM tb_chat_conversations WHERE conv_id = ?", [convId]);
        if (!conv) return res.status(404).json({ message: "ไม่พบแชทนี้" });

        const message = await insertMessage({
            convId, senderType: "staff", staffId: req.user.user_id, text: req.body.text, files: req.files,
        });
        res.status(201).json({ message });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ message: err.message });
        next(err);
    }
}

module.exports = {
    ensureMyConversation, getMyMessages, sendMyMessage,
    listConversations, getConversationMessages, replyToConversation, getUnreadCount,
    MAX_IMAGES_PER_MESSAGE,
};
