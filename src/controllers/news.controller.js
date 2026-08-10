const fs = require("fs/promises");
const path = require("path");
const sharp = require("sharp");
const pool = require("../config/db");
const { generateId, generateIds } = require("../utils/generateId");
const { resolveUploadPath } = require("../utils/uploads");

const NEWS_BLOCK_DIR = path.join(__dirname, "..", "..", "uploads", "news-blocks");

// องค์ประกอบพื้นฐาน (ประกอบเองอิสระ) + widget สำเร็จรูป (รูป+ข้อความจัดหน้าไว้ให้แล้ว) — card_set/carousel
// ต่างจากที่เหลือตรงที่เนื้อหาจริงอยู่ใน tb_news_block_items (มีหลายชิ้นซ้ำกันในหนึ่ง widget) ไม่ใช่คอลัมน์
// ของ tb_news_blocks เอง — CELL_TYPES คือสิ่งที่วางในกริดของ widget "สร้างเอง" (custom) ได้ ไม่รวม custom
// เองกันซ้อนไม่รู้จบ (custom ภายใน custom) ส่วน BLOCK_TYPES คือ blk_type ที่ใช้ในฟีดหลักได้ทั้งหมด
const SIMPLE_TYPES = ["text", "image", "heading", "button", "post", "card", "youtube"];
const REPEATING_TYPES = ["card_set", "carousel"];
const CELL_TYPES = [...SIMPLE_TYPES, ...REPEATING_TYPES];
const BLOCK_TYPES = [...CELL_TYPES, "custom"];

// รูปแบบลิงก์ YouTube ที่ยอมรับ — watch?v=, youtu.be/, embed/, shorts/ (ครอบคลุมลิงก์ที่คนก็อปมาปกติทุกแบบ)
// เช็คแค่ "หน้าตาเหมือนลิงก์ YouTube" หยาบๆ ไม่ได้ยิง request ไปเช็คว่าวิดีโอมีจริงไหม (เหมือนลิงก์ปุ่ม/card
// อื่นๆ ที่ไม่เคยเช็ค URL จริงจังขนาดนั้น) กันแค่พิมพ์ผิด/วางลิงก์เว็บอื่นมาผิดที่
const YOUTUBE_URL_PATTERN = /^https?:\/\/(www\.)?(youtube\.com\/(watch\?v=|embed\/|shorts\/)|youtu\.be\/)[\w-]+/i;

// จำนวนการ์ดที่โชว์พร้อมกันในแถวเลื่อนแนวนอนของ card_set — จำกัดช่วงไว้กันค่าประหลาด (0, ติดลบ, เยอะเกินจน
// เลย์เอาต์พัง) ไม่ใช่ตัวเลขจาก client ตรงๆ
function clampItemsPerView(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 4;
    return Math.min(8, Math.max(1, Math.round(n)));
}

// ตรวจ type/เนื้อหาของ 1 ช่อง (ใช้ร่วมกันทั้ง widget พื้นฐานในฟีดหลัก และช่องในกริดของ widget "สร้างเอง")
// คืนข้อความ error หรือ null ถ้าผ่าน — label ใช้บอกตำแหน่งที่ผิดให้ตรงบริบท (widget ที่ N / องค์ประกอบที่ N)
function validateCellContent(c, label) {
    if ((c.blk_type === "text" || c.blk_type === "heading") && !c.blk_text?.trim()) {
        return `${label}: กรุณากรอกข้อความ`;
    }
    if (c.blk_type === "button") {
        if (!c.blk_text?.trim()) return `${label}: กรุณากรอกข้อความบนปุ่ม`;
        if (!c.blk_link_url?.trim()) return `${label}: กรุณากรอกลิงก์ปลายทาง`;
    }
    if (c.blk_type === "post" && !c.blk_text?.trim()) return `${label} (โพสทั่วไป): กรุณากรอกเนื้อหา`;
    if (c.blk_type === "card" && !c.blk_title?.trim()) return `${label} (Card): กรุณากรอกหัวข้อการ์ด`;
    if (c.blk_type === "youtube") {
        if (!c.blk_link_url?.trim()) return `${label} (YouTube): กรุณาใส่ลิงก์วิดีโอ`;
        if (!YOUTUBE_URL_PATTERN.test(c.blk_link_url.trim())) return `${label} (YouTube): ลิงก์ไม่ใช่รูปแบบ YouTube ที่รู้จัก`;
    }
    if (REPEATING_TYPES.includes(c.blk_type)) {
        if (!Array.isArray(c.items) || c.items.length === 0) {
            return `${label}: กรุณาเพิ่มอย่างน้อย 1 รายการ`;
        }
        // เดิมเช็คแค่ "มีอย่างน้อย 1 รายการ" ไม่เคยเช็คว่าแต่ละรายการมีเนื้อหาจริงไหม — การ์ด/สไลด์ที่กรอกว่าง
        // เปล่าสนิท (เช่น กด "+ เพิ่ม Card" ทิ้งไว้เฉยๆ ไม่กรอกอะไรเลย) จึงเคยผ่านการตรวจสอบและถูกบันทึก/เผยแพร่
        // ได้ กลายเป็นการ์ดว่างโผล่ในฟีดจริง ต่างจาก widget แบบอื่นทุกแบบที่บังคับมีเนื้อหาอย่างน้อย 1 อย่างเสมอ
        for (let i = 0; i < c.items.length; i++) {
            const it = c.items[i];
            if (!it.item_title?.trim() && !it.item_text?.trim() && !it.item_image_url) {
                return `${label}: รายการที่ ${i + 1} ต้องกรอกข้อความหรือแนบรูปอย่างน้อย 1 อย่าง`;
            }
        }
    }
    return null;
}

