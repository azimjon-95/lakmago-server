import { PromoSubscription, PromoBilling, PromoTariffLog } from '../models/PromoBilling.js';
import { Promotion } from '../models/Promotion.js';
import { AdCampaign } from '../models/AdCampaign.js';
import { Ledger } from '../models/Ledger.js';
import { getSettings } from '../models/Settings.js';
import { getIO } from '../sockets/io.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Mijozlarni jalb qilish xizmati billingi.
 *
 * Qoidalar:
 *  • Aksiya YOKI reklama yoqilsa obuna boshlanadi
 *  • Ikkalasi yoqilsa ham BITTA narx (30 000 emas, 15 000)
 *  • Bonus narxni oshirmaydi
 *  • Har 24 soat — aniq davr, calendar day emas
 *  • Har davr alohida yozuv → qarz aniq hisoblanadi
 */

/** Restoranda faol aksiya yoki reklama bormi. */
export async function hasActivePromoService(restaurantId) {
  const now = new Date();

  const [promo, ad] = await Promise.all([
    Promotion.exists({
      restaurantId, isActive: true,
      startsAt: { $lte: now }, endsAt: { $gte: now },
    }),
    AdCampaign.exists({
      restaurantId, isActive: true,
      startsAt: { $lte: now }, endsAt: { $gte: now },
    }),
  ]);

  return Boolean(promo || ad);
}

/**
 * Obunani boshlaydi yoki mavjudini qaytaradi.
 * Aksiya/reklama yoqilganda chaqiriladi.
 */
export async function ensureSubscription(restaurantId) {
  let sub = await PromoSubscription.findOne({ restaurantId });
  if (sub) {
    // To'xtatilgan bo'lsa qayta yoqamiz
    if (sub.status === 'expired') {
      sub.status = 'active';
      sub.startedAt = new Date();
      sub.lastBilledAt = new Date();
      await sub.save();
    }
    return sub;
  }

  const settings = await getSettings();
  const now = new Date();

  sub = await PromoSubscription.create({
    restaurantId,
    status: 'active',
    startedAt: now,
    lastBilledAt: now,
    dailyPrice: settings.promoDailyPrice || 15000,
  });

  return sub;
}

/**
 * Bir restoran uchun kechikkan billing davrlarini yaratadi.
 *
 * Server o'chib qolgan bo'lsa ham barcha davrlar yoziladi —
 * qarz yo'qolmaydi.
 */
async function billRestaurant(sub, now = new Date()) {
  // To'xtatilgan yoki tugagan obunaga hisob yozilmaydi
  if (sub.status !== 'active') return 0;

  // Xizmat hali ishlatilyaptimi
  const stillActive = await hasActivePromoService(sub.restaurantId);
  if (!stillActive) {
    // Aksiya va reklama o'chirilgan — obuna tugadi
    sub.status = 'expired';
    await sub.save();
    return 0;
  }

  let created = 0;
  let cursor = new Date(sub.lastBilledAt);

  // Har 24 soatlik davr uchun alohida yozuv
  while (cursor.getTime() + DAY_MS <= now.getTime()) {
    const periodStart = new Date(cursor);
    const periodEnd = new Date(cursor.getTime() + DAY_MS);

    try {
      await PromoBilling.create({
        restaurantId: sub.restaurantId,
        periodStart,
        periodEnd,
        amount: sub.dailyPrice,
        status: 'unpaid',
      });
      created++;
    } catch (e) {
      // Unique indeks — bu davr allaqachon yozilgan
      if (e.code !== 11000) throw e;
    }

    cursor = periodEnd;
  }

  if (created > 0) {
    sub.lastBilledAt = cursor;
    await sub.save();

    getIO()?.to('admin').emit('promo:billing', {
      restaurantId: String(sub.restaurantId),
      periods: created,
    });
  }

  return created;
}

/**
 * Barcha faol obunalar uchun billing.
 * Soatiga bir marta ishga tushadi — 24 soatlik davrni
 * o'tkazib yubormaslik uchun yetarli.
 */
