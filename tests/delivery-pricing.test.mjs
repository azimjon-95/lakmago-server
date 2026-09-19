/*
 * ═══════════════════════════════════════════════════════════
 * YETKAZISH NARXI — IKKI REJIM
 * ═══════════════════════════════════════════════════════════
 *
 * flat  — bitta qat'iy narx
 * perKm — bepul masofadan keyin har km uchun narx
 *
 * Ikkalasida ham bepul chegarasi va minimal summa ishlaydi.
 * Naqd/karta farqi yo'q: narx bir xil, faqat to'lov usuli boshqa.
 *
 * npm run test:delivery
 */
import { calcDeliveryPrice } from '../src/services/deliveryEngine.js';

let fails = 0;
const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗ FAIL:', m); if (!c) fails++; };
const R = (extra = {}) => ({
  deliveryEnabled: true, deliveryFee: 15000, freeDeliveryThreshold: 300000,
  delivery: { maxDistanceKm: 8, ...extra },
});

console.log('\n[1] QAT‘IY NARX rejimi');
{
  const r = R();
  ok(calcDeliveryPrice(3.3, r, 50000).price === 15000, 'masofadan qat‘i nazar 15 000');
  ok(calcDeliveryPrice(7.9, r, 50000).price === 15000, 'uzoqroq ham 15 000');
  ok(calcDeliveryPrice(3.3, r, 300000).price === 0, 'chegaradan oshdi — bepul');
  ok(calcDeliveryPrice(3.3, r, 299999).price === 15000, 'chegaradan 1 so‘m kam — pullik');
}

console.log('\n[2] KILOMETR rejimi (1 km bepul, keyin 2 000/km)');
{
  const r = R({ pricingMode: 'perKm', freeKm: 1, perKm: 2000 });
  ok(calcDeliveryPrice(0.8, r, 50000).price === 0, '0.8 km — bepul masofa ichida');
  ok(calcDeliveryPrice(1, r, 50000).price === 0, 'roppa-rosa 1 km — bepul');
  ok(calcDeliveryPrice(3.3, r, 50000).price === 4600, '3.3 km → 2.3 × 2 000 = 4 600');
  ok(calcDeliveryPrice(5, r, 50000).price === 8000, '5 km → 4 × 2 000 = 8 000');
  const b = calcDeliveryPrice(3.3, r, 50000).breakdown;
  ok(b?.paidKm === 2.3 && b?.perKm === 2000, `tafsilot: ${b?.paidKm} km × ${b?.perKm}`);
}

console.log('\n[3] Kilometr rejimida ham BEPUL CHEGARASI ishlaydi');
{
  const r = R({ pricingMode: 'perKm', freeKm: 1, perKm: 2000 });
  ok(calcDeliveryPrice(5, r, 300000).price === 0, '300 000 dan oshdi — bepul');
  ok(calcDeliveryPrice(5, r, 250000).price === 8000, 'chegaradan past — pullik');
}

console.log('\n[4] Bepul masofa 0 — birinchi metrdan pullik');
{
  const r = R({ pricingMode: 'perKm', freeKm: 0, perKm: 3000 });
  ok(calcDeliveryPrice(2, r, 50000).price === 6000, '2 km → 6 000');
  ok(calcDeliveryPrice(0.4, r, 50000).price === 1200, '0.4 km → 1 200');
}

console.log('\n[5] Yaxlitlash — g‘alati summa chiqmaydi');
{
  const r = R({ pricingMode: 'perKm', freeKm: 0, perKm: 1700 });
  const p = calcDeliveryPrice(2.34, r, 50000).price;
  ok(p % 100 === 0, `2.34 km × 1 700 = ${p} (100 so‘mgacha yaxlitlangan)`);
}

console.log('\n[6] Masofa noma‘lum — qat‘iy narxga qaytadi');
{
  const r = R({ pricingMode: 'perKm', freeKm: 1, perKm: 2000 });
  const q = calcDeliveryPrice(NaN, r, 50000);
  ok(q.price === 15000, `koordinatasiz: ${q.price} (qat‘iy narx)`);
  ok(q.breakdown?.fallback === true, 'zaxira rejim belgilandi');
}

console.log('\n[7] Radius va o‘chirilgan yetkazish — ikkala rejimda ham');
{
  for (const mode of ['flat', 'perKm']) {
    const r = R({ pricingMode: mode, freeKm: 1, perKm: 2000 });
    ok(calcDeliveryPrice(12, r, 50000).code === 'OUT_OF_RANGE', `${mode}: radiusdan uzoq`);
    ok(calcDeliveryPrice(3, { ...r, deliveryEnabled: false }, 50000).code === 'DELIVERY_DISABLED',
      `${mode}: yetkazish o‘chirilgan`);
  }
}

console.log('\n[8] Eski restoranlar (rejim yozilmagan) — avvalgidek');
{
  const r = { deliveryEnabled: true, deliveryFee: 12000, delivery: { maxDistanceKm: 10 } };
  ok(calcDeliveryPrice(4, r, 50000).price === 12000, 'qat‘iy narx qo‘llandi');
}

console.log(fails ? `\n✗ ${fails} ta xato` : '\n✓ HAMMASI O‘TDI');
process.exit(fails ? 1 : 0);
