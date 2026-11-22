/*
 * Moliyaviy yadro — 2-bosqich testlari (bazasiz). npm run test:finance-core
 *
 * TZ 16: A (komissiya kombinatsiyalari, noto'g'ri foiz), B (yetkazish taqsimoti), C (naqd komissiya),
 * D (shlyuz haqi restoran ulushini kamaytirmaydi), F (qaytarish: to'liq/qisman/takroriy, LokmaGo kuryeri),
 * hamda audit nuqsonlari: F-00 (server subtotal), F-04, F-05, F-08/F-09 (menyu = to'lov, butun so'm), F-10, F-22.
 */
import { readFileSync } from 'node:fs';

process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:1/never';   // model importi ulanmaydi (buffer), so'rov yuborilmaydi

const { computeOrderFinance, reconcile, somToTiyin } = await import('../src/services/orderFinance.js');
const { applyDeliveryParty } = await import('../src/services/deliveryParty.js');
const { computeRefund, validateRefund } = await import('../src/services/refund.js');
const { applyPricing, itemCustomerUnitPrice, itemsCustomerBreakdown } = await import('../src/services/customerPricing.js');

let failed = 0; let passed = 0;
const ok = (cond, name, extra = '') => { if (cond) { passed += 1; } else { failed += 1; console.log(`  ✗ ${name} ${extra}`); } };
const eq = (a, b, name) => ok(a === b, name, `→ ${a} ≠ ${b}`);
const T = (som) => som * 100;
const section = (s) => console.log(`\n[${s}]`);

/* ───────── A. Kelishuv kombinatsiyalari (TZ 2.4 jadvali) ───────── */
section('A. Komissiya kombinatsiyalari — ovqat 100 000, yetkazish 15 000');
for (const [R, C, gross] of [[5, 0, 5000], [0, 5, 5000], [5, 5, 10000], [10, 0, 10000], [6, 2, 8000], [3, 7, 10000], [0, 0, 0]]) {
  const f = computeOrderFinance({ foodBaseTiyin: T(100000), deliveryFeeTiyin: T(15000), restaurantCommissionPercent: R, customerFeePercent: C });
  eq(f.lokmaGrossCommission, T(gross), `${R}%+${C}%: LokmaGo gross`);
  eq(f.customerFoodTotal, T(100000 + 1000 * C), `${R}%+${C}%: mijoz taom summasi = F + F×C`);
  eq(f.restaurantFoodPayout, T(100000 - 1000 * R), `${R}%+${C}%: restoran taom ulushi = F − F×R`);
  eq(f.totalCharged, T(100000 + 1000 * C + 15000), `${R}%+${C}%: jami = taom + yetkazish`);
  ok(reconcile(f).ok, `${R}%+${C}%: rekonsiliatsiya`);
}
section('A. Noto‘g‘ri foiz rad etiladi');
for (const bad of [-1, 101, 'abc', Infinity]) {
  let threw = false;
  try { computeOrderFinance({ foodBaseTiyin: T(1000), restaurantCommissionPercent: bad }); } catch { threw = true; }
  ok(threw, `komissiya ${bad} → xato`);
  threw = false;
  try { computeOrderFinance({ foodBaseTiyin: T(1000), customerFeePercent: bad }); } catch { threw = true; }
  ok(threw, `mijoz haqi ${bad} → xato`);
}
{
  // Kelishuv yo'q → chaqiruvchi 0 beradi (egasi qarori: 0% qabul, admin ogohlantiriladi) — uydirma foiz yo'q
  const f = computeOrderFinance({ foodBaseTiyin: T(50000) });
  eq(f.lokmaGrossCommission, 0, 'kelishuvsiz: komissiya 0, uydirma foiz yo‘q');
  const src = readFileSync('src/controllers/misc.js', 'utf8');
  ok(/notificationId: `finance:no-agreement:\$\{key\}:\$\{day\}`/.test(src) && src.includes("audience: 'admin'") && src.includes("type: 'finance'"),
    'kelishuvsiz restoran: adminga kunlik "finance" bildirishnomasi (faqat admin auditoriyasi)');
}

