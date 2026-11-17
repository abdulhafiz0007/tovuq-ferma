# Tuxum fermasi hisobi

- `/` – boshliq uchun dashboard (faqat koʻrish): shu oy foydasi, bugungi kirim-chiqim, 30 kunlik grafik, toifalar boʻyicha taqsimot
- `/admin` – login va parol bilan kiriladigan admin panel: har bir kirim/chiqimni sana, toifa, miqdor va summa bilan kiritish, tahrirlash, oʻchirish, oy boʻyicha koʻrish va Excel (CSV) ga yuklab olish

Kod oʻzgargandan keyin serverni qayta ishga tushiring (`Ctrl+C`, keyin `npm start`), aks holda eski versiya ishlab turadi.

## API
| Soʻrov | Izoh |
|---|---|
| `GET /api/entries?from=YYYY-MM-DD&to=YYYY-MM-DD` | Oraliqdagi yozuvlar |
| `POST /api/entries` | Yangi yozuv (admin) – `{date, type: "in"/"out", cat, amount, qty?, item?, note?}` (`item` — yem xaridida qaysi xomashyo) |
| `PUT /api/entries/:id` | Tahrirlash (admin) |
| `DELETE /api/entries/:id` | Oʻchirish (admin) |
| `GET /api/stock` | Yem ombori: retsept (`cfg`) va harakatlar (`recs`) |
| `PUT /api/stock/cfg` | Retsept va mahsulotlar (admin) – `{items: [{id, name, price}], recipes: [{from, parts: {id: kg}}]}` |
| `POST /api/stock/rec` | Yem tayyorlandi `{date, kind: "mix", kg}` yoki sanoq `{date, kind: "count", item, qty}` (admin) |
| `DELETE /api/stock/rec/:id` | Oʻchirish (admin) |

Yozuvlar Redis'da har oy uchun alohida `ferma:e:YYYY-MM` hash'da, fayl rejimida esa `data/entries.json` da saqlanadi. Toifalar roʻyxati `public/common.js` dagi `CATS` da.

**Yem ombori:** har bir xomashyo qoldigʻi = oxirgi sanoq + kelgan (Chiqim → Yem, mahsulot tanlangan xaridlar) − sarflangan (tayyorlangan yem kg × shu kundagi retsept ulushi). Retsept va harakatlar Redis'da `ferma:stockcfg` / `ferma:stock`, fayl rejimida `data/stock.json` da.

## Mahalliy ishga tushirish
```
npm install
npm start
```
http://localhost:3000 va http://localhost:3000/admin
Maʼlumot `data/entries.json` faylida saqlanadi.

## Muhit oʻzgaruvchilari
| Nom | Izoh |
|---|---|
| `ADMIN_USER` / `ADMIN_PASS` | Admin login va paroli (berilmasa: admin / admin123) |
| `SESSION_SECRET` | Tasodifiy uzun matn |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Maʼlumot bazasi (bepul) |
| `DATA_FILE` | Redis boʻlmasa, fayl yoʻli |

**Productionda `ADMIN_PASS` ni albatta oʻzgartiring**, chunki standart parol kod ichida yozilgan va GitHub orqali koʻrinadi.

## GitHub
```
git init && git add . && git commit -m "ferma dashboard"
git branch -M main
git remote add origin https://github.com/<login>/<repo>.git
git push -u origin main
```

## Vercel
1. Vercel → Add New → Project → GitHub repo ni tanlang → Deploy.
2. Vercel serverless, fayl saqlanmaydi. Shuning uchun **Storage → Upstash Redis** (Marketplace) ni loyihaga ulang. Kerakli `KV_REST_API_URL` va `KV_REST_API_TOKEN` oʻzi qoʻshiladi.
3. Settings → Environment Variables: `ADMIN_USER`, `ADMIN_PASS`, `SESSION_SECRET` ni qoʻshing, keyin Redeploy qiling.

## Render.com
1. New → Web Service → GitHub repo.
2. Build Command: `npm install`, Start Command: `npm start`.
3. Environment: `ADMIN_USER`, `ADMIN_PASS`, `SESSION_SECRET`.
4. Maʼlumot saqlanishi uchun biri kerak: Upstash Redis oʻzgaruvchilari, yoki pullik **Disk** ulab `DATA_FILE=/var/data/params.json` qoʻyish. Bepul rejada disk yoʻq, fayl har deployda oʻchadi.
