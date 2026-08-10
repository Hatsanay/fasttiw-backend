const pool = require("../config/db");

// อ่านค่าตรงๆ จาก DB ทุกครั้ง (ไม่ cache) เพราะเรียกไม่บ่อย (แค่ตอนคำนวณจ่ายเงิน/จัดสรรกำไร และหน้าตั้งค่า)
// validate เข้มงวดตอนอ่านด้วย ไม่ใช่แค่ปล่อยผ่าน — เผื่อค่าใน DB เพี้ยนโดยไม่คาดคิด การ fallback เป็น 0
// เงียบๆ จะทำให้ % ที่ใช้จริงต่ำกว่าที่ตั้งไว้ (กำไร/ยอดเก็บดูสูงเกินจริง) ซึ่งเป็นทิศทางอันตรายกว่าเสมอ
async function getPercentSetting(key) {
    const [rows] = await pool.query("SELECT setting_value FROM tb_settings WHERE setting_key = ?", [key]);
    const value = Number(rows[0]?.setting_value);
    if (!Number.isFinite(value) || value < 0 || value > 100) {
        console.error(`ค่า ${key} ผิดปกติ: "${rows[0]?.setting_value}" — ใช้ 0 แทนชั่วคราว`);
        return 0;
    }
    return value;
}

async function getPaymentGatewayFeePercent() {
    return getPercentSetting("payment_gateway_fee_percent");
}

async function getPaymentSettings(req, res, next) {
    try {
        const feePercent = await getPaymentGatewayFeePercent();
        res.json({ payment_gateway_fee_percent: feePercent });
    } catch (err) {
        next(err);
    }
}

async function updatePaymentSettings(req, res, next) {
    try {
        const { payment_gateway_fee_percent } = req.body ?? {};
        const value = Number(payment_gateway_fee_percent);
        if (!Number.isFinite(value) || value < 0 || value > 100) {
            return res.status(400).json({ message: "เปอร์เซ็นต์ค่าธรรมเนียมต้องเป็นตัวเลข 0-100" });
        }

        await pool.query(
            `INSERT INTO tb_settings (setting_key, setting_value, setting_updated_by_id)
             VALUES ('payment_gateway_fee_percent', ?, ?)
             ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), setting_updated_by_id = VALUES(setting_updated_by_id)`,
            [String(value), req.user.user_id]
        );

        res.json({ message: "บันทึกการตั้งค่าสำเร็จ" });
    } catch (err) {
        next(err);
    }
}

// ค่าตั้งต้นสำหรับคำนวณ "จัดสรรกำไร" (ทุนสำรองตามกฎหมาย + ปันผล + ภาษีหัก ณ ที่จ่าย) — ทั้งหมด
// snapshot ลง tb_profit_allocations ทุกครั้งที่จัดสรรจริง (ดูคอมเมนต์ใน partnerDistribution.controller.js)
// การอ่านค่าจากที่นี่จึงใช้แค่ตอน "แสดงค่าปัจจุบันในหน้าตั้งค่า" กับ "ตอนกำลังจะจัดสรรครั้งใหม่" เท่านั้น
// ไม่กระทบรายการจัดสรรเก่าที่ทำไปแล้วเลย
async function getDividendConfig() {
    const [rows] = await pool.query(
        "SELECT setting_value FROM tb_settings WHERE setting_key = 'registered_capital'"
    );
    const registeredCapital = Number(rows[0]?.setting_value ?? 0) || 0;
    return {
        legalReservePercent: await getPercentSetting("legal_reserve_percent"),
        dividendPercent: await getPercentSetting("dividend_percent"),
        withholdingTaxPercent: await getPercentSetting("withholding_tax_percent"),
        registeredCapital,
    };
}

async function getDividendSettings(req, res, next) {
    try {
        const config = await getDividendConfig();
        res.json({
            legal_reserve_percent: config.legalReservePercent,
            dividend_percent: config.dividendPercent,
            withholding_tax_percent: config.withholdingTaxPercent,
            registered_capital: config.registeredCapital,
        });
    } catch (err) {
        next(err);
    }
}

const DIVIDEND_PERCENT_FIELDS = ["legal_reserve_percent", "dividend_percent", "withholding_tax_percent"];

async function updateDividendSettings(req, res, next) {
    try {
        const body = req.body ?? {};
        const values = {};

        for (const key of DIVIDEND_PERCENT_FIELDS) {
            const value = Number(body[key]);
            if (!Number.isFinite(value) || value < 0 || value > 100) {
                return res.status(400).json({ message: `${key} ต้องเป็นตัวเลข 0-100` });
            }
            values[key] = value;
        }

        const registeredCapital = Number(body.registered_capital);
        if (!Number.isFinite(registeredCapital) || registeredCapital < 0) {
            return res.status(400).json({ message: "ทุนจดทะเบียนต้องเป็นตัวเลขไม่ติดลบ" });
        }
        values.registered_capital = registeredCapital;

        for (const [key, value] of Object.entries(values)) {
            await pool.query(
                `INSERT INTO tb_settings (setting_key, setting_value, setting_updated_by_id)
                 VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), setting_updated_by_id = VALUES(setting_updated_by_id)`,
                [key, String(value), req.user.user_id]
            );
        }

        res.json({ message: "บันทึกการตั้งค่าสำเร็จ" });
    } catch (err) {
        next(err);
    }
}

module.exports = {
    getPaymentSettings, updatePaymentSettings, getPaymentGatewayFeePercent,
    getDividendSettings, updateDividendSettings, getDividendConfig,
};
