const crypto = require("crypto");
const ExcelJS = require("exceljs");
const pool = require("../config/db");
const { generateId } = require("../utils/generateId");
const { hasActiveEntitlement } = require("./entitlement.controller");
const { generateIds } = require("../utils/generateId");
const { loadPrintableQuestions, makeFormOrder, insertForm, buildPrintData, formChoiceCounts, parseJson } = require("./paperForm.controller");
const { buildReadiness, toCriterion } = require("./attempt.controller");

// กลุ่มสอบกระดาษ — ลูกค้าชวนเพื่อนสอบกระดาษพร้อมกัน (เฟส 1: กลุ่ม + ลิงก์เชิญ + เข้ากลุ่ม + รายชื่อ) — CLAUDE.md ข้อ 6.9.1
//
// การตัดสินใจร่วมกับผู้ใช้ (2026-09-28):
// - ผู้จัด = ลูกค้าทั่วไป ต้องถือสิทธิ์ชุดนั้น · สมาชิกทุกคนต้องมีบัญชีของตัวเอง · ยังไม่คิดเงิน
// - **ผู้จัดเห็นคะแนนสมาชิกเรียงตามชื่อ ไม่มีอันดับ** (CLAUDE.md: ไม่ทำ leaderboard) · สมาชิกไม่เห็นรายชื่อ/คะแนนกันเอง
// - สมาชิกต้องกดยอมรับว่า "ผู้จัดจะเห็นคะแนนของคุณ" ตอนเข้ากลุ่ม (PDPA) — backend บังคับ consent === true
// - เฉลยละเอียดเห็นเฉพาะคนที่ถือสิทธิ์ชุดนั้นเอง (เฟส 3) — ไม่งั้นผู้ซื้อ 1 คนแจกเฉลยทั้งกลุ่มได้ฟรี = แชร์บัญชีอีกรูปแบบ

const MAX_MEMBERS = 50; // รวมผู้จัด — กลุ่มติวทั่วไปไม่เกินนี้ และกระดาษคำตอบ/ชุดข้อสอบที่ต้องพิมพ์รวมยังจัดการได้
const MAX_GROUPS_PER_DAY = 10;
const TITLE_MAX = 120;
const ANTI_CHEAT = ["same", "variants", "unique"];
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // ตัด 0/O 1/I/L — ต้องพิมพ์/บอกกันปากต่อปากได้
const VARIANT_LETTERS = ["A", "B", "C", "D"];
// ใบสอบของกลุ่มต่อวัน (รวมทุกรอบ) — 6 รอบเต็มกลุ่ม 50 คน · กันกด "เริ่มรอบใหม่" + "สร้างชุดสอบ" วนไม่รู้จบ
// (แต่ละใบเก็บลำดับข้อทั้งชุดเป็น JSON)
const MAX_GROUP_FORMS_PER_DAY = 300;

