// เทมเพลตอีเมลทั้งหมดของระบบ รวมไว้ที่เดียวเพื่อให้หน้าตาสม่ำเสมอ (ใช้ renderLayout ร่วมกันทุกฉบับ)
//
// ข้อจำกัดของอีเมลที่ทำให้เขียนต่างจากหน้าเว็บปกติ — จงใจทั้งหมด ไม่ใช่เขียนสไตล์เก่า:
//   - ใช้ <table> จัด layout ไม่ใช้ flex/grid เพราะ Outlook (Word rendering engine) ไม่รองรับ
//   - inline style ทุกจุด เพราะ Gmail ตัด <style> ใน <head> ทิ้งในบาง client
//   - ไม่โหลดเว็บฟอนต์ ใช้ system font stack ที่มีไทยครบ
//   - รูปทุกอันต้องเป็น URL เต็ม (ไม่มี relative path ในกล่องจดหมาย) และต้องอ่านรู้เรื่องแม้ลูกค้าปิดรูป
const { escapeHtml } = require("./mailer");

const BRAND_BLUE = "#2B5CE6";
const BRAND_ORANGE = "#FF9F1C";
const INK = "#101828";
const INK_SOFT = "#475467";
const LINE = "#E4E7EC";
const FONT = "'Segoe UI', 'Helvetica Neue', 'Noto Sans Thai', 'Sarabun', Tahoma, sans-serif";

function storeUrl() {
    return (process.env.STORE_URL || "https://www.fasttiw.com").replace(/\/$/, "");
}

const baht = (n) => `฿${Number(n || 0).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// วันที่แบบไทยพร้อมเวลา ตรึง timezone เป็นกรุงเทพเสมอ — เซิร์ฟเวอร์อาจตั้ง TZ เป็น UTC แล้วลูกค้าจะเห็น
// เวลาชำระเงินเพี้ยนไป 7 ชั่วโมงในใบเสร็จ ซึ่งเป็นเอกสารที่ลูกค้าอาจเอาไปอ้างอิงจริง
function thaiDateTime(value) {
    const d = value ? new Date(value) : new Date();
    return d.toLocaleString("th-TH", {
        dateStyle: "long",
        timeStyle: "short",
        timeZone: "Asia/Bangkok",
    });
}

function thaiDate(value) {
    return new Date(value).toLocaleDateString("th-TH", { dateStyle: "long", timeZone: "Asia/Bangkok" });
}

// เปลือกอีเมลที่ใช้ร่วมกันทุกฉบับ — preheader คือข้อความที่ client แสดงต่อท้ายหัวข้อในรายการกล่องจดหมาย
// ถ้าไม่กำหนดเอง Gmail จะดึงคำแรกๆ ในเนื้อหามาแสดงแทน ซึ่งมักเป็นคำว่า "ดูในเว็บ" หรือชื่อร้านซ้ำ
function renderLayout({ title, preheader = "", bodyHtml }) {
    const url = storeUrl();
    return `<!doctype html>
