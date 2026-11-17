const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '20kb' }));

const USER = process.env.ADMIN_USER || 'admin';
const PASS = process.env.ADMIN_PASS || 'admin123';
const SECRET = process.env.SESSION_SECRET ||
  crypto.createHash('sha256').update('ferma|' + USER + '|' + PASS).digest('hex');

/* ---------- Saqlash: Upstash Redis yoki fayl ---------- */
const R_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const R_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
// DATA_FILE ning papkasi ishlatiladi (yozuvlar shu papkadagi entries.json ga tushadi)
const FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'params.json');

async function redis(cmd) {
  const r = await fetch(R_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + R_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error || 'redis error');
  return j.result;
}

/* ---------- Kunlik kirim-chiqim yozuvlari (har oy alohida hash) ---------- */
const EFILE = path.join(path.dirname(FILE), 'entries.json');
const EKEY = m => 'ferma:e:' + m;
const readEF = () => { try { return JSON.parse(fs.readFileSync(EFILE, 'utf8')); } catch { return {}; } };
const writeEF = d => { fs.mkdirSync(path.dirname(EFILE), { recursive: true }); fs.writeFileSync(EFILE, JSON.stringify(d)); };

async function pipeline(cmds) {
  const r = await fetch(R_URL.replace(/\/$/, '') + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + R_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds)
  });
  const j = await r.json();
  if (!r.ok || !Array.isArray(j)) throw new Error('redis error');
  return j.map(x => { if (x.error) throw new Error(x.error); return x.result; });
}
async function getEntries(months) {
  if (R_URL && R_TOKEN) {
    const res = await pipeline(months.map(m => ['HGETALL', EKEY(m)]));
    const out = [];
    for (const a of res) for (let i = 1; i < (a || []).length; i += 2) out.push(JSON.parse(a[i]));
    return out;
  }
  const d = readEF();
  return months.flatMap(m => Object.values(d[m] || {}));
}
async function putEntry(e) {
  const m = e.date.slice(0, 7);
  if (R_URL && R_TOKEN) return redis(['HSET', EKEY(m), e.id, JSON.stringify(e)]);
  const d = readEF();
  (d[m] = d[m] || {})[e.id] = e;
  writeEF(d);
}
async function delEntry(id) {
  const m = id.slice(0, 7);
  if (R_URL && R_TOKEN) return (await redis(['HDEL', EKEY(m), id])) > 0;
  const d = readEF();
  if (!d[m] || !d[m][id]) return false;
  delete d[m][id];
  writeEF(d);
  return true;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^\d{4}-\d{2}\.[0-9a-f]{12}$/;
const validDate = s => DATE_RE.test(s || '') && !isNaN(Date.parse(s + 'T00:00:00Z')) &&
  new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
function monthsBetween(from, to) {
  let [y, m] = from.slice(0, 7).split('-').map(Number);
  const end = to.slice(0, 7), out = [];
  for (;;) {
    const k = y + '-' + String(m).padStart(2, '0');
    out.push(k);
    if (k >= end || out.length >= 36) return out;
    if (++m > 12) { m = 1; y++; }
  }
}
function cleanEntry(b) {
  b = b || {};
  if (!validDate(b.date)) return 'Sana notoʻgʻri';
  if (b.type !== 'in' && b.type !== 'out') return 'Turi notoʻgʻri';
  if (!/^[a-z_]{1,20}$/.test(b.cat || '')) return 'Toifa notoʻgʻri';
  const amount = Math.round(Number(b.amount));
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1e13) return 'Summa notoʻgʻri';
  const qty = b.qty === '' || b.qty == null ? null : Number(b.qty);
  if (qty !== null && (!Number.isFinite(qty) || qty < 0 || qty > 1e9)) return 'Miqdor notoʻgʻri';
  // Oylik chiqimlar uchun: qaysi oy hisobiga tushishi (masalan, oktyabr maoshi noyabrda toʻlansa)
  const period = b.period ? String(b.period) : null;
  if (period && !/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) return 'Oy notoʻgʻri';
  return { date: b.date, type: b.type, cat: b.cat, amount, qty, period, note: String(b.note || '').trim().slice(0, 200) };
}