function randomCode() {
    return "G-" + Array.from(crypto.randomBytes(6), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

/** ชื่อผู้จัดที่คนนอกกลุ่มเห็นตอนกดลิงก์เชิญ — ชื่อจริง + อักษรแรกของนามสกุล ไม่เปิดเผยชื่อเต็ม */
function shortName(fname, lname) {
    const first = (fname || "").trim();
    const last = (lname || "").trim();
    if (!first && !last) return "ผู้จัด";
    // สระหน้า (เ แ โ ใ ไ) เขียนก่อนพยัญชนะ — "ใจดี" ต้องได้ "จ." ไม่ใช่ "ใ."
    const initial = last.replace(/^[เ-ไ]+/, "").charAt(0) || last.charAt(0);
    return last ? `${first} ${initial}.` : first;
}

function fullName(fname, lname) {
    return [fname, lname].filter(Boolean).join(" ").trim() || "(ยังไม่ได้ตั้งชื่อ)";
}

/** ตรวจค่าที่แก้ได้ (สร้าง/แก้ไข) — คืน { value } หรือ { error } · ส่งเฉพาะฟิลด์ที่ต้องการแก้ ฟิลด์ที่ไม่ส่ง = ไม่แก้ */
function validateSettings(body, { requireTitle }) {
    const out = {};
    if (body.title !== undefined || requireTitle) {
        const title = String(body.title ?? "").trim();
        if (!title) return { error: "กรุณาตั้งชื่อกลุ่ม" };
        if (title.length > TITLE_MAX) return { error: `ชื่อกลุ่มยาวได้ไม่เกิน ${TITLE_MAX} ตัวอักษร` };
        out.pg_title = title;
    }
    if (body.anti_cheat !== undefined) {
        if (!ANTI_CHEAT.includes(body.anti_cheat)) return { error: "รูปแบบกันลอกไม่ถูกต้อง" };
        out.pg_anti_cheat = body.anti_cheat;
        // variants มีความหมายเฉพาะแบบแบ่งชุด — แบบอื่นเก็บเป็น 1 ให้ชัด
        if (body.anti_cheat === "variants") {
            const n = Number(body.variants ?? 2);
            if (!Number.isInteger(n) || n < 2 || n > 4) return { error: "แบ่งชุดได้ 2-4 ชุด" };
            out.pg_variants = n;
        } else out.pg_variants = 1;
    }
    if (body.status !== undefined) {
        if (!["open", "closed"].includes(body.status)) return { error: "สถานะไม่ถูกต้อง" };
        out.pg_status = body.status;
    }
    return { value: out };
}

/** กลุ่ม + บทบาทของลูกค้าคนนี้ (owner / member) — null = ไม่เกี่ยวข้อง (ตอบ 404 ไม่บอกว่ามีกลุ่มนี้) */
async function loadGroupFor(customerId, groupId) {
    const [[row]] = await pool.query(
        `SELECT g.*, p.prod_name, o.cus_fname AS owner_fname, o.cus_lname AS owner_lname,
                (SELECT COUNT(*) FROM tb_paper_group_members m WHERE m.pgm_group_id = g.pg_id) AS member_count,
                me.pgm_consent_at AS my_consent_at
         FROM tb_paper_groups g
         JOIN tb_products p ON p.prod_id = g.pg_product_id
         JOIN tb_customers o ON o.cus_id = g.pg_owner_id
         LEFT JOIN tb_paper_group_members me ON me.pgm_group_id = g.pg_id AND me.pgm_customer_id = ?
         WHERE g.pg_id = ?`,
        [customerId, groupId]
    );
    if (!row) return null;
    const role = row.pg_owner_id === customerId ? "owner" : row.my_consent_at ? "member" : null;
    return role ? { group: row, role } : null;
}

function publicGroup(g, role) {
    return {
        id: g.pg_id,
        title: g.pg_title,
        product_id: g.pg_product_id,
        prod_name: g.prod_name,
        owner_name: role === "owner" ? fullName(g.owner_fname, g.owner_lname) : shortName(g.owner_fname, g.owner_lname),
        member_count: Number(g.member_count),
        max_members: MAX_MEMBERS,
        status: g.pg_status,
        anti_cheat: g.pg_anti_cheat,
        variants: g.pg_variants,
        round: g.pg_round,
        created_at: g.pg_created_at,
        role,
        // รหัสเชิญเห็นเฉพาะผู้จัด — สมาชิกส่งต่อเองไม่ได้ ผู้จัดคุมได้ว่าใครเข้ากลุ่ม
        ...(role === "owner" ? { code: g.pg_code } : { joined_at: g.my_consent_at }),
    };
}

/** สมาชิกเรียง: ผู้จัดก่อน แล้วตามชื่อ — ไม่ใช่ตามคะแนน/ลำดับเข้า (ไม่ทำ leaderboard — CLAUDE.md ข้อ 5) */
async function loadMembers(group, db = pool) {
    const [rows] = await db.query(
        `SELECT c.cus_id, c.cus_fname, c.cus_lname, m.pgm_consent_at
         FROM tb_paper_group_members m JOIN tb_customers c ON c.cus_id = m.pgm_customer_id
         WHERE m.pgm_group_id = ?`,
        [group.pg_id]
    );
    return rows
        .map((m) => ({ customer_id: m.cus_id, name: fullName(m.cus_fname, m.cus_lname), joined_at: m.pgm_consent_at, is_owner: m.cus_id === group.pg_owner_id }))
        .sort((a, b) => (a.is_owner === b.is_owner ? a.name.localeCompare(b.name, "th") : a.is_owner ? -1 : 1));
}

/** จำนวนใบสอบของรอบปัจจุบันที่ยังใช้ได้ (พิมพ์แล้ว/ตรวจแล้ว) */
async function countRoundForms(group) {
    const [[{ n }]] = await pool.query(
        "SELECT COUNT(*) AS n FROM tb_paper_forms WHERE pf_group_id = ? AND pf_group_round = ? AND pf_status <> 'void'",
        [group.pg_id, group.pg_round]
    );
    return Number(n);
}

/**
 * งานของผู้จัดที่แตะเนื้อหาชุดข้อสอบ (สร้างใบสอบ / พิมพ์) — ต้องเป็นผู้จัด และ*ยังถือสิทธิ์ชุดนั้นอยู่*
 * (สิทธิ์หมดแล้วยังพิมพ์ชุดข้อสอบให้ทั้งกลุ่มได้ = ใช้ของที่ไม่ได้จ่ายเงินต่อ) · ส่งคำตอบ error ให้แล้วคืน null
 */
async function requireOwnerWithProduct(req, res) {
    const loaded = await loadGroupFor(req.customer.cus_id, req.params.id);
    if (!loaded) {
        res.status(404).json({ message: "ไม่พบกลุ่มนี้" });
        return null;
    }
    if (loaded.role !== "owner") {
        res.status(403).json({ message: "เฉพาะผู้จัดเท่านั้น" });
        return null;
    }
    if (!(await hasActiveEntitlement(req.customer.cus_id, loaded.group.pg_product_id))) {
        res.status(403).json({ message: "สิทธิ์ชุดข้อสอบนี้ของคุณหมดอายุหรือถูกยกเลิกแล้ว — ต่ออายุก่อนถึงจะสร้าง/พิมพ์ชุดสอบให้กลุ่มได้" });
        return null;
    }
    return loaded.group;
}

// POST /V1/store/paper-groups  { product_id, title, anti_cheat?, variants? }
async function createGroup(req, res, next) {
    try {
        const ownerId = req.customer.cus_id;
        const productId = req.body?.product_id;
        if (!productId) return res.status(400).json({ message: "ต้องระบุชุดข้อสอบ" });
        const checked = validateSettings({ anti_cheat: "same", ...req.body }, { requireTitle: true });
        if (checked.error) return res.status(400).json({ message: checked.error });
        if (!(await hasActiveEntitlement(ownerId, productId))) {
            return res.status(403).json({ message: "ต้องมีสิทธิ์ชุดข้อสอบนี้ก่อนถึงจะสร้างกลุ่มสอบได้" });
        }
        const [[{ recent }]] = await pool.query(
            "SELECT COUNT(*) AS recent FROM tb_paper_groups WHERE pg_owner_id = ? AND pg_created_at > NOW() - INTERVAL 1 DAY",
            [ownerId]
        );
        if (recent >= MAX_GROUPS_PER_DAY) return res.status(429).json({ message: `สร้างกลุ่มได้วันละไม่เกิน ${MAX_GROUPS_PER_DAY} กลุ่ม` });

        const id = await generateId("tb_paper_groups", "PGR");
        const s = checked.value;
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            // รหัสสุ่ม 6 ตัวจาก 31 ตัวอักษร (~890 ล้านแบบ) ชนกันยากมาก แต่ถ้าชนก็สุ่มใหม่
            for (let attempt = 0; ; attempt++) {
                try {
                    await conn.query(
                        `INSERT INTO tb_paper_groups (pg_id, pg_code, pg_owner_id, pg_product_id, pg_title, pg_anti_cheat, pg_variants)
                         VALUES (?, ?, ?, ?, ?, ?, ?)`,
                        [id, randomCode(), ownerId, productId, s.pg_title, s.pg_anti_cheat, s.pg_variants]
                    );
                    break;
                } catch (err) {
                    if (err.code !== "ER_DUP_ENTRY" || !String(err.message).includes("uq_pg_code") || attempt >= 4) throw err;
                }
            }
            // ผู้จัดเป็นสมาชิกของกลุ่มตัวเองด้วย (สอบไปพร้อมเพื่อนได้)
            await conn.query("INSERT INTO tb_paper_group_members (pgm_group_id, pgm_customer_id) VALUES (?, ?)", [id, ownerId]);
            await conn.commit();
        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }
        const loaded = await loadGroupFor(ownerId, id);
        res.status(201).json(publicGroup(loaded.group, "owner"));
    } catch (err) {
        next(err);
    }
}

// GET /V1/store/paper-groups?product_id= — กลุ่มที่ฉันเป็นผู้จัดหรือสมาชิก (ล่าสุดก่อน)
async function listMyGroups(req, res, next) {
    try {
        const params = [req.customer.cus_id, req.customer.cus_id];
        let filter = "";
        if (req.query.product_id) {
            filter = " AND g.pg_product_id = ?";
            params.push(req.query.product_id);
        }
        const [rows] = await pool.query(
            `SELECT g.*, p.prod_name, o.cus_fname AS owner_fname, o.cus_lname AS owner_lname,
                    (SELECT COUNT(*) FROM tb_paper_group_members m WHERE m.pgm_group_id = g.pg_id) AS member_count,
                    me.pgm_consent_at AS my_consent_at
             FROM tb_paper_group_members me
             JOIN tb_paper_groups g ON g.pg_id = me.pgm_group_id
             JOIN tb_products p ON p.prod_id = g.pg_product_id
             JOIN tb_customers o ON o.cus_id = g.pg_owner_id
             WHERE me.pgm_customer_id = ?${filter}
             ORDER BY (g.pg_owner_id = ?) DESC, g.pg_created_at DESC
             LIMIT 100`,
            [params[0], ...params.slice(2), params[1]]
        );
        res.json({ data: rows.map((g) => publicGroup(g, g.pg_owner_id === req.customer.cus_id ? "owner" : "member")) });
    } catch (err) {
        next(err);
    }
}

// GET /V1/store/paper-groups/:id — ผู้จัดได้รายชื่อสมาชิก · สมาชิกได้แค่ข้อมูลกลุ่ม (ไม่เห็นกันเอง)
async function getGroup(req, res, next) {
    try {
        const loaded = await loadGroupFor(req.customer.cus_id, req.params.id);
        if (!loaded) return res.status(404).json({ message: "ไม่พบกลุ่มนี้" });
        const out = publicGroup(loaded.group, loaded.role);
        // สมาชิกที่ไม่มีสิทธิ์ชุดนี้ สอบได้และเห็นคะแนน แต่เฉลยละเอียดต้องซื้อเอง (ตัดสินใจกับผู้ใช้ 2026-09-28)
        const [hasProduct, [forms]] = await Promise.all([
            hasActiveEntitlement(req.customer.cus_id, loaded.group.pg_product_id),
            pool.query(
                `SELECT pf.pf_customer_id, pf.pf_code, pf.pf_variant, pf.pf_status
                 FROM tb_paper_forms pf
                 WHERE pf.pf_group_id = ? AND pf.pf_group_round = ? AND pf.pf_status <> 'void'`,
                [loaded.group.pg_id, loaded.group.pg_round]
            ),
        ]);
        // สมาชิกที่ไม่มีสิทธิ์ชุดนี้ สอบได้และเห็นคะแนน แต่เฉลยละเอียดต้องซื้อเอง (ตัดสินใจกับผู้ใช้ 2026-09-28)
        out.has_product = hasProduct;
        const formOf = new Map(forms.map((f) => [f.pf_customer_id, { code: f.pf_code, variant: f.pf_variant, status: f.pf_status }]));
        out.forms_count = forms.length;
        if (loaded.role === "owner") {
            const members = await loadMembers(loaded.group);
            out.members = members.map((m) => ({ ...m, form: formOf.get(m.customer_id) ?? null }));
        } else {
            out.my_form = formOf.get(req.customer.cus_id) ?? null;
        }
        res.json(out);
    } catch (err) {
        next(err);
    }
}

// PUT /V1/store/paper-groups/:id — ผู้จัดแก้ชื่อ/กันลอก/เปิด-ปิดรับสมาชิก
async function updateGroup(req, res, next) {
    try {
        const loaded = await loadGroupFor(req.customer.cus_id, req.params.id);
        if (!loaded) return res.status(404).json({ message: "ไม่พบกลุ่มนี้" });
        if (loaded.role !== "owner") return res.status(403).json({ message: "เฉพาะผู้จัดเท่านั้น" });
        const checked = validateSettings(req.body ?? {}, { requireTitle: false });
        if (checked.error) return res.status(400).json({ message: checked.error });
        const g = loaded.group;
        const cheatChanged =
            (checked.value.pg_anti_cheat !== undefined && checked.value.pg_anti_cheat !== g.pg_anti_cheat) ||
            (checked.value.pg_variants !== undefined && checked.value.pg_variants !== g.pg_variants);
        if (cheatChanged && (await countRoundForms(g)) > 0) {
            // กระดาษของรอบนี้พิมพ์ตามแบบเดิมไปแล้ว — เปลี่ยนกลางทางแล้วใบที่สร้างเพิ่มจะคนละแบบกับที่แจกไป
            return res.status(409).json({ message: "สร้างชุดสอบของรอบนี้ไปแล้ว เปลี่ยนแบบกันลอกไม่ได้ — กด \"เริ่มรอบใหม่\" ก่อน" });
        }
        const fields = Object.keys(checked.value);
        if (fields.length) {
            await pool.query(`UPDATE tb_paper_groups SET ${fields.map((f) => `${f} = ?`).join(", ")} WHERE pg_id = ?`, [
                ...fields.map((f) => checked.value[f]),
                loaded.group.pg_id,
            ]);
        }
        const again = await loadGroupFor(req.customer.cus_id, req.params.id);
        res.json(publicGroup(again.group, "owner"));
    } catch (err) {
        next(err);
    }
}

// POST /V1/store/paper-groups/:id/code — ออกรหัสเชิญใหม่ (ลิงก์เก่าหลุดไปที่อื่น) · ลิงก์เดิมใช้ไม่ได้ทันที
async function regenerateCode(req, res, next) {
    try {
        const loaded = await loadGroupFor(req.customer.cus_id, req.params.id);
        if (!loaded) return res.status(404).json({ message: "ไม่พบกลุ่มนี้" });
        if (loaded.role !== "owner") return res.status(403).json({ message: "เฉพาะผู้จัดเท่านั้น" });
        for (let attempt = 0; ; attempt++) {
            try {
                await pool.query("UPDATE tb_paper_groups SET pg_code = ? WHERE pg_id = ?", [randomCode(), loaded.group.pg_id]);
                break;
            } catch (err) {
                if (err.code !== "ER_DUP_ENTRY" || attempt >= 4) throw err;
            }
        }
        const again = await loadGroupFor(req.customer.cus_id, req.params.id);
        res.json(publicGroup(again.group, "owner"));
    } catch (err) {
        next(err);
    }
}

// DELETE /V1/store/paper-groups/:id — ผู้จัดลบกลุ่ม (สมาชิกหลุดออกทั้งหมด)
async function deleteGroup(req, res, next) {
    try {
        const loaded = await loadGroupFor(req.customer.cus_id, req.params.id);
        if (!loaded) return res.status(404).json({ message: "ไม่พบกลุ่มนี้" });
        if (loaded.role !== "owner") return res.status(403).json({ message: "เฉพาะผู้จัดเท่านั้น" });
        // ใบที่ยังไม่ตรวจถูกยกเลิก (กระดาษที่แจกไปตรวจไม่ได้อีก) · ใบที่ตรวจแล้วอยู่ต่อเป็นผลในประวัติของสมาชิก
        // (FK เป็น SET NULL — ลบกลุ่มแล้วผลสอบไม่หายตาม)
        await pool.query("UPDATE tb_paper_forms SET pf_status = 'void' WHERE pf_group_id = ? AND pf_status = 'printed'", [loaded.group.pg_id]);
        await pool.query("DELETE FROM tb_paper_groups WHERE pg_id = ?", [loaded.group.pg_id]);
        res.json({ deleted: true });
    } catch (err) {
        next(err);
    }
}

// DELETE /V1/store/paper-groups/:id/members/:customerId — ผู้จัดเอาสมาชิกออก / สมาชิกออกจากกลุ่มเอง
async function removeMember(req, res, next) {
    try {
        const me = req.customer.cus_id;
        const target = req.params.customerId === "me" ? me : req.params.customerId;
        const loaded = await loadGroupFor(me, req.params.id);
        if (!loaded) return res.status(404).json({ message: "ไม่พบกลุ่มนี้" });
        if (loaded.role !== "owner" && target !== me) return res.status(403).json({ message: "เฉพาะผู้จัดเท่านั้น" });
        if (target === loaded.group.pg_owner_id) return res.status(400).json({ message: "ผู้จัดออกจากกลุ่มตัวเองไม่ได้ — ลบกลุ่มแทน" });
        const [result] = await pool.query("DELETE FROM tb_paper_group_members WHERE pgm_group_id = ? AND pgm_customer_id = ?", [
            loaded.group.pg_id,
            target,
        ]);
        if (!result.affectedRows) return res.status(404).json({ message: "ไม่พบสมาชิกคนนี้ในกลุ่ม" });
        // ใบที่ยังไม่ตรวจของคนนี้ใช้ไม่ได้อีก (ไม่อยู่ในกลุ่มแล้ว) · ใบที่ตรวจแล้วเป็นผลในประวัติของเขาต่อไป
        await pool.query("UPDATE tb_paper_forms SET pf_status = 'void' WHERE pf_group_id = ? AND pf_customer_id = ? AND pf_status = 'printed'", [
            loaded.group.pg_id,
            target,
        ]);
        res.json({ removed: true });
    } catch (err) {
        next(err);
    }
}

// POST /V1/store/paper-groups/:id/forms — สร้างใบสอบให้สมาชิกทุกคนที่ยังไม่มีใบของรอบนี้ (กดซ้ำได้ เช่น มีคนเข้ากลุ่มเพิ่ม)
//
// ใบสอบเป็นของตัวสมาชิก (pf_customer_id = สมาชิก) — QR บอกได้ว่าเป็นของใคร ผลตรวจเข้าประวัติของคนนั้นเอง
// ลำดับข้อตามแบบกันลอกของกลุ่ม:
//   same     — ทุกคนลำดับเดียวกัน (ตามที่แอดมินจัด) · คนที่มาทีหลังได้ลำดับเดียวกับใบที่มีอยู่แล้ว
//   variants — ชุด A-D สลับกันคนละชุด ใช้ชุดที่มีคนน้อยที่สุดก่อน (เรียงตามชื่อ = แจกสลับที่นั่งได้เลย)
//              คนชุดเดียวกันได้ลำดับเดียวกันเป๊ะ (คัดลอกจากใบแรกของชุดนั้น)
//   unique   — สุ่มใหม่ทุกคน
// คัดลอกลำดับจาก "ใบที่มีอยู่แล้วในรอบนี้" ไม่สุ่มใหม่ — ชุดข้อสอบที่พิมพ์แจกไปแล้วต้องใช้กับคนที่มาทีหลังได้
async function generateForms(req, res, next) {
    try {
        const group = await requireOwnerWithProduct(req, res);
        if (!group) return;
        const loaded = await loadPrintableQuestions(group.pg_product_id);
        if (loaded.error) return res.status(400).json({ message: loaded.error });

        const conn = await pool.getConnection();
        let created = 0;
        try {
            await conn.beginTransaction();
            // ล็อกกลุ่ม — กดสองครั้งพร้อมกันต้องไม่ได้ใบซ้ำคนละ 2 ใบ · อ่านแบบกันลอกจากแถวที่ล็อกแล้ว (ล่าสุดจริง)
            const [[g]] = await conn.query("SELECT pg_round, pg_anti_cheat, pg_variants FROM tb_paper_groups WHERE pg_id = ? FOR UPDATE", [group.pg_id]);
            const members = await loadMembers(group, conn);
            const [existing] = await conn.query(
                `SELECT pf_customer_id, pf_variant, pf_question_ids, pf_choice_orders FROM tb_paper_forms
                 WHERE pf_group_id = ? AND pf_group_round = ? AND pf_status <> 'void'`,
                [group.pg_id, g.pg_round]
            );
            const has = new Set(existing.map((f) => f.pf_customer_id));
            const missing = members.filter((m) => !has.has(m.customer_id));
            if (missing.length) {
                const [[{ today }]] = await conn.query(
                    "SELECT COUNT(*) AS today FROM tb_paper_forms WHERE pf_group_id = ? AND pf_created_at > NOW() - INTERVAL 1 DAY",
                    [group.pg_id]
                );
                if (Number(today) + missing.length > MAX_GROUP_FORMS_PER_DAY) {
                    await conn.rollback();
                    return res.status(429).json({ message: `สร้างชุดสอบให้กลุ่มได้วันละไม่เกิน ${MAX_GROUP_FORMS_PER_DAY} ใบ — ลองใหม่พรุ่งนี้` });
                }

                const fromRow = (f) => ({ questionIds: parseJson(f.pf_question_ids), choiceOrders: parseJson(f.pf_choice_orders) });
                const templates = new Map(); // variant ('' = ชุดเดียวกันทั้งกลุ่ม) → ลำดับ
                const counts = new Map(VARIANT_LETTERS.slice(0, g.pg_variants).map((v) => [v, 0]));
                for (const f of existing) {
                    const key = f.pf_variant ?? "";
                    if (!templates.has(key)) templates.set(key, fromRow(f));
                    if (counts.has(f.pf_variant)) counts.set(f.pf_variant, counts.get(f.pf_variant) + 1);
                }
                const ids = await generateIds("tb_paper_forms", "PPF", missing.length);
                for (const [i, m] of missing.entries()) {
                    let variant = null;
                    let order;
                    if (g.pg_anti_cheat === "unique") {
                        order = makeFormOrder(loaded.base, true);
                    } else {
                        if (g.pg_anti_cheat === "variants") {
                            // ชุดที่มีคนน้อยสุด เสมอกันเอาตัวอักษรแรก — ไล่ตามชื่อได้ A B C A B C …
                            variant = [...counts.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))[0][0];
                            counts.set(variant, counts.get(variant) + 1);
                        }
                        const key = variant ?? "";
                        if (!templates.has(key)) templates.set(key, makeFormOrder(loaded.base, g.pg_anti_cheat === "variants"));
                        order = templates.get(key);
                    }
                    await insertForm(conn, {
                        pfId: ids[i],
                        customerId: m.customer_id,
                        productId: group.pg_product_id,
                        order,
                        shuffled: g.pg_anti_cheat !== "same",
                        groupId: group.pg_id,
                        round: g.pg_round,
                        variant,
                    });
                    created++;
                }
            }
            await conn.commit();
        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }
        res.status(created ? 201 : 200).json({ created });
    } catch (err) {
        next(err);
    }
}

