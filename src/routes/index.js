const express = require("express");
const authController = require("../controllers/auth.controller");
const userController = require("../controllers/user.controller");
const roleController = require("../controllers/role.controller");
const logController = require("../controllers/log.controller");
const departmentController = require("../controllers/department.controller");
const productController = require("../controllers/product.controller");
const questionController = require("../controllers/question.controller");
const categoryController = require("../controllers/category.controller");
const topicController = require("../controllers/topic.controller");
const customerController = require("../controllers/customer.controller");
const entitlementController = require("../controllers/entitlement.controller");
const couponController = require("../controllers/coupon.controller");
const expenseCategoryController = require("../controllers/expenseCategory.controller");
const expenseController = require("../controllers/expense.controller");
const reportController = require("../controllers/report.controller");
const payrollController = require("../controllers/payroll.controller");
const partnerController = require("../controllers/partner.controller");
const packageController = require("../controllers/package.controller");
const dataDeletionRequestController = require("../controllers/dataDeletionRequest.controller");
const settingsController = require("../controllers/settings.controller");
const partnerDistributionController = require("../controllers/partnerDistribution.controller");
const questionReportController = require("../controllers/questionReport.controller");
const orderController = require("../controllers/order.controller");
const newsController = require("../controllers/news.controller");
const chatController = require("../controllers/chat.controller");
const { requireAuth } = require("../middlewares/auth.middleware");
const { requirePermission } = require("../middlewares/permission.middleware");
const { uploadImage, uploadSpreadsheet } = require("../middlewares/upload.middleware");
const { noStore } = require("../middlewares/noStore.middleware");

const router = express.Router();

router.get("/health", (req, res) => res.json({ status: "ok" }));

// ─── auth ───────────────────────────────────────────────────────────────────
router.post("/V1/auth/login", authController.login);
router.post("/V1/auth/logout", requireAuth, authController.logout);
router.get("/V1/auth/verifyPermission", requireAuth, authController.verifyPermission);

// ─── users ──────────────────────────────────────────────────────────────────
// route ที่ขึ้นต้นด้วย /me ต้องประกาศก่อน /:id เสมอ ไม่งั้น express จะจับ "me" เป็นค่า :id ไปก่อน
router.get("/V1/users/me", requireAuth, userController.me);
router.put("/V1/users/me", requireAuth, userController.updateMyProfile);
router.put("/V1/users/me/password", requireAuth, userController.changeOwnPassword);
router.put(
    "/V1/users/me/image",
    requireAuth,
    uploadImage.single("image"),
    userController.uploadMyImage
);
router.get("/V1/users", requireAuth, requirePermission("usersManagement"), userController.getAll);
router.get("/V1/users/:id", requireAuth, requirePermission("usersManagement"), userController.getOne);
router.post("/V1/users", requireAuth, requirePermission("createUsers"), userController.create);
router.put("/V1/users/:id", requireAuth, requirePermission("editUsers"), userController.update);
router.put("/V1/users/:id/reset-password", requireAuth, requirePermission("editUsers"), userController.resetPassword);
router.delete("/V1/users/:id", requireAuth, requirePermission("deleteUsers"), userController.remove);
router.put(
    "/V1/users/:id/image",
    requireAuth,
    requirePermission(["createUsers", "editUsers"]),
    uploadImage.single("image"),
    userController.uploadImage
);

// ─── roles ──────────────────────────────────────────────────────────────────
// getRole ใช้ทั้งหน้า "จัดการสิทธิ์" และ dropdown เลือกสิทธิ์ตอนสร้าง/แก้ผู้ใช้
// เลยล็อกแค่ requireAuth ไม่ล็อกด้วย roleManagement bit เพื่อไม่บล็อก dropdown นั้น
router.get("/V1/roles", requireAuth, roleController.getAll);
router.get("/V1/roles/:id", requireAuth, roleController.getOne);
router.post("/V1/roles", requireAuth, requirePermission("createRole"), roleController.create);
router.put("/V1/roles/:id", requireAuth, requirePermission("editRole"), roleController.update);
router.delete("/V1/roles/:id", requireAuth, requirePermission("deleteRole"), roleController.remove);

