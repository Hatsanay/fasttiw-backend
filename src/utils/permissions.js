// Flat bit order must stay in sync with PERMISSION_GROUPS in
// frontend/app/components/bit.tsx — same order, same length (TOTAL_BITS).
const PERMISSION_KEYS = [
    "dashboard",
    "usersManagement",
    "createUsers",
    "editUsers",
    "deleteUsers",
    "roleManagement",
    "createRole",
    "editRole",
    "deleteRole",
    "departmentManagement",
    "createDepartment",
    "editDepartment",
    "deleteDepartment",
    "loginLogs",
    "productsManagement",
    "createProduct",
    "editProduct",
    "deleteProduct",
    "categoriesManagement",
    "createCategory",
    "editCategory",
    "deleteCategory",
    "topicsManagement",
    "createTopic",
    "editTopic",
    "deleteTopic",
    "customersManagement",
    "createCustomer",
    "editCustomer",
    "deleteCustomer",
    "couponsManagement",
    "createCoupon",
    "editCoupon",
    "deleteCoupon",
    "expensesManagement",
    "createExpense",
    "editExpense",
    "deleteExpense",
    "expenseCategoriesManagement",
    "createExpenseCategory",
    "editExpenseCategory",
    "deleteExpenseCategory",
    "reportsManagement",
    "payrollManagement",
    "createPayroll",
    "editPayroll",
    "deletePayroll",
    "partnersManagement",
    "editPartner",
    // กลุ่มใหม่ต้องต่อท้ายเสมอ (ห้ามแทรกกลาง) เพราะตำแหน่ง bit ผูกกับ role_permission ที่บันทึกไว้ใน DB แล้ว
    "packagesManagement",
    "createPackage",
    "editPackage",
    "deletePackage",
    // กลุ่มใหม่ต้องต่อท้ายเสมอ (ห้ามแทรกกลาง) เพราะตำแหน่ง bit ผูกกับ role_permission ที่บันทึกไว้ใน DB แล้ว
    "paymentSettings",
    "partnerDistributionsManagement",
    "createPartnerDistribution",
    "editPartnerDistribution",
    "deletePartnerDistribution",
    // กลุ่มใหม่ต้องต่อท้ายเสมอ (ห้ามแทรกกลาง) เพราะตำแหน่ง bit ผูกกับ role_permission ที่บันทึกไว้ใน DB แล้ว
    "runPayroll",
    // กลุ่มใหม่ต้องต่อท้ายเสมอ (ห้ามแทรกกลาง) เพราะตำแหน่ง bit ผูกกับ role_permission ที่บันทึกไว้ใน DB แล้ว
    "newsManagement",
    "createNews",
    "editNews",
    "deleteNews",
    // กลุ่มใหม่ต้องต่อท้ายเสมอ (ห้ามแทรกกลาง) เพราะตำแหน่ง bit ผูกกับ role_permission ที่บันทึกไว้ใน DB แล้ว
    "chatManagement",
];

const BIT_INDEX = Object.fromEntries(PERMISSION_KEYS.map((key, i) => [key, i]));

function hasBit(rolePermission, key) {
    const index = BIT_INDEX[key];
    if (index === undefined) return false;
    return rolePermission?.[index] === "1";
}

module.exports = { PERMISSION_KEYS, BIT_INDEX, hasBit };