// POST /V1/store/paper-groups/:id/round — เริ่มรอบสอบใหม่: ใบของรอบนี้ที่ยังไม่ตรวจถูกยกเลิก (กระดาษแผ่นเก่าตรวจไม่ได้อีก)
// ใบที่ตรวจแล้วเป็นผลของรอบเดิมต่อไป · หลังจากนี้เปลี่ยนแบบกันลอกได้แล้วค่อยสร้างใบของรอบใหม่
async function startNewRound(req, res, next) {
    try {
        const loaded = await loadGroupFor(req.customer.cus_id, req.params.id);
        if (!loaded) return res.status(404).json({ message: "ไม่พบกลุ่มนี้" });
        if (loaded.role !== "owner") return res.status(403).json({ message: "เฉพาะผู้จัดเท่านั้น" });
        const conn = await pool.getConnection();
        let round;
        let voided;
        try {
            await conn.beginTransaction();
            const [[g]] = await conn.query("SELECT pg_round FROM tb_paper_groups WHERE pg_id = ? FOR UPDATE", [loaded.group.pg_id]);
            const [[{ n }]] = await conn.query(
                "SELECT COUNT(*) AS n FROM tb_paper_forms WHERE pf_group_id = ? AND pf_group_round = ? AND pf_status <> 'void'",
                [loaded.group.pg_id, g.pg_round]
            );
            if (!Number(n)) {
                await conn.rollback();
                return res.status(409).json({ message: "รอบนี้ยังไม่ได้สร้างชุดสอบเลย ใช้รอบนี้ต่อได้" });
            }
            const [result] = await conn.query(
                "UPDATE tb_paper_forms SET pf_status = 'void' WHERE pf_group_id = ? AND pf_group_round = ? AND pf_status = 'printed'",
                [loaded.group.pg_id, g.pg_round]
            );
            voided = result.affectedRows;
            round = g.pg_round + 1;
            await conn.query("UPDATE tb_paper_groups SET pg_round = ? WHERE pg_id = ?", [round, loaded.group.pg_id]);
            await conn.commit();
        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }
        res.json({ round, voided });
    } catch (err) {
        next(err);
    }
}