export async function runBillingCycle() {
  const subs = await PromoSubscription.find({ status: 'active' });
  const now = new Date();

  let total = 0;
  for (const sub of subs) {
    try {
      total += await billRestaurant(sub, now);
    } catch (e) {
      console.error(`[promo-billing] ${sub.restaurantId}:`, e.message);
    }
  }

  if (total > 0) {
    console.log(`[promo-billing] ${total} ta davr hisoblandi`);
  }
  return total;
}

/**
 * Restoran qarzi — to'lanmagan davrlar yig'indisi.
 */
export async function getDebt(restaurantId) {
  const rows = await PromoBilling.aggregate([
    { $match: { restaurantId, service: 'promo', status: 'unpaid' } },
    { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
  ]);

  return {
    debt: rows[0]?.total || 0,
    periods: rows[0]?.count || 0,
  };
}

/**
 * Qarzni to'langan deb belgilaydi.
 *
 * Ikki marta yechilmasligi uchun: faqat 'unpaid' davrlar
 * yangilanadi va Ledger yozuvi bilan bog'lanadi.
 *
 * @param {string} via - 'manual' yoki 'settlement'
 */
export async function markDebtPaid(restaurantId, adminId, via = 'manual', maxAmount = null, service = 'promo') {
  const unpaid = await PromoBilling.find({
    restaurantId, service, status: 'unpaid',
  }).sort({ periodStart: 1 });

  if (unpaid.length === 0) return { paid: 0, periods: 0 };

  // Cheklangan summa bo'lsa (settlement) — eskisidan boshlab yopamiz
  let remaining = maxAmount ?? Infinity;
  const toPay = [];

  for (const b of unpaid) {
    if (b.amount > remaining) break;
    toPay.push(b);
    remaining -= b.amount;
  }

  if (toPay.length === 0) return { paid: 0, periods: 0 };

  const total = toPay.reduce((s, b) => s + b.amount, 0);
  const now = new Date();

  // Moliyaviy jurnalga yozamiz
  const ledger = await Ledger.create({
    type: 'adjustment',
    amount: total,
    restaurantId,
    createdBy: adminId || null,
    meta: {
      note: via === 'settlement'
        ? 'Mijozlarni jalb qilish qarzi — delivery tushumidan'
        : 'Mijozlarni jalb qilish qarzi — qo\u2018lda to\u2018landi',
    },
  });

  await PromoBilling.updateMany(
    { _id: { $in: toPay.map((b) => b._id) } },
    {
      status: 'paid',
      paidAt: now,
      paidVia: via,
      confirmedBy: adminId || null,
      ledgerId: ledger._id,
      $set: {},
    },
  );

  // paidAmount har yozuvga alohida
  for (const b of toPay) {
    await PromoBilling.updateOne({ _id: b._id }, { paidAmount: b.amount });
  }

  getIO()?.to('admin').emit('promo:billing', {
    restaurantId: String(restaurantId),
    paid: total,
  });

  return { paid: total, periods: toPay.length };
}

/** Tarifni o'zgartiradi. Eski yozuvlar qayta hisoblanmaydi. */
export async function changeTariff(newPrice, adminId, adminName) {
  const settings = await getSettings();
  const oldPrice = settings.promoDailyPrice || 15000;

  if (oldPrice === newPrice) return { changed: false };

  settings.promoDailyPrice = newPrice;
  await settings.save();

  await PromoTariffLog.create({
    oldPrice, newPrice,
    changedBy: adminId || null,
    changedByName: adminName || '',
  });

  // Faol obunalarga YANGI narx — keyingi davrlardan
  await PromoSubscription.updateMany(
    { status: 'active' },
    { dailyPrice: newPrice },
  );

  return { changed: true, oldPrice, newPrice };
}

/**
 * Delivery to'lovidan qarzni ushlab qolish.
 * recordPayout ichida chaqiriladi.
 *
 * @returns {number} ushlab qolingan summa
 */
export async function deductFromSettlement(restaurantId, availableAmount) {
  const settings = await getSettings();
  if (!settings.promoDeductFromSettlement) return 0;

  const { debt } = await getDebt(restaurantId);
  if (debt <= 0) return 0;

  // Mavjud summadan oshmasin
  const canPay = Math.min(debt, availableAmount);
  if (canPay <= 0) return 0;

  const result = await markDebtPaid(restaurantId, null, 'settlement', canPay);
  return result.paid;
}
