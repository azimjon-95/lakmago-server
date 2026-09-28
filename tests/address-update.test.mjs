/*
 * ═══════════════════════════════════════════════════════════
 * MANZILNI TAHRIRLASH — PATCH /api/addresses/:id
 * ═══════════════════════════════════════════════════════════
 *
 * Client (buyurtma tasdiqlash qadamidagi "Tahrirlash") shu endpointga
 * tayanadi. Tekshiriladi: yuborilgan maydon yangilanadi, YUBORILMAGANI
 * saqlanadi (zod `.partial()` + `.default('')` bosib ketmasin), boshqa
 * manzil va tanlangan (default) manzil o'zgarmaydi, begona manzil
 * tahrirlanmaydi, noto'g'ri qiymat rad etiladi.
 *
 * npm run test:address
 */
process.env.MONGO_URI = 'mongodb://127.0.0.1:27017/lokma_address_update';
const mongoose = (await import('mongoose')).default;
await mongoose.connect(process.env.MONGO_URI);
await mongoose.connection.db.dropDatabase();
const { User } = await import('../src/models/User.js');
const { addressController } = await import('../src/controllers/address.js');

let fails = 0;
const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗ FAIL:', m); if (!c) fails++; };
const call = async (fn, req) => {
  let status = 200; let body = null;
  const res = { status(c) { status = c; return this; }, json(b) { body = b; return this; } };
  await fn(req, res, (e) => { body = { next: e?.message }; status = 500; });
  await new Promise((r) => setTimeout(r, 250));
  return { status, body };
};

const u = await User.create({
  firstName: 'Azimjon', telegramId: '77',
  addresses: [
    { title: 'Uy', address: 'Chilonzor 5', street: 'Chilonzor 5', city: 'Toshkent', note: 'eski izoh', labelId: 'home', lat: 41.31, lng: 69.24 },
    { title: 'Ish', address: 'Yunusobod 12', city: 'Toshkent', labelId: 'work', lat: 41.29, lng: 69.21 },
  ],
});
const home = u.addresses[0]; const work = u.addresses[1];
u.defaultAddressId = work._id; await u.save();
const fresh = async () => (await User.findById(u._id).lean());
const patch = (id, body, userId = u._id) => call(addressController.update, { userId: String(userId), params: { id: String(id) }, body });

console.log('\n[1] Client yuboradigan TO‘LIQ payload — hammasi yangilanadi');
{
  const r = await patch(home._id, {
    title: 'Uy (yangi)', address: 'Chilonzor 5-kvartal, 12-uy', street: 'Chilonzor 5-kvartal, 12-uy', city: 'Toshkent',
    note: 'Domofon 24', labelId: 'home', lat: 41.3, lng: 69.25,
  });
  ok(r.status === 200, `status ${r.status}`);
  const a = (await fresh()).addresses[0];
  ok(a.address === 'Chilonzor 5-kvartal, 12-uy' && a.note === 'Domofon 24' && a.title === 'Uy (yangi)' && a.lat === 41.3 && a.lng === 69.25, 'matn, izoh, nom, nuqta yangilandi');
}

console.log('\n[2] Boshqa manzil va TANLANGAN (default) manzil o‘zgarmaydi');
{
  const f = await fresh();
  ok(f.addresses[1].address === 'Yunusobod 12' && f.addresses[1].lat === 41.29, 'ikkinchi manzil joyida');
  ok(String(f.defaultAddressId) === String(work._id), 'defaultAddressId o‘zgarmadi');
  ok(f.addresses.length === 2 && String(f.addresses[0]._id) === String(home._id), 'manzillar soni va id o‘zgarmadi');
}

console.log('\n[3] QISMAN yangilash — yuborilmagan maydonlar SAQLANADI (default bilan bosilmaydi)');
{
  await patch(home._id, { note: 'faqat izoh o‘zgardi' });
  const a = (await fresh()).addresses[0];
  ok(a.note === 'faqat izoh o‘zgardi', 'izoh yangilandi');
  ok(a.address === 'Chilonzor 5-kvartal, 12-uy' && a.street === 'Chilonzor 5-kvartal, 12-uy' && a.city === 'Toshkent' && a.title === 'Uy (yangi)' && a.labelId === 'home' && a.lat === 41.3 && a.lng === 69.25,
    `qolgan maydonlar butun: ${JSON.stringify({ address: a.address, city: a.city, title: a.title, labelId: a.labelId, lat: a.lat })}`);
}

console.log('\n[4] Izohni BO‘SHATISH mumkin (mijoz izohni o‘chirsa)');
{
  await patch(home._id, { note: '' });
  ok((await fresh()).addresses[0].note === '', 'izoh bo‘shatildi');
}

console.log('\n[5] Begona foydalanuvchi manzilini tahrirlay OLMAYDI');
{
  const other = await User.create({ firstName: 'Boshqa', telegramId: '88', addresses: [{ title: 'Uy', address: 'Begona uy', lat: 41.2, lng: 69.2 }] });
  const r = await patch(home._id, { address: 'BUZILDI' }, other._id);
  ok(r.status === 404, `begona: ${r.status}`);
  ok((await fresh()).addresses[0].address === 'Chilonzor 5-kvartal, 12-uy', 'asl manzil o‘zgarmadi');
  const r2 = await patch(other.addresses[0]._id, { address: 'BUZILDI' });
  ok(r2.status === 404 && (await User.findById(other._id).lean()).addresses[0].address === 'Begona uy', 'teskarisi ham: mening tokenim bilan begonaniki o‘zgarmaydi');
}

console.log('\n[6] Noto‘g‘ri qiymatlar rad etiladi (400), bazaga yozilmaydi');
{
  for (const [name, body] of [['bo‘sh manzil', { address: '' }], ['lat matn', { lat: 'abc' }], ['bo‘sh nom', { title: '' }], ['note son', { note: 123 }]]) {
    const r = await patch(home._id, body);
    ok(r.status === 400, `${name} → ${r.status}`);
  }
  ok((await fresh()).addresses[0].address === 'Chilonzor 5-kvartal, 12-uy', 'hech biri yozilmadi');
}

console.log('\n[7] Vaqtinchalik (mijoz tomonidagi) id — server yiqilmaydi, 404 beradi (client buni lokal saqlaydi)');
{
  const r = await patch('addr1790000000000', { note: 'x' });
  ok(r.status === 404, `temp id: ${r.status}`);
}

console.log(fails ? `\n✗ ${fails} ta xato` : '\n✓ HAMMASI O‘TDI');
await mongoose.disconnect();
process.exit(fails ? 1 : 0);
