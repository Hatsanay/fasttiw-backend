const fs = require("fs/promises");
const path = require("path");
const sharp = require("sharp");
const pool = require("../config/db");
const { generateId, generateIds } = require("../utils/generateId");
const { resolveUploadPath } = require("../utils/uploads");

const PACKAGE_COVER_DIR = path.join(__dirname, "..", "..", "uploads", "packages");

async function getAll(req, res, next) {
    try {
        const limit = Number(req.query.limit) || 10;
        const offset = Number(req.query.offset) || 0;
        const search = `%${req.query.search ?? ""}%`;
        const status = ["draft", "published", "archived"].includes(req.query.status) ? req.query.status : null;

        const conditions = ["pkg_name LIKE ?"];
        const params = [search];
        if (status) { conditions.push("pkg_status = ?"); params.push(status); }
        const whereClause = conditions.join(" AND ");

        const [rows] = await pool.query(
            `SELECT pkg_id, pkg_name, pkg_price, pkg_cover_url, pkg_status, pkg_created_at, pkg_updated_at,
                    (SELECT COUNT(*) FROM tb_package_items pi WHERE pi.pki_package_id = tb_packages.pkg_id) AS product_count
             FROM tb_packages
             WHERE ${whereClause}
             ORDER BY pkg_id DESC
             LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );
        const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM tb_packages WHERE ${whereClause}`, params);

        res.json({ data: rows, total });
    } catch (err) {
        next(err);
    }
}

async function getOne(req, res, next) {
    try {
        const [rows] = await pool.query(
            `SELECT pkg_id, pkg_name, pkg_description, pkg_price, pkg_cover_url, pkg_status, pkg_created_at, pkg_updated_at
             FROM tb_packages WHERE pkg_id = ?`,
            [req.params.id]
        );
        if (!rows[0]) return res.status(404).json({ message: "ไม่พบแพ็กเกจนี้" });

        const [items] = await pool.query(
            `SELECT pi.pki_id, pi.pki_product_id, p.prod_name, p.prod_price, p.prod_is_free
             FROM tb_package_items pi JOIN tb_products p ON p.prod_id = pi.pki_product_id
             WHERE pi.pki_package_id = ?`,
            [req.params.id]
        );

        res.json({ ...rows[0], items });
    } catch (err) {
        next(err);
    }
}

// ต้องมีอย่างน้อย 2 ชุดถึงจะเรียกว่า "แพ็กเกจรวม" ได้จริง (1 ชุดไม่ต่างจากซื้อ product ตรงๆ)
function validatePackageInput({ pkg_name, pkg_price, product_ids }) {
    if (!pkg_name) return "กรุณากรอกชื่อแพ็กเกจ";
    if (!Array.isArray(product_ids) || product_ids.length < 2) return "แพ็กเกจต้องมีอย่างน้อย 2 ชุดข้อสอบ";
    const price = Number(pkg_price);
    if (!Number.isFinite(price) || price <= 0) return "ราคาแพ็กเกจต้องมากกว่า 0";
    return null;
}

// รับ conn (transaction connection) เข้ามาแทนที่จะใช้ pool ตรงๆ — ต้องอยู่ในธุรกรรมเดียวกับการ
// insert/update ตัว package เอง ไม่งั้นถ้า INSERT รายการที่ N ล้มเหลว (เช่น product_id ไม่มีจริง) รายการที่
// DELETE ไปก่อนหน้าและ INSERT สำเร็จไปแล้วบางส่วนจะค้างอยู่ ทำให้แพ็กเกจเสียหายครึ่งๆ กลางๆ
async function replacePackageItems(conn, packageId, productIds) {
    // แทนที่ทั้งหมด (ลบเก่าทิ้งแล้วใส่ใหม่) ง่ายกว่า diff รายชิ้น เพราะจำนวน product ต่อแพ็กเกจน้อย
    await conn.query("DELETE FROM tb_package_items WHERE pki_package_id = ?", [packageId]);
    const itemIds = await generateIds("tb_package_items", "PKI", productIds.length);
    for (let i = 0; i < productIds.length; i++) {
        await conn.query(
            "INSERT INTO tb_package_items (pki_id, pki_package_id, pki_product_id) VALUES (?, ?, ?)",
            [itemIds[i], packageId, productIds[i]]
        );
    }
}