function validateBlocks(blocks) {
    if (!Array.isArray(blocks)) return "รูปแบบข้อมูลไม่ถูกต้อง";
    for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        if (!BLOCK_TYPES.includes(b?.blk_type)) return `widget ที่ ${i + 1}: ประเภทไม่ถูกต้อง`;
        if (b.blk_type === "custom") {
            const structError = validateStructure(b.blk_custom_structure);
            if (structError) return `widget ที่ ${i + 1} (สร้างเอง): ${structError}`;
            continue;
        }
        const err = validateCellContent(b, `widget ที่ ${i + 1}`);
        if (err) return err;
    }
    return null;
}

// ตรวจแค่โครงสร้าง (key/type/ตำแหน่ง/ขนาด) ไม่ตรวจเนื้อหา — ใช้ร่วมกันทั้ง validateTemplateStructure และ
// validateStructure ด้านล่าง
function validateCellStructural(c, label) {
    if (!c?.key || typeof c.key !== "string") return `${label}: ไม่มี key`;
    if (!CELL_TYPES.includes(c.blk_type)) return `${label}: ประเภทไม่ถูกต้อง`;
    if (![c.x, c.y, c.w, c.h].every((n) => Number.isInteger(n) && n >= 0)) return `${label}: ตำแหน่ง/ขนาดไม่ถูกต้อง`;
    if (c.w < 1 || c.h < 1 || c.x + c.w > 12) return `${label}: ขนาด/ตำแหน่งเกินขอบเขตกริด`;
    return null;
}

// โครงสร้างของ widget "สร้างเอง" ตอนออกแบบเป็น template — ตรวจแค่โครงสร้าง (type/ตำแหน่ง/ขนาด) เท่านั้น
// ไม่บังคับกรอกเนื้อหา เพราะ template คือ "widget สำเร็จรูปเปล่าๆ" (เหมือน Card/Post ที่เป็นแค่รูปแบบว่าง)
// รอให้กรอกเนื้อหาจริงตอนถูกลากไปใช้ในฟีดต่างหาก
function validateTemplateStructure(cells) {
    if (!Array.isArray(cells) || cells.length === 0) return "กรุณาเพิ่มอย่างน้อย 1 องค์ประกอบใน widget";
    for (let i = 0; i < cells.length; i++) {
        const err = validateCellStructural(cells[i], `องค์ประกอบที่ ${i + 1}`);
        if (err) return err;
    }
    return null;
}

// โครงสร้างของ widget "สร้างเอง" ตอนถูกใช้งานจริงเป็น custom block ในฟีดหลัก — ตรวจทั้งโครงสร้างและเนื้อหา
// เหมือน widget แบบอื่นทุกตัว (ต้องกรอกเนื้อหาจริงก่อนถึงจะบันทึกเข้าฟีดได้ ไม่ปล่อยว่างเหมือนตอนเป็น
// template เปล่าๆ)
function validateStructure(cells) {
    if (!Array.isArray(cells) || cells.length === 0) return "กรุณาเพิ่มอย่างน้อย 1 องค์ประกอบใน widget";
    for (let i = 0; i < cells.length; i++) {
        const c = cells[i];
        const label = `องค์ประกอบที่ ${i + 1}`;
        const structErr = validateCellStructural(c, label);
        if (structErr) return structErr;
        const err = validateCellContent(c, label);
        if (err) return err;
    }
    return null;
}

// รวมค่า blk_* ตาม type ของ block เดียว — field ที่ไม่เกี่ยวกับ type นั้นถูกบังคับเป็น NULL เสมอ กันข้อมูลขยะ
// ติดมาจาก client (เช่น ส่ง blk_link_url มาทั้งที่เป็น text block)
function pickBlockFields(b) {
    return {
        blk_title: (b.blk_type === "post" || b.blk_type === "card") ? (b.blk_title || null) : null,
        blk_text: (b.blk_type === "text" || b.blk_type === "heading" || b.blk_type === "button" || b.blk_type === "post" || b.blk_type === "card")
            ? (b.blk_text || null) : null,
        blk_link_url: (b.blk_type === "button" || b.blk_type === "card" || b.blk_type === "youtube") ? (b.blk_link_url || null) : null,
        blk_link_label: b.blk_type === "card" ? (b.blk_link_label || null) : null,
        blk_items_per_view: b.blk_type === "card_set" ? clampItemsPerView(b.blk_items_per_view) : 4,
    };
}

