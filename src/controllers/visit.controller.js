const pool = require("../config/db");
const { clientKey } = require("../middlewares/rateLimit.middleware");
const {
    bangkokDate, getDailySalt, visitorHash, isBot, deviceType, classifySource, referrerHost,
    normalizePath, touchPresence, countOnline,
} = require("../utils/visitTracking");

// โดเมนของเว็บเราเอง — referrer จากหน้าในเว็บเดียวกัน (กดรีเฟรช/เปิดแท็บใหม่) ไม่ใช่ "แหล่งที่มา"
function ownHosts() {
    try {
        const host = new URL(process.env.STORE_URL || "http://localhost:3001").hostname.replace(/^www\./, "");
        return [host, `www.${host}`];
    } catch {
        return [];
    }
}

let warnedUntrustedIp = false;

// รับสัญญาณจากหน้าเว็บลูกค้า (ผ่าน tiwwai-store/app/api/track) — kind = "view" (เปิดหน้า) หรือ "ping"
// (ยังเปิดแท็บอยู่ ใช้นับ "ออนไลน์ตอนนี้" อย่างเดียว ไม่บันทึกลงตาราง)
//
// **ห้ามทำให้หน้าเว็บพังหรือช้า** — ตอบ 204 เสมอแม้บันทึกไม่สำเร็จ ตัวนับเป็นของเสริม ไม่ใช่งานหลัก
async function track(req, res) {
    res.status(204).end();

    try {
        const body = req.body ?? {};
        const userAgent = String(body.ua ?? "").slice(0, 500);
        if (isBot(userAgent)) return;

        const secret = process.env.INTERNAL_PROXY_SECRET;
        const trusted = !!secret && req.headers["x-internal-secret"] === secret;
        if (!trusted && !warnedUntrustedIp) {
            // ไม่มี secret = backend เห็นแค่ IP ของเซิร์ฟเวอร์ Next ซึ่งเหมือนกันทุกคน ลูกค้าที่ใช้เบราว์เซอร์รุ่นเดียวกัน
            // จะถูกนับเป็นคนเดียว (ตัวเลขต่ำกว่าจริงมาก) — เตือนครั้งเดียวพอ ไม่ spam log
            console.warn("[visits] ไม่ได้รับ IP จริงของผู้เยี่ยมชม (ตั้ง INTERNAL_PROXY_SECRET ให้ตรงกันทั้ง backend และ tiwwai-store) — จำนวนคนจะต่ำกว่าความจริง");
            warnedUntrustedIp = true;
        }

        const date = bangkokDate();
        const visitor = visitorHash(await getDailySalt(date), clientKey(req), userAgent);
        touchPresence(visitor);
        if (body.kind === "ping") return;

        const path = normalizePath(body.path);
        if (!path) return;

        const isEntry = body.entry === true;
        await pool.query(
            `INSERT INTO tb_page_views (pv_date, pv_visitor, pv_path, pv_is_entry, pv_source, pv_referrer_host, pv_device)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                date,
                visitor,
                path,
                isEntry ? 1 : 0,
                isEntry ? classifySource({ referrer: body.referrer, utmSource: body.utm_source, hasFbclid: body.fbclid === true, userAgent, ownHosts: ownHosts() }) : null,
                isEntry ? referrerHost(body.referrer) : null,
                deviceType(userAgent),
            ]
        );
    } catch (err) {
        console.error("[visits] บันทึกไม่สำเร็จ:", err.message);
    }
}

/* ─────────────────── รายงาน (หน้าแอดมิน /visitors) ─────────────────── */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 3600 * 1000;
const MAX_SPAN_DAYS = 3660; // 10 ปี
const MAX_DAY_BUCKETS = 400; // เกินนี้เป็นรายวันแล้วกราฟอ่านไม่ออก — สลับเป็นรายเดือนให้อัตโนมัติ

// วันที่เป็นสตริง YYYY-MM-DD ตลอดทาง (ไม่แปลงเป็น Date ท้องถิ่น) กันเขตเวลาของเซิร์ฟเวอร์มาทำให้เลื่อนวัน
const toMs = (d) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
const fromMs = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (d, n) => fromMs(toMs(d) + n * DAY_MS);
const daysBetween = (a, b) => Math.round((toMs(b) - toMs(a)) / DAY_MS);

function parseRange(query) {
    const today = bangkokDate();
    let to = DATE_RE.test(query.to ?? "") ? query.to : today;
    let from = DATE_RE.test(query.from ?? "") ? query.from : addDays(to, -29);
    if (from > to) [from, to] = [to, from];
    if (daysBetween(from, to) > MAX_SPAN_DAYS) from = addDays(to, -MAX_SPAN_DAYS);

    let granularity = ["day", "month", "year"].includes(query.granularity) ? query.granularity : "day";
    const autoSwitched = granularity === "day" && daysBetween(from, to) + 1 > MAX_DAY_BUCKETS;
    if (autoSwitched) granularity = "month";
    return { from, to, granularity, autoSwitched };
}

const BUCKET_SQL = { day: "%Y-%m-%d", month: "%Y-%m", year: "%Y" };

// ทุกช่วงเวลาในกราฟต้องมีจุด แม้วันนั้นไม่มีใครเข้าเลย — ไม่งั้นเส้นกราฟลากข้ามวันที่เป็น 0 ไปเฉยๆ
// แล้วดูเหมือนยอดคงที่ ทั้งที่จริงคือไม่มีคนเข้า
function allBuckets(from, to, granularity) {
    const keys = [];
    if (granularity === "day") {
        for (let d = from; d <= to; d = addDays(d, 1)) keys.push(d);
    } else if (granularity === "month") {
        let [y, m] = [+from.slice(0, 4), +from.slice(5, 7)];
        const end = to.slice(0, 7);
        for (;;) {
            const key = `${y}-${String(m).padStart(2, "0")}`;
            keys.push(key);
            if (key >= end) break;
            if (++m > 12) { m = 1; y++; }
        }
    } else {
        for (let y = +from.slice(0, 4); y <= +to.slice(0, 4); y++) keys.push(String(y));
    }
    return keys;
}

// หน้าที่มีรหัสชุดข้อสอบ — ดึงชื่อชุดมาแสดงแทนรหัส (แอดมินอ่าน PRD2026... ไม่ออก)
// /products/<id>, /products/<id>/sample และ /exam/<id> (หน้าเลือกโหมดก่อนเริ่มทำ — ไม่รวม /exam/attempts/...)
const PRODUCT_PATH = /^\/(?:products|exam)\/(?!attempts(?:\/|$))([^/]+)(\/sample)?$/;

async function getOverview(req, res, next) {
    try {
        const { from, to, granularity, autoSwitched } = parseRange(req.query);
        const span = daysBetween(from, to) + 1;
        const prevTo = addDays(from, -1);
        const prevFrom = addDays(prevTo, -(span - 1));
        const range = [from, to];

        const [[totals]] = await pool.query(
            `SELECT COUNT(*) AS pageviews, COUNT(DISTINCT pv_date, pv_visitor) AS visitors
             FROM tb_page_views WHERE pv_date BETWEEN ? AND ?`,
            range
        );
        const [[previous]] = await pool.query(
            `SELECT COUNT(*) AS pageviews, COUNT(DISTINCT pv_date, pv_visitor) AS visitors
             FROM tb_page_views WHERE pv_date BETWEEN ? AND ?`,
            [prevFrom, prevTo]
        );

        // "คน" ในช่วงเดือน/ปี = ผลรวมคนรายวัน (COUNT DISTINCT วัน+คน) — ระบบไม่ใช้ cookie จึงตามคนข้ามวันไม่ได้
        // (ตัดสินใจร่วมกับผู้ใช้ ดู database/query/create_page_views.sql)
        const [seriesRows] = await pool.query(
            `SELECT DATE_FORMAT(pv_date, ?) AS period,
                    COUNT(DISTINCT pv_date, pv_visitor) AS visitors, COUNT(*) AS pageviews
             FROM tb_page_views WHERE pv_date BETWEEN ? AND ?
             GROUP BY period ORDER BY period`,
            [BUCKET_SQL[granularity], ...range]
        );
        const byPeriod = new Map(seriesRows.map((r) => [r.period, r]));
        const series = allBuckets(from, to, granularity).map((period) => ({
            period,
            visitors: Number(byPeriod.get(period)?.visitors ?? 0),
            pageviews: Number(byPeriod.get(period)?.pageviews ?? 0),
        }));

        // แหล่งที่มานับจากหน้าแรกที่เข้ามา (entry) — คนเดียวกันเข้ามาทาง Facebook แล้วตกเย็นเข้าทาง Google
        // จะนับให้ทั้งสองช่องทาง ถูกต้องตามความหมาย "ช่องทางนี้พาคนเข้ามากี่คน"
        const [sources] = await pool.query(
            `SELECT pv_source AS source, COUNT(DISTINCT pv_date, pv_visitor) AS visitors
             FROM tb_page_views WHERE pv_is_entry = 1 AND pv_date BETWEEN ? AND ?
             GROUP BY pv_source ORDER BY visitors DESC`,
            range
        );
        const [devices] = await pool.query(
            `SELECT pv_device AS device, COUNT(DISTINCT pv_date, pv_visitor) AS visitors
             FROM tb_page_views WHERE pv_date BETWEEN ? AND ?
             GROUP BY pv_device ORDER BY visitors DESC`,
            range
        );
        const [pages] = await pool.query(
            `SELECT pv_path AS path, COUNT(DISTINCT pv_date, pv_visitor) AS visitors, COUNT(*) AS pageviews
             FROM tb_page_views WHERE pv_date BETWEEN ? AND ?
             GROUP BY pv_path ORDER BY visitors DESC, pageviews DESC, pv_path LIMIT 10`,
            range
        );
        const productIds = [...new Set(pages.map((p) => p.path.match(PRODUCT_PATH)?.[1]).filter(Boolean))];
        const productNames = new Map();
        if (productIds.length) {
            const [prods] = await pool.query("SELECT prod_id, prod_name FROM tb_products WHERE prod_id IN (?)", [productIds]);
            for (const p of prods) productNames.set(p.prod_id, p.prod_name);
        }

        // อัตราเปลี่ยนเป็นลูกค้า — นับเฉพาะช่วงที่ "เก็บสถิติผู้เยี่ยมชมแล้ว" เท่านั้น ถ้าช่วงที่เลือกเริ่มก่อนวันแรก
        // ที่เก็บข้อมูล ยอดสมัคร/ซื้อของวันเก่าๆ จะถูกหารด้วยผู้เยี่ยมชม 0 คน ทำให้อัตราสูงเกินจริงหลายเท่า
        const [[{ firstDay }]] = await pool.query("SELECT DATE_FORMAT(MIN(pv_date), '%Y-%m-%d') AS firstDay FROM tb_page_views");
        const funnelFrom = firstDay && firstDay > from ? firstDay : from;
        const funnelStart = `${funnelFrom} 00:00:00`;
        const funnelEnd = `${addDays(to, 1)} 00:00:00`;
        // สมัครเองผ่านเว็บเท่านั้น (ไม่นับบัญชีที่แอดมินสร้างจากแชทเพจ) — ดู alter_customers_add_signup_via.sql
        const [[{ signups }]] = await pool.query(
            `SELECT COUNT(*) AS signups FROM tb_customers
             WHERE cus_signup_via IN ('web', 'google') AND cus_created_at >= ? AND cus_created_at < ?`,
            [funnelStart, funnelEnd]
        );
        const [[{ buyers }]] = await pool.query(
            `SELECT COUNT(DISTINCT ord_customer_id) AS buyers FROM tb_orders
             WHERE ord_status = 'paid' AND ord_paid_at >= ? AND ord_paid_at < ?`,
            [funnelStart, funnelEnd]
        );
        const [[funnelVisitors]] = funnelFrom === from
            ? [[{ visitors: totals.visitors }]]
            : await pool.query(
                  "SELECT COUNT(DISTINCT pv_date, pv_visitor) AS visitors FROM tb_page_views WHERE pv_date BETWEEN ? AND ?",
                  [funnelFrom, to]
              );

        res.json({
            range: { from, to, granularity, auto_switched: autoSwitched, days: span },
            tracking_since: firstDay,
            online_now: countOnline(),
            totals: { visitors: Number(totals.visitors), pageviews: Number(totals.pageviews) },
            previous: { from: prevFrom, to: prevTo, visitors: Number(previous.visitors), pageviews: Number(previous.pageviews) },
            series,
            sources: sources.map((s) => ({ source: s.source ?? "direct", visitors: Number(s.visitors) })),
            devices: devices.map((d) => ({ device: d.device, visitors: Number(d.visitors) })),
            pages: pages.map((p) => ({
                path: p.path,
                product_name: productNames.get(p.path.match(PRODUCT_PATH)?.[1]) ?? null,
                is_sample: /\/sample$/.test(p.path),
                visitors: Number(p.visitors),
                pageviews: Number(p.pageviews),
            })),
            funnel: {
                from: funnelFrom,
                to,
                visitors: Number(funnelVisitors.visitors),
                signups: Number(signups),
                buyers: Number(buyers),
            },
        });
    } catch (err) {
        next(err);
    }
}

// ตัวเลข "ออนไลน์ตอนนี้" อย่างเดียว — หน้าแอดมินดึงซ้ำทุก 30 วินาที แยกจาก getOverview เพราะตัวนั้นยิง query
// หลายตัวบนตาราง page views ไม่คุ้มที่จะรันทั้งชุดทุกครึ่งนาทีเพื่อตัวเลขเดียวที่อยู่ในหน่วยความจำอยู่แล้ว
function getOnline(req, res) {
    res.json({ online_now: countOnline() });
}

module.exports = { track, getOverview, getOnline };
