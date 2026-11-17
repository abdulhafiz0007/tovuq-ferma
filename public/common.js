/* Dashboard va admin panel uchun umumiy maʼlumot va yordamchilar */
const CATS = {
  in: [
    ['tuxum', 'Tuxum sotuvi', 'klitka'],
    ['tovuq', 'Tovuq sotuvi', 'bosh'],
    ['gong', 'Goʻng sotuvi', 'qop'],
    ['boshqa_k', 'Boshqa kirim', '']
  ],
  out: [
    ['yem', 'Yem', 'kg'],
    ['ish', 'Ish haqi', ''],
    ['elektr', 'Elektr', ''],
    ['klitka', 'Klitka (lotok) xaridi', 'dona'],
    ['vet', 'Dori / veterinar', ''],
    ['jojo', 'Joʻja / tovuq xaridi', 'bosh'],
    ['transport', 'Transport / yoqilgʻi', ''],
    ['tamir', 'Taʼmir / jihoz', ''],
    ['soliq', 'Soliq / toʻlovlar', ''],
    ['boshqa_c', 'Boshqa chiqim', '']
  ]
};
const CAT = {};
// 4-ustun = 1: oylik chiqim (bir marta toʻlanadi, dashboardda oy kunlariga taqsimlanadi)
for (const t in CATS) for (const [k, n, u, m] of CATS[t]) CAT[k] = { name: n, unit: u, type: t, monthly: !!m };
const MONTHLY = new Set(Object.keys(CAT).filter(k => CAT[k].monthly));
const catName = k => (CAT[k] || {}).name || k;

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => Math.round(n).toLocaleString('ru-RU').replace(/ /g, ' ');
const fq = n => (Math.round(n * 100) / 100).toLocaleString('ru-RU').replace(/ /g, ' ');
const money = n => (n < 0 ? '−' : '') + fmt(Math.abs(n)) + ' soʻm';
const short = n => {
  const a = Math.abs(n), s = n < 0 ? '−' : '';
  if (a >= 1e9) return s + (a / 1e9).toFixed(1).replace(/\.0$/, '') + ' mlrd';
  if (a >= 1e6) return s + (a / 1e6).toFixed(1).replace(/\.0$/, '') + ' mln';
  if (a >= 1e3) return s + Math.round(a / 1e3) + ' ming';
  return s + fmt(a);
};
const MO = ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentyabr', 'oktyabr', 'noyabr', 'dekabr'];
const MOS = ['yan', 'fev', 'mar', 'apr', 'may', 'iyn', 'iyl', 'avg', 'sen', 'okt', 'noy', 'dek'];
const WD = ['yakshanba', 'dushanba', 'seshanba', 'chorshanba', 'payshanba', 'juma', 'shanba'];
const pad = n => String(n).padStart(2, '0');
const iso = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const parseISO = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parseISO(s); d.setDate(d.getDate() + n); return iso(d); };
const dayLabel = s => { const d = parseISO(s); return d.getDate() + '-' + MO[d.getMonth()]; };
const hm = t => { const d = new Date(t); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
const sumBy = (list, type) => list.reduce((a, e) => a + (e.type === type ? e.amount : 0), 0);

/* ---------- Oylik chiqimlarni kunlarga taqsimlash ---------- */
const ym = s => s.slice(0, 7);
const prevYm = m => { let [y, mo] = m.split('-').map(Number); if (--mo < 1) { mo = 12; y--; } return y + '-' + pad(mo); };
const daysIn = m => { const [y, mo] = m.split('-').map(Number); return new Date(y, mo, 0).getDate(); };
const monthName = m => MO[+m.slice(5) - 1];
const periodOf = e => e.period || ym(e.date);
const periodLabel = e => MONTHLY.has(e.cat) ? ' · ' + monthName(periodOf(e)) + ' uchun' : '';
const isFixed = e => e.type === 'out' && MONTHLY.has(e.cat);

// Har oy uchun oylik chiqimlar: {total, cats, est}. Joriy yoki oʻtgan oy uchun hali kiritilmagan
// toifaga undan oldingi oyning summasi taxminiy olinadi (est roʻyxatida).
function fixedCosts(list, todayIso) {
  const act = {};
  for (const e of list) if (isFixed(e)) {
    const p = periodOf(e);
    (act[p] = act[p] || {})[e.cat] = (act[p][e.cat] || 0) + e.amount;
  }
  const cur = ym(todayIso), recent = new Set([cur, prevYm(cur)]), cache = {};
  return m => {
    if (cache[m]) return cache[m];
    const out = { total: 0, cats: {}, est: [] };
    for (const c of MONTHLY) {
      let v = (act[m] || {})[c] || 0;
      if (!v && recent.has(m)) {
        const p1 = prevYm(m);
        v = (act[p1] || {})[c] || (act[prevYm(p1)] || {})[c] || 0;
        if (v) out.est.push(c);
      }
      if (v) { out.cats[c] = v; out.total += v; }
    }
    return (cache[m] = out);
  };
}
// Bir kun: kirim, chiqim (oʻzgaruvchan + oylik chiqimning kunlik ulushi), shundan doimiy
function dayStats(list, d, fx) {
  const L = list.filter(e => e.date === d), fix = fx(ym(d)).total / daysIn(ym(d));
  const vo = L.reduce((a, e) => a + (e.type === 'out' && !isFixed(e) ? e.amount : 0), 0);
  return { date: d, in: sumBy(L, 'in'), out: vo + fix, fix };
}
// Oyning 1..n kunlari: oylik chiqimlardan n/oy kuni ulushi olinadi
function periodStats(list, m, n, fx) {
  const L = list.filter(e => ym(e.date) === m && +e.date.slice(8) <= n);
  const f = fx(m), share = n / daysIn(m), outCats = {}, inCats = {};
  for (const e of L) {
    if (e.type === 'in') inCats[e.cat] = (inCats[e.cat] || 0) + e.amount;
    else if (!isFixed(e)) outCats[e.cat] = (outCats[e.cat] || 0) + e.amount;
  }
  for (const c in f.cats) outCats[c] = (outCats[c] || 0) + f.cats[c] * share;
  const sum = o => Object.values(o).reduce((a, b) => a + b, 0);
  return { L, in: sum(inCats), out: sum(outCats), fix: f.total * share, fixMonth: f, outCats, inCats, est: f.est };
}

function toast(msg) {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 2600);
}