/* ───────── B. Yetkazish ───────── */
section('B. Yetkazish komissiyaga kirmaydi; taqsimot yetkazuvchiga qarab');
{
  const a = computeOrderFinance({ foodBaseTiyin: T(100000), deliveryFeeTiyin: 0, restaurantCommissionPercent: 5, customerFeePercent: 5 });
  const b = computeOrderFinance({ foodBaseTiyin: T(100000), deliveryFeeTiyin: T(20000), restaurantCommissionPercent: 5, customerFeePercent: 5 });
  eq(b.lokmaGrossCommission, a.lokmaGrossCommission, 'yetkazish qo‘shilsa ham komissiya o‘zgarmaydi');
  eq(b.restaurantDeliveryPayout, T(20000), 'restoran kuryeri: yetkazish 100% restoranga');
  eq(a.restaurantDeliveryPayout, 0, 'yetkazish 0');
  const l = applyDeliveryParty(b, { party: 'lokma', nominalDeliveryFeeTiyin: T(20000), percent: 10 });
  eq(l.restaurantDeliveryPayout, 0, 'LokmaGo kuryeri: restoranga yetkazish yo‘q');
  eq(l.courierPayout, T(18000), 'kuryer ulushi 90%');
  eq(l.lokmaDeliveryCommission, T(2000), 'LokmaGo yetkazish foizi 10%');
  eq(l.restaurantPayout, T(95000), 'restoranga faqat taom ulushi');
  ok(reconcile(l).ok, 'LokmaGo kuryeri: rekonsiliatsiya');
  const free = applyDeliveryParty(computeOrderFinance({ foodBaseTiyin: T(100000), restaurantCommissionPercent: 5 }),
    { party: 'lokma', nominalDeliveryFeeTiyin: T(20000), percent: 10, free: true });
  eq(free.deliverySubsidy, T(18000), 'tekin yetkazish: kuryer ulushini LokmaGo to‘laydi');
  ok(reconcile(free).ok, 'tekin yetkazish: rekonsiliatsiya');
}

/* ───────── C/D. Naqd komissiya va shlyuz haqi ───────── */
section('C/D. Naqd qarz = gross (mijoz haqi bilan); shlyuz haqi restoran ulushini kamaytirmaydi');
{
  const cash = computeOrderFinance({ foodBaseTiyin: T(100000), deliveryFeeTiyin: T(20000), restaurantCommissionPercent: 5, customerFeePercent: 5, paymentFeePercent: 0 });
  eq(cash.lokmaGrossCommission, T(10000), 'naqd 5%+5%: restoran LokmaGo’ga 10 000 qarz (settleOrder gross’ni yozadi)');
  eq(cash.clickFeeAmount, 0, 'naqdda shlyuz haqi yo‘q');
  const card = computeOrderFinance({ foodBaseTiyin: T(100000), deliveryFeeTiyin: T(20000), restaurantCommissionPercent: 5, paymentFeePercent: 1.5 });
  const noFee = computeOrderFinance({ foodBaseTiyin: T(100000), deliveryFeeTiyin: T(20000), restaurantCommissionPercent: 5, paymentFeePercent: 0 });
  eq(card.restaurantPayout, noFee.restaurantPayout, 'Click 1.5% restoran ulushini kamaytirmaydi');
  eq(card.restaurantPayout, T(115000), 'restoranga: 95 000 + 20 000');
  eq(card.clickFeeAmount, T(1800), 'Click haqi jami 120 000 dan 1.5%');
  eq(card.lokmaNetCommission, T(3200), 'LokmaGo net = 5 000 − 1 800');
  const settle = readFileSync('src/services/billing.js', 'utf8');
  ok(settle.includes('commission = tiyinToSom(fin.lokmaGrossCommission)'), 'settleOrder naqd qarzni gross’dan yozadi (mijoz haqi ham)');
}

