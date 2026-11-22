const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '20kb' }));

const USER = process.env.ADMIN_USER || 'admin';
const PASS = process.env.ADMIN_PASS || 'admin123';
// Tuxum yigʻuvchilar sahifasi (/yigim) uchun alohida parol — faqat tuxum yigʻimini kirita oladi
const WPASS = process.env.WORKER_PASS || 'tuxum123';
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

/* ---------- Tuxum sotuvidan avtomatik chiqimlar ---------- */
// Tuxum sotuvi kiritilsa/oʻzgarsa/oʻchirilsa, oʻsha kunning feleka chiqimi qayta hisoblanadi
// (sotilgan klitka × FELEKA_PRICE) va kunlik ish haqi (oylik ÷ 30) yoʻq boʻlsa qoʻshiladi.
const FELEKA_PRICE = Number(process.env.FELEKA_PRICE) || 550;
const SALARY_MONTH = Number(process.env.SALARY_MONTH) || 112600000;
// Avtomatik yozuvlar koʻrinmaydigan `auto` maydoni bilan belgilanadi (eski yozuvlarda izoh boʻlgan)
// Feleka oddiy tuxum ham, siniq tuxum sotuviga ham ketadi
const isEgg = c => c === 'tuxum' || c === 'siniq';
const isAutoFel = e => e.cat === 'klitka' && (e.auto === 'fel' || e.note === 'feleka, avtomatik');
const newId = date => date.slice(0, 7) + '.' + crypto.randomBytes(6).toString('hex');
async function syncAuto(date) {
  const day = (await getEntries([date.slice(0, 7)])).filter(e => e.date === date);
  const qty = day.filter(e => isEgg(e.cat)).reduce((a, e) => a + (e.qty || 0), 0);
  const fel = day.filter(isAutoFel);
  for (const e of fel.slice(qty ? 1 : 0)) await delEntry(e.id);
  if (qty) {
    const amount = Math.round(qty * FELEKA_PRICE);
    if (!fel[0] || fel[0].qty !== qty || fel[0].amount !== amount || fel[0].note)
      await putEntry({ date, type: 'out', cat: 'klitka', amount, qty, period: null, note: '', auto: 'fel', id: fel[0] ? fel[0].id : newId(date), ts: Date.now() });
    if (!day.some(e => e.cat === 'ish'))
      await putEntry({ date, type: 'out', cat: 'ish', amount: Math.round(SALARY_MONTH / 30), qty: null, period: null, note: '', auto: 'ish', id: newId(date), ts: Date.now() });
  }
}
const syncSafe = async (...dates) => { for (const d of new Set(dates)) try { await syncAuto(d); } catch (e) { console.error('syncAuto', d, e.message); } };

/* ---------- Sessiya (imzolangan cookie) ---------- */
const sign = v => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
const h = s => crypto.createHash('sha256').update(String(s)).digest();
const same = (a, b) => crypto.timingSafeEqual(h(a), h(b));
const makeToken = (role, days = 7) => {
  const p = Buffer.from(JSON.stringify({ exp: Date.now() + days * 864e5, ...(role ? { role } : {}) })).toString('base64url');
  return p + '.' + sign(p);
};
const readToken = t => {
  if (!t) return null;
  const [p, s] = t.split('.');
  if (!p || !s || !same(sign(p), s)) return null;
  try { const j = JSON.parse(Buffer.from(p, 'base64url').toString()); return j.exp > Date.now() ? j : null; } catch { return null; }
};
// Admin tokenida role boʻlmaydi; ishchi tokeni (role: 'w') admin sifatida qabul qilinmaydi
const okToken = t => { const j = readToken(t); return !!j && !j.role; };
const okWorker = t => { const j = readToken(t); return !!j && j.role === 'w'; };
const getCookie = (req, n) => {
  const c = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(n + '='));
  return c ? c.slice(n.length + 1) : '';
};
const setCookie = (req, res, val, maxAge, name = 'fa') =>
  res.setHeader('Set-Cookie', `${name}=${val}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}` + (req.secure ? '; Secure' : ''));
const auth = (req, res, next) => okToken(getCookie(req, 'fa')) ? next() : res.status(401).json({ error: 'Kirish kerak' });
const authW = (req, res, next) => okWorker(getCookie(req, 'fw')) || okToken(getCookie(req, 'fa')) ? next() : res.status(401).json({ error: 'Kirish kerak' });

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