// เหมือน pickBlockFields แต่คืนเป็น key ของ cell (blk_* -> ตรงตัวเดียวกัน เพราะ cell ใช้ shape เดียวกับ
// block พื้นฐานทุกประการ ต่างแค่มี key/x/y/w/h เพิ่มมา) ไม่แตะ image_url/items เพราะผู้เรียกต้อง whitelist เอง
function pickCellFields(c) {
    const fields = pickBlockFields(c);
    return { key: c.key, blk_type: c.blk_type, x: c.x, y: c.y, w: c.w, h: c.h, ...fields };
}

// เก็บ URL รูปทั้งหมดที่อยู่ในโครงสร้าง (ทั้งระดับ cell และ item ย่อยของ card_set/carousel ที่ซ้อนอยู่ข้างใน)
// ใช้ทั้งตอน whitelist รูป carry-over และตอนลบไฟล์กำพร้าหลังบันทึก
function collectImageUrls(cells) {
    if (!Array.isArray(cells)) return [];
    const urls = [];
    for (const c of cells) {
        if (c.blk_image_url) urls.push(c.blk_image_url);
        for (const it of c.items ?? []) {
            if (it.item_image_url) urls.push(it.item_image_url);
        }
    }
    return urls;
}

// whitelist รูปในโครงสร้างใหม่เทียบกับ URL ที่มีอยู่จริงก่อนบันทึกครั้งนี้ (กันช่องโหว่ path traversal ตอน
// carry-over เหมือน block/item ปกติ) คืนโครงสร้างที่ sanitize แล้วพร้อม insert/เก็บลง JSON
function sanitizeStructure(cells, existingUrls) {
    return (Array.isArray(cells) ? cells : []).map((c) => ({
        ...pickCellFields(c),
        blk_image_url: c.blk_image_url && existingUrls.has(c.blk_image_url) ? c.blk_image_url : null,
        items: REPEATING_TYPES.includes(c.blk_type) && Array.isArray(c.items)
            ? c.items.map((it) => ({
                  key: it.key,
                  item_title: it.item_title || null,
                  item_text: it.item_text || null,
                  item_image_url: it.item_image_url && existingUrls.has(it.item_image_url) ? it.item_image_url : null,
                  item_link_url: it.item_link_url || null,
                  item_link_label: it.item_link_label || null,
              }))
            : [],
    }));
}

// แนบ items (ชุด Card/Carousel เท่านั้น มีค่าอาร์เรย์ว่างสำหรับ widget แบบอื่น) เข้ากับแต่ละ block ตาม
// ลำดับ item_order — ใช้ร่วมกันทั้ง getAll (แอดมิน) และ getPublished (ลูกค้า) — custom ไม่มีแถวใน
// tb_news_block_items เลย (เนื้อหาอยู่ใน blk_custom_structure แทน) จึงได้ items: [] ว่างเปล่าตามปกติ
async function attachItems(blocks) {
    if (blocks.length === 0) return blocks;
    const [items] = await pool.query(
        `SELECT item_id, item_block_id, item_order, item_image_url, item_title, item_text, item_link_url, item_link_label
         FROM tb_news_block_items WHERE item_block_id IN (?) ORDER BY item_order`,
        [blocks.map((b) => b.blk_id)]
    );
    const itemsByBlock = {};
    for (const it of items) (itemsByBlock[it.item_block_id] ??= []).push(it);
    return blocks.map((b) => ({ ...b, items: itemsByBlock[b.blk_id] ?? [] }));
}

// แอดมินเห็นทุก widget ไม่ว่าสถานะไหน (draft/published) เพราะกำลังแก้ไข feed เดียวกันตลอด ไม่มี "โพสต์"
// แยกให้เลือกว่ากำลังดูอันไหนอยู่แล้ว
async function getAll(req, res, next) {
    try {
        const [blocks] = await pool.query(
            `SELECT blk_id, blk_type, blk_order, blk_status, blk_show_on_landing, blk_title, blk_text, blk_image_url, blk_link_url, blk_link_label, blk_items_per_view, blk_custom_structure
             FROM tb_news_blocks ORDER BY blk_order`
        );
        res.json({ blocks: await attachItems(blocks) });
    } catch (err) {
        next(err);
    }
}