/* ───────── F-08/F-09: menyu yig'indisi = to'lov, butun so'm ───────── */
section('F-08/F-09. Mijoz menyuda ko‘rgan summa = to‘laydigan summa (butun so‘m)');
{
  const ctxs = [[0, 5], [10, 5], [0, 7.5], [3, 2], [12.5, 3.3], [0, 0]];
  const items = [
    { unitPrice: 10333, quantity: 3 },
    { unitPrice: 7450, quantity: 2, selectedOptions: [{ name: 'Pishloq', price: 1950 }] },
    { unitPrice: 18990, quantity: 1, selectedOptions: [{ name: 'Katta', price: 4000, variant: true }] },
    { unitPrice: 999, quantity: 7 },
  ];
  for (const [mk, cf] of ctxs) {
    const ctx = { deliveryMarkupPercent: mk, customerFeePercent: cf };
    const b = itemsCustomerBreakdown(items, ctx);
    const shown = items.reduce((s, it) => s + itemCustomerUnitPrice(it, ctx) * it.quantity, 0);
    eq(b.price, shown, `ustama ${mk}% haq ${cf}%: bo‘laklar yig‘indisi = menyu narxlari`);
    eq(b.base, items.reduce((s, it) => s + it.unitPrice * it.quantity, 0), `ustama ${mk}% haq ${cf}%: baza = Σ unitPrice×qty`);
    const f = computeOrderFinance({
      foodBaseTiyin: T(b.base), deliveryFeeTiyin: T(12000), deliveryMarkupPercent: mk, customerFeePercent: cf,
      restaurantCommissionPercent: 5, paymentFeePercent: 1.5,
      deliveryMarkupLinesTiyin: T(b.markup), customerFeeLinesTiyin: T(b.fee),
    });
    eq(f.customerFoodTotal, T(shown), `ustama ${mk}% haq ${cf}%: to‘lov = menyu yig‘indisi (${shown})`);
    eq(f.totalCharged % 100, 0, `ustama ${mk}% haq ${cf}%: jami butun so‘m`);
    ok(reconcile(f).ok, `ustama ${mk}% haq ${cf}%: rekonsiliatsiya`);
    eq(f.feeRounding, 'lines', 'snapshot belgisi feeRounding=lines');
  }
  // Menyudagi narx (applyPricing) bilan bitta pozitsiya bo'laklari bir xil
  const dish = { price: 23450, optionGroups: [{ options: [{ id: 'a', price: 3100 }] }] };
  const ctx = { deliveryMarkupPercent: 7, customerFeePercent: 4.5 };
  const shownDish = applyPricing(dish, ctx);
  const line = itemCustomerUnitPrice({ unitPrice: 23450 + 3100, selectedOptions: [{ name: 'a', price: 3100 }] }, ctx);
  eq(line, shownDish.price + shownDish.optionGroups[0].options[0].price, 'menyu (taom + qo‘shimcha) = pozitsiya narxi');

  // Chegirma bilan: proporsional, butun so'm, rekonsiliatsiya
  for (const disc of [1, 333, 5000, 12345]) {
    const b = itemsCustomerBreakdown(items, { deliveryMarkupPercent: 10, customerFeePercent: 5 });
    const f = computeOrderFinance({
      foodBaseTiyin: T(b.base), discountTiyin: T(disc), deliveryMarkupPercent: 10, customerFeePercent: 5, restaurantCommissionPercent: 6,
      deliveryMarkupLinesTiyin: T(b.markup), customerFeeLinesTiyin: T(b.fee),
    });
    eq(f.customerFoodTotal % 100, 0, `chegirma ${disc}: mijoz summasi butun so‘m`);
    ok(reconcile(f).ok, `chegirma ${disc}: rekonsiliatsiya`);
    ok(f.customerFoodTotal <= T(b.price - disc), `chegirma ${disc}: menyu − chegirmadan oshmaydi`);
  }
  // Bo'laklar berilmasa — avvalgi foiz hisobi (qaytarish va eski chaqiruvlar o'zgarmaydi)
  const legacy = computeOrderFinance({ foodBaseTiyin: T(10333), customerFeePercent: 5 });
  eq(legacy.customerFeeAmount, 51665, 'bo‘laklarsiz: avvalgi hisob saqlangan');
  eq(legacy.feeRounding, 'percent', 'bo‘laklarsiz: feeRounding=percent');
}

/* ───────── F-00: server subtotal ───────── */
section('F-00. Minimal summa, bepul yetkazish, chegirmalar SERVER summasidan');
{
  const src = readFileSync('src/controllers/misc.js', 'utf8');
  const iSet = src.indexOf('o.subtotal = o._menu.price;');
  ok(iSet > 0, 'o.subtotal server menyu yig‘indisiga almashtiriladi');
  for (const [name, needle] of [
    ['minimal summa', 'checkMinOrder(o.subtotal'],
    ['yetkazish kotirovkasi (bepul chegara)', 'const quote = await quoteDelivery('],
    ['olib ketish chegirmasi', 'o._pickupDiscount = Math.round(o.subtotal'],
    ['aksiya', 'applyPromotion(o.restaurantId, o.items || [], o.subtotal)'],
  ]) {
    const i = src.indexOf(needle);
    ok(i > iSet, `${name} server summasidan KEYIN hisoblanadi`, `(set ${iSet}, use ${i})`);
  }
  ok(src.indexOf('o.subtotal = o._menu.price;') > src.indexOf('o._foodBaseSom = priceCheck.foodBaseSom;'), 'server summasi narx tekshiruvidan keyin');
  ok(src.includes('const agreement = o._agreement;'), 'kelishuv bir marta olinadi va snapshot shundan quriladi');
}

