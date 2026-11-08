/*
 * TEKSHIRUV: MongoDB `catalogcategories` kolleksiyasi (Market kategoriyalari) talabga mosmi.
 * Ishlatish:  MONGO_URI="mongodb+srv://..." node scripts/verify-catalogcategories.mjs [--images]
 *   --images  — har bir imageUrl ni HTTP orqali ochib, 200 ekanini tekshiradi (Cloudinary).
 * Chiqish kodi: 0 — hammasi to'g'ri; 1 — xato bor (ro'yxat chiqadi).
 */
import mongoose from 'mongoose';

const KEYS = ['shaxsiy_gigiyena', 'maishiy_kimyo', 'bolalar_oziq_ovqatlari', 'choy', 'shokolad', 'uy_rozgor_mahsulotlari',
  'pechenye', 'konserva_mahsulotlari', 'bolalar_gigiyena', 'konfetlar', 'sut_mahsulotlari', 'shirinliklar', 'gazli_ichimliklar',
  'makaron_mahsulotlari', 'chips_snacklar', 'muzqaymoq', 'yangi_meva', 'souslar', 'qahva', 'tozalash_vositalari', 'ichimliklar'];

const uri = process.env.MONGO_URI;
if (!uri) { console.error('MONGO_URI kerak'); process.exit(1); }
const checkImages = process.argv.includes('--images');
const problems = [];
const bad = (key, msg) => problems.push(`${key}: ${msg}`);

await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
const db = mongoose.connection.db;
const col = db.collection('catalogcategories');
const docs = await col.find({}).toArray();
console.log(`Kolleksiya: ${mongoose.connection.name}.catalogcategories — hujjatlar: ${docs.length}`);
if (docs.length !== 21) problems.push(`hujjatlar soni ${docs.length} (21 kerak)`);

const byKey = new Map(docs.map((d) => [d.key, d]));
for (const k of KEYS) if (!byKey.has(k)) problems.push(`kalit yo‘q: ${k}`);
for (const d of docs) if (!KEYS.includes(d.key)) problems.push(`ortiqcha kalit: ${d.key}`);

for (const k of KEYS) {
  const d = byKey.get(k);
  if (!d) continue;
  if (!d.name?.trim()) bad(k, 'name (uz) bo‘sh');
  if (!d.i18n?.ru?.name?.trim()) bad(k, 'i18n.ru.name bo‘sh');
  if (!d.i18n?.en?.name?.trim()) bad(k, 'i18n.en.name bo‘sh');
  if (!d.description?.trim() && !d.i18n?.uz?.description?.trim()) bad(k, 'tavsif (uz) bo‘sh');
  if (!d.i18n?.ru?.description?.trim()) bad(k, 'i18n.ru.description bo‘sh');
  if (!d.i18n?.en?.description?.trim()) bad(k, 'i18n.en.description bo‘sh');
  if (!(d.imageUrl || '').startsWith('https://res.cloudinary.com/')) bad(k, `imageUrl Cloudinary emas: ${d.imageUrl || '(bo‘sh)'}`);
  else if (!d.imageUrl.includes(`catalog-categories/${k}`)) bad(k, 'imageUrl kalit bilan mos emas (lokmago/catalog-categories/<key>)');
  if (typeof d.order !== 'number') bad(k, 'order raqam emas');
  if (d.isActive !== true) bad(k, 'isActive true emas');
}

if (checkImages) {
  for (const k of KEYS) {
    const d = byKey.get(k);
    if (!d?.imageUrl) continue;
    try {
      const r = await fetch(d.imageUrl, { method: 'HEAD' });
      if (r.status !== 200) bad(k, `rasm ochilmadi: HTTP ${r.status}`);
    } catch (e) { bad(k, `rasm so‘rovi xato: ${e.message}`); }
  }
}

await mongoose.disconnect();
if (problems.length) {
  console.log('\nXATOLAR (' + problems.length + '):');
  for (const p of problems) console.log(' - ' + p);
  process.exit(1);
}
console.log('\nHAMMASI TO‘G‘RI: 21 kategoriya, uz/ru/en nomlar va tavsiflar, Cloudinary rasmlar' + (checkImages ? ' (HTTP 200 tekshirildi)' : '') + '.');
