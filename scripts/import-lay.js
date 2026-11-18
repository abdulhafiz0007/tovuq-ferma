// Daftardagi tuxum yigʻimi yozuvlarini (3-sex) bazaga yuklaydi.
// Ishlatish: ADMIN_USER=admin ADMIN_PASS=... node scripts/import-lay.js https://tovuq-ferma.vercel.app
// Ustunlar: sana, tovuqlar soni, padej, tuxum (dona), siniq tuxum
const ROWS = `
2026-10-15 59860 38 44520 9
2026-10-16 59822 30 44460 8
2026-10-17 59792 30 44490 11
2026-10-18 59762 48 43770 9
2026-10-19 59714 24 43920 10
2026-10-20 59690 56 41520 7
2026-10-21 59634 30 45510 9
2026-10-22 59604 39 43860 7
2026-10-23 59565 27 43350 8
2026-10-24 59538 41 43350 9
2026-10-25 59497 43 43200 9
2026-10-26 59457 30 41730 7
2026-10-27 59424 33 39990 10
2026-10-28 59391 31 47370 8
2026-10-29 59361 55 43050 11
2026-10-30 59306 37 42690 10
2026-10-31 59275 42 42660 12
2026-11-01 59233 33 41790 10
2026-11-02 59200 36 42450 10
2026-11-03 59164 38 42360 11
2026-11-04 59126 42 42390 10
2026-11-05 59084 42 41850 11
2026-11-06 59042 49 41580 10
2026-11-07 58993 57 39810 11
2026-11-08 58936 71 38160 8
2026-11-09 58865 81 37140 9
2026-11-10 58784 97 36810 11
2026-11-11 58687 98 36390 10
2026-11-12 58589 98 37320 11
2026-11-13 58491 93 37200 8
2026-11-14 58398 67 36060 9
2026-11-15 58331 99 35730 9
2026-11-16 58201 101 36180 8
2026-11-17 58100 81 34800 9
`.trim().split('\n').map(l => l.trim().split(/\s+/));

const SEX = 2; // 3-sex
const arr = v => { const a = [null, null, null, null]; a[SEX] = v; return a; };

(async () => {
  const base = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');
  const login = await fetch(base + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.ADMIN_USER || 'admin', password: process.env.ADMIN_PASS || 'admin123' })
  });
  if (!login.ok) throw new Error('Login: ' + (await login.text()));
  const cookie = login.headers.get('set-cookie').split(';')[0];
  for (const [date, hens, dead, eggs, broken] of ROWS) {
    const h = [0, 0, 0, 0]; h[SEX] = +hens;
    const r = await fetch(base + '/api/lay/' + date, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ hens: h, eggs: arr(+eggs), dead: arr(+dead), broken: arr(+broken) })
    });
    console.log(date, r.status, r.ok ? (eggs / hens * 100).toFixed(1) + '%' : await r.text());
    if (!r.ok) process.exit(1);
  }
})().catch(e => { console.error(e.message); process.exit(1); });