// ─── departments ────────────────────────────────────────────────────────────
// getAll ใช้ทั้งหน้า "จัดการแผนก" และ dropdown ตอนสร้าง/แก้ role เลยล็อกแค่ requireAuth เหมือน getRole
router.get("/V1/departments", requireAuth, departmentController.getAll);
router.get("/V1/departments/:id", requireAuth, departmentController.getOne);
router.post("/V1/departments", requireAuth, requirePermission("createDepartment"), departmentController.create);
router.put("/V1/departments/:id", requireAuth, requirePermission("editDepartment"), departmentController.update);
router.delete("/V1/departments/:id", requireAuth, requirePermission("deleteDepartment"), departmentController.remove);

// ─── logs ───────────────────────────────────────────────────────────────────
router.get("/V1/logs", requireAuth, requirePermission("loginLogs"), logController.getAll);
router.delete("/V1/logs", requireAuth, requirePermission("loginLogs"), logController.removeAll);

// ─── products (ชุดข้อสอบ) ───────────────────────────────────────────────────────
router.get("/V1/products", requireAuth, requirePermission("productsManagement"), productController.getAll);
router.get("/V1/products/:id", requireAuth, requirePermission("productsManagement"), productController.getOne);
router.post("/V1/products", requireAuth, requirePermission("createProduct"), productController.create);
router.put("/V1/products/:id", requireAuth, requirePermission("editProduct"), productController.update);
router.delete("/V1/products/:id", requireAuth, requirePermission("deleteProduct"), productController.remove);
router.put("/V1/products/:id/status", requireAuth, requirePermission("deleteProduct"), productController.setStatus);
router.put(
    "/V1/products/:id/image",
    requireAuth,
    requirePermission(["createProduct", "editProduct"]),
    uploadImage.single("image"),
    productController.uploadCover
);
router.get("/V1/products/:id/preview", requireAuth, requirePermission("productsManagement"), productController.preview);

// ─── questions (คำถามในแต่ละ product) ──────────────────────────────────────────
// ไม่ผูกกับ product เฉพาะเจาะจง เพราะรูปแบบคอลัมน์เหมือนกันทุกชุดข้อสอบ
router.get(
    "/V1/questions/template",
    requireAuth,
    requirePermission("createProduct"),
    questionController.downloadTemplate
);
router.get(
    "/V1/products/:productId/questions",
    requireAuth,
    requirePermission("productsManagement"),
    questionController.getAll
);
// ต้องมาก่อน route "/questions/:id" (GET) ด้านล่างเสมอ ไม่งั้น Express จะจับคำว่า "export" เป็นค่า :id
// ของ route เดี่ยวไปก่อน (path ยาวเท่ากันทั้งคู่ — สั้นกว่า/general กว่าต้องมาทีหลังเสมอ เหมือน batch ด้านล่าง)
router.get(
    "/V1/products/:productId/questions/export",
    requireAuth,
    requirePermission("productsManagement"),
    questionController.exportQuestions
);
router.get(
    "/V1/products/:productId/questions/:id",
    requireAuth,
    requirePermission("productsManagement"),
    questionController.getOne
);
router.post(
    "/V1/products/:productId/questions",
    requireAuth,
    requirePermission("createProduct"),
    questionController.create
);
router.post(
    "/V1/products/:productId/questions/batch",
    requireAuth,
    requirePermission("createProduct"),
    questionController.createBatch
);
router.put(
    "/V1/products/:productId/questions/:id",
    requireAuth,
    requirePermission("editProduct"),
    questionController.update
);
// ต้องมาก่อน route "/questions/:id" (DELETE) ด้านล่างเสมอ ไม่งั้น Express จะจับคำว่า "batch" เป็นค่า :id
// ของ route เดี่ยวไปก่อน (path ยาวเท่ากันทั้งคู่ — สั้นกว่า/general กว่าต้องมาทีหลังเสมอ)
router.delete(
    "/V1/products/:productId/questions/batch",
    requireAuth,
    requirePermission("deleteProduct"),
    questionController.removeBatch
);
router.delete(
    "/V1/products/:productId/questions/:id",
    requireAuth,
    requirePermission("deleteProduct"),
    questionController.remove
);
router.put(
    "/V1/products/:productId/questions/:id/image",
    requireAuth,
    requirePermission(["createProduct", "editProduct"]),
    uploadImage.single("image"),
    questionController.uploadImage
);
router.delete(
    "/V1/products/:productId/questions/:id/image",
    requireAuth,
    requirePermission(["createProduct", "editProduct"]),
    questionController.removeImage
);
router.put(
    "/V1/products/:productId/questions/:questionId/choices/:choiceId/image",
    requireAuth,
    requirePermission(["createProduct", "editProduct"]),
    uploadImage.single("image"),
    questionController.uploadChoiceImage
);
router.delete(
    "/V1/products/:productId/questions/:questionId/choices/:choiceId/image",
    requireAuth,
    requirePermission(["createProduct", "editProduct"]),
    questionController.removeChoiceImage
);
router.post(
    "/V1/products/:productId/questions/import",
    requireAuth,
    requirePermission("createProduct"),
    uploadSpreadsheet.single("file"),
    questionController.importFile
);
router.get(
    "/V1/products/:productId/questions/import/status/:jobId",
    requireAuth,
    requirePermission("createProduct"),
    questionController.getImportStatus
);
router.post(
    "/V1/products/:productId/questions/import/cancel/:jobId",
    requireAuth,
    requirePermission("createProduct"),
    questionController.cancelImportJob
);