/* ---------- Sessiya (imzolangan cookie) ---------- */
const sign = v => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
const h = s => crypto.createHash('sha256').update(String(s)).digest();
const same = (a, b) => crypto.timingSafeEqual(h(a), h(b));
const makeToken = () => {
  const p = Buffer.from(JSON.stringify({ exp: Date.now() + 7 * 864e5 })).toString('base64url');
  return p + '.' + sign(p);
};
const okToken = t => {
  if (!t) return false;
  const [p, s] = t.split('.');
  if (!p || !s || !same(sign(p), s)) return false;
  try { return JSON.parse(Buffer.from(p, 'base64url').toString()).exp > Date.now(); } catch { return false; }
};
const getCookie = (req, n) => {
  const c = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(n + '='));
  return c ? c.slice(n.length + 1) : '';
};
const setCookie = (req, res, val, maxAge) =>
  res.setHeader('Set-Cookie', `fa=${val}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}` + (req.secure ? '; Secure' : ''));
const auth = (req, res, next) => okToken(getCookie(req, 'fa')) ? next() : res.status(401).json({ error: 'Kirish kerak' });

/* ---------- Login urinishlarini cheklash ---------- */
const tries = new Map();
function blocked(ip) { const t = tries.get(ip); return t && t.n >= 5 && Date.now() - t.t < 10 * 60e3; }

