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
  // Yem xaridi: qaysi xomashyo (ombor hisobiga kirim boʻlib tushadi)
  const item = b.item ? String(b.item) : null;
  if (item && !ITEM_RE.test(item)) return 'Mahsulot notoʻgʻri';
  return { date: b.date, type: b.type, cat: b.cat, amount, qty, period, item, note: String(b.note || '').trim().slice(0, 200) };
}

/* ---------- Yem ombori: retsept (cfg) va harakatlar (yem tayyorlash, sanoq) ---------- */
const ITEM_RE = /^[a-z0-9_]{1,24}$/;
const SFILE = path.join(path.dirname(FILE), 'stock.json');
const readSF = () => { try { return JSON.parse(fs.readFileSync(SFILE, 'utf8')); } catch { return {}; } };
const writeSF = d => { fs.mkdirSync(path.dirname(SFILE), { recursive: true }); fs.writeFileSync(SFILE, JSON.stringify(d)); };
// Boshlangʻich retsept: 19.03.2026 dagi rasion (4 000 kg partiya)
const DEFAULT_CFG = {
  items: [
    ['bugdoy', 'Bugʻdoy', 2300, 3675], ['soya', 'Soya', 447, 8500], ['semichka', 'Semichka', 680, 3811],
    ['yog', 'Yogʻ', 140, 18500], ['lizin', 'Lizin', 2, 21500], ['metionin', 'Metionin', 1.5, 70000],
    ['monokalsiy', 'Monokalsiy', 36, 18832], ['soda', 'Soda', 6, 8000], ['tuz', 'Tuz', 8, 1300],
    ['izvest', 'Izvest', 374, 280], ['xolin', 'Xolin', 1, 21500], ['premiks', 'Premiks', 4, 125000],
    ['tetrabiotik', 'Tetrabiotik', 0.5, 69000]
  ].map(([id, name, , price]) => ({ id, name, price })),
  recipes: [{ from: '2026-03-19', parts: { bugdoy: 2300, soya: 447, semichka: 680, yog: 140, lizin: 2, metionin: 1.5,
    monokalsiy: 36, soda: 6, tuz: 8, izvest: 374, xolin: 1, premiks: 4, tetrabiotik: 0.5 } }]
};
async function getStock() {
  if (R_URL && R_TOKEN) {
    const [c, h] = await pipeline([['GET', 'ferma:stockcfg'], ['HGETALL', 'ferma:stock']]);
    const recs = [];
    for (let i = 1; i < (h || []).length; i += 2) recs.push(JSON.parse(h[i]));
    return { cfg: c ? JSON.parse(c) : DEFAULT_CFG, recs };
  }
  const d = readSF();
  return { cfg: d.cfg || DEFAULT_CFG, recs: Object.values(d.recs || {}) };
}
async function putCfg(cfg) {
  if (R_URL && R_TOKEN) return redis(['SET', 'ferma:stockcfg', JSON.stringify(cfg)]);
  const d = readSF(); d.cfg = cfg; writeSF(d);
}
async function putRec(r) {
  if (R_URL && R_TOKEN) return redis(['HSET', 'ferma:stock', r.id, JSON.stringify(r)]);
  const d = readSF(); (d.recs = d.recs || {})[r.id] = r; writeSF(d);
}
async function delRec(id) {
  if (R_URL && R_TOKEN) return (await redis(['HDEL', 'ferma:stock', id])) > 0;
  const d = readSF();
  if (!d.recs || !d.recs[id]) return false;
  delete d.recs[id]; writeSF(d); return true;
}
const kgOk = v => Number.isFinite(v) && v >= 0 && v <= 1e8;
function cleanCfg(b) {
  b = b || {};
  if (!Array.isArray(b.items) || !b.items.length || b.items.length > 60) return 'Mahsulotlar roʻyxati notoʻgʻri';
  const items = [], ids = new Set();
  for (const x of b.items) {
    const name = String((x || {}).name || '').trim().slice(0, 40), price = Number(x.price) || 0;
    if (!ITEM_RE.test(x.id || '') || ids.has(x.id) || !name || !kgOk(price)) return 'Mahsulot notoʻgʻri: ' + (name || x.id);
    ids.add(x.id); items.push({ id: x.id, name, price });
  }
  if (!Array.isArray(b.recipes) || !b.recipes.length || b.recipes.length > 200) return 'Retsept notoʻgʻri';
  const recipes = [];
  for (const r of b.recipes) {
    if (!validDate((r || {}).from)) return 'Retsept sanasi notoʻgʻri';
    const parts = {};
    let tot = 0;
    for (const [k, v] of Object.entries(r.parts || {})) {
      const n = Number(v);
      if (!ids.has(k) || !kgOk(n)) return 'Retseptdagi miqdor notoʻgʻri';
      if (n > 0) { parts[k] = n; tot += n; }
    }
    if (!tot) return 'Retsept boʻsh';
    recipes.push({ from: r.from, parts });
  }
  recipes.sort((a, b) => a.from.localeCompare(b.from));
  return { items, recipes };
}
function cleanRec(b) {
  b = b || {};
  if (!validDate(b.date)) return 'Sana notoʻgʻri';
  const note = String(b.note || '').trim().slice(0, 200);
  if (b.kind === 'mix') {
    const kg = Number(b.kg);
    if (!kgOk(kg) || !kg) return 'Yem miqdori notoʻgʻri';
    return { date: b.date, kind: 'mix', kg, note };
  }
  if (b.kind === 'count') {
    const qty = Number(b.qty);
    if (!ITEM_RE.test(b.item || '')) return 'Mahsulot notoʻgʻri';
    if (!kgOk(qty)) return 'Qoldiq notoʻgʻri';
    return { date: b.date, kind: 'count', item: b.item, qty, note };
  }
  return 'Turi notoʻgʻri';
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

app.get('/api/stock', async (req, res) => {
  try { res.json(await getStock()); }
  catch (e) { res.status(500).json({ error: 'Bazaga ulanib boʻlmadi' }); }
});
app.put('/api/stock/cfg', auth, async (req, res) => {
  const c = cleanCfg(req.body);
  if (typeof c === 'string') return res.status(400).json({ error: c });
  try { await putCfg(c); res.json(c); }
  catch (e) { res.status(500).json({ error: 'Saqlab boʻlmadi' }); }
});
app.post('/api/stock/rec', auth, async (req, res) => {
  const r = cleanRec(req.body);
  if (typeof r === 'string') return res.status(400).json({ error: r });
  r.id = 's' + crypto.randomBytes(6).toString('hex');
  r.ts = Date.now();
  try { await putRec(r); res.json(r); }
  catch (e) { res.status(500).json({ error: 'Saqlab boʻlmadi' }); }
});
app.delete('/api/stock/rec/:id', auth, async (req, res) => {
  if (!/^s[0-9a-f]{12}$/.test(req.params.id)) return res.status(400).json({ error: 'ID notoʻgʻri' });
  try { res.json({ ok: await delRec(req.params.id) }); }
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