// GET /V1/store/paper-groups/:id/sheets — กระดาษคำตอบของทุกคนในรอบนี้ (พิมพ์รวมไฟล์เดียว พร้อมชื่อ) เรียงเหมือนรายชื่อ
async function getGroupSheets(req, res, next) {
    try {
        const group = await requireOwnerWithProduct(req, res);
        if (!group) return;
        const [members, [forms]] = await Promise.all([
            loadMembers(group),
            pool.query(
                `SELECT pf_customer_id, pf_code, pf_variant, pf_pages, pf_status, pf_question_ids, pf_choice_orders FROM tb_paper_forms
                 WHERE pf_group_id = ? AND pf_group_round = ? AND pf_status <> 'void'`,
                [group.pg_id, group.pg_round]
            ),
        ]);
        const formOf = new Map(forms.map((f) => [f.pf_customer_id, f]));
        res.json({
            title: group.pg_title,
            prod_name: group.prod_name,
            round: group.pg_round,
            sheets: members
                .filter((m) => formOf.has(m.customer_id))
                .map((m) => {
                    const f = formOf.get(m.customer_id);
                    return {
                        code: f.pf_code,
                        holder_name: m.name,
                        variant: f.pf_variant,
                        pages: f.pf_pages,
                        // printed = รอตรวจ · graded = ตรวจแล้ว (สแกนทั้งกองส่งซ้ำได้ = แทนผลเดิม)
                        status: f.pf_status,
                        choice_counts: formChoiceCounts(f),
                    };
                }),
        });
    } catch (err) {
        next(err);
    }
}