/* ───────── F: Qaytarish ───────── */
section('F-04. LokmaGo kuryeri yetkazgan buyurtmani qaytarish');
{
  let f = computeOrderFinance({ foodBaseTiyin: T(100000), deliveryFeeTiyin: T(20000), restaurantCommissionPercent: 5, paymentFeePercent: 1.5 });
  f = applyDeliveryParty(f, { party: 'lokma', nominalDeliveryFeeTiyin: T(20000), percent: 10 });
  const { refund } = computeRefund(f, {});
  ok(validateRefund(f, refund).ok, 'to‘liq qaytarish tekshiruvdan o‘tadi (ilgari yiqilardi va jurnalga yozilmasdi)');
  eq(refund.restaurantPayout, f.restaurantPayout, 'restoran ulushi aynan asl (95 000) teskari');
  eq(refund.courierPayout, f.courierPayout, 'kuryer ulushi teskari');
  eq(refund.totalCharged, f.totalCharged, 'mijozga jami qaytariladi');
  ok(reconcile(refund).ok, 'qaytarish rekonsiliatsiyasi');
  const part = computeRefund(f, { foodBaseRefundTiyin: T(30000) });
  eq(part.refund.courierPayout, 0, 'qisman (taom) qaytarishda kuryer ulushiga tegilmaydi');
  eq(part.refund.restaurantDeliveryPayout, 0, 'qisman: restoran yetkazish 0');
}

section('F-10. Qisman qaytarishlar yig‘indisi asl summaga ANIQ teng (tasodifiy 400 holat)');
{
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const fields = ['totalCharged', 'restaurantPayout', 'restaurantFoodPayout', 'lokmaGrossCommission', 'customerFeeAmount',
    'restaurantCommissionAmount', 'clickFeeAmount', 'courierPayout', 'discountAmount', 'deliveryMarkupAmount', 'lokmaNetCommission'];
  let exact = 0; let over = 0; let recon = 0; let cases = 0;
  for (let k = 0; k < 400; k++) {
    const base = 1 + rnd(5_000_000);
    let f = computeOrderFinance({
      foodBaseTiyin: base, deliveryFeeTiyin: rnd(3) ? rnd(3_000_000) : 0, discountTiyin: rnd(4) ? 0 : rnd(base),
      deliveryMarkupPercent: rnd(3) ? 0 : rnd(15), customerFeePercent: rnd(11), restaurantCommissionPercent: rnd(16) + rnd(100) / 100,
      paymentFeePercent: rnd(2) ? 1.5 : 0,
    });
    if (rnd(2) && f.deliveryFee > 0) f = applyDeliveryParty(f, { party: 'lokma', nominalDeliveryFeeTiyin: f.deliveryFee, percent: rnd(30) });
    const sums = Object.fromEntries(fields.map((x) => [x, 0]));
    let done = 0; let delivered = false; let steps = 0;
    while (done < base && steps < 8) {
      const left = base - done;
      const chunk = steps === 7 ? left : Math.max(1, rnd(left) + (rnd(3) ? 0 : left));
      const r = computeRefund(f, {
        foodBaseRefundTiyin: Math.min(chunk, left), refundDelivery: !delivered && rnd(2) === 0,
        alreadyRefundedFoodBaseTiyin: done, deliveryAlreadyRefunded: delivered,
      });
      if (r.deliveryRefunded) delivered = true;
      if (!reconcile(r.refund).ok) recon += 1;
      for (const x of fields) sums[x] += Math.round(Number(r.refund[x]) || 0);
      done += r.refund.foodBase; steps += 1;
    }
    if (!delivered && f.deliveryFee > 0) {
      const r = computeRefund(f, { foodBaseRefundTiyin: 0, refundDelivery: true, alreadyRefundedFoodBaseTiyin: done });
      for (const x of fields) sums[x] += Math.round(Number(r.refund[x]) || 0);
    }
    cases += 1;
    const allExact = fields.every((x) => sums[x] === Math.round(Number(f[x]) || 0));
    if (allExact) exact += 1;
    if (['totalCharged', 'restaurantPayout', 'lokmaGrossCommission', 'courierPayout'].some((x) => sums[x] > Math.round(Number(f[x]) || 0))) over += 1;
  }
  eq(exact, cases, `barcha maydonlar yig‘indisi asl summaga aniq teng (${cases} holat)`);
  eq(over, 0, 'hech qachon asldan ortiq qaytarilmaydi');
  eq(recon, 0, 'har bir qism rekonsiliatsiyadan o‘tadi');
}