// insert block + (ถ้าเป็น card_set/carousel) items ลูกของมัน คืน item_ids ของ block นั้นกลับไป
async function insertBlockWithItems(conn, order, blockId, blkImageUrl, blockInput, itemIds, itemImageUrls, updatedById) {
    const fields = pickBlockFields(blockInput);
    const status = blockInput.blk_status === "published" ? "published" : "draft";
    // เผยแพร่ใน landing page เป็นอิสระจาก status โดยตั้งใจ (ติ๊กไว้ตอนยัง draft ก็ขึ้นหน้าแรกได้เลย) ทุก type
    // ตั้งได้เหมือนกัน (ไม่ผูกกับ blk_type แบบ field อื่นใน pickBlockFields) จึงเก็บตรงนี้คู่กับ status ไปเลย
    const showOnLanding = blockInput.blk_show_on_landing ? 1 : 0;
    const customStructure = blockInput.blk_type === "custom" ? JSON.stringify(blockInput.blk_custom_structure ?? []) : null;
    await conn.query(
        `INSERT INTO tb_news_blocks (blk_id, blk_order, blk_status, blk_show_on_landing, blk_type, blk_title, blk_text, blk_image_url, blk_link_url, blk_link_label, blk_items_per_view, blk_custom_structure, blk_updated_by_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [blockId, order, status, showOnLanding, blockInput.blk_type, fields.blk_title, fields.blk_text, blkImageUrl, fields.blk_link_url, fields.blk_link_label, fields.blk_items_per_view, customStructure, updatedById]
    );

    if (!REPEATING_TYPES.includes(blockInput.blk_type)) return [];

    const items = Array.isArray(blockInput.items) ? blockInput.items : [];
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        await conn.query(
            `INSERT INTO tb_news_block_items (item_id, item_block_id, item_order, item_title, item_text, item_image_url, item_link_url, item_link_label)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [itemIds[i], blockId, i, item.item_title || null, item.item_text || null, itemImageUrls[i] ?? null, item.item_link_url || null, item.item_link_label || null]
        );
    }
    return itemIds.slice(0, items.length);
}

// บันทึกทั้ง feed ในคำขอเดียว (ลบของเดิมทั้งหมดแล้วสร้างใหม่ตามลำดับที่ส่งมา) — ไม่มีตารางอื่นผูก FK กลับมา
// ที่ tb_news_blocks/tb_news_block_items เลย จึงลบ+สร้างใหม่ได้ปลอดภัยเสมอ (item ลูกหายตาม CASCADE ไปด้วย)
// แต่ยังต้อง whitelist รูปภาพเดิม (block + item + รูปที่ซ้อนอยู่ใน blk_custom_structure ของ widget สร้างเอง)
// เหมือนเดิมกันช่องโหว่ path traversal ตอน carry-over — เทียบกับ "รูปทั้งหมดที่มีอยู่ก่อนบันทึกครั้งนี้"
// ไม่ใช่เทียบต่อ block เดียวกัน เพราะทุก block ถูกสร้าง blk_id ใหม่หมดทุกครั้งอยู่แล้ว (ไม่มี id เดิมให้ผูกกลับ)
async function save(req, res, next) {
    const conn = await pool.getConnection();
    try {
        const { blocks } = req.body ?? {};
        const blocksError = validateBlocks(blocks);
        if (blocksError) return res.status(400).json({ message: blocksError });

        const [oldBlocks] = await pool.query("SELECT blk_id, blk_image_url, blk_custom_structure FROM tb_news_blocks");
        const [oldItems] = await pool.query(
            `SELECT item_id, item_image_url FROM tb_news_block_items WHERE item_block_id IN (?)`,
            [oldBlocks.length ? oldBlocks.map((b) => b.blk_id) : [""]]
        );

        const existingImageUrls = new Set([
            ...oldBlocks.map((b) => b.blk_image_url).filter(Boolean),
            ...oldBlocks.flatMap((b) => collectImageUrls(b.blk_custom_structure)),
            ...oldItems.map((i) => i.item_image_url).filter(Boolean),
        ]);

        const sanitizedBlocks = blocks.map((b) => {
            if (b.blk_type === "custom") {
                return {
                    ...b,
                    blk_image_url: null,
                    blk_custom_structure: sanitizeStructure(b.blk_custom_structure, existingImageUrls),
                    items: [],
                };
            }
            return {
                ...b,
                blk_image_url: b.blk_image_url && existingImageUrls.has(b.blk_image_url) ? b.blk_image_url : null,
                blk_custom_structure: null,
                items: REPEATING_TYPES.includes(b.blk_type) && Array.isArray(b.items)
                    ? b.items.map((item) => ({
                          ...item,
                          item_image_url: item.item_image_url && existingImageUrls.has(item.item_image_url) ? item.item_image_url : null,
                      }))
                    : [],
            };
        });

        const keptImageUrls = new Set([
            ...sanitizedBlocks.map((b) => b.blk_image_url).filter(Boolean),
            ...sanitizedBlocks.flatMap((b) => collectImageUrls(b.blk_custom_structure)),
            ...sanitizedBlocks.flatMap((b) => b.items.map((i) => i.item_image_url)).filter(Boolean),
        ]);

        // generateIds คืน [] ถ้า count เป็น 0 (เช่น บันทึกฟีดว่างเปล่าเพื่อล้างทั้งหมด) ต้อง guard ไว้ก่อนเรียก
        // เพราะฟังก์ชันนี้เอา ids[ids.length - 1] ไปใช้ต่อ ถ้าอาร์เรย์ว่างจะได้ undefined แล้วพังตอน INSERT
        const blockIds = sanitizedBlocks.length > 0 ? await generateIds("tb_news_blocks", "NEB", sanitizedBlocks.length) : [];
        const totalItems = sanitizedBlocks.reduce((sum, b) => sum + b.items.length, 0);
        const allItemIds = totalItems > 0 ? await generateIds("tb_news_block_items", "NEI", totalItems) : [];

        await conn.beginTransaction();
        await conn.query("DELETE FROM tb_news_blocks");

        let itemCursor = 0;
        const itemIdsByBlock = [];
        for (let i = 0; i < sanitizedBlocks.length; i++) {
            const b = sanitizedBlocks[i];
            const itemIdsForThisBlock = allItemIds.slice(itemCursor, itemCursor + b.items.length);
            itemCursor += b.items.length;
            const itemImageUrls = b.items.map((item) => item.item_image_url);
            const ids = await insertBlockWithItems(conn, i, blockIds[i], b.blk_image_url, b, itemIdsForThisBlock, itemImageUrls, req.user.user_id);
            itemIdsByBlock.push(ids);
        }
        await conn.commit();

        await Promise.all([
            ...oldBlocks.filter((b) => b.blk_image_url && !keptImageUrls.has(b.blk_image_url))
                .map((b) => fs.unlink(resolveUploadPath(b.blk_image_url)).catch(() => {})),
            ...oldBlocks.flatMap((b) => collectImageUrls(b.blk_custom_structure))
                .filter((url) => !keptImageUrls.has(url))
                .map((url) => fs.unlink(resolveUploadPath(url)).catch(() => {})),
            ...oldItems.filter((i) => i.item_image_url && !keptImageUrls.has(i.item_image_url))
                .map((i) => fs.unlink(resolveUploadPath(i.item_image_url)).catch(() => {})),
        ]);

        res.json({ message: "บันทึกข่าวสารสำเร็จ", block_ids: blockIds, item_ids: itemIdsByBlock });
    } catch (err) {
        await conn.rollback();
        next(err);
    } finally {
        conn.release();
    }
}

