/*
 * ═══════════════════════════════════════════════════════════
 * DAROMAD JADVALI — HAR RESTORAN O'Z FOIZI BILAN
 * ═══════════════════════════════════════════════════════════
 *
 * XATO: jadval foizni eski manbadan olardi
 * (`Restaurant.commissionPercent`, bo'lmasa `Settings`), kelishuvlar
 * esa `CommissionAgreement` da saqlanadi. Restoranlarda eski maydon
 * to'ldirilmagani uchun HAMMASI umumiy standartga (10%) tushardi —
 * Totli 5%, Tutti 6% bo'lsa ham jadvalda 10% ko'rinardi.
 *
 * npm run test:revenue
 */
import { mergeRevenueRows } from '../src/controllers/admin.js';

let fails = 0;
const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗ FAIL:', m); if (!c) fails++; };
const tiyinToSom = (t) => Math.round(Number(t) || 0) / 100;
const S = (som) => Math.round(som * 100);          // so'm → tiyin

const restMap = new Map([
  ['r1', { name: 'TOTLI Tortlari' }],
  ['r2', { name: 'Ziynat Restaurant' }],
  ['r3', { name: 'TUTTI FOOD' }],
  ['r4', { name: 'Eski', commissionPercent: 10, commissionMode: 'deduct' }],
]);

/* Eski mantiq — hozirgi `resolveCommission` + `calcCommission` kabi */
const legacyCommission = async (rest, gross) => {
  const pct = Number(rest.commissionPercent) || 10;
  const commission = Math.round((gross * pct) / 100);
  return { commission, restaurantShare: gross - commission };
};

console.log('\n[1] Uch restoran — UCH XIL kelishuv');
{
  /* Snapshot'dagi summalar (tiyinda) — har biri o'z foizi bilan */
  const v2 = [
    { _id: 'r1', orders: 2, foodSubtotal: S(20000), commission: S(1000), restaurantShare: S(19000) },   // 5%
    { _id: 'r2', orders: 1, foodSubtotal: S(73000), commission: S(7300), restaurantShare: S(65700) },   // 10%
    { _id: 'r3', orders: 1, foodSubtotal: S(78000), commission: S(4680), restaurantShare: S(73320) },   // 6%
  ];
  const rows = await mergeRevenueRows({ v2, legacy: [], restMap, legacyCommission, tiyinToSom });
  const by = (n) => rows.find((r) => r.name === n);

  ok(by('TOTLI Tortlari').commissionPercent === 5, `Totli: ${by('TOTLI Tortlari').commissionPercent}%`);
  ok(by('Ziynat Restaurant').commissionPercent === 10, `Ziynat: ${by('Ziynat Restaurant').commissionPercent}%`);
  ok(by('TUTTI FOOD').commissionPercent === 6, `Tutti: ${by('TUTTI FOOD').commissionPercent}%`);

  ok(by('TOTLI Tortlari').platformIncome === 1000, `Totli bizga: ${by('TOTLI Tortlari').platformIncome}`);
  ok(by('TUTTI FOOD').platformIncome === 4680, `Tutti bizga: ${by('TUTTI FOOD').platformIncome}`);

  const total = rows.reduce((s, r) => s + r.platformIncome, 0);
  ok(total === 12980, `bizning daromad: ${total} (hammasi 10% bo‘lsa 17 100 chiqardi)`);

  // Jadval ichida mantiq buzilmasin
  for (const r of rows) {
    ok(r.gross === r.platformIncome + r.restaurantIncome,
      `${r.name}: aylanma = restoran + bizga (${r.gross})`);
  }
}

console.log('\n[2] Eski buyurtmalar — avvalgi mantiq bilan qo‘shiladi');
{
  const v2 = [{ _id: 'r1', orders: 1, foodSubtotal: S(20000), commission: S(1000), restaurantShare: S(19000) }];
  const legacy = [{ _id: 'r4', orders: 1, gross: 50000 }];
  const rows = await mergeRevenueRows({ v2, legacy, restMap, legacyCommission, tiyinToSom });

  const eski = rows.find((r) => r.name === 'Eski');
  ok(eski.platformIncome === 5000, `eski: ${eski.platformIncome} (50 000 × 10%)`);
  ok(eski.hasLegacy === true, 'legacy deb belgilandi');
  ok(rows.find((r) => r.name === 'TOTLI Tortlari').commissionPercent === 5,
    'yangi buyurtmalar o‘z foizida qoldi');
}

console.log('\n[3] Bitta restoranda eski va yangi buyurtma birga');
{
  const v2 = [{ _id: 'r4', orders: 1, foodSubtotal: S(10000), commission: S(500), restaurantShare: S(9500) }];   // 5%
  const legacy = [{ _id: 'r4', orders: 1, gross: 10000 }];                                                      // 10%
  const rows = await mergeRevenueRows({ v2, legacy, restMap, legacyCommission, tiyinToSom });

  ok(rows[0].gross === 20000, `aylanma: ${rows[0].gross}`);
  ok(rows[0].platformIncome === 1500, `bizga: ${rows[0].platformIncome} (500 + 1 000)`);
  ok(rows[0].commissionPercent === 7.5, `o‘rtacha foiz: ${rows[0].commissionPercent}% (aralash davr)`);
  ok(rows[0].orders === 2, `buyurtmalar: ${rows[0].orders}`);
}

console.log('\n[4] Chekka holatlar');
{
  const rows = await mergeRevenueRows({
    v2: [{ _id: 'r1', orders: 1, foodSubtotal: 0, commission: 0, restaurantShare: 0 }],
    legacy: [], restMap, legacyCommission, tiyinToSom,
  });
  ok(rows[0].commissionPercent === 0, 'nol aylanmada nolga bo‘linmaydi');

  const unknown = await mergeRevenueRows({
    v2: [{ _id: 'yoq', orders: 1, foodSubtotal: S(1000), commission: S(100), restaurantShare: S(900) }],
    legacy: [], restMap, legacyCommission, tiyinToSom,
  });
  ok(unknown[0].name === 'Nomsiz', 'o‘chirilgan restoran ham jadvalda qoladi');

  const empty = await mergeRevenueRows({ v2: [], legacy: [], restMap, legacyCommission, tiyinToSom });
  ok(empty.length === 0, 'buyurtma yo‘q — bo‘sh jadval');
}

console.log('\n[5] Saralash — eng katta aylanma birinchi');
{
  const v2 = [
    { _id: 'r1', orders: 1, foodSubtotal: S(20000), commission: S(1000), restaurantShare: S(19000) },
    { _id: 'r3', orders: 1, foodSubtotal: S(78000), commission: S(4680), restaurantShare: S(73320) },
  ];
  const rows = await mergeRevenueRows({ v2, legacy: [], restMap, legacyCommission, tiyinToSom });
  ok(rows[0].name === 'TUTTI FOOD', `birinchi: ${rows[0].name}`);
}

console.log(fails ? `\n✗ ${fails} ta xato` : '\n✓ HAMMASI O‘TDI');
process.exit(fails ? 1 : 0);