// ─── categories (หมวดหมู่ชุดข้อสอบ) ──────────────────────────────────────────────
// getAll ใช้ทั้งหน้าจัดการหมวดหมู่ และ dropdown เลือกหมวดหมู่ตอนสร้าง/แก้ product
// เลยล็อกแค่ requireAuth เหมือน getRole/getDepartment
router.get("/V1/categories", requireAuth, categoryController.getAll);
router.get("/V1/categories/:id", requireAuth, categoryController.getOne);
router.post("/V1/categories", requireAuth, requirePermission("createCategory"), categoryController.create);
router.put("/V1/categories/:id", requireAuth, requirePermission("editCategory"), categoryController.update);
router.delete("/V1/categories/:id", requireAuth, requirePermission("deleteCategory"), categoryController.remove);

// ─── topics (หมวดหมู่คำถาม/หัวข้อ) ───────────────────────────────────────────────
router.get("/V1/topics", requireAuth, topicController.getAll);
router.get("/V1/topics/:id", requireAuth, topicController.getOne);
router.post("/V1/topics", requireAuth, requirePermission("createTopic"), topicController.create);
router.put("/V1/topics/:id", requireAuth, requirePermission("editTopic"), topicController.update);
router.delete("/V1/topics/:id", requireAuth, requirePermission("deleteTopic"), topicController.remove);

// ─── customers (ลูกค้า/ผู้ทำข้อสอบ) ──────────────────────────────────────────────
// สร้างแบบกดปุ่มเดียว ได้ username+รหัสผ่านชั่วคราวทันที เหมือน tb_users ไม่มี magic link/token แล้ว
router.get("/V1/customers", requireAuth, requirePermission("customersManagement"), customerController.getAll);
router.get("/V1/customers/:id", requireAuth, requirePermission("customersManagement"), customerController.getOne);
router.post("/V1/customers", requireAuth, requirePermission("createCustomer"), customerController.create);
router.put("/V1/customers/:id", requireAuth, requirePermission("editCustomer"), customerController.update);
router.put(
    "/V1/customers/:id/reset-password",
    requireAuth,
    requirePermission("editCustomer"),
    customerController.resetPassword
);
router.put(
    "/V1/customers/:id/image",
    requireAuth,
    requirePermission("editCustomer"),
    uploadImage.single("image"),
    customerController.uploadImage
);
router.delete("/V1/customers/:id", requireAuth, requirePermission("deleteCustomer"), customerController.remove);