// GET /V1/store/paper-groups/:id/booklet?variant=A | ?member=<cus_id> — ชุดข้อสอบสำหรับพิมพ์ของกลุ่ม (ไม่มีเฉลย)
//   same     — ไฟล์เดียวใช้ทั้งกลุ่ม (ไม่ต้องส่งอะไร)
//   variants — ทีละชุด (?variant=)
//   unique   — ทีละคน (?member=) ชื่อกำกับบนหัวกระดาษ
async function getGroupBooklet(req, res, next) {
    try {
        const group = await requireOwnerWithProduct(req, res);
        if (!group) return;
        const params = [group.pg_id, group.pg_round];
        let filter = "";
        if (group.pg_anti_cheat === "variants") {
            const variant = String(req.query.variant ?? "").toUpperCase();
            if (!VARIANT_LETTERS.includes(variant)) return res.status(400).json({ message: "ต้องเลือกชุด (A-D)" });
            filter = " AND pf.pf_variant = ?";
            params.push(variant);
        } else if (group.pg_anti_cheat === "unique") {
            if (!req.query.member) return res.status(400).json({ message: "ต้องเลือกสมาชิก" });
            filter = " AND pf.pf_customer_id = ?";
            params.push(String(req.query.member));
        }
        const [[form]] = await pool.query(
            `SELECT pf.*, p.prod_name, p.prod_total_score, c.cus_fname, c.cus_lname FROM tb_paper_forms pf
             JOIN tb_products p ON p.prod_id = pf.pf_product_id
             JOIN tb_customers c ON c.cus_id = pf.pf_customer_id
             WHERE pf.pf_group_id = ? AND pf.pf_group_round = ? AND pf.pf_status <> 'void'${filter}
             ORDER BY pf.pf_created_at LIMIT 1`,
            params
        );
        if (!form) return res.status(404).json({ message: "ยังไม่มีชุดสอบนี้ — กด \"สร้างชุดสอบให้ทุกคน\" ก่อน" });
        res.json({
            ...(await buildPrintData(form)),
            group_title: group.pg_title,
            anti_cheat: group.pg_anti_cheat,
            // ชื่อบนชุดข้อสอบเฉพาะแบบสลับไม่ซ้ำทุกคน — แบบอื่นทั้งชุดใช้ร่วมกันหลายคน
            holder_name: group.pg_anti_cheat === "unique" ? fullName(form.cus_fname, form.cus_lname) : null,
        });
    } catch (err) {
        next(err);
    }
}