/* ───────── F-05 / F-22: recordRefund jurnal yozuvlari (model metodlari soxta) ───────── */
section('F-05/F-22. recordRefund — jurnal yozuvlari');
{
  const { Ledger } = await import('../src/models/Ledger.js');
  const { Restaurant } = await import('../src/models/Restaurant.js');
  const { recordRefund } = await import('../src/services/billing.js');
  const run = async ({ order, settled }) => {
    const created = []; const incs = [];
    Ledger.find = () => ({ select: () => ({ lean: async () => [] }) });
    Ledger.findOne = () => ({ lean: async () => (settled ? { _id: 'due1', amount: 1 } : null) });
    Ledger.create = async (doc) => { created.push(doc); return doc; };
    Restaurant.updateOne = async (_q, upd) => { incs.push(upd.$inc.balance); return {}; };
    const res = await recordRefund(order, order.paymentMethod);
    return { created, incs, res };
  };
  const fin = computeOrderFinance({ foodBaseTiyin: T(100000), deliveryFeeTiyin: T(20000), restaurantCommissionPercent: 5, customerFeePercent: 5, paymentFeePercent: 1.5 });
  const card = { _id: 'o1', restaurantId: 'r1', userId: 'u1', total: 125000, paymentMethod: 'click', finance: fin };

  let r = await run({ order: card, settled: false });
  eq(r.created.filter((x) => x.type === 'commission').length, 0, 'yetkazishdan oldin bekor: manfiy komissiya YOZILMAYDI (F-05)');
  eq(r.created.filter((x) => x.type === 'refund').length, 1, 'refund yozuvi bor');
  eq(r.incs.length, 0, 'balansga tegilmaydi (hisob-kitob bo‘lmagan)');

  r = await run({ order: card, settled: true });
  const com = r.created.find((x) => x.type === 'commission');
  eq(com?.amount, -10000, 'hisob-kitobdan keyin: komissiya teskari −10 000');
  eq(r.incs[0], -115000, 'karta: restoran ulushi teskari −115 000');

  let lf = computeOrderFinance({ foodBaseTiyin: T(100000), deliveryFeeTiyin: T(20000), restaurantCommissionPercent: 5, paymentFeePercent: 0 });
  lf = applyDeliveryParty(lf, { party: 'lokma', nominalDeliveryFeeTiyin: T(20000), percent: 10 });
  const cashLokma = { _id: 'o2', restaurantId: 'r1', userId: 'u1', total: 120000, paymentMethod: 'cash', courierParty: 'lokma', finance: lf };
  r = await run({ order: cashLokma, settled: true });
  eq(r.incs[0], -95000, 'naqd + LokmaGo kuryeri: restoran ulushi karta kabi teskari −95 000 (F-22)');
  ok(r.created.filter((x) => x.type !== 'refund').every((x) => x.isCash === false), 'naqd + LokmaGo kuryeri: isCash=false (settleOrder bilan bir xil)');
  ok(r.res && r.res.refunded === 120000, 'LokmaGo kuryeri buyurtmasi qaytarishi jurnalga yozildi (F-04)');

  const cashOwn = { _id: 'o3', restaurantId: 'r1', userId: 'u1', total: 125000, paymentMethod: 'cash', courierParty: 'restaurant', finance: computeOrderFinance({ foodBaseTiyin: T(100000), deliveryFeeTiyin: T(20000), restaurantCommissionPercent: 5, customerFeePercent: 5 }) };
  r = await run({ order: cashOwn, settled: true });
  eq(r.incs[0], 10000, 'naqd (restoran kuryeri): komissiya qarzi bekor +10 000');
}

console.log(`\n${failed ? `✗ ${failed} ta XATO` : '✓ HAMMASI O‘TDI'} (${passed} tekshiruv)`);
process.exit(failed ? 1 : 0);