async function create(req, res, next) {
    const conn = await pool.getConnection();
    try {
        const { pkg_name, pkg_description, pkg_price, product_ids } = req.body ?? {};
        const error = validatePackageInput({ pkg_name, pkg_price, product_ids });
        if (error) return res.status(400).json({ message: error });

        const pkg_id = await generateId("tb_packages", "PKG");

        await conn.beginTransaction();
        await conn.query(
            "INSERT INTO tb_packages (pkg_id, pkg_name, pkg_description, pkg_price, pkg_created_by_id) VALUES (?, ?, ?, ?, ?)",
            [pkg_id, pkg_name, pkg_description || null, Number(pkg_price), req.user.user_id]
        );
        await replacePackageItems(conn, pkg_id, product_ids);
        await conn.commit();

        res.status(201).json({ pkg_id });
    } catch (err) {
        await conn.rollback();
        if (err.code === "ER_DUP_ENTRY") return res.status(409).json({ message: "มีชุดข้อสอบซ้ำในแพ็กเกจนี้" });
        if (err.code === "ER_NO_REFERENCED_ROW_2") return res.status(400).json({ message: "มีชุดข้อสอบบางรายการไม่พบในระบบ" });
        next(err);
    } finally {
        conn.release();
    }
}

async function update(req, res, next) {
    const conn = await pool.getConnection();
    try {
        const { pkg_name, pkg_description, pkg_price, pkg_status, product_ids } = req.body ?? {};
        const error = validatePackageInput({ pkg_name, pkg_price, product_ids });
        if (error) return res.status(400).json({ message: error });
        const status = ["draft", "published", "archived"].includes(pkg_status) ? pkg_status : "draft";

        await conn.beginTransaction();
        await conn.query(
            "UPDATE tb_packages SET pkg_name = ?, pkg_description = ?, pkg_price = ?, pkg_status = ? WHERE pkg_id = ?",
            [pkg_name, pkg_description || null, Number(pkg_price), status, req.params.id]
        );
        await replacePackageItems(conn, req.params.id, product_ids);
        await conn.commit();

        res.json({ message: "แก้ไขแพ็กเกจสำเร็จ" });
    } catch (err) {
        await conn.rollback();
        if (err.code === "ER_DUP_ENTRY") return res.status(409).json({ message: "มีชุดข้อสอบซ้ำในแพ็กเกจนี้" });
        if (err.code === "ER_NO_REFERENCED_ROW_2") return res.status(400).json({ message: "มีชุดข้อสอบบางรายการไม่พบในระบบ" });
        next(err);
    } finally {
        conn.release();
    }
}

async function remove(req, res, next) {
    try {
        const [rows] = await pool.query("SELECT pkg_cover_url FROM tb_packages WHERE pkg_id = ?", [req.params.id]);

        await pool.query("DELETE FROM tb_packages WHERE pkg_id = ?", [req.params.id]);

        if (rows[0]?.pkg_cover_url) {
            await fs.unlink(resolveUploadPath(rows[0].pkg_cover_url)).catch(() => {});
        }

        res.status(204).end();
    } catch (err) {
        if (err.code === "ER_ROW_IS_REFERENCED_2" || err.code === "ER_ROW_IS_REFERENCED") {
            return res.status(409).json({ message: "ไม่สามารถลบแพ็กเกจนี้ได้ เพราะมีคำสั่งซื้อผูกอยู่" });
        }
        next(err);
    }
}

// resize + บีบเป็น webp เหมือน prod_cover_url — ใช้ fit:"inside" เพราะภาพหน้าปกแพ็กเกจไม่ควรถูกครอปเป็น
// สี่เหลี่ยมจัตุรัสตายตัว
async function saveCoverForPackage(packageId, file) {
    const [rows] = await pool.query("SELECT pkg_cover_url FROM tb_packages WHERE pkg_id = ?", [packageId]);
    if (!rows[0]) {
        const err = new Error("ไม่พบแพ็กเกจนี้");
        err.status = 404;
        throw err;
    }
    const oldCoverUrl = rows[0].pkg_cover_url;

    await fs.mkdir(PACKAGE_COVER_DIR, { recursive: true });

    const filename = `${Date.now()}-${Math.round(Math.random() * 1e9)}.webp`;
    await sharp(file.buffer)
        .resize(800, 800, { fit: "inside", withoutEnlargement: true })
        .webp({ quality: 80 })
        .toFile(path.join(PACKAGE_COVER_DIR, filename));

    const pkg_cover_url = `/uploads/packages/${filename}`;
    await pool.query("UPDATE tb_packages SET pkg_cover_url = ? WHERE pkg_id = ?", [pkg_cover_url, packageId]);

    if (oldCoverUrl) {
        await fs.unlink(resolveUploadPath(oldCoverUrl)).catch(() => {});
    }

    return pkg_cover_url;
}

async function uploadCover(req, res, next) {
    try {
        if (!req.file) return res.status(400).json({ message: "ไม่พบไฟล์รูปภาพ" });
        const pkg_cover_url = await saveCoverForPackage(req.params.id, req.file);
        res.json({ pkg_cover_url });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ message: err.message });
        next(err);
    }
}

module.exports = { getAll, getOne, create, update, remove, uploadCover };
