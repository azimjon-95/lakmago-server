#!/usr/bin/env node
/*
 * ═══════════════════════════════════════════════════════════
 * ESKI HISOB-KITOB — SOLISHTIRMA HISOBOT (FAQAT O'QIYDI)
 * ═══════════════════════════════════════════════════════════
 *
 * ⚠ BU SKRIPT BAZANI O'ZGARTIRMAYDI.
 *   Hech qanday yozuv yaratmaydi, o'chirmaydi, tahrirlamaydi.
 *   Faqat o'qiydi va hisobot chiqaradi.
 *
 * MAQSAD: snapshot'dan oldingi (legacy) buyurtmalar bo'yicha
 * restoranga yozilgan qarz bilan YANGI qoidalar bo'yicha
 * chiqadigan qarzni solishtirish. Farq qancha ekanini bilib,
 * keyin buxgalter `type: 'adjustment'` yozuvi bilan qo'lda
 * to'g'rilashi mumkin.
 *
 * ISHLATISH:
 *   node scripts/legacy-finance-report.js
 *   node scripts/legacy-finance-report.js --restaurant <id>
 *   node scripts/legacy-finance-report.js --csv > hisobot.csv
 *   node scripts/legacy-finance-report.js --limit 500
 *
 * YANGI HISOB QANDAY CHIQARILADI:
 *   foodBase   — buyurtma elementlaridan (unitPrice × qty).
 *                DIQQAT: eski buyurtmalarda `unitPrice` mijoz
 *                ko'rgan narx bo'lishi mumkin (o'sha paytda
 *                server narxni tekshirmasdi) — shuning uchun
 *                natija TAXMINIY va "taklif" sifatida qaraladi.
 *   foizlar    — buyurtma sanasida AMAL QILGAN shartnomadan.
 *                Shartnoma topilmasa, restoranning joriy
 *                `commissionPercent` i ishlatiladi va qator
 *                `?` belgisi bilan chiqadi.
 */
import mongoose from 'mongoose';
import { config } from '../src/config/index.js';
import { Order } from '../src/models/Order.js';
import { Ledger } from '../src/models/Ledger.js';
import { Restaurant } from '../src/models/Restaurant.js';
import { CommissionAgreement } from '../src/models/CommissionAgreement.js';
import { computeOrderFinance, somToTiyin, tiyinToSom } from '../src/services/orderFinance.js';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] || true) : null;
};
const asCsv = args.includes('--csv');
const limit = Number(flag('limit')) || 1000;
const restaurantFilter = flag('restaurant');

const som = (n) => Math.round(Number(n) || 0);
const fmt = (n) => som(n).toLocaleString('ru-RU');

/** Buyurtma sanasida amal qilgan shartnoma. */
async function agreementAt(restaurantId, date, cache) {
  const key = String(restaurantId);
  if (!cache.has(key)) {
    const list = await CommissionAgreement.find({ restaurantId })
      .sort({ effectiveFrom: -1 }).lean();
    cache.set(key, list);
  }
  return cache.get(key).find((a) => {
    const from = a.effectiveFrom ? new Date(a.effectiveFrom) : null;
    const to = a.effectiveTo ? new Date(a.effectiveTo) : null;
    if (from && date < from) return false;
    if (to && date > to) return false;
    return true;
  }) || null;
}

