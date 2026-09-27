const fs = require("fs/promises");
const path = require("path");
const pool = require("../config/db");
const { SCAN_DIR, RETENTION_DAYS, deleteScanFiles } = require("../utils/paperScanStorage");

const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000; // ทุก 6 ชั่วโมง — ลบช้าไปไม่กี่ชั่วโมงไม่มีผลอะไร

// ลบภาพกระดาษคำตอบที่เก็บครบ 90 วันแล้ว (ระบบสอบกระดาษ — CLAUDE.md ข้อ 6.9, ผู้ใช้เลือกระยะเก็บ)
// ผลตรวจ (tb_attempts) ไม่ถูกแตะ — ลบแค่ภาพ หน้าเฉลยยังอยู่ครบ
//
// 2 รอบ: (1) ตามแถวในฐานข้อมูล (2) ตามอายุไฟล์บนดิสก์ — รอบสองเก็บไฟล์ที่ไม่มีแถวชี้แล้ว เช่น ใบสอบถูกลบ
// (ลูกค้าถูกลบ → แถวภาพหายตาม cascade แต่ไฟล์ยังอยู่) หรือเขียนไฟล์แล้ว server ล่มก่อนบันทึกแถว
async function sweepPaperScans() {
    try {
        const [rows] = await pool.query(
            "SELECT ps_form_id, ps_page, ps_file FROM tb_paper_scans WHERE ps_created_at < NOW() - INTERVAL ? DAY",
            [RETENTION_DAYS]
        );
        if (rows.length) {
            await deleteScanFiles(rows.map((r) => r.ps_file));
            await pool.query("DELETE FROM tb_paper_scans WHERE ps_created_at < NOW() - INTERVAL ? DAY", [RETENTION_DAYS]);
        }

        const cutoff = Date.now() - (RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000;
        const names = await fs.readdir(SCAN_DIR).catch((err) => (err.code === "ENOENT" ? [] : Promise.reject(err)));
        const stale = [];
        for (const name of names) {
            const stat = await fs.stat(path.join(SCAN_DIR, name)).catch(() => null);
            if (stat?.isFile() && stat.mtimeMs < cutoff) stale.push(name);
        }
        await deleteScanFiles(stale);

        if (rows.length || stale.length) {
            console.log(`[paper-scan-sweep] ลบภาพที่ครบ ${RETENTION_DAYS} วัน ${rows.length} หน้า · ไฟล์ค้าง ${stale.length} ไฟล์`);
        }
    } catch (err) {
        console.error("[paper-scan-sweep] เกิดข้อผิดพลาด:", err.message);
    }
}

function startPaperScanSweep() {
    sweepPaperScans();
    setInterval(sweepPaperScans, SWEEP_INTERVAL_MS);
}

module.exports = { startPaperScanSweep, sweepPaperScans };
