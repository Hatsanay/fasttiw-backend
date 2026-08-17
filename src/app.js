const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const path = require("path");
const routes = require("./routes");
const storeRoutes = require("./routes/store.routes");
const { notFound, errorHandler } = require("./middlewares/error.middleware");

const app = express();

// รองรับได้หลาย origin (แอดมิน + storefront ลูกค้า คนละพอร์ตกัน) — คั่นด้วย comma ใน env
const allowedOrigins = [process.env.FRONTEND_URL, process.env.STORE_URL].filter(Boolean);
app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(morgan("dev"));
// เก็บ raw body ไว้ใน req.rawBody ด้วย — webhook ของ Stripe (stripe.webhooks.constructEvent) ต้องเอา raw
// bytes เป๊ะๆ (ไม่ใช่ JSON ที่ parse แล้ว) ไปคำนวณ signature เทียบกับที่ส่งมา ถ้าใช้ body ที่ผ่าน
// JSON.parse/serialize ใหม่ การจัดรูปแบบ whitespace อาจต่างจาก raw bytes ต้นฉบับจนตรวจสอบ signature ไม่ผ่าน
app.use(express.json({
    verify: (req, res, buf) => { req.rawBody = buf; },
}));
app.use(express.urlencoded({ extended: true }));

// เสิร์ฟรูปโปรไฟล์ที่อัปโหลดไว้ static ที่ /uploads/<filename> ตรงกับ user_avatar_url ที่เก็บใน DB
app.use("/uploads", express.static(path.join(__dirname, "..", "uploads")));

app.use("/api", routes);
app.use("/api", storeRoutes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