// resize + บีบเป็น webp เหมือนรูปหน้าปกชุดข้อสอบ (fit:"inside" กันครอปเสีย เพราะภาพประกาศข่าวมักเป็น
// โปสเตอร์/แบนเนอร์ที่มีอัตราส่วนหลากหลาย ไม่ควรถูกบังคับตัดเป็นสี่เหลี่ยมจัตุรัส)
async function resizeAndSaveFile(file) {
    await fs.mkdir(NEWS_BLOCK_DIR, { recursive: true });
    const filename = `${Date.now()}-${Math.round(Math.random() * 1e9)}.webp`;
    await sharp(file.buffer)
        .resize(1200, 1200, { fit: "inside", withoutEnlargement: true })
        .webp({ quality: 80 })
        .toFile(path.join(NEWS_BLOCK_DIR, filename));
    return `/uploads/news-blocks/${filename}`;
}

// lock แถวด้วย FOR UPDATE เหมือน saveResizedImageInStructure แม้ตรงนี้จะ UPDATE คอลัมน์เดียวตรงๆ (ไม่ได้อ่าน-
// แก้ไข-เขียน JSON ก้อนใหญ่) ก็ตาม เพราะถ้าอัปโหลด 2 คำขอชนกันแบบไม่ล็อก (เช่น กด "บันทึก" ซ้ำสองครั้งเร็วๆ
// ก่อนปุ่มจะ disable) ทั้งคู่จะอ่าน oldUrl ตัวเดียวกัน แล้วลบไฟล์นั้นซ้ำกัน — คำขอที่แพ้ (อัปเดตคอลัมน์ก่อน
// แต่ถูกคำขอหลังทับ) จะไม่มีใครรู้ว่าต้องลบไฟล์ของตัวเองทิ้ง กลายเป็นไฟล์กำพร้าค้างอยู่ตลอดไป
async function saveResizedImage({ table, idColumn, imageColumn, id, file, notFoundMessage }) {
    const url = await resizeAndSaveFile(file);
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [rows] = await conn.query(`SELECT ${imageColumn} FROM ${table} WHERE ${idColumn} = ? FOR UPDATE`, [id]);
        if (!rows[0]) {
            const err = new Error(notFoundMessage);
            err.status = 404;
            throw err;
        }
        const oldUrl = rows[0][imageColumn];
        await conn.query(`UPDATE ${table} SET ${imageColumn} = ? WHERE ${idColumn} = ?`, [url, id]);
        await conn.commit();
        if (oldUrl) await fs.unlink(resolveUploadPath(oldUrl)).catch(() => {});
        return url;
    } catch (err) {
        await conn.rollback();
        await fs.unlink(resolveUploadPath(url)).catch(() => {});
        throw err;
    } finally {
        conn.release();
    }
}

