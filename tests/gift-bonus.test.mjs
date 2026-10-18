/*
 * LOKMAGO SOVG'A-BONUSI: qoida mantig'i, buyurtma hisobi, restoranga qoplash (PUL!), API. Baza KERAK EMAS.
 * npm run test:gift-bonus
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(40);
const G = await import('../src/services/giftBonus.js');
const { GiftBonus } = await import('../src/models/GiftBonus.js');
const { Order } = await import('../src/models/Order.js');
const { Ledger } = await import('../src/models/Ledger.js');
const { Restaurant } = await import('../src/models/Restaurant.js');
const billing = await import('../src/services/billing.js');
const { giftBonusController: C } = await import('../src/controllers/giftBonus.js');

let fails = 0;
const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗ FAIL:', m); if (!c) fails++; };
const OID = (n) => String(n).padStart(24, 'a');
// Seshanba 2026-10-20 11:00 Toshkent = 06:00 UTC
const T = (iso) => new Date(iso);
const NOON = T('2026-10-20T07:00:00Z'); // 12:00 Toshkent, seshanba
const rule = (o = {}) => ({ _id: OID(1), name: 'Kola', itemName: '1 l Coca-Cola', quantity: 1, reimburse: 12_000, minAmount: 100_000, maxAmount: 0, basis: 'menu', active: true, scope: 'all', restaurantIds: [], kinds: ['restaurant', 'choyxona', 'cafe', 'fastfood', 'club'], fulfillments: ['delivery', 'pickup'], paymentMethods: [], weekdays: [], hourFrom: null, hourTo: null, perCustomerPerDay: 0, perCustomerTotal: 0, dailyLimit: 0, totalLimit: 0, budget: 0, ...o });
const ctx = (o = {}) => ({ restaurantId: OID(9), restaurantKind: 'restaurant', fulfillment: 'delivery', paymentMethod: 'cash', menuAmount: 100_000, paidAmount: 100_000, now: NOON, ...o });
const gifts = (rules, c, usage) => G.evaluateGifts(rules, c, usage);

console.log('\n[1] Shart chegarasi: 100 000 va undan oshganlarga');
ok(gifts([rule()], ctx({ menuAmount: 99_999 })).gifts.length === 0, '99 999 — sovg‘a YO‘Q');
ok(gifts([rule()], ctx({ menuAmount: 100_000 })).gifts.length === 1, '100 000 — sovg‘a BOR (aynan chegara)');
ok(gifts([rule()], ctx({ menuAmount: 100_001 })).gifts.length === 1, '100 001 — sovg‘a bor');
ok(gifts([rule()], ctx({ menuAmount: 5_000_000 })).gifts.length === 1, 'katta buyurtmada ham BITTA (ko‘paymaydi)');
ok(gifts([rule({ quantity: 2 })], ctx()).gifts[0].quantity === 2, 'qoidadagi miqdor (2 dona) olinadi');
ok(gifts([rule({ maxAmount: 300_000 })], ctx({ menuAmount: 300_001 })).gifts.length === 0, 'yuqori chegaradan oshsa — yo‘q');
ok(gifts([rule({ maxAmount: 300_000 })], ctx({ menuAmount: 300_000 })).gifts.length === 1, 'yuqori chegaraning o‘zida — bor');

console.log('\n[2] "Yana X so‘m qoldi" (savat uchun)');
{
  const r = gifts([rule()], ctx({ menuAmount: 77_000 }));
  ok(r.gifts.length === 0 && r.next?.missing === 23_000 && r.next.itemName === '1 l Coca-Cola', '77 000 → yana 23 000 so‘m');
  ok(gifts([rule()], ctx({ menuAmount: 0 })).next === null, 'savat bo‘sh — taklif yo‘q');
  ok(gifts([rule()], ctx({ menuAmount: 150_000 })).next === null, 'sovg‘a olingan — "yana" ko‘rsatilmaydi');
  const r2 = gifts([rule({ _id: OID(1), minAmount: 100_000 }), rule({ _id: OID(2), itemName: 'Salat', minAmount: 80_000 })], ctx({ menuAmount: 70_000 }));
  ok(r2.next.itemName === 'Salat' && r2.next.missing === 10_000, 'bir nechta qoidadan eng YAQINI ko‘rsatiladi');
}

console.log('\n[3] Hisob asosi: menyu narxi yoki chegirmadan keyin');
ok(gifts([rule({ basis: 'menu' })], ctx({ menuAmount: 110_000, paidAmount: 95_000 })).gifts.length === 1, 'menu: aksiya chegirmasi tushirib yubormaydi');
ok(gifts([rule({ basis: 'paid' })], ctx({ menuAmount: 110_000, paidAmount: 95_000 })).gifts.length === 0, 'paid: chegirmadan keyin 95 000 — yo‘q');
ok(gifts([rule({ basis: 'paid' })], ctx({ menuAmount: 110_000, paidAmount: 100_000 })).gifts.length === 1, 'paid: 100 000 — bor');

console.log('\n[4] Qayerda: restoran, tur, yetkazish, to‘lov');
ok(gifts([rule({ scope: 'include', restaurantIds: [OID(9)] })], ctx()).gifts.length === 1, 'faqat tanlanganlar: tanlangan restoran — bor');
ok(gifts([rule({ scope: 'include', restaurantIds: [OID(8)] })], ctx()).gifts.length === 0, 'faqat tanlanganlar: boshqa restoran — yo‘q');
ok(gifts([rule({ scope: 'exclude', restaurantIds: [OID(9)] })], ctx()).gifts.length === 0, 'istisno: ro‘yxatdagi restoran — yo‘q');
ok(gifts([rule({ scope: 'exclude', restaurantIds: [OID(8)] })], ctx()).gifts.length === 1, 'istisno: boshqa restoran — bor');
ok(gifts([rule()], ctx({ restaurantKind: 'shop' })).gifts.length === 0, 'do‘kon (shop) standart holatda KIRMAYDI');
ok(gifts([rule({ kinds: ['shop'] })], ctx({ restaurantKind: 'shop' })).gifts.length === 1, 'turlarga "shop" qo‘shilsa — kiradi');
ok(gifts([rule({ fulfillments: ['delivery'] })], ctx({ fulfillment: 'pickup' })).gifts.length === 0, 'faqat yetkazish: olib ketishda — yo‘q');
ok(gifts([rule({ paymentMethods: ['click'] })], ctx({ paymentMethod: 'cash' })).gifts.length === 0, 'faqat Click: naqdda — yo‘q');
ok(gifts([rule({ paymentMethods: ['click'] })], ctx({ paymentMethod: 'click' })).gifts.length === 1, 'faqat Click: Click bilan — bor');

console.log('\n[5] Qachon: faollik, sana, hafta kuni, soat (Toshkent)');
ok(!G.isLive(rule({ active: false }), NOON), 'o‘chirilgan — amal qilmaydi');
ok(!G.isLive(rule({ startsAt: T('2026-10-21') }), NOON), 'hali boshlanmagan');
ok(!G.isLive(rule({ endsAt: T('2026-10-20T06:59:59Z') }), NOON), 'tugagan');
ok(G.isLive(rule({ weekdays: [2] }), NOON), 'seshanba ruxsat — bor');
ok(!G.isLive(rule({ weekdays: [0, 6] }), NOON), 'faqat dam olish kunlari — seshanba yo‘q');
ok(G.isLive(rule({ hourFrom: 11, hourTo: 14 }), NOON), '11–14 oynasida 12:00 — bor');
ok(!G.isLive(rule({ hourFrom: 13, hourTo: 22 }), NOON), '13–22 oynasida 12:00 — yo‘q');
ok(G.isLive(rule({ hourFrom: 22, hourTo: 6 }), T('2026-10-20T19:30:00Z')), 'tungi 22–06: 00:30 (Toshkent) — bor (tun oshadi)');
ok(!G.isLive(rule({ hourFrom: 22, hourTo: 6 }), NOON), 'tungi 22–06: 12:00 — yo‘q');
ok(G.tashkent(T('2026-10-20T19:30:00Z')).weekday === 3, 'UTC 19:30 seshanba = Toshkent 00:30 CHORSHANBA (kun to‘g‘ri hisoblanadi)');

console.log('\n[6] Chegaralar va byudjet');
ok(G.limitsBlock(rule({ totalLimit: 10 }), { total: 10 }) === 'total_limit', 'umumiy limit tugadi');
ok(G.limitsBlock(rule({ totalLimit: 10 }), { total: 9 }) === null, 'umumiy limit: 9/10 — hali bor');
ok(G.limitsBlock(rule({ dailyLimit: 5 }), { today: 5 }) === 'daily_limit', 'kunlik limit tugadi');
ok(G.limitsBlock(rule({ perCustomerPerDay: 1 }), { customerToday: 1 }) === 'customer_daily', 'mijoz kuniga 1 ta — ikkinchisi yo‘q');
ok(G.limitsBlock(rule({ perCustomerTotal: 3 }), { customerTotal: 3 }) === 'customer_total', 'mijoz uchun jami limit');
ok(G.limitsBlock(rule({ budget: 100_000, reimburse: 12_000 }), { spent: 88_000 }) === null, 'byudjet: 88 000 + 12 000 = 100 000 — sig‘adi');
ok(G.limitsBlock(rule({ budget: 100_000, reimburse: 12_000 }), { spent: 88_001 }) === 'budget', 'byudjet: bir so‘m oshsa — to‘xtaydi');
ok(gifts([rule({ perCustomerPerDay: 1 })], ctx(), () => ({ customerToday: 1 })).gifts.length === 0, 'limit tugagan qoida baholashda sovg‘a bermaydi');

console.log('\n[7] Bir nechta qoida');
{
  const r = gifts([rule({ _id: OID(1) }), rule({ _id: OID(2), itemName: 'Pepsi' }), rule({ _id: OID(3), itemName: 'Salat' }), rule({ _id: OID(4), itemName: 'Non' })], ctx());
  ok(r.gifts.length === G.MAX_GIFT_LINES, `bir buyurtmada ko‘pi bilan ${G.MAX_GIFT_LINES} ta sovg‘a`);
}
ok(G.giftsCost([{ reimburse: 12_000, quantity: 1 }, { reimburse: 5_000, quantity: 2 }]) === 22_000, 'qoplash summasi: 12 000×1 + 5 000×2');

console.log('\n[8] Sanitizatsiya');
{
  let r = G.sanitizeGift({ name: 'Kola', itemName: '1 l Coca-Cola', reimburse: 12000, minAmount: 100000 });
  ok(!r.error && r.data.reimburse === 12_000 && r.data.basis === 'menu' && r.data.quantity === 1, 'to‘g‘ri qoida qabul qilindi');
  ok(G.sanitizeGift({ name: 'K', itemName: 'Kola' }).error, 'qisqa nom — xato');
  ok(G.sanitizeGift({ name: 'Kola', itemName: '' }).error, 'sovg‘a nomisiz — xato');
  ok(/Rasm/.test(G.sanitizeGift({ name: 'Kola', itemName: 'Kola', imageUrl: 'http://x/a.png' }).error || ''), 'http rasm — xato');
  ok(/Yuqori/.test(G.sanitizeGift({ name: 'Kola', itemName: 'Kola', minAmount: 100000, maxAmount: 50000 }).error || ''), 'yuqori chegara pastdan kichik — xato');
  ok(/Restoranlarni/.test(G.sanitizeGift({ name: 'Kola', itemName: 'Kola', scope: 'include', restaurantIds: [] }).error || ''), 'tanlangan restoranlar bo‘sh — xato');
  ok(/ikkala soatni/.test(G.sanitizeGift({ name: 'Kola', itemName: 'Kola', hourFrom: 10 }).error || ''), 'bitta soat — xato');
  ok(G.sanitizeGift({ name: 'Kola', itemName: 'Kola', reimburse: -5 }).data.reimburse === 0, 'manfiy qoplash 0 ga keltiriladi');
  ok(G.sanitizeGift({ name: 'Kola', itemName: 'Kola', quantity: 99 }).data.quantity === 5, 'miqdor ko‘pi bilan 5');
  ok(G.sanitizeGift({ name: 'Kola', itemName: 'Kola', weekdays: [1, 1, 9, 'x'] }).data.weekdays.join() === '1', 'hafta kunlari tozalandi');
  ok(G.sanitizeGift({ active: true }, { partial: true }).data.active === true && Object.keys(G.sanitizeGift({ active: true }, { partial: true }).data).length === 1, 'PATCH faqat berilgan maydon');
}

console.log('\n[9] Buyurtma yaratishda (baza o‘rniga soxta modellar)');
let liveRules = [rule()];
GiftBonus.find = () => ({ sort() { return this; }, limit() { return this; }, lean: async () => structuredClone(liveRules) });
let orderAgg = []; let counts = { customerToday: 0 };
Order.aggregate = async () => orderAgg;
Order.countDocuments = async (f) => (f.userId ? counts.customerToday : 0);
{
  const rest = { _id: OID(9), kind: 'restaurant' };
  G.invalidateGiftCache();
  let r = await G.resolveGifts({ restaurant: rest, userId: OID(5), menuAmount: 120_000, paidAmount: 110_000, fulfillment: 'delivery', paymentMethod: 'cash', now: NOON });
  ok(r.items.length === 1 && r.cost === 12_000 && r.items[0].itemName === '1 l Coca-Cola' && r.items[0].reimburse === 12_000, '120 000 buyurtma: 1 l Coca-Cola, qoplash 12 000');
  ok(String(r.items[0].ruleId) === OID(1), 'qoida ID muzlatildi (keyin o‘zgarsa ham eski buyurtma o‘zgarmaydi)');
  r = await G.resolveGifts({ restaurant: rest, userId: OID(5), menuAmount: 90_000, paidAmount: 90_000, fulfillment: 'delivery', paymentMethod: 'cash', now: NOON });
  ok(r.items.length === 0 && r.cost === 0, '90 000 buyurtma: sovg‘a yo‘q');
  liveRules = [rule({ perCustomerPerDay: 1 })]; G.invalidateGiftCache(); counts = { customerToday: 1 };
  r = await G.resolveGifts({ restaurant: rest, userId: OID(5), menuAmount: 150_000, paidAmount: 150_000, fulfillment: 'delivery', paymentMethod: 'cash', now: NOON });
  ok(r.items.length === 0, 'mijoz bugun allaqachon olgan (kuniga 1 ta) — ikkinchi buyurtmaga yo‘q');
  liveRules = [rule({ budget: 20_000 })]; G.invalidateGiftCache(); orderAgg = [{ n: 1, spent: 12_000 }];
  r = await G.resolveGifts({ restaurant: rest, userId: OID(5), menuAmount: 150_000, paidAmount: 150_000, fulfillment: 'delivery', paymentMethod: 'cash', now: NOON });
  ok(r.items.length === 0, 'byudjet tugagan (12 000 + 12 000 > 20 000) — sovg‘a yo‘q');
  GiftBonus.find = () => { throw new Error('baza o‘chdi'); }; G.invalidateGiftCache();
  const origErr = console.error; console.error = () => {};
  r = await G.resolveGifts({ restaurant: rest, userId: OID(5), menuAmount: 150_000, paidAmount: 150_000, fulfillment: 'delivery', paymentMethod: 'cash', now: NOON });
  console.error = origErr;
  ok(Array.isArray(r.items) && r.items.length === 0 && r.cost === 0, 'XATO bo‘lsa buyurtma bonussiz davom etadi (HECH QACHON to‘xtatmaydi)');
}

console.log('\n[10] RESTORANGA QOPLASH (settleOrder) — pul');
{
  const state = { ledger: [], order: null, restaurant: null };
  const mkOrder = (o = {}) => ({ _id: OID(70), restaurantId: OID(9), userId: OID(5), status: 'delivered', paymentMethod: 'card', subtotal: 120_000, total: 134_500, isPaid: true, deliveredAt: new Date(), bonusItems: [{ ruleId: OID(1), itemName: '1 l Coca-Cola', quantity: 1, reimburse: 12_000 }], finance: { model: 'v2', foodSubtotal: 12_000_000, lokmaGrossCommission: 1_200_000, restaurantPayout: 10_800_000, restaurantCommissionPercent: 10, customerFeePercent: 0, customerFeeAmount: 0, restaurantCommissionAmount: 1_200_000, lokmaNetCommission: 1_200_000, clickFoodFeeAmount: 0 }, ...o });
  const mkRest = (bal = 0) => ({ _id: OID(9), balance: bal, totalOrders: 0, save: async function () { state.saved = this.balance; } });
  Order.findById = async () => state.order;
  Order.findOneAndUpdate = async () => null;
  Ledger.findOne = async (f) => state.ledger.find((l) => String(l.orderId) === String(f.orderId) && l.type === f.type) || null;
  Ledger.create = async (d) => { state.ledger.push(d); return d; };
  Restaurant.findById = async () => state.restaurant;
  const run = async (order, bal = 0) => { state.ledger = []; state.order = order; state.restaurant = mkRest(bal); await billing.settleOrder(order._id); return state; };
  const comp = (s) => s.ledger.filter((l) => l.type === 'bonus_compensation');

  // KARTA: restoran ulushi 108 000 + cola 12 000
  let s = await run(mkOrder());
  ok(comp(s).length === 1 && comp(s)[0].amount === 12_000, 'karta: 12 000 so‘m qoplash yozildi');
  ok(s.restaurant.balance === 108_000 + 12_000, `karta: balans = ulush 108 000 + cola 12 000 = ${s.restaurant.balance}`);
  ok(comp(s)[0].meta.gifts[0].amount === 12_000 && String(comp(s)[0].restaurantId) === OID(9) && String(comp(s)[0].orderId) === OID(70), 'jurnalda tafsilot: sovg‘a, restoran va buyurtma bog‘langan');

  // NAQD: restoran naqd oldi, komissiya qarz, cola qoplanadi
  s = await run(mkOrder({ paymentMethod: 'cash' }));
  ok(s.restaurant.balance === -12_000 + 12_000, `naqd: komissiya qarzi −12 000 va cola +12 000 → balans ${s.restaurant.balance}`);

  // Sovg'asiz buyurtma: hech narsa o'zgarmaydi
  s = await run(mkOrder({ bonusItems: undefined }));
  ok(comp(s).length === 0 && s.restaurant.balance === 108_000, 'sovg‘asiz buyurtma: qoplash yo‘q, hisob avvalgidek (108 000)');
  s = await run(mkOrder({ bonusItems: [{ itemName: 'Aksiya', quantity: 1, reimburse: 0 }] }));
  ok(comp(s).length === 0, 'qoplash 0 so‘m bo‘lsa jurnalga 0 yozilmaydi');

  // Ko'p dona va ikkita sovg'a
  s = await run(mkOrder({ bonusItems: [{ itemName: 'Kola', quantity: 2, reimburse: 12_000 }, { itemName: 'Salat', quantity: 1, reimburse: 8_000 }] }));
  ok(comp(s)[0].amount === 32_000 && s.restaurant.balance === 108_000 + 32_000, '2×12 000 + 8 000 = 32 000 qoplandi');

  // Takroriy hisob-kitob: ikki marta yozilmaydi
  state.ledger = []; state.order = mkOrder(); state.restaurant = mkRest(0);
  await billing.settleOrder(OID(70)); const bal1 = state.restaurant.balance; const n1 = state.ledger.length;
  await billing.settleOrder(OID(70));
  ok(state.ledger.length === n1 && state.restaurant.balance === bal1, 'settleOrder ikki marta chaqirilsa — qoplash TAKRORLANMAYDI');

  // Komissiya bazasi: sovg'a taom summasiga kirmaydi
  const commissionRow = s.ledger.find((l) => l.type === 'commission');
  ok(commissionRow && commissionRow.amount === 12_000, 'komissiya sovg‘a tufayli o‘zgarmaydi (12 000 = taomning 10%)');
}

console.log('\n[11] API (soxta model)');
{
  const res = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, set() { return this; } });
  const run = (fn, req) => new Promise((resolve) => { const r = res(); r.json = (b) => { r.body = b; resolve(r); return r; }; fn(req, r, (e) => { r.code = 500; r.body = { error: String(e) }; resolve(r); }); });
  Restaurant.find = () => ({ select() { return this; }, lean: async () => [{ _id: OID(9), kind: 'restaurant', pickupDiscountPercent: 10 }, { _id: OID(8), kind: 'shop', pickupDiscountPercent: 0 }] });
  liveRules = [rule({ basis: 'paid' })]; GiftBonus.find = () => ({ sort() { return this; }, limit() { return this; }, lean: async () => structuredClone(liveRules) }); G.invalidateGiftCache();
  let r = await run(C.quote, { userId: OID(5), body: { groups: [{ restaurantId: OID(9), subtotal: 120_000 }], fulfillment: 'delivery' } });
  ok(r.code === 200 && r.body.groups[0].gifts.length === 1 && r.body.groups[0].gifts[0].itemName === '1 l Coca-Cola', 'savat: 120 000 — sovg‘a bor');
  ok(!('reimburse' in r.body.groups[0].gifts[0]), 'mijozga ichki qoplash summasi YUBORILMAYDI');
  r = await run(C.quote, { userId: OID(5), body: { groups: [{ restaurantId: OID(9), subtotal: 105_000 }], fulfillment: 'pickup' } });
  ok(r.body.groups[0].gifts.length === 0 && r.body.groups[0].next.missing === 5_500, 'olib ketishda 10% chegirma (105 000 − 10 500 = 94 500) hisobga olinadi: yana 5 500 so‘m');
  r = await run(C.quote, { userId: OID(5), body: { groups: [{ restaurantId: OID(8), subtotal: 500_000 }] } });
  ok(r.body.groups[0].gifts.length === 0, 'do‘kon (shop) uchun sovg‘a yo‘q');
  r = await run(C.quote, { userId: OID(5), body: { groups: [{ restaurantId: 'zzz', subtotal: 1 }] } });
  ok(r.code === 400, 'noto‘g‘ri restoran ID — 400');
  r = await run(C.quote, { userId: OID(5), body: { groups: [{ restaurantId: OID(7), subtotal: 500_000 }] } });
  ok(r.code === 200 && r.body.groups.length === 0, 'noma’lum restoran — jim o‘tkazib yuboriladi');
}

console.log(fails ? `\n✗ ${fails} ta xato` : '\n✓ Hammasi o‘tdi');
process.exit(fails ? 1 : 0);