// ─── entitlements (สิทธิ์การเข้าถึงชุดข้อสอบของลูกค้า) ───────────────────────────
router.get(
    "/V1/customers/:id/entitlements",
    requireAuth,
    requirePermission("customersManagement"),
    entitlementController.getByCustomer
);
router.post(
    "/V1/customers/:id/entitlements",
    requireAuth,
    requirePermission("createCustomer"),
    entitlementController.createBatch
);
// ภาพรวมสิทธิ์ทั้งหมด (ทุกลูกค้า) — ใช้ requirePermission("customersManagement") เหมือนหน้าลูกค้า
// เพราะเป็นข้อมูลชุดเดียวกัน ไม่แยก permission group ใหม่ให้ role ต้องตั้งค่าเพิ่ม
router.get(
    "/V1/entitlements",
    requireAuth,
    requirePermission("customersManagement"),
    entitlementController.getAll
);
router.put(
    "/V1/entitlements/:id/revoke",
    requireAuth,
    requirePermission("editCustomer"),
    entitlementController.revoke
);

// ─── coupons (คูปอง/โค้ดส่วนลด) ───────────────────────────────────────────────
// อนุญาต createCustomer ด้วย (ไม่ใช่แค่ couponsManagement) เพราะ dropdown เลือกโค้ดใน GrantProductsModal
// ต้องเรียก endpoint นี้ (แบบ usable=true) แม้ role นั้นไม่มีสิทธิ์จัดการคูปองโดยตรงก็ตาม
router.get(
    "/V1/coupons",
    requireAuth,
    requirePermission(["couponsManagement", "createCustomer"]),
    couponController.getAll
);
// วางก่อน /:id เพื่อความชัดเจน (แม้จริงๆ ไม่ชนกันเพราะคนละจำนวน segment) — ใช้ตอนแอดมินกรอกโค้ดส่วนลด
// ระหว่างเลือกชุดข้อสอบให้ลูกค้า (ดู GrantProductsModal) เลยอนุญาตด้วยสิทธิ์ createCustomer แทน couponsManagement
router.get(
    "/V1/coupons/validate/:code",
    requireAuth,
    requirePermission("createCustomer"),
    couponController.validateCode
);
router.get("/V1/coupons/:id", requireAuth, requirePermission("couponsManagement"), couponController.getOne);
router.post("/V1/coupons", requireAuth, requirePermission("createCoupon"), couponController.create);
router.put("/V1/coupons/:id", requireAuth, requirePermission("editCoupon"), couponController.update);
router.delete("/V1/coupons/:id", requireAuth, requirePermission("deleteCoupon"), couponController.remove);

// ─── expense categories (หมวดหมู่ค่าใช้จ่าย) ──────────────────────────────────────
router.get("/V1/expense-categories", requireAuth, requirePermission("expenseCategoriesManagement"), expenseCategoryController.getAll);
router.get("/V1/expense-categories/:id", requireAuth, requirePermission("expenseCategoriesManagement"), expenseCategoryController.getOne);
router.post("/V1/expense-categories", requireAuth, requirePermission("createExpenseCategory"), expenseCategoryController.create);
router.put("/V1/expense-categories/:id", requireAuth, requirePermission("editExpenseCategory"), expenseCategoryController.update);
router.delete("/V1/expense-categories/:id", requireAuth, requirePermission("deleteExpenseCategory"), expenseCategoryController.remove);

// ─── expenses (ค่าใช้จ่าย) ────────────────────────────────────────────────────────
router.get("/V1/expenses", requireAuth, requirePermission("expensesManagement"), expenseController.getAll);
router.get("/V1/expenses/:id", requireAuth, requirePermission("expensesManagement"), expenseController.getOne);
router.post("/V1/expenses", requireAuth, requirePermission("createExpense"), expenseController.create);
router.put("/V1/expenses/:id", requireAuth, requirePermission("editExpense"), expenseController.update);
router.delete("/V1/expenses/:id", requireAuth, requirePermission("deleteExpense"), expenseController.remove);

