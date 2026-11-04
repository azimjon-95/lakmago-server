/*
 * Kim yetkazadi va yetkazish puli kimga (src/services/deliveryParty.js) + rekonsiliatsiya (orderFinance.reconcile).
 * Baza kerak emas. npm run test:delivery-party
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeOrderFinance, reconcile, somToTiyin } from '../src/services/orderFinance.js';
import {
  applyDeliveryParty, splitCourierFee, courierPercentFor, initialParty, isFreeByLokma,
  applyLokmaFreeDelivery, courierSettlement, normalizePercent, cashExposure,
} from '../src/services/deliveryParty.js';
import { DISTRICTS, DEFAULT_DISTRICT, isDistrict, normalizeDistricts, districtLabel } from '../src/constants/districts.js';

const base = (o = {}) => computeOrderFinance({
  foodBaseTiyin: somToTiyin(100000), deliveryFeeTiyin: somToTiyin(30000),
  customerFeePercent: 3, restaurantCommissionPercent: 10, paymentFeePercent: 0, ...o,
});
const S = (som) => somToTiyin(som);

test('restoran kuryeri: hozirgidek — yetkazish 100% restoranga, rekonsiliatsiya', () => {
  const f0 = base();
  const f = applyDeliveryParty(f0, { party: 'restaurant' });
  assert.equal(f.restaurantDeliveryPayout, S(30000));
  assert.equal(f.restaurantPayout, f0.restaurantPayout, 'avvalgi restoran ulushi o\'zgarmaydi');
  assert.equal(f.lokmaNetCommission, f0.lokmaNetCommission);
  assert.equal(f.lokmaCashNet, f0.lokmaCashNet);
  assert.equal(f.courierPayout, 0);
  assert.ok(reconcile(f).ok && reconcile(f0).ok);
});

test('LokmaGo kuryeri: 30 000 so\'m, 10% → kuryerga 27 000, LokmaGo\'ga 3 000; restoranga yetkazish YO\'Q', () => {
  const f0 = base();
  const f = applyDeliveryParty(f0, { party: 'lokma', percent: 10 });
  assert.equal(f.courierPayout, S(27000));
  assert.equal(f.lokmaDeliveryCommission, S(3000));
  assert.equal(f.restaurantDeliveryPayout, 0);
  assert.equal(f.restaurantPayout, f0.restaurantFoodPayout, 'restoranga faqat taom ulushi');
  assert.equal(f.lokmaNetCommission, f0.lokmaNetCommission + S(3000));
  assert.equal(f.totalCharged, f0.totalCharged, 'mijoz to\'lovi o\'zgarmaydi');
  const r = reconcile(f); assert.ok(r.ok, JSON.stringify(r));
  assert.equal(f0, f0); assert.notEqual(f, f0, 'kirish obyekti o\'zgartirilmaydi');
  assert.equal(f0.restaurantDeliveryPayout, S(30000));
});

test('LokmaGo foizi boshqariladi: 0% (hammasi kuryerga), 15%, 100%', () => {
  for (const [p, courier] of [[0, 30000], [15, 25500], [100, 0]]) {
    const f = applyDeliveryParty(base(), { party: 'lokma', percent: p });
    assert.equal(f.courierPayout, S(courier), `${p}%`);
    assert.ok(reconcile(f).ok);
  }
});

test('TEKIN yetkazish: mijozdan 0, kuryer ulushini LokmaGo to\'laydi (subsidiya), LokmaGo foiz olmaydi', () => {
  const f0 = base({ deliveryFeeTiyin: 0 });
  const f = applyDeliveryParty(f0, { party: 'lokma', nominalDeliveryFeeTiyin: S(30000), percent: 10, free: true });
  assert.equal(f.totalCharged, f0.totalCharged, 'mijoz yetkazish to\'lamaydi');
  assert.equal(f.deliveryFee, 0);
  assert.equal(f.nominalDeliveryFee, S(30000));
  assert.equal(f.courierPayout, S(27000));
  assert.equal(f.deliverySubsidy, S(27000));
  assert.equal(f.lokmaDeliveryCommission, 0);
  assert.equal(f.lokmaNetCommission, f0.lokmaNetCommission - S(27000), 'LokmaGo xarajati');
  assert.ok(f.freeDeliveryByLokma);
  assert.ok(reconcile(f).ok, JSON.stringify(reconcile(f)));
});

test('noto\'g\'ri kombinatsiyalar rad etiladi (pul yo\'qolmasin)', () => {
  assert.throws(() => applyDeliveryParty(base(), { party: 'lokma', free: true, nominalDeliveryFeeTiyin: S(30000) }), /olinmasligi/);
  assert.throws(() => applyDeliveryParty(base(), { party: 'lokma', nominalDeliveryFeeTiyin: S(25000) }), /nominal/);
  // restoran kuryerida "free" e'tiborsiz (tekin faqat LokmaGo kuryerida)
  const f = applyDeliveryParty(base(), { party: 'restaurant', free: true });
  assert.equal(f.freeDeliveryByLokma, false);
  assert.equal(f.restaurantDeliveryPayout, S(30000));
});

test('qayta qo\'llash: lokma → restaurant → asl holat (both rejimida tanlov o\'zgarsa)', () => {
  const f0 = base({ paymentFeePercent: 1.5 });
  const back = applyDeliveryParty(applyDeliveryParty(f0, { party: 'lokma', percent: 10 }), { party: 'restaurant' });
  for (const k of ['restaurantPayout', 'restaurantDeliveryPayout', 'lokmaNetCommission', 'lokmaCashNet', 'deliveryPayout']) {
    assert.equal(back[k], f0[k], k);
  }
  assert.equal(back.courierPayout, 0);
  const pending = applyDeliveryParty(f0, { party: null });
  assert.equal(pending.courierParty, null);
  assert.equal(pending.restaurantPayout, f0.restaurantPayout, 'tanlanmagan — restoran deb hisoblanadi');
});

test('rekonsiliatsiya: 3000 ta tasodifiy buyurtma (karta 1.5% / naqd, foizlar, tekin) — bironta tiyin yo\'qolmaydi', () => {
  let seed = 7; const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  for (let i = 0; i < 3000; i++) {
    const free = rnd() < 0.3;
    const nominal = Math.round(rnd() * 6000000) + 1;
    const f0 = computeOrderFinance({
      foodBaseTiyin: Math.round(rnd() * 50000000) + 1,
      deliveryFeeTiyin: free ? 0 : nominal,
      discountTiyin: Math.round(rnd() * 500000),
      customerFeePercent: Math.round(rnd() * 500) / 100,
      restaurantCommissionPercent: Math.round(rnd() * 2500) / 100,
      paymentFeePercent: rnd() < 0.5 ? 1.5 : 0,
    });
    const party = free || rnd() < 0.6 ? 'lokma' : 'restaurant';
    const f = applyDeliveryParty(f0, { party, nominalDeliveryFeeTiyin: nominal, percent: Math.round(rnd() * 3000) / 100, free });
    const r = reconcile(f);
    assert.ok(r.ok, `#${i} ${JSON.stringify(r)}`);
    assert.ok(f.courierPayout >= 0 && f.restaurantPayout >= 0);
    assert.ok(Number.isInteger(f.courierPayout) && Number.isInteger(f.lokmaNetCommission));
  }
});

test('kuryer balansi: naqd → −jami + ulush; karta → +ulush; restoran kuryeri → yo\'q', () => {
  const lok = applyDeliveryParty(base(), { party: 'lokma', percent: 10 });
  assert.deepEqual(courierSettlement(lok, { paymentMethod: 'cash' }), [
    { type: 'courier_cash', amount: -lok.totalCharged },
    { type: 'courier_earning', amount: S(27000) },
  ]);
  assert.deepEqual(courierSettlement(lok, { paymentMethod: 'click' }), [{ type: 'courier_earning', amount: S(27000) }]);
  assert.deepEqual(courierSettlement(applyDeliveryParty(base(), { party: 'restaurant' }), { paymentMethod: 'cash' }), []);
  // naqd: kuryer qo'lida LokmaGo puli = jami − ulush; karta: balans ulushga oshadi
  assert.equal(cashExposure(lok, 'cash'), lok.totalCharged - S(27000));
  assert.equal(cashExposure(lok, 'click'), -S(27000));
});

test('rejim va foiz manbasi: admin restoranga alohida foiz bersa — o\'sha, aks holda global', () => {
  assert.equal(courierPercentFor({ lokmaCourierPercent: 12.5 }, { courier: { commissionPercent: 10 } }), 12.5);
  assert.equal(courierPercentFor({ lokmaCourierPercent: null }, { courier: { commissionPercent: 8 } }), 8);
  assert.equal(courierPercentFor({}, {}), 10, 'standart 10%');
  assert.equal(normalizePercent(150), 100); assert.equal(normalizePercent(-3), 0); assert.equal(normalizePercent('x'), 10);
  assert.equal(initialParty({ courierMode: 'own' }), 'restaurant');
  assert.equal(initialParty({ courierMode: 'lokma' }), 'lokma');
  assert.equal(initialParty({ courierMode: 'both' }), null);
  assert.equal(initialParty({}), 'restaurant', 'eski restoranlar — hozirgidek o\'z kuryeri');
  assert.deepEqual(splitCourierFee(S(30000), 10), { nominal: S(30000), courier: S(27000), lokma: S(3000) });
});

test('tekin yetkazish faqat "lokma" rejimida (both/own da restoran tekinga yetkazib qolmasin)', () => {
  const q = { available: true, price: 30000, distanceKm: 3 };
  assert.equal(isFreeByLokma({ courierMode: 'lokma', lokmaFreeDelivery: true }), true);
  assert.equal(isFreeByLokma({ courierMode: 'both', lokmaFreeDelivery: true }), false);
  assert.deepEqual(applyLokmaFreeDelivery(q, { courierMode: 'lokma', lokmaFreeDelivery: true }), { ...q, price: 0, nominalPrice: 30000, freeByLokma: true });
  assert.deepEqual(applyLokmaFreeDelivery(q, { courierMode: 'both', lokmaFreeDelivery: true }), { ...q, nominalPrice: 30000 });
  assert.equal(applyLokmaFreeDelivery({ available: false, reason: 'x' }, { courierMode: 'lokma', lokmaFreeDelivery: true }).available, false);
});

test('tumanlar: Namangan viloyati, standart Pop, kalitlar noyob', () => {
  assert.equal(DEFAULT_DISTRICT, 'pop');
  assert.equal(DISTRICTS.length, 14);
  assert.equal(new Set(DISTRICTS.map((d) => d.id)).size, 14);
  for (const d of DISTRICTS) assert.ok(d.uz && d.uzc && d.ru && ['city', 'district'].includes(d.group), d.id);
  assert.ok(isDistrict('chust') && !isDistrict('toshkent'));
  assert.deepEqual(normalizeDistricts(['chust', 'xx', 'pop', 'chust']), ['pop', 'chust']);
  assert.equal(districtLabel('pop', 'ru'), 'Папский район');
});
