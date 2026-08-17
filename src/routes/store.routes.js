const express = require("express");
const customerAuthController = require("../controllers/customerAuth.controller");
const storeController = require("../controllers/store.controller");
const attemptController = require("../controllers/attempt.controller");
const bookmarkController = require("../controllers/bookmark.controller");
const dataDeletionRequestController = require("../controllers/dataDeletionRequest.controller");
const questionReportController = require("../controllers/questionReport.controller");
const newsController = require("../controllers/news.controller");
const chatController = require("../controllers/chat.controller");
const { requireCustomerAuth, optionalCustomerAuth } = require("../middlewares/customerAuth.middleware");
const { uploadImage } = require("../middlewares/upload.middleware");
const { noStore } = require("../middlewares/noStore.middleware");

// เส้นทางทั้งหมดของฝั่งลูกค้า (storefront + ทำข้อสอบ) แยกจาก route staff เดิมทั้งหมด —
// ใช้ requireCustomerAuth (token payload { cus_id }) แทน requireAuth/requirePermission ของฝั่งแอดมิน
const router = express.Router();

router.post("/V1/store/auth/register", customerAuthController.register);
router.post("/V1/store/auth/login", customerAuthController.login);
router.post("/V1/store/auth/logout", requireCustomerAuth, customerAuthController.logout);
router.get("/V1/store/me", requireCustomerAuth, customerAuthController.getMe);
router.put("/V1/store/me", requireCustomerAuth, customerAuthController.updateMyProfile);
router.put("/V1/store/me/password", requireCustomerAuth, customerAuthController.changeMyPassword);
router.put("/V1/store/me/onboarding", requireCustomerAuth, customerAuthController.completeOnboarding);
router.put("/V1/store/me/image", requireCustomerAuth, uploadImage.single("image"), customerAuthController.uploadMyImage);
router.get("/V1/store/me/sessions", requireCustomerAuth, customerAuthController.getMySessions);
router.delete("/V1/store/me/sessions/:id", requireCustomerAuth, customerAuthController.deleteMySession);
router.post("/V1/store/me/deletion-request", requireCustomerAuth, dataDeletionRequestController.createMyRequest);

// สาธารณะ ไม่ต้อง login — สำหรับหน้า landing/แคตตาล็อก
router.get("/V1/store/products", storeController.getPublicProducts);
router.get("/V1/store/products/popular", storeController.getPopularProducts);
router.get("/V1/store/products/:id", storeController.getPublicProduct);
router.get("/V1/store/products/:id/sample-questions", storeController.getSampleQuestions);
router.get("/V1/store/packages", storeController.getPublicPackages);
router.get("/V1/store/categories", storeController.getPublicCategories);
// ข่าวสาร/ประกาศ — ฟีดเดียว (ไม่มี "โพสต์" แยกกัน) เนื้อหาการตลาด/ประชาสัมพันธ์ ไม่ใช่เนื้อหาข้อสอบที่ต้อง
// ปกป้อง จึงเปิดสาธารณะเหมือน products/packages (ดูได้โดยไม่ต้อง login) เมนูในหน้าเว็บจะโชว์เฉพาะหลัง login
// ตามที่ตกลงกัน แต่ตัวเนื้อหาเองไม่ได้ล็อกไว้ — เห็นเฉพาะ widget ที่ published แล้วเท่านั้น (ดู getPublished)
router.get("/V1/store/news", newsController.getPublished);
// widget ที่แอดมินติ๊ก "เผยแพร่ใน landing page" ไว้ — เป็นอิสระจาก blk_status (ติ๊กไว้ตอนยัง draft ก็ขึ้นได้
// เลย ไม่ต้อง published ที่ /news ก่อน) ใช้กับหน้าแรกของเว็บลูกค้าเป็น teaser สั้นๆ ก่อนลิงก์ไปหน้า /news เต็ม
router.get("/V1/store/news/landing", newsController.getLandingNews);