// รูปของ 1 ช่องในโครงสร้าง JSON (ใช้ทั้ง blk_custom_structure ของ custom block และ tpl_structure ของ
// template) — ต่างจาก saveResizedImage เพราะรูปไม่ได้เป็นคอลัมน์ตรงๆ ต้องอ่าน/แก้/เขียน JSON ทั้งก้อนกลับ
// อ่าน-แก้ไข-เขียน JSON ทั้งก้อนกลับ (ต่างจาก saveResizedImage ที่ UPDATE คอลัมน์เดียวตรงๆ อะตอมมิกอยู่แล้ว)
// ถ้าอัปโหลดรูปหลายรูปในบล็อก/template เดียวกันพร้อมกัน (เช่น เพิ่งลากรูปใส่ 2-3 ช่องในกริดเดียวกันแล้วกด
// "บันทึกการเปลี่ยนแปลง" ทีเดียว — ฝั่ง client ยิงอัปโหลดพร้อมกันหมดด้วย Promise.all) แต่ละคำขอจะ
// SELECT-แก้ไข-UPDATE คอลัมน์เดียวกันแข่งกัน ถ้าไม่ล็อกแถวไว้ คำขอที่สองจะอ่านค่าเก่าที่ยังไม่เห็นการแก้ไข
// ของคำขอแรก แล้วเขียนทับกลืนการแก้ไขนั้นหายไปเงียบๆ (lost update) — จึง lock แถวด้วย FOR UPDATE ในทรานแซกชัน
// เดียวกัน บังคับให้คำขอที่มาทีหลังต้องรอคำขอแรก commit ก่อนแล้วค่อยเห็นผลลัพธ์ล่าสุดจริง
// resize รูป (งานหนัก) ทำก่อนเปิดทรานแซกชันเสมอ ไม่ถือ row lock ระหว่างประมวลผลภาพนานๆ
async function saveResizedImageInStructure({ table, idColumn, structureColumn, id, cellKey, itemKey, file, notFoundMessage }) {
    const url = await resizeAndSaveFile(file);
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [rows] = await conn.query(`SELECT ${structureColumn} FROM ${table} WHERE ${idColumn} = ? FOR UPDATE`, [id]);
        if (!rows[0]) {
            const err = new Error(notFoundMessage);
            err.status = 404;
            throw err;
        }
        const structure = Array.isArray(rows[0][structureColumn]) ? rows[0][structureColumn] : [];
        const cell = structure.find((c) => c.key === cellKey);
        if (!cell) {
            const err = new Error("ไม่พบช่องนี้ใน widget");
            err.status = 404;
            throw err;
        }

        let oldUrl;
        if (itemKey) {
            const item = (cell.items ?? []).find((it) => it.key === itemKey);
            if (!item) {
                const err = new Error("ไม่พบรายการนี้");
                err.status = 404;
                throw err;
            }
            oldUrl = item.item_image_url;
            item.item_image_url = url;
        } else {
            oldUrl = cell.blk_image_url;
            cell.blk_image_url = url;
        }

        await conn.query(`UPDATE ${table} SET ${structureColumn} = ? WHERE ${idColumn} = ?`, [JSON.stringify(structure), id]);
        await conn.commit();
        if (oldUrl) await fs.unlink(resolveUploadPath(oldUrl)).catch(() => {});
        return url;
    } catch (err) {
        await conn.rollback();
        await fs.unlink(resolveUploadPath(url)).catch(() => {}); // รูปที่ resize/เซฟไว้ก่อนหน้าแล้วกลายเป็นขยะ เพราะทรานแซกชันไม่สำเร็จ
        throw err;
    } finally {
        conn.release();
    }
}

async function uploadBlockImage(req, res, next) {
    try {
        if (!req.file) return res.status(400).json({ message: "ไม่พบไฟล์รูปภาพ" });
        const blk_image_url = await saveResizedImage({
            table: "tb_news_blocks", idColumn: "blk_id", imageColumn: "blk_image_url",
            id: req.params.blockId, file: req.file, notFoundMessage: "ไม่พบ widget นี้",
        });
        res.json({ blk_image_url });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ message: err.message });
        next(err);
    }
}