/* ---------- API ---------- */
app.use('/api', (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

app.post('/api/login', (req, res) => {
  if (blocked(req.ip)) return res.status(429).json({ error: 'Koʻp urinish. 10 daqiqadan keyin qayta urinib koʻring.' });
  const { username, password } = req.body || {};
  if (same(username || '', USER) && same(password || '', PASS)) {
    tries.delete(req.ip);
    setCookie(req, res, makeToken(), 7 * 86400);
    return res.json({ ok: true });
  }
  const t = tries.get(req.ip) || { n: 0, t: 0 };
  tries.set(req.ip, { n: t.n + 1, t: Date.now() });
  res.status(401).json({ error: 'Login yoki parol notoʻgʻri' });
});

app.post('/api/logout', (req, res) => { setCookie(req, res, '', 0); res.json({ ok: true }); });
app.get('/api/me', (req, res) => res.json({ admin: okToken(getCookie(req, 'fa')) }));

app.get('/api/entries', async (req, res) => {
  const { from, to } = req.query;
  if (!validDate(from) || !validDate(to) || from > to) return res.status(400).json({ error: 'Sana oraligʻi notoʻgʻri' });
  try {
    const list = (await getEntries(monthsBetween(from, to)))
      .filter(e => e.date >= from && e.date <= to)
      .sort((a, b) => b.date.localeCompare(a.date) || b.ts - a.ts);
    res.json(list);
  } catch (e) { res.status(500).json({ error: 'Bazaga ulanib boʻlmadi' }); }
});

app.post('/api/entries', auth, async (req, res) => {
  const e = cleanEntry(req.body);
  if (typeof e === 'string') return res.status(400).json({ error: e });
  e.id = e.date.slice(0, 7) + '.' + crypto.randomBytes(6).toString('hex');
  e.ts = Date.now();
  try { await putEntry(e); res.json(e); }
  catch (err) { res.status(500).json({ error: 'Saqlab boʻlmadi. Bazani (Upstash) ulang.' }); }
});

app.put('/api/entries/:id', auth, async (req, res) => {
  const id = req.params.id;
  if (!ID_RE.test(id)) return res.status(400).json({ error: 'ID notoʻgʻri' });
  const e = cleanEntry(req.body);
  if (typeof e === 'string') return res.status(400).json({ error: e });
  // Oy oʻzgarsa, yozuv boshqa hashga koʻchadi va yangi ID oladi
  e.id = e.date.slice(0, 7) === id.slice(0, 7) ? id : e.date.slice(0, 7) + '.' + id.slice(8);
  e.ts = Date.now();
  try {
    if (e.id !== id && !(await delEntry(id))) return res.status(404).json({ error: 'Yozuv topilmadi' });
    await putEntry(e);
    res.json(e);
  } catch (err) { res.status(500).json({ error: 'Saqlab boʻlmadi' }); }
});

app.delete('/api/entries/:id', auth, async (req, res) => {
  if (!ID_RE.test(req.params.id)) return res.status(400).json({ error: 'ID notoʻgʻri' });
  try { res.json({ ok: await delEntry(req.params.id) }); }
  catch (err) { res.status(500).json({ error: 'Oʻchirib boʻlmadi' }); }
});

/* ---------- Tuxum yigʻimi: sexlardagi tovuqlar soni va har kuni yigʻilgan tuxum ---------- */
// Har kungi yozuv oʻsha kundagi tovuqlar sonini ham saqlaydi — keyin son oʻzgarsa, eski foizlar buzilmaydi.
const SEX_N = 4;
// Boshlangʻich holat: faqat 3-sexda tovuq bor
const DEFAULT_HENS = [0, 0, 65000, 0];
const LFILE = path.join(path.dirname(FILE), 'lay.json');
const readLF = () => { try { return JSON.parse(fs.readFileSync(LFILE, 'utf8')); } catch { return {}; } };
const writeLF = d => { fs.mkdirSync(path.dirname(LFILE), { recursive: true }); fs.writeFileSync(LFILE, JSON.stringify(d)); };
async function getLay() {
  if (R_URL && R_TOKEN) {
    const [s, h] = await pipeline([['GET', 'ferma:sex'], ['HGETALL', 'ferma:lay']]);
    const recs = [];
    for (let i = 1; i < (h || []).length; i += 2) recs.push(JSON.parse(h[i]));
    return { hens: s ? JSON.parse(s) : DEFAULT_HENS, recs };
  }
  const d = readLF();
  return { hens: d.hens || DEFAULT_HENS, recs: Object.values(d.recs || {}) };
}
async function putLay(r, hens) {
  if (R_URL && R_TOKEN) {
    const cmds = [['HSET', 'ferma:lay', r.date, JSON.stringify(r)]];
    if (hens) cmds.push(['SET', 'ferma:sex', JSON.stringify(hens)]);
    return pipeline(cmds);
  }
  const d = readLF();
  (d.recs = d.recs || {})[r.date] = r;
  if (hens) d.hens = hens;
  writeLF(d);
}
async function delLay(date) {
  if (R_URL && R_TOKEN) return (await redis(['HDEL', 'ferma:lay', date])) > 0;
  const d = readLF();
  if (!d.recs || !d.recs[date]) return false;
  delete d.recs[date]; writeLF(d); return true;
}
const countArr = (a, max) => Array.isArray(a) && a.length === SEX_N &&
  a.every(v => v === null || (Number.isInteger(v) && v >= 0 && v <= max));

app.get('/api/lay', async (req, res) => {
  const { from, to } = req.query;
  if (!validDate(from) || !validDate(to) || from > to) return res.status(400).json({ error: 'Sana oraligʻi notoʻgʻri' });
  try {
    const d = await getLay();
    res.json({ hens: d.hens, recs: d.recs.filter(r => r.date >= from && r.date <= to).sort((a, b) => a.date.localeCompare(b.date)) });
  } catch (e) { res.status(500).json({ error: 'Bazaga ulanib boʻlmadi' }); }
});
// {hens: [4], eggs: [4]} — tuxum dona; null = shu sex boʻyicha kiritilmagan
app.put('/api/lay/:date', auth, async (req, res) => {
  const date = req.params.date, b = req.body || {};
  if (!validDate(date)) return res.status(400).json({ error: 'Sana notoʻgʻri' });
  if (!countArr(b.hens, 1e6)) return res.status(400).json({ error: 'Tovuqlar soni notoʻgʻri' });
  if (!countArr(b.eggs, 1e6) || b.eggs.every(v => v === null)) return res.status(400).json({ error: 'Tuxum soni notoʻgʻri' });
  const hens = b.hens.map(v => v || 0);
  if (b.eggs.some((v, i) => v && !hens[i])) return res.status(400).json({ error: 'Tuxum kiritilgan sexda tovuqlar soni yoʻq' });
  const r = { date, hens, eggs: b.eggs, ts: Date.now() };
  try {
    // Joriy tovuqlar soni faqat eng oxirgi sana kiritilganda yangilanadi (eski kunni tuzatish uni orqaga qaytarmaydi)
    const d = await getLay();
    const latest = d.recs.every(x => x.date <= date);
    await putLay(r, latest ? hens : null);
    res.json(r);
  } catch (e) { res.status(500).json({ error: 'Saqlab boʻlmadi' }); }
});
app.delete('/api/lay/:date', auth, async (req, res) => {
  if (!validDate(req.params.date)) return res.status(400).json({ error: 'Sana notoʻgʻri' });
  try { res.json({ ok: await delLay(req.params.date) }); }
  catch (e) { res.status(500).json({ error: 'Oʻchirib boʻlmadi' }); }
});

/* ---------- Sahifalar ---------- */
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.use(express.static(path.join(__dirname, 'public')));

module.exports = app;
if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log('Ferma dashboard: http://localhost:' + port))
    .on('error', e => {
      if (e.code !== 'EADDRINUSE') throw e;
      console.error(`${port}-port band: server allaqachon boshqa oynada ishlayapti.\n` +
        `Oʻsha oynani yoping (Ctrl+C) yoki boshqa portda ishga tushiring: $env:PORT=3001; npm start`);
      process.exit(1);
    });
}