// ─── reports (รายงานการเงิน) ──────────────────────────────────────────────────────
router.get("/V1/reports/summary", requireAuth, requirePermission("reportsManagement"), reportController.summary);
router.get("/V1/reports/by-product", requireAuth, requirePermission("reportsManagement"), reportController.byProduct);
router.get("/V1/reports/partner-share", requireAuth, requirePermission(["reportsManagement", "partnersManagement"]), reportController.partnerShare);
router.get("/V1/reports/retained-earnings", requireAuth, requirePermission(["reportsManagement", "partnersManagement"]), reportController.getRetainedEarnings);
router.get("/V1/reports/product-ranking", requireAuth, requirePermission("reportsManagement"), reportController.getProductRanking);
router.get("/V1/reports/package-ranking", requireAuth, requirePermission("reportsManagement"), reportController.getPackageRanking);
router.get("/V1/reports/free-to-paid-conversion", requireAuth, requirePermission("reportsManagement"), reportController.getFreeToPaidConversion);
router.get("/V1/reports/daily-sales-trend", requireAuth, requirePermission("reportsManagement"), reportController.getDailySalesTrend);
router.get("/V1/reports/top-categories", requireAuth, requirePermission("reportsManagement"), reportController.getTopCategories);

// ─── payroll (เงินเดือนพนักงาน) ───────────────────────────────────────────────────
// /run-status ต้องมาก่อน /:id เสมอ ไม่งั้น Express จะจับ "run-status" เป็นค่า :id ของ route ด้านล่างไปก่อน
router.get("/V1/payrolls/run-status", requireAuth, requirePermission("payrollManagement"), payrollController.getRunStatus);
router.post("/V1/payrolls/batch-pay", requireAuth, requirePermission("runPayroll"), payrollController.batchPay);
router.get("/V1/payrolls", requireAuth, requirePermission("payrollManagement"), payrollController.getAll);
router.get("/V1/payrolls/:id", requireAuth, requirePermission("payrollManagement"), payrollController.getOne);
router.post("/V1/payrolls", requireAuth, requirePermission("createPayroll"), payrollController.create);
router.put("/V1/payrolls/:id", requireAuth, requirePermission("editPayroll"), payrollController.update);
router.put("/V1/payrolls/:id/pay", requireAuth, requirePermission("editPayroll"), payrollController.markPaid);
router.delete("/V1/payrolls/:id", requireAuth, requirePermission("deletePayroll"), payrollController.remove);

router.get("/V1/partners", requireAuth, requirePermission("partnersManagement"), partnerController.getAll);
router.put("/V1/partners", requireAuth, requirePermission("editPartner"), partnerController.setPartner);
router.delete("/V1/partners/:userId", requireAuth, requirePermission("editPartner"), partnerController.removePartner);

// ─── ประวัติจ่ายส่วนแบ่งกำไรหุ้นส่วนจริง (ไม่ใช่ค่าใช้จ่าย — ดูคอมเมนต์ใน partnerDistribution.controller.js) ──
router.get("/V1/partner-distributions", requireAuth, requirePermission("partnerDistributionsManagement"), partnerDistributionController.getAll);
router.get("/V1/partner-distributions/:id", requireAuth, requirePermission("partnerDistributionsManagement"), partnerDistributionController.getOne);
router.post("/V1/partner-distributions", requireAuth, requirePermission("createPartnerDistribution"), partnerDistributionController.create);
router.put("/V1/partner-distributions/:id", requireAuth, requirePermission("editPartnerDistribution"), partnerDistributionController.update);
router.put("/V1/partner-distributions/:id/pay", requireAuth, requirePermission("editPartnerDistribution"), partnerDistributionController.markPaid);
router.delete("/V1/partner-distributions/:id", requireAuth, requirePermission("deletePartnerDistribution"), partnerDistributionController.remove);

// จัดสรรกำไรอย่างเป็นทางการ — เป็น resource แยกจาก partner-distributions เจตนา (คนละ path เดี่ยวๆ)
// กันชนกับ route /partner-distributions/:id ด้านบน (ถ้าใช้ path ซ้อนกันแล้วมาทีหลัง Express จะจับ
// "allocations" เป็นค่า :id ไปก่อนโดยไม่ตั้งใจ)
router.get("/V1/profit-allocations", requireAuth, requirePermission("partnerDistributionsManagement"), partnerDistributionController.getAllocations);
router.get("/V1/profit-allocations/preview", requireAuth, requirePermission("createPartnerDistribution"), partnerDistributionController.previewAllocation);
router.post("/V1/profit-allocations", requireAuth, requirePermission("createPartnerDistribution"), partnerDistributionController.createAllocation);

