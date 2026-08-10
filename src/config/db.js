const mysql = require("mysql2/promise");

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    timezone: "+07:00",
    // กัน connection หลุดเงียบๆ ตอนไม่มี query นานๆ (idle timeout ฝั่ง MySQL/network) ซึ่งทำให้
    // request แรกหลังจากนั้นต้องเสีย round-trip สร้าง connection ใหม่แทนที่จะรีไซเคิลจาก pool ได้เลย
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
});

// MySQL server รันด้วย system timezone เป็น UTC ค่า NOW()/CURRENT_TIMESTAMP() ที่คำนวณฝั่ง server
// (เช่น DEFAULT CURRENT_TIMESTAMP ของ *_created_at) เลยเพี้ยนไป 7 ชม. จากเวลาไทยจริง
// ต้องสั่ง SET time_zone ให้ทุก connection ใน pool ไม่ใช่แค่ตั้ง option ฝั่ง driver อย่างเดียว
// (option "timezone" ด้านบนมีผลแค่ตอนแปลง JS Date <-> DATETIME ฝั่ง client เท่านั้น)
pool.on("connection", (connection) => {
    connection.query("SET time_zone = '+07:00'");
});

module.exports = pool;