// ─── ผลสอบของกลุ่ม (เฟส 4) ─────────────────────────────────────────────────────────────────────────
// ผู้จัดเห็นผลของสมาชิกทุกคน **เรียงตามชื่อ ไม่มีอันดับ** (ผู้จัดก่อน — ลำดับเดียวกับรายชื่อในหน้ากลุ่ม)
// CLAUDE.md ข้อ 5 ไม่ทำ leaderboard: ไม่มีเลขอันดับ ไม่มีการเรียงตามคะแนน ทั้งในหน้าเว็บและไฟล์ Excel
//
// - เห็นเฉพาะสมาชิกที่ **ยังอยู่ในกลุ่ม** — ยอมรับตอนเข้ากลุ่มว่าผู้จัดจะเห็นคะแนน ออกจากกลุ่ม = ถอนความยินยอม
//   (ผลสอบยังอยู่ในประวัติของเจ้าตัวเหมือนเดิม แค่ผู้จัดไม่เห็นแล้ว)
// - ไม่ต้องถือสิทธิ์ชุดข้อสอบ — ผลเป็นคะแนน/ผ่านไหม/ผลรายหมวด ไม่มีรายข้อหรือเฉลย (ไม่ส่ง att_id ด้วย:
//   ผู้จัดเปิดหน้าเฉลยของสมาชิกไม่ได้อยู่แล้ว แต่ไม่ให้มีอะไรชวนลอง)
// - ผ่าน/ไม่ผ่าน ใช้ buildReadiness ตัวเดียวกับหน้าเฉลยของสมาชิก — ตัวเลขสองหน้าตรงกันเสมอ

/** ผลสอบของรอบหนึ่ง — ใช้ร่วมกันทั้งหน้าเว็บและไฟล์ Excel */
async function buildGroupResults(group, round) {
    const [members, [forms], [[product]], [topicCriteria], [roundRows]] = await Promise.all([
        loadMembers(group),
        pool.query(
            `SELECT pf.pf_customer_id, pf.pf_code, pf.pf_variant, pf.pf_status,
                    a.att_id, a.att_score, a.att_earned_score, a.att_max_score, a.att_total_questions, a.att_submitted_at
             FROM tb_paper_forms pf
             LEFT JOIN tb_attempts a ON a.att_paper_form_id = pf.pf_id AND a.att_status = 'submitted'
             WHERE pf.pf_group_id = ? AND pf.pf_group_round = ? AND pf.pf_status <> 'void'`,
            [group.pg_id, round]
        ),
        pool.query("SELECT prod_pass_percent, prod_pass_min FROM tb_products WHERE prod_id = ?", [group.pg_product_id]),
        pool.query("SELECT ptp_topic_id, ptp_pass_percent, ptp_pass_min FROM tb_product_topic_pass_criteria WHERE ptp_product_id = ?", [
            group.pg_product_id,
        ]),
        // รอบที่มีใบสอบ (ไม่นับใบที่ถูกยกเลิก) — ให้เลือกดูรอบเก่าได้
        // ตัวนับ "ตรวจแล้ว" นับเฉพาะคนที่ยังอยู่ในกลุ่ม ให้ตรงกับรายชื่อที่แสดง (คนที่ออกไปแล้วผู้จัดไม่เห็นผล)
        pool.query(
            `SELECT pf.pf_group_round AS round, SUM(pf.pf_status = 'graded' AND m.pgm_customer_id IS NOT NULL) AS graded
             FROM tb_paper_forms pf
             LEFT JOIN tb_paper_group_members m ON m.pgm_group_id = pf.pf_group_id AND m.pgm_customer_id = pf.pf_customer_id
             WHERE pf.pf_group_id = ? AND pf.pf_status <> 'void'
             GROUP BY pf.pf_group_round ORDER BY pf.pf_group_round DESC`,
            [group.pg_id]
        ),
    ]);

    const formOf = new Map(forms.map((f) => [f.pf_customer_id, f]));
    const memberIds = new Set(members.map((m) => m.customer_id));
    const attemptIds = forms.filter((f) => f.att_id && memberIds.has(f.pf_customer_id)).map((f) => f.att_id);

    // ผลรายหมวดของทุกใบในคำสั่งเดียว — สูตรเดียวกับ topicRows ใน getReview (COALESCE(ans_score, 1))
    const [topicRows, correctRows] = attemptIds.length
        ? await Promise.all([
              pool
                  .query(
                      `SELECT a.ans_attempt_id, t.tpc_id, t.tpc_name,
                              COUNT(*) AS total,
                              SUM(a.ans_is_correct) AS correct,
                              SUM(CASE WHEN a.ans_is_correct THEN COALESCE(a.ans_score, 1) ELSE 0 END) AS earned,
                              SUM(COALESCE(a.ans_score, 1)) AS possible,
                              SUM(a.ans_score IS NOT NULL) AS scored_answers
                       FROM tb_attempt_answers a
                       JOIN tb_questions q ON q.ques_id = a.ans_question_id
                       JOIN tb_topics t ON t.tpc_id = q.ques_topic_id
                       WHERE a.ans_attempt_id IN (?) AND a.ans_is_correct IS NOT NULL
                       GROUP BY a.ans_attempt_id, t.tpc_id, t.tpc_name`,
                      [attemptIds]
                  )
                  .then(([rows]) => rows),
              pool
                  .query(
                      "SELECT ans_attempt_id, SUM(ans_is_correct) AS correct FROM tb_attempt_answers WHERE ans_attempt_id IN (?) GROUP BY ans_attempt_id",
                      [attemptIds]
                  )
                  .then(([rows]) => rows),
          ])
        : [[], []];

    const topicsByAttempt = new Map();
    for (const t of topicRows) {
        if (!topicsByAttempt.has(t.ans_attempt_id)) topicsByAttempt.set(t.ans_attempt_id, []);
        topicsByAttempt.get(t.ans_attempt_id).push(t);
    }
    const correctByAttempt = new Map(correctRows.map((r) => [r.ans_attempt_id, Number(r.correct) || 0]));
    const criterion = toCriterion(product?.prod_pass_percent, product?.prod_pass_min);
    const hasCriterion = !!criterion || topicCriteria.some((t) => toCriterion(t.ptp_pass_percent, t.ptp_pass_min));

    const rows = members.map((m) => {
        const f = formOf.get(m.customer_id);
        const base = {
            customer_id: m.customer_id,
            name: m.name,
            is_owner: m.is_owner,
            form: f ? { code: f.pf_code, variant: f.pf_variant, status: f.pf_status } : null,
        };
        if (!f?.att_id) return { ...base, result: null };
        const myTopics = topicsByAttempt.get(f.att_id) ?? [];
        const correct = correctByAttempt.get(f.att_id) ?? 0;
        const readiness = buildReadiness(f, criterion, correct, myTopics, topicCriteria);
        const scored = f.att_max_score != null && Number(f.att_max_score) > 0;
        return {
            ...base,
            result: {
                score: Number(f.att_score),
                earned: scored ? Number(f.att_earned_score) : null,
                max: scored ? Number(f.att_max_score) : null,
                correct,
                total: Number(f.att_total_questions),
                // null = ชุดนี้ไม่ได้ตั้งเกณฑ์ผ่าน
                passed: readiness ? readiness.passed : null,
                failed_subjects: readiness ? readiness.subjects.filter((s) => !s.passed).map((s) => s.tpc_name) : [],
                graded_at: f.att_submitted_at,
                topics: Object.fromEntries(myTopics.map((t) => [t.tpc_id, Math.round((Number(t.earned) / Number(t.possible)) * 100)])),
            },
        };
    });

    // ผลรายหมวดของทั้งกลุ่ม — รวมคะแนนดิบทุกใบแล้วค่อยหาร (ไม่ใช่เฉลี่ยของ %) ตรงกับวิธีคิดผลรายหมวดที่อื่น
    // เรียงหมวดที่อ่อนสุดก่อน (เรียง "หมวด" ไม่ใช่เรียงคน) — ผู้จัดรู้ทันทีว่าควรติวเรื่องอะไรเพิ่ม
    const topicAgg = new Map();
    for (const t of topicRows) {
        const agg = topicAgg.get(t.tpc_id) ?? { tpc_id: t.tpc_id, tpc_name: t.tpc_name, earned: 0, possible: 0, members: 0 };
        agg.earned += Number(t.earned);
        agg.possible += Number(t.possible);
        agg.members += 1;
        topicAgg.set(t.tpc_id, agg);
    }
    const topics = [...topicAgg.values()]
        .map((t) => ({ tpc_id: t.tpc_id, tpc_name: t.tpc_name, accuracy: t.possible > 0 ? Math.round((t.earned / t.possible) * 100) : 0, members: t.members }))
        .sort((a, b) => a.accuracy - b.accuracy || a.tpc_name.localeCompare(b.tpc_name, "th"));

    const graded = rows.filter((r) => r.result);
    const rounds = roundRows.map((r) => ({ round: Number(r.round), graded: Number(r.graded) }));
    if (!rounds.some((r) => r.round === group.pg_round)) rounds.unshift({ round: group.pg_round, graded: 0 });

    return {
        title: group.pg_title,
        prod_name: group.prod_name,
        round,
        current_round: group.pg_round,
        rounds,
        has_criterion: hasCriterion,
        summary: {
            members: rows.length,
            with_form: rows.filter((r) => r.form).length,
            graded: graded.length,
            average_score: graded.length ? Math.round((graded.reduce((s, r) => s + r.result.score, 0) / graded.length) * 10) / 10 : null,
            passed: hasCriterion ? graded.filter((r) => r.result.passed).length : null,
        },
        topics,
        members: rows,
    };
}