// ─── packages (แพ็กเกจรวมชุด) ────────────────────────────────────────────────────
router.get("/V1/packages", requireAuth, requirePermission("packagesManagement"), packageController.getAll);
router.get("/V1/packages/:id", requireAuth, requirePermission("packagesManagement"), packageController.getOne);
router.post("/V1/packages", requireAuth, requirePermission("createPackage"), packageController.create);
router.put("/V1/packages/:id", requireAuth, requirePermission("editPackage"), packageController.update);
router.delete("/V1/packages/:id", requireAuth, requirePermission("deletePackage"), packageController.remove);
router.put(
    "/V1/packages/:id/image",
    requireAuth,
    requirePermission(["createPackage", "editPackage"]),
    uploadImage.single("image"),
    packageController.uploadCover
);

// ─── คำขอลบข้อมูลบัญชี (PDPA) — ใช้สิทธิ์เดียวกับจัดการลูกค้า ไม่เพิ่ม permission bit ใหม่สำหรับ
// ฟีเจอร์เล็กๆ นี้ (เป็นเรื่องบัญชีลูกค้าโดยตรงอยู่แล้ว) ────────────────────────────────────────
router.get("/V1/data-deletion-requests", requireAuth, requirePermission("customersManagement"), dataDeletionRequestController.getAll);
router.put("/V1/data-deletion-requests/:id", requireAuth, requirePermission("editCustomer"), dataDeletionRequestController.updateStatus);

// ─── แจ้งปัญหารายข้อ — ใช้สิทธิ์เดียวกับจัดการชุดข้อสอบ (productsManagement/editProduct) ────────────
router.get("/V1/question-reports", requireAuth, requirePermission("productsManagement"), questionReportController.getAll);
router.put("/V1/question-reports/:id/resolve", requireAuth, requirePermission("editProduct"), questionReportController.resolve);

// ─── คำสั่งซื้อ (ดูภาพรวม + fallback ยืนยันจ่ายเงินด้วยมือ ตามกฎเหล็กข้อ 5 ในหัวข้อการชำระเงินของ
// CLAUDE.md) ไม่เพิ่ม permission bit ใหม่ — ดูรายการใช้สิทธิ์เดียวกับดูรายงาน (ข้อมูลการเงิน), ยืนยันจ่าย
// ด้วยมือใช้สิทธิ์เดียวกับ grant สิทธิ์ลูกค้าแบบ manual เพราะมีผลเท่ากับ grant สิทธิ์ทันทีเหมือนกัน ─────
router.get("/V1/orders", requireAuth, requirePermission("reportsManagement"), orderController.getAll);
router.put("/V1/orders/:id/force-confirm", requireAuth, requirePermission("createCustomer"), orderController.forceConfirm);

// ─── ตั้งค่า % ค่าธรรมเนียม payment gateway (Omise) — บิตเดียวคุมทั้งดู+แก้ เพราะเป็นค่าเดียว ไม่ใช่
// CRUD resource ─────────────────────────────────────────────────────────────────────────────
router.get("/V1/settings/payment", requireAuth, requirePermission("paymentSettings"), settingsController.getPaymentSettings);
router.put("/V1/settings/payment", requireAuth, requirePermission("paymentSettings"), settingsController.updatePaymentSettings);
router.get("/V1/settings/dividend", requireAuth, requirePermission("partnerDistributionsManagement"), settingsController.getDividendSettings);
router.put("/V1/settings/dividend", requireAuth, requirePermission("createPartnerDistribution"), settingsController.updateDividendSettings);