// Tuxum yigʻuvchilar: faqat parol, sessiya 60 kun
app.post('/api/wlogin', (req, res) => {
  if (blocked(req.ip)) return res.status(429).json({ error: 'Koʻp urinish. 10 daqiqadan keyin qayta urinib koʻring.' });
  if (same((req.body || {}).password || '', WPASS)) {
    tries.delete(req.ip);
    setCookie(req, res, makeToken('w', 60), 60 * 86400, 'fw');
    return res.json({ ok: true });
  }
  const t = tries.get(req.ip) || { n: 0, t: 0 };
  tries.set(req.ip, { n: t.n + 1, t: Date.now() });
  res.status(401).json({ error: 'Parol notoʻgʻri' });
});
app.post('/api/wlogout', (req, res) => { setCookie(req, res, '', 0, 'fw'); res.json({ ok: true }); });
app.get('/api/wme', (req, res) => res.json({ ok: okWorker(getCookie(req, 'fw')) || okToken(getCookie(req, 'fa')) }));
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
  e.id = newId(e.date);
  e.ts = Date.now();
  try { await putEntry(e); if (isEgg(e.cat)) await syncSafe(e.date); res.json(e); }
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
    const old = (await getEntries([id.slice(0, 7)])).find(x => x.id === id);
    if (!old) return res.status(404).json({ error: 'Yozuv topilmadi' });
    if (old.auto) e.auto = old.auto;
    if (e.id !== id) await delEntry(id);
    await putEntry(e);
    if (isEgg(old.cat) || isEgg(e.cat)) await syncSafe(old.date, e.date);
    res.json(e);
  } catch (err) { res.status(500).json({ error: 'Saqlab boʻlmadi' }); }
});