async function main() {
  await mongoose.connect(config.mongoUri);

  const filter = {
    'finance.model': { $ne: 'v2' },                  // faqat ESKI buyurtmalar
    status: { $in: ['delivered', 'completed'] },
  };
  if (restaurantFilter) filter.restaurantId = new mongoose.Types.ObjectId(restaurantFilter);

  const orders = await Order.find(filter)
    .select('restaurantId restaurantName items subtotal deliveryFee total paymentMethod createdAt')
    .sort({ createdAt: 1 })
    .limit(limit)
    .lean();

  const agreementCache = new Map();
  const restaurants = new Map();
  const rows = [];

  let totalOld = 0;
  let totalCorrect = 0;
  let uncertain = 0;
  let skippedRefunded = 0;

  for (const order of orders) {
    /*
     * Qaytarilgan buyurtmalar hisobotga KIRMAYDI: ularning
     * qarzi allaqachon teskari yozuv bilan bekor qilingan,
     * yangi hisob bilan solishtirish esa yolg'on "farq"
     * ko'rsatardi (masalan 0 → 9 000).
     */
    const refunded = await Ledger.countDocuments({ orderId: order._id, type: 'refund' });
    if (refunded) { skippedRefunded++; continue; }

    // Bu buyurtma uchun restoranga YOZILGAN qarz
    const dues = await Ledger.find({ orderId: order._id, type: 'restaurant_due' })
      .select('amount').lean();
    if (!dues.length) continue;                       // hisob-kitob qilinmagan
    const oldDue = dues.reduce((s, d) => s + (Number(d.amount) || 0), 0);

    if (!restaurants.has(String(order.restaurantId))) {
      const r = await Restaurant.findById(order.restaurantId)
        .select('name commissionPercent deliveryMarkupPercent').lean();
      restaurants.set(String(order.restaurantId), r || {});
    }
    const rest = restaurants.get(String(order.restaurantId));

    const agreement = await agreementAt(order.restaurantId, new Date(order.createdAt), agreementCache);
    const approx = !agreement;
    if (approx) uncertain++;

    const restPct = agreement
      ? Number(agreement.restaurantCommissionPercent) || 0
      : Number(rest.commissionPercent) || 0;
    const custPct = agreement ? Number(agreement.customerFeePercent) || 0 : 0;

    const foodBaseSom = (order.items || []).reduce(
      (s, it) => s + (Number(it.unitPrice) || 0) * (Number(it.quantity) || 0), 0,
    );

    const isCash = order.paymentMethod === 'cash';
    const f = computeOrderFinance({
      foodBaseTiyin: somToTiyin(foodBaseSom),
      deliveryFeeTiyin: somToTiyin(order.deliveryFee || 0),
      deliveryMarkupPercent: 0,
      customerFeePercent: custPct,
      restaurantCommissionPercent: restPct,
      paymentFeePercent: isCash ? 0 : (config.split.clickFeePercent || 0),
    });

    // Naqdda restoranga qarz emas, BIZGA komissiya qarz (manfiy)
    const correctDue = isCash
      ? -tiyinToSom(f.lokmaGrossCommission)
      : tiyinToSom(f.restaurantPayout);

    totalOld += oldDue;
    totalCorrect += correctDue;

    rows.push({
      orderId: String(order._id),
      restaurantId: String(order.restaurantId),
      restaurantName: order.restaurantName || rest.name || '',
      date: new Date(order.createdAt).toISOString().slice(0, 10),
      payment: order.paymentMethod || '',
      oldDue: som(oldDue),
      correctDue: som(correctDue),
      diff: som(correctDue - oldDue),
      approx,
    });
  }

  await mongoose.disconnect();

  if (asCsv) {
    console.log('orderId,restaurantId,restaurantName,date,payment,oldDue,correctDue,diff,approx');
    for (const r of rows) {
      console.log([r.orderId, r.restaurantId, `"${r.restaurantName}"`, r.date,
        r.payment, r.oldDue, r.correctDue, r.diff, r.approx ? 'taxminiy' : ''].join(','));
    }
    return;
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  ESKI HISOB-KITOB — SOLISHTIRMA HISOBOT');
  console.log('  ⚠ BAZA O‘ZGARTIRILMADI — faqat o‘qildi');
  console.log('═══════════════════════════════════════════════════════════\n');

  if (!rows.length) {
    console.log('Solishtiriladigan eski buyurtma topilmadi.\n');
    return;
  }

  // Restoran bo'yicha guruhlash
  const byRest = new Map();
  for (const r of rows) {
    if (!byRest.has(r.restaurantId)) {
      byRest.set(r.restaurantId, { name: r.restaurantName, old: 0, correct: 0, count: 0 });
    }
    const g = byRest.get(r.restaurantId);
    g.old += r.oldDue; g.correct += r.correctDue; g.count++;
  }

  console.log('RESTORANLAR BO‘YICHA:\n');
  console.log('  Restoran                     Buyurtma      Yozilgan       To‘g‘ri         Farq');
  console.log('  ' + '─'.repeat(78));
  for (const [, g] of byRest) {
    const diff = g.correct - g.old;
    const diffStr = (diff > 0 ? '+' : '') + fmt(diff);
    console.log(
      `  ${(g.name || '—').slice(0, 26).padEnd(26)} ${String(g.count).padStart(8)} `
      + `${fmt(g.old).padStart(13)} ${fmt(g.correct).padStart(13)} ${diffStr.padStart(12)}`,
    );
  }

  console.log('\n  ' + '─'.repeat(78));
  console.log(`  JAMI YOZILGAN QARZ   : ${fmt(totalOld)} so‘m`);
  console.log(`  JAMI TO‘G‘RI QARZ    : ${fmt(totalCorrect)} so‘m`);
  const diff = totalCorrect - totalOld;
  console.log(`  FARQ                 : ${(diff > 0 ? '+' : '') + fmt(diff)} so‘m`);
  console.log(`  Buyurtmalar          : ${rows.length} ta`);
  if (skippedRefunded) {
    console.log(`  Qaytarilgan (hisobga kirmadi): ${skippedRefunded} ta`);
  }
  if (uncertain) {
    console.log(`\n  ⚠ ${uncertain} ta buyurtmada o‘sha sanadagi shartnoma topilmadi —`);
    console.log('    ular restoranning joriy foizi bilan TAXMINIY hisoblandi.');
  }

  console.log('\n  Eng katta farqli 10 ta buyurtma:\n');
  const top = [...rows].sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff)).slice(0, 10);
  for (const r of top) {
    console.log(
      `    ${r.date}  ${r.orderId}  ${(r.restaurantName || '').slice(0, 18).padEnd(18)} `
      + `${fmt(r.oldDue).padStart(11)} → ${fmt(r.correctDue).padStart(11)}  `
      + `${(r.diff > 0 ? '+' : '') + fmt(r.diff)}${r.approx ? '  ?' : ''}`,
    );
  }

  console.log('\n  ─── KEYINGI QADAM ───');
  console.log('  Bu hisobot TAKLIF. Avtomatik tuzatish QILINMAYDI.');
  console.log('  Tuzatish uchun buxgalter har bir buyurtma bo‘yicha');
  console.log('  `type: adjustment` yozuvi yaratadi (kim, qachon, sabab');
  console.log('  va summalar bilan). Asl yozuvlar o‘zgarmaydi.\n');
}

main().catch((e) => {
  console.error('Xato:', e.message);
  process.exit(1);
});