/** ผู้จัดเท่านั้น + รอบที่ขอ (ไม่ส่ง = รอบปัจจุบัน) — ส่งคำตอบ error ให้แล้วคืน null */
async function loadResultsRequest(req, res) {
    const loaded = await loadGroupFor(req.customer.cus_id, req.params.id);
    if (!loaded) {
        res.status(404).json({ message: "ไม่พบกลุ่มนี้" });
        return null;
    }
    if (loaded.role !== "owner") {
        res.status(403).json({ message: "เฉพาะผู้จัดเท่านั้น" });
        return null;
    }
    const group = loaded.group;
    let round = group.pg_round;
    if (req.query.round !== undefined && req.query.round !== "") {
        round = Number(req.query.round);
        if (!Number.isInteger(round) || round < 1 || round > group.pg_round) {
            res.status(400).json({ message: "รอบสอบไม่ถูกต้อง" });
            return null;
        }
    }
    return { group, round };
}

// GET /V1/store/paper-groups/:id/results?round=N
async function getGroupResults(req, res, next) {
    try {
        const loaded = await loadResultsRequest(req, res);
        if (!loaded) return;
        res.json(await buildGroupResults(loaded.group, loaded.round));
    } catch (err) {
        next(err);
    }
}

const FORM_STATUS_TEXT = { printed: "รอตรวจ", graded: "ตรวจแล้ว" };

function formatBangkok(date) {
    return date
        ? new Date(date).toLocaleString("th-TH", {
              timeZone: "Asia/Bangkok",
              year: "numeric",
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
          })
        : "";
}