// ─── ข่าวสาร (แอดมิน) — ฟีดเดียว (ไม่มี "โพสต์" แยกกัน) ประกอบด้วย widget หลายชิ้นเรียงลำดับกันเหมือน
// สร้าง landing page หนึ่งหน้า บันทึกทั้งฟีดในคำขอเดียว (ลบของเดิมทั้งหมดแล้วสร้างใหม่ตามลำดับที่ส่งมา)
// รูปแต่ละ widget/รายการย่อยอัปโหลดแยก request หลังบันทึกเนื้อหาหลักสำเร็จ (endpoint หลักรับ JSON) ────
router.get("/V1/news", requireAuth, requirePermission("newsManagement"), newsController.getAll);
router.put("/V1/news", requireAuth, requirePermission("editNews"), newsController.save);
router.put(
    "/V1/news/blocks/:blockId/image",
    requireAuth, requirePermission("editNews"),
    uploadImage.single("image"),
    newsController.uploadBlockImage
);
router.put(
    "/V1/news/blocks/:blockId/items/:itemId/image",
    requireAuth, requirePermission("editNews"),
    uploadImage.single("image"),
    newsController.uploadItemImage
);
router.put(
    "/V1/news/blocks/:blockId/custom-cells/:cellKey/image",
    requireAuth, requirePermission("editNews"),
    uploadImage.single("image"),
    newsController.uploadCustomCellImage
);
router.put(
    "/V1/news/blocks/:blockId/custom-cells/:cellKey/items/:itemKey/image",
    requireAuth, requirePermission("editNews"),
    uploadImage.single("image"),
    newsController.uploadCustomCellImage
);

// ─── widget "สร้างเอง" (Template) — แม่แบบที่แอดมินออกแบบเองบนกริด (ลาก+ย่อ/ขยายตำแหน่งช่องได้อิสระ)
// บันทึกไว้ใช้ซ้ำได้หลายจุดในฟีดหลัก (ลากเข้าฟีด = clone โครงสร้างไปเป็น custom block ใหม่ อิสระจาก
// template ต้นทางตั้งแต่นั้น แก้ template ทีหลังไม่กระทบของที่ใช้ไปแล้ว) ──────────────────────────────
router.get("/V1/news/templates", requireAuth, requirePermission("newsManagement"), newsController.listTemplates);
router.get("/V1/news/templates/:id", requireAuth, requirePermission("newsManagement"), newsController.getTemplate);
router.post("/V1/news/templates", requireAuth, requirePermission("editNews"), newsController.createTemplate);
router.put("/V1/news/templates/:id", requireAuth, requirePermission("editNews"), newsController.updateTemplate);
router.delete("/V1/news/templates/:id", requireAuth, requirePermission("editNews"), newsController.deleteTemplate);
router.put(
    "/V1/news/templates/:id/cells/:cellKey/image",
    requireAuth, requirePermission("editNews"),
    uploadImage.single("image"),
    newsController.uploadTemplateCellImage
);
router.put(
    "/V1/news/templates/:id/cells/:cellKey/items/:itemKey/image",
    requireAuth, requirePermission("editNews"),
    uploadImage.single("image"),
    newsController.uploadTemplateCellImage
);

// ─── แชทกับลูกค้า — กล่องข้อความรวม ทุกคนที่มีสิทธิ์ chatManagement เห็น/ตอบได้ทุกแชท (ไม่มีระบบ assign
// เจ้าของแชท) รายการ/ข้อความ poll ฝั่ง client เอง (ไม่มี WebSocket ในระบบนี้) ──────────────────────────
router.get("/V1/chat/unread-count", requireAuth, requirePermission("chatManagement"), noStore, chatController.getUnreadCount);
router.get("/V1/chat/conversations", requireAuth, requirePermission("chatManagement"), noStore, chatController.listConversations);
router.get("/V1/chat/conversations/:convId/messages", requireAuth, requirePermission("chatManagement"), noStore, chatController.getConversationMessages);
router.post(
    "/V1/chat/conversations/:convId/messages",
    requireAuth, requirePermission("chatManagement"),
    uploadImage.array("images", chatController.MAX_IMAGES_PER_MESSAGE),
    chatController.replyToConversation
);

module.exports = router;