// webhook จาก payment gateway จริง — ไม่ผ่าน requireCustomerAuth (provider ยิงมาเอง ไม่มี customer token)
// พิสูจน์ตัวตนด้วย signature ภายในแทน (ดูคอมเมนต์ที่ handlePaymentWebhook)
router.post("/V1/store/webhooks/payment", storeController.handlePaymentWebhook);

// ต้อง login
router.post("/V1/store/checkout", requireCustomerAuth, storeController.checkout);
// mock ยืนยันจ่ายเงิน — mount เฉพาะตอน dev/test ที่ยังไม่มีบัญชี Stripe จริงเท่านั้น (สองเงื่อนไขพร้อมกัน
// เหมือน guard ในตัว controller เอง — ไม่มี route นี้เลยด้วยซ้ำถ้ามี STRIPE_SECRET_KEY จริงแล้ว ปลอดภัยกว่า
// พึ่ง guard ชั้นเดียวในฟังก์ชัน)
if (process.env.ALLOW_MOCK_PAYMENT_CONFIRM === "true" && !storeController.isPaymentGatewayConfigured()) {
    router.post("/V1/store/orders/:id/confirm-payment", requireCustomerAuth, storeController.confirmPayment);
}
router.get("/V1/store/orders/:id", requireCustomerAuth, storeController.getOrder);
router.put("/V1/store/orders/:id/cancel", requireCustomerAuth, storeController.cancelMyOrder);
router.get("/V1/store/my/entitlements", requireCustomerAuth, storeController.getMyEntitlements);

// ทำข้อสอบ
router.post("/V1/store/products/:id/attempts", requireCustomerAuth, attemptController.startOrResumeAttempt);
router.get("/V1/store/products/:id/export-questions", requireCustomerAuth, attemptController.exportPrintableQuestions);
router.get("/V1/store/attempts", requireCustomerAuth, attemptController.getAttemptHistory);
router.get("/V1/store/me/weak-areas", requireCustomerAuth, attemptController.getWeakAreas);
router.get("/V1/store/attempts/:id", requireCustomerAuth, attemptController.getAttempt);
router.put("/V1/store/attempts/:id/answers/:questionId", requireCustomerAuth, attemptController.submitAnswer);
router.post("/V1/store/attempts/:id/submit", requireCustomerAuth, attemptController.submitAttempt);
router.post("/V1/store/attempts/:id/abandon", requireCustomerAuth, attemptController.abandonAttempt);
router.get("/V1/store/attempts/:id/review", requireCustomerAuth, attemptController.getReview);

// bookmark
router.get("/V1/store/bookmarks", requireCustomerAuth, bookmarkController.getAll);
router.post("/V1/store/bookmarks/:questionId", requireCustomerAuth, bookmarkController.add);
router.delete("/V1/store/bookmarks/:questionId", requireCustomerAuth, bookmarkController.remove);

// แจ้งปัญหารายข้อ
router.post("/V1/store/questions/:id/report", requireCustomerAuth, questionReportController.createReport);

// live chat — ใช้ optionalCustomerAuth เพราะต้องรองรับทั้งผู้เยี่ยมชม (ยังไม่ login) และลูกค้าที่ login แล้ว
// ในชุด endpoint เดียวกัน (ดูตรรกะ merge ตอน login ระหว่างคุยอยู่ที่ ensureConversation ใน chat.controller.js)
router.post("/V1/store/chat/conversation", optionalCustomerAuth, chatController.ensureMyConversation);
router.get("/V1/store/chat/conversation/:convId/messages", optionalCustomerAuth, noStore, chatController.getMyMessages);
router.post(
    "/V1/store/chat/conversation/:convId/messages",
    optionalCustomerAuth,
    uploadImage.array("images", chatController.MAX_IMAGES_PER_MESSAGE),
    chatController.sendMyMessage
);

module.exports = router;
