/*
 * REKLAMA OYNALARI: matn tozalash, havola xavfsizligi, faollik, API (soxta model). Baza KERAK EMAS.
 * npm run test:promo-modals
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(40);
const { cleanText, cleanLink, sanitizePromo, isLive, publicView, MAX_ACTIVE } = await import('../src/services/promoModals.js');
const { PromoModal } = await import('../src/models/PromoModal.js');
const { promoModalController: C, invalidatePromoCache } = await import('../src/controllers/promoModals.js');

let fails = 0;
const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗ FAIL:', m); if (!c) fails++; };

console.log('\n[1] Matn: urg‘u, bo‘shliq, uzunlik');
ok(cleanText('100 000 so‘mlik  taom   buyurtma qiling 1 litr *Coca-Cola Bonus!*', 90) === '100 000 so‘mlik taom buyurtma qiling 1 litr *Coca-Cola Bonus!*', 'urg‘u saqlanadi, bo‘shliqlar yig‘iladi');
ok(cleanText('Salom *dunyo', 90) === 'Salom dunyo', 'juft bo‘lmagan * olib tashlanadi');
ok(cleanText('*a* *b* *c*', 90) === '*a* *b* c', 'ko‘pi bilan 2 urg‘u');
ok(cleanText('**', 90) === '', 'bo‘sh urg‘u olib tashlanadi');
ok(cleanText('a\u200Bb\u0007c', 90) === 'abc', 'ko‘rinmas/boshqaruv belgilari olinadi');
ok(cleanText('Qator1\n\n\nQator2', 90) === 'Qator1\nQator2', 'ko‘p bo‘sh qator → bitta');
const long = cleanText('x'.repeat(200), 90);
ok(long.length === 90, 'uzunlik cheklanadi');
const longStar = cleanText(`${'a'.repeat(85)} *bbbbbbbbbb*`, 90);
ok(longStar.replace(/\*/g, '').length <= 90 && (longStar.match(/\*/g) || []).length % 2 === 0, 'kesilganda ham urg‘u yopiladi');
ok(cleanText('<script>alert(1)</script>', 90) === '<script>alert(1)</script>', 'HTML matn sifatida qoladi (mijozda escape qilinadi)');

console.log('\n[2] Havola xavfsizligi');
for (const [i, o] of [['/market', '/market'], ['/restaurant/abc?x=1', '/restaurant/abc?x=1'], ['https://lokmago.uz/a', 'https://lokmago.uz/a'],
  ['javascript:alert(1)', ''], ['//evil.com', ''], ['http://x.com', ''], ['data:text/html,x', ''], ['/a b', ''], ['', '']]) {
  ok(cleanLink(i) === o, `${JSON.stringify(i)} → ${JSON.stringify(cleanLink(i))}`);
}

console.log('\n[3] sanitizePromo');
{
  let r = sanitizePromo({ title: 'Ok', template: 'brush' });
  ok(r.error, 'juda qisqa sarlavha — xato');
  r = sanitizePromo({ title: 'Yaxshi taklif', template: 'neon' });
  ok(/Shablon/.test(r.error || ''), 'noma’lum shablon — xato');
  r = sanitizePromo({ title: 'Yaxshi taklif', link: 'javascript:x' });
  ok(/Havola/.test(r.error || ''), 'xavfli havola — xato (jim yutilmaydi)');
  r = sanitizePromo({ title: 'Yaxshi taklif', imageUrl: 'http://x/a.png' });
  ok(/Rasm/.test(r.error || ''), 'http rasm — xato');
  r = sanitizePromo({ title: 'Yaxshi taklif', startsAt: '2026-10-20', endsAt: '2026-10-10' });
  ok(/Tugash/.test(r.error || ''), 'tugash boshlanishdan oldin — xato');
  r = sanitizePromo({ title: 'Yaxshi *taklif*', footer: '*LokmaGo* bilan', template: 'coupon', active: 1, frequency: 'once', link: '/market', imageUrl: 'https://res.cloudinary.com/x/a.png' });
  ok(!r.error && r.data.template === 'coupon' && r.data.active === true && r.data.frequency === 'once', 'to‘g‘ri ma’lumot qabul qilindi');
  r = sanitizePromo({ active: false }, { partial: true });
  ok(!r.error && Object.keys(r.data).join() === 'active', 'PATCH faqat berilgan maydon');
}

