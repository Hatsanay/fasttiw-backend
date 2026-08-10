const crypto = require("crypto");

// ตัดตัวอักษรที่สับสนกันง่ายออก (0/O, 1/l/I) เพราะ admin ต้องอ่านออกเสียง/พิมพ์ต่อให้ user
const CHARS = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";

function generateTempPassword(length = 10) {
    let password = "";
    for (let i = 0; i < length; i++) {
        password += CHARS[crypto.randomInt(CHARS.length)];
    }
    return password;
}

module.exports = { generateTempPassword };