// รูปของ 1 รายการย่อยใน widget แบบชุด Card/Carousel (tb_news_block_items) — คนละ endpoint จาก
// uploadBlockImage เพราะเป็นคนละตาราง/คอลัมน์กัน
async function uploadItemImage(req, res, next) {
    try {
        if (!req.file) return res.status(400).json({ message: "ไม่พบไฟล์รูปภาพ" });
        const item_image_url = await saveResizedImage({
            table: "tb_news_block_items", idColumn: "item_id", imageColumn: "item_image_url",
            id: req.params.itemId, file: req.file, notFoundMessage: "ไม่พบรายการนี้",
        });
        res.json({ item_image_url });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ message: err.message });
        next(err);
    }
}

// รูปของช่อง (หรือรายการย่อยในช่อง ถ้ามี itemKey) ภายใน widget "สร้างเอง" ที่ใช้อยู่ในฟีดจริง (คนละที่เก็บ
// จาก template ต้นทาง เพราะ clone มาเป็นอิสระแล้วตั้งแต่ตอนลากเข้าฟีด)
async function uploadCustomCellImage(req, res, next) {
    try {
        if (!req.file) return res.status(400).json({ message: "ไม่พบไฟล์รูปภาพ" });
        const image_url = await saveResizedImageInStructure({
            table: "tb_news_blocks", idColumn: "blk_id", structureColumn: "blk_custom_structure",
            id: req.params.blockId, cellKey: req.params.cellKey, itemKey: req.params.itemKey,
            file: req.file, notFoundMessage: "ไม่พบ widget นี้",
        });
        res.json({ image_url });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ message: err.message });
        next(err);
    }
}

// ─── public (ลูกค้า, ไม่ auth) — เห็นเฉพาะ widget ที่ published แล้วเท่านั้น เรียงตาม blk_order เดียวกับ
// ที่แอดมินจัดไว้ในหน้าแก้ไข (ไม่มี "โพสต์" ให้คลิกเข้าไปดูทีละอันอีกต่อไป — เห็นทั้งฟีดในหน้าเดียว) ────
async function getPublished(req, res, next) {
    try {
        // blk_updated_at ส่งให้ฝั่งลูกค้าด้วย ใช้แสดงเป็นวันที่โพสต์ในการ์ดฟีด (เหมือน timestamp ใต้ชื่อเพจ
        // ของ Facebook) — สะท้อน "บันทึกล่าสุดเมื่อไหร่" ไม่ใช่วันที่สร้างครั้งแรก เพราะ save() ลบ+สร้างใหม่ทุกครั้ง
        const [blocks] = await pool.query(
            `SELECT blk_id, blk_type, blk_order, blk_title, blk_text, blk_image_url, blk_link_url, blk_link_label, blk_items_per_view, blk_custom_structure, blk_updated_at
             FROM tb_news_blocks WHERE blk_status = 'published' ORDER BY blk_order`
        );
        res.json({ blocks: await attachItems(blocks) });
    } catch (err) {
        next(err);
    }
}

// widget ที่แอดมินติ๊ก "เผยแพร่ใน landing page" ไว้ — เป็นอิสระจาก blk_status โดยตั้งใจ (ติ๊กไว้ตอนยัง draft
// ก็ขึ้น landing page ได้เลย ไม่ต้อง published ที่ฟีดข่าวสารเต็มก่อน) เพราะแอดมินอาจอยากโชว์ที่หน้าแรกอย่างเดียว
// โดยยังไม่พร้อมเปิดเป็นข่าวสารเต็มรูปแบบที่ /news ก็ได้ — ใช้กับหน้าแรกของเว็บลูกค้าเป็น teaser สั้นๆ ก่อน
// ลิงก์ไปหน้า /news เต็ม — ไม่จำกัดจำนวนไว้ฝั่ง backend เพราะแอดมินติ๊กเลือกเองทีละ widget อยู่แล้ว (ควบคุม
// ปริมาณเองได้จากฝั่งแอดมิน ไม่ต้องมี LIMIT ซ่อนมาอีกชั้นที่อาจทำให้งงว่าทำไมติ๊กแล้วไม่ขึ้น)
async function getLandingNews(req, res, next) {
    try {
        const [blocks] = await pool.query(
            `SELECT blk_id, blk_type, blk_order, blk_title, blk_text, blk_image_url, blk_link_url, blk_link_label, blk_items_per_view, blk_custom_structure, blk_updated_at
             FROM tb_news_blocks WHERE blk_show_on_landing = 1 ORDER BY blk_order`
        );
        res.json({ blocks: await attachItems(blocks) });
    } catch (err) {
        next(err);
    }
}

// ─── widget "สร้างเอง" (Template) — แม่แบบที่แอดมินออกแบบเองบนกริด บันทึกไว้ใช้ซ้ำได้หลายจุดในฟีด (ลาก
// เข้าฟีด = clone tpl_structure ไปเป็น blk_custom_structure ของ block ใหม่ อิสระจากกันตั้งแต่นั้น) ────────
async function listTemplates(req, res, next) {
    try {
        const [rows] = await pool.query(
            "SELECT tpl_id, tpl_name, tpl_updated_at FROM tb_news_widget_templates ORDER BY tpl_updated_at DESC"
        );
        res.json({ data: rows });
    } catch (err) {
        next(err);
    }
}