async function getEntries(from, to) {
  const r = await fetch(`/api/entries?from=${from}&to=${to}`, { cache: 'no-store' });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'server javob bermadi (' + r.status + '). Serverni qayta ishga tushiring.');
  return r.json();
}

/* ---------- Tuxum berish foizi ---------- */
const SEXES = 4;
async function getLay(from, to) {
  const r = await fetch(`/api/lay?from=${from}&to=${to}`, { cache: 'no-store' });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'server javob bermadi (' + r.status + '). Serverni qayta ishga tushiring.');
  return r.json();
}
// Bir kunlik yozuv: faqat tuxumi kiritilgan sexlar hisobga olinadi
function layDay(r) {
  let eggs = 0, hens = 0;
  r.eggs.forEach((v, i) => { if (v != null && r.hens[i]) { eggs += v; hens += r.hens[i]; } });
  return { date: r.date, eggs, hens, pct: hens ? eggs / hens * 100 : null };
}
const pctStr = p => p == null ? '—' : p.toFixed(1).replace('.', ',') + '%';

/* Kunlik kirim/chiqim juft ustunli grafigi (SVG, tooltip bilan) */
function dailyChart(box, days) {
  const W = Math.max(320, box.clientWidth), H = W > 640 ? 330 : 240, L = 52, R = 8, T = 10, B = 26;
  const max = Math.max(1, ...days.map(d => Math.max(d.in, d.out)));
  const step = niceStep(max / 4), top = Math.ceil(max / step) * step;
  const y = v => T + (H - T - B) * (1 - v / top);
  const cw = (W - L - R) / days.length, bw = Math.max(2, Math.min(14, (cw - 6) / 2));
  const bar = (x, v, cls) => {
    if (v <= 0) return '';
    const yy = y(v), h = y(0) - yy, r = Math.min(4, h, bw / 2);
    return `<path fill="var(${cls})" d="M${x},${y(0)}V${yy + r}Q${x},${yy} ${x + r},${yy}H${x + bw - r}Q${x + bw},${yy} ${x + bw},${yy + r}V${y(0)}Z"/>`;
  };
  let s = '';
  for (let v = 0; v <= top + 1e-9; v += step)
    s += `<line class="grid-l" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="ax" x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${short(v)}</text>`;
  const every = Math.ceil(days.length / Math.floor((W - L) / 46));
  days.forEach((d, i) => {
    const x0 = L + i * cw, cx = x0 + cw / 2;
    s += `<rect class="hit" data-i="${i}" x="${x0}" y="${T}" width="${cw}" height="${H - T - B}" rx="4"/>`;
    s += bar(cx - bw - 1, d.in, '--cin') + bar(cx + 1, d.out, '--cout');
    if ((days.length - 1 - i) % every === 0) {
      const dt = parseISO(d.date);
      s += `<text class="ax" x="${cx}" y="${H - 8}" text-anchor="middle">${dt.getDate()} ${MOS[dt.getMonth()]}</text>`;
    }
  });
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Kunlik kirim va chiqim grafigi">${s}</svg><div class="tip" hidden></div>`;
  const tip = box.querySelector('.tip'), svg = box.querySelector('svg');
  let on = null;
  const show = el => {
    if (on) on.classList.remove('on');
    on = el; el.classList.add('on');
    const d = days[+el.dataset.i], net = d.in - d.out;
    tip.innerHTML = `<b>${dayLabel(d.date)}</b><div><span><i class="dot d-in"></i>Kirim</span>${fmt(d.in)}</div><div><span><i class="dot d-out"></i>Chiqim</span>${fmt(d.out)}</div>${d.fix ? `<div><span>shundan doimiy</span>${fmt(d.fix)}</div>` : ''}<div><span>Sof</span><strong class="${net < 0 ? 'neg' : 'pos'}">${money(net)}</strong></div>`;
    tip.hidden = false;
    const k = svg.getBoundingClientRect().width / W, bx = (+el.getAttribute('x') + cw / 2) * k;
    const tw = tip.offsetWidth, half = tw / 2, bwid = box.clientWidth;
    tip.style.left = Math.min(bwid - half, Math.max(half, bx)) + 'px';
    tip.style.top = Math.max(tip.offsetHeight + 4, y(Math.max(d.in, d.out)) * k - 8) + 'px';
  };
  box.querySelectorAll('.hit').forEach(el => {
    el.addEventListener('mouseenter', () => show(el));
    el.addEventListener('click', () => show(el));
  });
  svg.addEventListener('mouseleave', () => { tip.hidden = true; if (on) on.classList.remove('on'); });
}
function niceStep(x) {
  const p = Math.pow(10, Math.floor(Math.log10(x || 1))), f = x / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

/* Toifalar boʻyicha taqsimot (gorizontal ustunlar) */
function catBars(by, type, est = []) {
  const rows = Object.entries(by).filter(r => r[1] > 0).sort((a, b) => b[1] - a[1]), tot = rows.reduce((a, r) => a + r[1], 0);
  if (!rows.length) return '<div class="empty">Bu davrda yozuv yoʻq</div>';
  return rows.map(([k, v]) => `<div class="bar ${type}"><div class="t"><span>${esc(catName(k))}${MONTHLY.has(k) ? ` <small class="meta">${est.includes(k) ? 'taxminiy, ' : ''}taqsimlangan</small>` : ''}</span><span>${short(v)} · ${(v / tot * 100).toFixed(0)}%</span></div><div class="b"><i style="width:${v / rows[0][1] * 100}%"></i></div></div>`).join('');
}