app.delete('/api/entries/:id', auth, async (req, res) => {
  if (!ID_RE.test(req.params.id)) return res.status(400).json({ error: 'ID notoʻgʻri' });
  try {
    const id = req.params.id, old = (await getEntries([id.slice(0, 7)])).find(x => x.id === id);
    const ok = await delEntry(id);
    if (ok && isEgg(old.cat)) await syncSafe(old.date);
    res.json({ ok });
  }
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
const LAY_NAME = { dead: 'Oʻlgan tovuqlar', broken: 'Siniq tuxum', trays: 'Chiqqan klitka' };
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
// {hens: [4], eggs: [4], dead?: [4], broken?: [4]} — dona; null = shu sex boʻyicha kiritilmagan
app.put('/api/lay/:date', auth, async (req, res) => {
  const date = req.params.date, b = req.body || {};
  if (!validDate(date)) return res.status(400).json({ error: 'Sana notoʻgʻri' });
  if (!countArr(b.hens, 1e6)) return res.status(400).json({ error: 'Tovuqlar soni notoʻgʻri' });
  if (!countArr(b.eggs, 1e6) || b.eggs.every(v => v === null)) return res.status(400).json({ error: 'Tuxum soni notoʻgʻri' });
  const hens = b.hens.map(v => v || 0);
  if (b.eggs.some((v, i) => v && !hens[i])) return res.status(400).json({ error: 'Tuxum kiritilgan sexda tovuqlar soni yoʻq' });
  // Ixtiyoriy: padej (oʻlgan tovuq) va siniq tuxum, sexlar boʻyicha
  for (const k of ['dead', 'broken', 'trays']) if (b[k] != null && !countArr(b[k], 1e6)) return res.status(400).json({ error: LAY_NAME[k] + ' soni notoʻgʻri' });
  const r = { date, hens, eggs: b.eggs, ts: Date.now() };
  for (const k of ['dead', 'broken', 'trays']) if (b[k] && b[k].some(v => v != null)) r[k] = b[k];
  try {
    // Joriy tovuqlar soni faqat eng oxirgi sana kiritilganda yangilanadi (eski kunni tuzatish uni orqaga qaytarmaydi)
    const d = await getLay();
    const latest = d.recs.every(x => x.date <= date);
    await putLay(r, latest ? hens : null);
    res.json(r);
  } catch (e) { res.status(500).json({ error: 'Saqlab boʻlmadi' }); }
});
// Tuxum yigʻuvchilar sahifasidan: bitta sex boʻyicha bir kunlik yozuv (oʻsha kunning boshqa sexlari saqlanib qoladi).
// Faqat oxirgi 7 kun va bugun uchun — eski kunlarni faqat admin tuzatadi.
const tashkentToday = () => new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10);
const shiftDate = (s, n) => new Date(Date.parse(s + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
app.put('/api/wlay/:date', authW, async (req, res) => {
  const date = req.params.date, b = req.body || {}, t = tashkentToday();
  if (!validDate(date) || date > shiftDate(t, 1) || date < shiftDate(t, -7)) return res.status(400).json({ error: 'Faqat oxirgi 7 kunni kiritish mumkin' });
  const sex = b.sex;
  if (!Number.isInteger(sex) || sex < 0 || sex >= SEX_N) return res.status(400).json({ error: 'Sex notoʻgʻri' });
  const n = (v, max, req) => v == null || v === '' ? (req ? undefined : null) : Number.isInteger(v) && v >= 0 && v <= max ? v : undefined;
  const v = { hens: n(b.hens, 1e6, true), eggs: n(b.eggs, 1e6, true), dead: n(b.dead, 1e6), broken: n(b.broken, 1e6), trays: n(b.trays, 1e5) };
  if (!v.hens) return res.status(400).json({ error: 'Tovuqlar sonini kiriting' });
  if (v.eggs === undefined) return res.status(400).json({ error: 'Olingan tuxum sonini kiriting' });
  for (const k of ['dead', 'broken', 'trays']) if (v[k] === undefined) return res.status(400).json({ error: LAY_NAME[k] + ' soni notoʻgʻri' });
  try {
    const d = await getLay();
    const old = d.recs.find(x => x.date === date);
    const arr = k => (old && old[k] ? old[k].slice() : Array(SEX_N).fill(null));
    const hens = old ? old.hens.slice() : d.hens.slice();
    hens[sex] = v.hens;
    const r = { date, hens, eggs: arr('eggs'), ts: Date.now() };
    r.eggs[sex] = v.eggs;
    for (const k of ['dead', 'broken', 'trays']) { const a = arr(k); a[sex] = v[k]; if (a.some(x => x != null)) r[k] = a; }
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

/* ---------- Dashboardga kirishlar: sana, qurilma, shahar ---------- */
const VFILE = path.join(path.dirname(FILE), 'visits.json');
const VMAX = 1000;
// Havola oldindan koʻrinishi (Telegram, WhatsApp) va botlar kirish hisoblanmaydi
const BOT_RE = /bot|crawl|spider|preview|facebookexternalhit|whatsapp|telegram(bot)?\b|slurp|curl|wget|python|node-fetch|headless/i;
function parseUA(ua) {
  const t = ua || '';
  let dev = 'Kompyuter', os = '';
  if (/iPhone/.test(t)) { dev = 'Telefon'; os = 'iPhone'; }
  else if (/iPad/.test(t) || (/Macintosh/.test(t) && /Mobile/.test(t))) { dev = 'Planshet'; os = 'iPad'; }
  else if (/Android/.test(t)) { dev = /Mobile/.test(t) ? 'Telefon' : 'Planshet'; os = 'Android'; const m = t.match(/;\s*([^;)]+?)\s+Build\//); if (m && !/^(K|wv)$/.test(m[1])) os += ' · ' + m[1].trim().slice(0, 30); }
  else if (/Windows/.test(t)) os = 'Windows';
  else if (/Mac OS X|Macintosh/.test(t)) os = 'Mac';
  else if (/Linux/.test(t)) os = 'Linux';
  const br = /YaBrowser/.test(t) ? 'Yandex' : /EdgA?\//.test(t) ? 'Edge' : /OPR\/|Opera/.test(t) ? 'Opera' : /SamsungBrowser/.test(t) ? 'Samsung' :
    /Firefox|FxiOS/.test(t) ? 'Firefox' : /CriOS|Chrome\//.test(t) ? 'Chrome' : /Safari\//.test(t) ? 'Safari' : '';
  return { dev, os, br };
}
const hdr = (req, n) => { const v = req.headers[n]; try { return v ? decodeURIComponent(String(v)) : ''; } catch { return String(v || ''); } };
app.post('/api/visit', async (req, res) => {
  const ua = String(req.headers['user-agent'] || '');
  if (BOT_RE.test(ua)) return res.json({ ok: true });
  const v = {
    ts: Date.now(), ...parseUA(ua),
    city: hdr(req, 'x-vercel-ip-city').slice(0, 60),
    region: hdr(req, 'x-vercel-ip-country-region').slice(0, 10),
    country: hdr(req, 'x-vercel-ip-country').slice(0, 4),
    admin: okToken(getCookie(req, 'fa')) || undefined
  };
  try {
    if (R_URL && R_TOKEN) await pipeline([['LPUSH', 'ferma:visits', JSON.stringify(v)], ['LTRIM', 'ferma:visits', 0, VMAX - 1]]);
    else {
      let a = []; try { a = JSON.parse(fs.readFileSync(VFILE, 'utf8')); } catch {}
      a.unshift(v); fs.mkdirSync(path.dirname(VFILE), { recursive: true }); fs.writeFileSync(VFILE, JSON.stringify(a.slice(0, VMAX)));
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Saqlab boʻlmadi' }); }
});
app.get('/api/visits', auth, async (req, res) => {
  try {
    let a;
    if (R_URL && R_TOKEN) a = ((await redis(['LRANGE', 'ferma:visits', 0, VMAX - 1])) || []).map(x => JSON.parse(x));
    else { try { a = JSON.parse(fs.readFileSync(VFILE, 'utf8')); } catch { a = []; } }
    res.json(a);
  } catch (e) { res.status(500).json({ error: 'Bazaga ulanib boʻlmadi' }); }
});

/* ---------- Sahifalar ---------- */
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/yigim', (req, res) => res.sendFile(path.join(__dirname, 'public', 'yigim.html')));
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