// GET /V1/store/paper-groups/:id/results.xlsx?round=N — ข้อมูลเดียวกับหน้าเว็บ เรียงตามชื่อ ไม่มีคอลัมน์อันดับ
async function exportGroupResults(req, res, next) {
    try {
        const loaded = await loadResultsRequest(req, res);
        if (!loaded) return;
        const data = await buildGroupResults(loaded.group, loaded.round);
        const scored = data.members.some((m) => m.result?.max != null);
        // หมวดในไฟล์เรียงตามชื่อ (คอลัมน์คงที่ เทียบข้ามรอบง่าย) — หน้าเว็บเรียงหมวดที่อ่อนสุดก่อน
        const topicCols = [...data.topics].sort((a, b) => a.tpc_name.localeCompare(b.tpc_name, "th"));

        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet("ผลรายคน");
        sheet.columns = [
            { header: "ชื่อ", key: "name", width: 28 },
            { header: "ชุด", key: "variant", width: 6 },
            { header: "รหัสใบสอบ", key: "code", width: 12 },
            { header: "สถานะ", key: "status", width: 14 },
            { header: "คะแนน (%)", key: "score", width: 11 },
            ...(scored ? [{ header: "คะแนนที่ได้", key: "points", width: 14 }] : []),
            { header: "ตอบถูก (ข้อ)", key: "correct", width: 13 },
            ...(data.has_criterion
                ? [
                      { header: "ผลตามเกณฑ์", key: "passed", width: 12 },
                      { header: "วิชาที่ไม่ผ่าน", key: "failed", width: 24 },
                  ]
                : []),
            { header: "ตรวจเมื่อ", key: "graded_at", width: 22 },
            ...topicCols.map((t) => ({ header: `${t.tpc_name} (%)`, key: `t_${t.tpc_id}`, width: Math.min(30, Math.max(12, t.tpc_name.length + 5)) })),
        ];
        sheet.getRow(1).font = { bold: true };
        sheet.views = [{ state: "frozen", xSplit: 1, ySplit: 1 }];
        for (const m of data.members) {
            const r = m.result;
            sheet.addRow({
                name: m.is_owner ? `${m.name} (ผู้จัด)` : m.name,
                variant: m.form?.variant ?? "",
                code: m.form?.code ?? "",
                status: m.form ? FORM_STATUS_TEXT[m.form.status] ?? m.form.status : "ยังไม่มีใบสอบ",
                score: r ? r.score : null,
                points: r && r.max != null ? `${r.earned} / ${r.max}` : null,
                correct: r ? `${r.correct} / ${r.total}` : null,
                passed: r && r.passed != null ? (r.passed ? "ผ่าน" : "ยังไม่ผ่าน") : null,
                failed: r ? r.failed_subjects.join(", ") : null,
                graded_at: r ? formatBangkok(r.graded_at) : null,
                ...Object.fromEntries(topicCols.map((t) => [`t_${t.tpc_id}`, r?.topics[t.tpc_id] ?? null])),
            });
        }

        const topicSheet = workbook.addWorksheet("สรุปรายหมวด");
        topicSheet.columns = [
            { header: "หมวด", key: "name", width: 32 },
            { header: "ทำถูกเฉลี่ยทั้งกลุ่ม (%)", key: "accuracy", width: 22 },
            { header: "จำนวนคนที่ตรวจแล้ว", key: "members", width: 20 },
        ];
        topicSheet.getRow(1).font = { bold: true };
        for (const t of data.topics) topicSheet.addRow({ name: t.tpc_name, accuracy: t.accuracy, members: t.members });
        topicSheet.addRow({});
        topicSheet.addRow({ name: `${data.title} · ${data.prod_name} · รอบที่ ${data.round}` });
        topicSheet.addRow({
            name: `ตรวจแล้ว ${data.summary.graded} จาก ${data.summary.members} คน · คะแนนเฉลี่ย ${data.summary.average_score ?? "-"}%`,
        });

        const buffer = await workbook.xlsx.writeBuffer();
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", `attachment; filename="fasttiw-group-${loaded.group.pg_id}-r${data.round}-results.xlsx"`);
        res.setHeader("Cache-Control", "no-store");
        res.send(Buffer.from(buffer));
    } catch (err) {
        next(err);
    }
}

async function findByCode(code) {
    const [[row]] = await pool.query(
        `SELECT g.*, p.prod_name, o.cus_fname AS owner_fname, o.cus_lname AS owner_lname,
                (SELECT COUNT(*) FROM tb_paper_group_members m WHERE m.pgm_group_id = g.pg_id) AS member_count
         FROM tb_paper_groups g
         JOIN tb_products p ON p.prod_id = g.pg_product_id
         JOIN tb_customers o ON o.cus_id = g.pg_owner_id
         WHERE g.pg_code = ?`,
        [String(code || "").toUpperCase()]
    );
    return row ?? null;
}

// GET /V1/store/paper-groups/join/:code — ข้อมูลก่อนกดเข้ากลุ่ม (ชื่อกลุ่ม ผู้จัดแบบย่อ ชุดข้อสอบ จำนวนสมาชิก)
async function previewJoin(req, res, next) {
    try {
        const g = await findByCode(req.params.code);
        if (!g) return res.status(404).json({ message: "ไม่พบกลุ่ม — ลิงก์อาจหมดอายุหรือผู้จัดออกลิงก์ใหม่แล้ว" });
        const [[mine]] = await pool.query("SELECT 1 AS yes FROM tb_paper_group_members WHERE pgm_group_id = ? AND pgm_customer_id = ?", [
            g.pg_id,
            req.customer.cus_id,
        ]);
        res.json({
            id: g.pg_id,
            title: g.pg_title,
            prod_name: g.prod_name,
            owner_name: shortName(g.owner_fname, g.owner_lname),
            member_count: Number(g.member_count),
            max_members: MAX_MEMBERS,
            status: g.pg_status,
            already_member: !!mine,
            has_product: await hasActiveEntitlement(req.customer.cus_id, g.pg_product_id),
        });
    } catch (err) {
        next(err);
    }
}

// POST /V1/store/paper-groups/join/:code  { consent: true }
async function joinGroup(req, res, next) {
    try {
        if (req.body?.consent !== true) {
            return res.status(400).json({ message: "ต้องยอมรับว่าผู้จัดจะเห็นคะแนนของคุณในกลุ่มนี้ก่อน" });
        }
        const g = await findByCode(req.params.code);
        if (!g) return res.status(404).json({ message: "ไม่พบกลุ่ม — ลิงก์อาจหมดอายุหรือผู้จัดออกลิงก์ใหม่แล้ว" });
        if (g.pg_status !== "open") return res.status(409).json({ message: "ผู้จัดปิดรับสมาชิกแล้ว" });
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            // ล็อกแถวกลุ่ม — กดเข้าพร้อมกันหลายคนตอนเหลือที่นั่งสุดท้าย ต้องไม่เกินเพดาน
            await conn.query("SELECT pg_id FROM tb_paper_groups WHERE pg_id = ? FOR UPDATE", [g.pg_id]);
            const [[{ n }]] = await conn.query("SELECT COUNT(*) AS n FROM tb_paper_group_members WHERE pgm_group_id = ?", [g.pg_id]);
            const [[mine]] = await conn.query("SELECT 1 AS yes FROM tb_paper_group_members WHERE pgm_group_id = ? AND pgm_customer_id = ?", [
                g.pg_id,
                req.customer.cus_id,
            ]);
            if (!mine) {
                if (n >= MAX_MEMBERS) {
                    await conn.rollback();
                    return res.status(409).json({ message: `กลุ่มเต็มแล้ว (${MAX_MEMBERS} คน)` });
                }
                await conn.query("INSERT INTO tb_paper_group_members (pgm_group_id, pgm_customer_id) VALUES (?, ?)", [g.pg_id, req.customer.cus_id]);
            }
            await conn.commit();
            res.status(mine ? 200 : 201).json({ id: g.pg_id, already_member: !!mine });
        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }
    } catch (err) {
        next(err);
    }
}

module.exports = {
    createGroup,
    listMyGroups,
    getGroup,
    updateGroup,
    regenerateCode,
    deleteGroup,
    removeMember,
    previewJoin,
    joinGroup,
    generateForms,
    startNewRound,
    getGroupSheets,
    getGroupBooklet,
    getGroupResults,
    exportGroupResults,
    MAX_MEMBERS,
};