<html lang="th">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:${FONT};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:28px 12px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid ${LINE};">

        <tr><td style="background:${BRAND_BLUE};padding:22px 28px;">
          <img src="${url}/logo/fasttiw-logo-dark.png" alt="Fasttiw" width="150" style="display:block;border:0;width:150px;height:auto;">
        </td></tr>
        <tr><td style="height:3px;background:${BRAND_ORANGE};font-size:0;line-height:0;">&nbsp;</td></tr>

        <tr><td style="padding:30px 28px 34px;color:${INK};font-size:15px;line-height:1.7;">
          ${bodyHtml}
        </td></tr>

        <tr><td style="padding:20px 28px 26px;border-top:1px solid ${LINE};background:#fafbfc;color:#8b95a5;font-size:12.5px;line-height:1.6;">
          อีเมลฉบับนี้ส่งอัตโนมัติจากระบบ Fasttiw — ตอบกลับอีเมลนี้ได้เลยหากมีข้อสงสัย<br>
          <a href="${url}" style="color:${BRAND_BLUE};text-decoration:none;">${url.replace(/^https?:\/\//, "")}</a>
          &nbsp;·&nbsp; Fasttiw by Softwork Development
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function button(href, label) {
    return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:26px 0 8px;"><tr>
      <td style="background:${BRAND_BLUE};border-radius:10px;">
        <a href="${href}" style="display:inline-block;padding:13px 30px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;font-family:${FONT};">${escapeHtml(label)}</a>
      </td></tr></table>`;
}

function row(label, value, opts = {}) {
    const weight = opts.bold ? "600" : "400";
    const color = opts.color || INK_SOFT;
    const border = opts.topBorder ? `border-top:1px solid ${LINE};` : "";
    return `<tr>
      <td style="padding:7px 0;${border}color:${INK_SOFT};font-size:14px;">${escapeHtml(label)}</td>
      <td style="padding:7px 0;${border}color:${color};font-size:14px;font-weight:${weight};text-align:right;white-space:nowrap;">${escapeHtml(value)}</td>
    </tr>`;
}

/* ─────────────────────────── ใบเสร็จหลังชำระเงินสำเร็จ ─────────────────────────── */

// order/items/customer มาจาก settlePaidOrder() ตอน settle สำเร็จ — entitlements คือรายการสิทธิ์ที่เพิ่ง
// ให้ไป พร้อมวันหมดอายุจริงหลังคำนวณ (NULL = ตลอดชีพ) เพื่อให้ลูกค้าเห็นในใบเสร็จเลยว่าใช้ได้ถึงเมื่อไหร่
// ไม่ต้องเข้าเว็บมาไล่หา
function buildReceiptEmail({ order, items, customer, entitlements = [] }) {
    const url = storeUrl();
    const name = [customer?.cus_fname, customer?.cus_lname].filter(Boolean).join(" ") || customer?.cus_username || "ลูกค้า";
    const paidAt = thaiDateTime(order.ord_paid_at);

    const itemRows = items
        .map(
            (it) => `<tr>
              <td style="padding:11px 0;border-top:1px solid ${LINE};color:${INK};font-size:14px;">${escapeHtml(it.prod_name)}</td>
              <td style="padding:11px 0;border-top:1px solid ${LINE};color:${INK};font-size:14px;text-align:right;white-space:nowrap;">${baht(it.oi_total ?? it.oi_price)}</td>
            </tr>`
        )
        .join("");

    const discount = Number(order.ord_discount || 0);
    const entitlementList = entitlements.length
        ? `<div style="margin-top:26px;padding:16px 18px;background:#f7f9ff;border:1px solid #dbe4fb;border-radius:10px;">
             <div style="font-weight:600;color:${INK};margin-bottom:8px;">สิทธิ์ที่ได้รับแล้ว</div>
             ${entitlements
                 .map(
                     (e) =>
                         `<div style="color:${INK_SOFT};font-size:14px;padding:3px 0;">• ${escapeHtml(e.prod_name)} — ${
                             e.ent_expires_at ? `ใช้ได้ถึง ${escapeHtml(thaiDate(e.ent_expires_at))}` : "ไม่มีวันหมดอายุ"
                         }</div>`
                 )
                 .join("")}
           </div>`
        : "";

    const bodyHtml = `
      <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#8b95a5;margin-bottom:6px;">ใบเสร็จรับเงิน</div>
      <h1 style="margin:0 0 6px;font-size:23px;font-weight:600;color:${INK};">ได้รับเงินเรียบร้อยแล้ว</h1>
      <p style="margin:0 0 24px;color:${INK_SOFT};">
        สวัสดีคุณ${escapeHtml(name)} ขอบคุณที่สั่งซื้อกับ Fasttiw — เปิดใช้สิทธิ์ให้เรียบร้อยแล้ว เข้าทำข้อสอบได้ทันที
      </p>

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
        ${row("เลขที่คำสั่งซื้อ", order.ord_id, { bold: true, color: INK })}
        ${row("วันที่ชำระเงิน", paidAt)}
        ${row("ช่องทางชำระเงิน", order.ord_omise_charge_id ? "PromptPay (สแกน QR)" : "ยืนยันโดยเจ้าหน้าที่")}
      </table>

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:22px;">
        <tr>
          <td style="padding-bottom:8px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#8b95a5;">รายการ</td>
          <td style="padding-bottom:8px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#8b95a5;text-align:right;">ราคา</td>
        </tr>
        ${itemRows}
        ${row("ยอดรวม", baht(order.ord_subtotal), { topBorder: true })}
        ${discount > 0 ? row("ส่วนลด", `- ${baht(discount)}`, { color: "#0E9F6E" }) : ""}
        <tr>
          <td style="padding:12px 0 0;border-top:2px solid ${INK};color:${INK};font-size:16px;font-weight:600;">ยอดชำระสุทธิ</td>
          <td style="padding:12px 0 0;border-top:2px solid ${INK};color:${BRAND_BLUE};font-size:19px;font-weight:600;text-align:right;white-space:nowrap;">${baht(order.ord_total)}</td>
        </tr>
      </table>

      ${entitlementList}

      ${button(`${url}/library`, "เข้าทำข้อสอบเลย")}

      <p style="margin:16px 0 0;color:${INK_SOFT};font-size:13.5px;">
        ดูรายละเอียดคำสั่งซื้อได้ที่
        <a href="${url}/orders/${encodeURIComponent(order.ord_id)}" style="color:${BRAND_BLUE};">หน้าคำสั่งซื้อ</a>
        หรือดูคำสั่งซื้อทั้งหมดที่ <a href="${url}/orders" style="color:${BRAND_BLUE};">คำสั่งซื้อของฉัน</a>
      </p>`;

    return {
        subject: `ใบเสร็จคำสั่งซื้อ ${order.ord_id} — Fasttiw`,
        html: renderLayout({
            title: `ใบเสร็จคำสั่งซื้อ ${order.ord_id}`,
            preheader: `ชำระเงิน ${baht(order.ord_total)} สำเร็จ เปิดสิทธิ์เข้าทำข้อสอบให้แล้ว`,
            bodyHtml,
        }),
    };
}

/* ─────────────────────────── ลิงก์ตั้งรหัสผ่านใหม่ ─────────────────────────── */

// ส่ง "ลิงก์" ไม่ใช่รหัสผ่าน ตามกฎใน CLAUDE.md ข้อ 7 (ห้ามส่งรหัสผ่านทางอีเมล) — ลิงก์มีอายุจำกัดและ
// ใช้ได้ครั้งเดียว ตัว token จริงถูก hash ก่อนเก็บลง DB ดู customerAuth.controller.js
function buildPasswordResetEmail({ customer, resetUrl, expiresMinutes }) {
    const name = [customer?.cus_fname, customer?.cus_lname].filter(Boolean).join(" ") || customer?.cus_username || "ลูกค้า";

    const bodyHtml = `
      <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#8b95a5;margin-bottom:6px;">ตั้งรหัสผ่านใหม่</div>
      <h1 style="margin:0 0 6px;font-size:23px;font-weight:600;color:${INK};">ลืมรหัสผ่านใช่ไหม</h1>
      <p style="margin:0 0 6px;color:${INK_SOFT};">
        สวัสดีคุณ${escapeHtml(name)} — มีคำขอตั้งรหัสผ่านใหม่สำหรับบัญชีนี้ กดปุ่มด้านล่างเพื่อตั้งรหัสผ่านใหม่ได้เลย
      </p>

      ${button(resetUrl, "ตั้งรหัสผ่านใหม่")}

      <p style="margin:18px 0 0;color:${INK_SOFT};font-size:13.5px;">
        ลิงก์นี้ใช้ได้ครั้งเดียวและหมดอายุใน ${expiresMinutes} นาที ถ้าหมดอายุแล้วให้กดขอลิงก์ใหม่จากหน้าเข้าสู่ระบบอีกครั้ง
      </p>
      <p style="margin:14px 0 0;padding:14px 16px;background:#fff8ec;border:1px solid #ffe2b8;border-radius:10px;color:${INK_SOFT};font-size:13.5px;">
        <strong style="color:${INK};">ไม่ได้เป็นคนขอ?</strong> ไม่ต้องทำอะไรเลย รหัสผ่านเดิมยังใช้ได้ตามปกติ
        และลิงก์นี้จะหมดอายุไปเอง
      </p>
      <p style="margin:18px 0 0;color:#8b95a5;font-size:12.5px;word-break:break-all;">
        ถ้ากดปุ่มไม่ได้ ให้คัดลอกลิงก์นี้ไปวางในเบราว์เซอร์: ${escapeHtml(resetUrl)}
      </p>`;

    return {
        subject: "ตั้งรหัสผ่านใหม่ — Fasttiw",
        html: renderLayout({
            title: "ตั้งรหัสผ่านใหม่",
            preheader: `ลิงก์ตั้งรหัสผ่านใหม่ ใช้ได้ครั้งเดียว หมดอายุใน ${expiresMinutes} นาที`,
            bodyHtml,
        }),
    };
}

module.exports = { buildReceiptEmail, buildPasswordResetEmail, renderLayout, thaiDateTime, thaiDate, baht };
