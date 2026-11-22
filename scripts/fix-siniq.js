// Tuxum sotuvidan siniq tuxumni ajratadi: har kuni "Tuxum sotuvi" (N klitka × 36 000) yozuvi
// (N − siniq) klitkaga kamaytiriladi va siniq klitka alohida "Siniq tuxum sotuvi" (× 20 000) boʻlib qoʻshiladi.
// Siniq soni oʻsha kunning tuxum yigʻimi yozuvidan olinadi. Siniq sotuvi allaqachon bor kunlar oʻtkazib yuboriladi.
// Koʻrish:   node scripts/fix-siniq.js https://tovuq-ferma.vercel.app
// Yozish:    ADMIN_USER=... ADMIN_PASS=... node scripts/fix-siniq.js https://tovuq-ferma.vercel.app --apply
const SINIQ_PRICE = 20000;
const FROM = '2026-10-15';

(async () => {
  const base = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');
  const apply = process.argv.includes('--apply');
  const to = new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10);
  const get = async u => { const r = await fetch(base + u); if (!r.ok) throw new Error(u + ': ' + r.status); return r.json(); };
  const [E, L] = await Promise.all([get(`/api/entries?from=${FROM}&to=${to}`), get(`/api/lay?from=${FROM}&to=${to}`)]);
  const broken = {};
  for (const r of L.recs) broken[r.date] = (r.broken || []).reduce((s, v) => s + (v || 0), 0);

  let cookie = null;
  if (apply) {
    const login = await fetch(base + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: process.env.ADMIN_USER || 'admin', password: process.env.ADMIN_PASS || 'admin123' })
    });
    if (!login.ok) throw new Error('Login: ' + (await login.text()));
    cookie = login.headers.get('set-cookie').split(';')[0];
  }
  const send = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(method + ' ' + url + ': ' + (await r.text()));
    return r.json();
  };

  let diff = 0;
  const sales = E.filter(e => e.cat === 'tuxum' && e.qty).sort((a, b) => a.date.localeCompare(b.date));
  for (const e of sales) {
    const b = broken[e.date] || 0;
    if (!b) { console.log(e.date, 'siniq yoʻq — oʻzgarmadi'); continue; }
    if (E.some(x => x.date === e.date && x.cat === 'siniq')) { console.log(e.date, 'siniq sotuvi allaqachon bor — oʻtkazildi'); continue; }
    if (b >= e.qty) { console.log(e.date, 'siniq', b, '≥ sotuv', e.qty, '— oʻtkazildi'); continue; }
    const price = e.amount / e.qty, q = e.qty - b;
    const amount = Math.round(q * price), samount = b * SINIQ_PRICE;
    diff += amount + samount - e.amount;
    console.log(`${e.date}: ${e.qty} kl × ${price} → ${q} kl × ${price} + ${b} siniq × ${SINIQ_PRICE}  (${e.amount} → ${amount + samount})`);
    if (!apply) continue;
    // Avval siniq qoʻshiladi, keyin tuxum kamaytiriladi — feleka har qadamda qayta hisoblanadi
    await send('POST', '/api/entries', { date: e.date, type: 'in', cat: 'siniq', qty: b, amount: samount, period: null, note: '' });
    await send('PUT', '/api/entries/' + e.id, { date: e.date, type: 'in', cat: 'tuxum', qty: q, amount, period: e.period || null, note: e.note || '' });
  }
  console.log(`\nJami kirim farqi: ${diff} soʻm${apply ? '' : '  (faqat koʻrish; yozish uchun --apply)'}`);
})().catch(e => { console.error(e.message); process.exit(1); });