console.log('\n[4] Faollik (jadval)');
const now = new Date('2026-10-20T10:00:00Z');
ok(isLive({ active: true }, now), 'faol, sanasiz');
ok(!isLive({ active: false }, now), 'o‘chirilgan');
ok(!isLive({ active: true, startsAt: new Date('2026-10-21') }, now), 'hali boshlanmagan');
ok(!isLive({ active: true, endsAt: new Date('2026-10-19') }, now), 'tugagan');
const pv = publicView({ _id: 'abc', version: 3, template: 'brush', title: 't', stats: { shown: 9 }, active: true });
ok(pv.key === 'abc:3' && !('stats' in pv) && !('active' in pv), 'mijozga: kalit (id:versiya), statistika yo‘q');

console.log('\n[5] API (soxta model)');
let rows = [];
const lean = (v) => ({ lean: async () => structuredClone(v), select() { return this; }, sort() { return this; }, limit() { return this; } });
PromoModal.find = (f = {}) => { const r = rows.filter((x) => !('active' in f) || x.active === f.active).sort((a, b) => a.order - b.order); return { sort() { return this; }, limit() { return this; }, lean: async () => structuredClone(r) }; };
PromoModal.countDocuments = async (f) => rows.filter((x) => x.active && (!f._id || x._id !== f._id.$ne)).length;
PromoModal.findOne = () => lean(rows.slice().sort((a, b) => b.order - a.order)[0] || null);
const OID = (n) => String(n).padStart(24, 'a');
PromoModal.create = async (d) => { const doc = { _id: OID(rows.length + 1), version: 1, createdAt: new Date(), ...d }; rows.push(doc); return { ...doc, toObject: () => doc }; };
PromoModal.findByIdAndUpdate = (id, u) => { const d = rows.find((x) => x._id === id); if (d) { Object.assign(d, u.$set || {}); if (u.$inc?.version) d.version += 1; } return lean(d || null); };
const res = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, set() { return this; }, end() { return this; } });
// asyncHandler promise qaytarmaydi — javob (json/end) yoki xato kelguncha kutamiz
const run = (fn, req) => new Promise((resolve) => {
  const r = res();
  r.json = (b) => { r.body = b; resolve(r); return r; };
  r.end = () => { resolve(r); return r; };
  fn(req, r, (e) => { r.code = 500; r.body = { error: String(e) }; resolve(r); });
});

let r = await run(C.create, { body: { title: 'Birinchi *taklif*', active: true } });
ok(r.code === 201 && r.body.order === 0, 'yaratildi, tartib 0');
r = await run(C.create, { body: { title: 'Ikkinchi taklif', active: false, template: 'sunburst' } });
ok(r.code === 201 && r.body.order === 1, 'ikkinchisi tartib 1');
invalidatePromoCache();
r = await run(C.active, {});
ok(r.body.length === 1 && r.body[0].title === 'Birinchi *taklif*', 'mijozga faqat faol oyna');
await run(C.update, { params: { id: OID(2) }, body: { active: true } });
r = await run(C.active, {});
ok(r.body.length === 2 && r.body[0].id === OID(1), 'yoqilgach ikkalasi, tartib bo‘yicha (kesh tozalangan)');
for (let i = 0; i < MAX_ACTIVE; i++) await run(C.create, { body: { title: `Qo‘shimcha ${i}`, active: false } });
for (const x of rows) x.active = true;
r = await run(C.create, { body: { title: 'Ortiqcha taklif', active: true } });
ok(r.code === 400 && /ko‘pi bilan/.test(r.body.error), `${MAX_ACTIVE} tadan ortiq faol bo‘lmaydi`);
r = await run(C.reshow, { params: { id: OID(1) } });
ok(r.body.version === 2, '"Qayta ko‘rsatish" versiyani oshiradi');
invalidatePromoCache();
r = await run(C.active, {});
ok(r.body.find((p) => p.id === OID(1)).key === `${OID(1)}:2`, 'mijoz kaliti yangilandi — bugun ko‘rganlarga ham chiqadi');
r = await run(C.update, { params: { id: 'zzz' }, body: {} });
ok(r.code === 404, 'noto‘g‘ri ID — 404');

console.log(fails ? `\n✗ ${fails} ta xato` : '\n✓ Hammasi o‘tdi');
process.exit(fails ? 1 : 0);
