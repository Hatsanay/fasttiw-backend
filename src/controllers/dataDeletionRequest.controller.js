const pool = require("../config/db");
const { generateId } = require("../utils/generateId");

// ลูกค้าขอลบข้อมูลบัญชีตนเอง (สิทธิ์ตาม PDPA) — ไม่ auto ลบทันที แค่สร้างคำขอไว้ให้แอดมินมาตรวจ/ประมวลผลเอง
// เพราะอาจต้องเก็บประวัติการเงิน/ภาษีบางส่วนไว้ตามกฎหมายอื่นก่อน จะลบแบบอัตโนมัติทันทีไม่ได้
async function createMyRequest(req, res, next) {
    try {
        const [existing] = await pool.query(
            "SELECT ddr_id FROM tb_data_deletion_requests WHERE ddr_customer_id = ? AND ddr_status = 'pending' LIMIT 1",
            [req.customer.cus_id]
        );
        if (existing[0]) return res.status(409).json({ message: "คุณมีคำขอลบข้อมูลที่รอดำเนินการอยู่แล้ว" });

        const ddr_id = await generateId("tb_data_deletion_requests", "DDR");
        await pool.query(
            "INSERT INTO tb_data_deletion_requests (ddr_id, ddr_customer_id) VALUES (?, ?)",
            [ddr_id, req.customer.cus_id]
        );
        res.status(201).json({ ddr_id });
    } catch (err) {
        next(err);
    }
}

async function getAll(req, res, next) {
    try {
        const status = ["pending", "completed", "rejected"].includes(req.query.status) ? req.query.status : null;
        const whereClause = status ? "WHERE d.ddr_status = ?" : "";
        const params = status ? [status] : [];

        const [rows] = await pool.query(
            `SELECT d.ddr_id, d.ddr_customer_id, c.cus_username, c.cus_email, d.ddr_status, d.ddr_note,
                    d.ddr_created_at, d.ddr_resolved_at
             FROM tb_data_deletion_requests d
             JOIN tb_customers c ON c.cus_id = d.ddr_customer_id
             ${whereClause}
             ORDER BY d.ddr_created_at DESC`,
            params
        );
        res.json({ data: rows });
    } catch (err) {
        next(err);
    }
}

// แอดมิน mark ว่าประมวลผลแล้ว (completed/rejected) — ตัวการลบข้อมูลจริงเป็นขั้นตอนที่แอดมินทำเองนอกระบบ
// (หรือในอนาคตอาจเพิ่ม endpoint ลบจริงแยกต่างหาก) จุดนี้แค่บันทึกว่าคำขอถูกจัดการแล้ว
async function updateStatus(req, res, next) {
    try {
        const { ddr_status, ddr_note } = req.body ?? {};
        if (!["completed", "rejected"].includes(ddr_status)) {
            return res.status(400).json({ message: "สถานะไม่ถูกต้อง" });
        }
        await pool.query(
            "UPDATE tb_data_deletion_requests SET ddr_status = ?, ddr_note = ?, ddr_resolved_at = NOW() WHERE ddr_id = ?",
            [ddr_status, ddr_note || null, req.params.id]
        );
        res.json({ message: "อัปเดตสถานะสำเร็จ" });
    } catch (err) {
        next(err);
    }
}

module.exports = { createMyRequest, getAll, updateStatus };