async function getTemplate(req, res, next) {
    try {
        const [[row]] = await pool.query(
            "SELECT tpl_id, tpl_name, tpl_structure FROM tb_news_widget_templates WHERE tpl_id = ?",
            [req.params.id]
        );
        if (!row) return res.status(404).json({ message: "ไม่พบ widget นี้" });
        res.json(row);
    } catch (err) {
        next(err);
    }
}

async function createTemplate(req, res, next) {
    try {
        const { tpl_name, structure } = req.body ?? {};
        if (!tpl_name?.trim()) return res.status(400).json({ message: "กรุณากรอกชื่อ widget" });
        const structError = validateTemplateStructure(structure);
        if (structError) return res.status(400).json({ message: structError });

        // สร้างใหม่ รูปยังไม่มีอยู่ก่อนแน่ๆ (whitelist กับ set ว่างเปล่า = บังคับ null ทุกรูปเสมอ) อัปโหลด
        // ทีหลังผ่าน endpoint แยกเท่านั้น (เหมือน block/item ปกติ)
        const sanitized = sanitizeStructure(structure, new Set());

        const tpl_id = await generateId("tb_news_widget_templates", "NWT");
        await pool.query(
            "INSERT INTO tb_news_widget_templates (tpl_id, tpl_name, tpl_structure, tpl_created_by_id) VALUES (?, ?, ?, ?)",
            [tpl_id, tpl_name.trim(), JSON.stringify(sanitized), req.user.user_id]
        );
        res.status(201).json({ tpl_id, structure: sanitized });
    } catch (err) {
        next(err);
    }
}

async function updateTemplate(req, res, next) {
    try {
        const { tpl_name, structure } = req.body ?? {};
        if (!tpl_name?.trim()) return res.status(400).json({ message: "กรุณากรอกชื่อ widget" });
        const structError = validateTemplateStructure(structure);
        if (structError) return res.status(400).json({ message: structError });

        const [[existing]] = await pool.query(
            "SELECT tpl_structure FROM tb_news_widget_templates WHERE tpl_id = ?",
            [req.params.id]
        );
        if (!existing) return res.status(404).json({ message: "ไม่พบ widget นี้" });

        const existingUrls = new Set(collectImageUrls(existing.tpl_structure));
        const sanitized = sanitizeStructure(structure, existingUrls);
        const keptUrls = new Set(collectImageUrls(sanitized));

        await pool.query(
            "UPDATE tb_news_widget_templates SET tpl_name = ?, tpl_structure = ? WHERE tpl_id = ?",
            [tpl_name.trim(), JSON.stringify(sanitized), req.params.id]
        );

        await Promise.all(
            collectImageUrls(existing.tpl_structure)
                .filter((url) => !keptUrls.has(url))
                .map((url) => fs.unlink(resolveUploadPath(url)).catch(() => {}))
        );

        res.json({ message: "บันทึก widget สำเร็จ", structure: sanitized });
    } catch (err) {
        next(err);
    }
}

async function deleteTemplate(req, res, next) {
    try {
        const [[row]] = await pool.query(
            "SELECT tpl_structure FROM tb_news_widget_templates WHERE tpl_id = ?",
            [req.params.id]
        );
        const [result] = await pool.query("DELETE FROM tb_news_widget_templates WHERE tpl_id = ?", [req.params.id]);
        if (result.affectedRows === 0) return res.status(404).json({ message: "ไม่พบ widget นี้" });

        const urls = row ? collectImageUrls(row.tpl_structure) : [];
        await Promise.all(urls.map((url) => fs.unlink(resolveUploadPath(url)).catch(() => {})));

        res.status(204).end();
    } catch (err) {
        next(err);
    }
}

async function uploadTemplateCellImage(req, res, next) {
    try {
        if (!req.file) return res.status(400).json({ message: "ไม่พบไฟล์รูปภาพ" });
        const image_url = await saveResizedImageInStructure({
            table: "tb_news_widget_templates", idColumn: "tpl_id", structureColumn: "tpl_structure",
            id: req.params.id, cellKey: req.params.cellKey, itemKey: req.params.itemKey,
            file: req.file, notFoundMessage: "ไม่พบ widget นี้",
        });
        res.json({ image_url });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ message: err.message });
        next(err);
    }
}

module.exports = {
    getAll, save, uploadBlockImage, uploadItemImage, uploadCustomCellImage, getPublished, getLandingNews,
    listTemplates, getTemplate, createTemplate, updateTemplate, deleteTemplate, uploadTemplateCellImage,
};
