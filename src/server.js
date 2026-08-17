require("dotenv").config();
const app = require("./app");
const pool = require("./config/db");
const { startEntitlementExpirySweep } = require("./jobs/entitlementExpirySweep");
const { startOrderExpirySweep } = require("./jobs/orderExpirySweep");

const PORT = process.env.PORT || 3003;

app.listen(PORT, async () => {
    console.log(`Backend running on http://localhost:${PORT}`);

    try {
        await pool.query("SELECT 1");
        console.log(`เชื่อมฐานข้อมูล "${process.env.DB_NAME}" สำเร็จ`);
        startEntitlementExpirySweep();
        startOrderExpirySweep();
    } catch (err) {
        console.error(`เชื่อมฐานข้อมูล "${process.env.DB_NAME}" ไม่สำเร็จ:`, err.message);
    }
});
