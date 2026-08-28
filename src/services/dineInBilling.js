import { DineInConfig } from '../models/DineIn.js';
import { PromoBilling } from '../models/PromoBilling.js';
import { Ledger } from '../models/Ledger.js';
import { getSettings } from '../models/Settings.js';
import { getIO } from '../sockets/io.js';

/**
 * Dine-in obunasi va billingi.
 *
 * Mavjud PromoBilling modeli qayta ishlatiladi — yangi
 * jadval yaratilmadi. Farqi 'service' maydonida.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Obunani boshlaydi. Sinov muddati bo'lsa u ham hisobga
 * olinadi.
 */
export async function startDineInSubscription(restaurantId) {
  const cfg = await DineInConfig.findOne({ restaurantId });
  if (!cfg) return null;

  const settings = await getSettings();
  const tariff = settings.dineIn || {};
  const now = new Date();

  // Allaqachon boshlangan
  if (cfg.subscriptionStartedAt) return cfg;

  cfg.subscriptionStartedAt = now;
  cfg.dailyPrice = tariff.price || 99000;
  cfg.billingPeriod = tariff.billingPeriod || 'monthly';

  // Sinov muddati
  const trialDays = Number(tariff.trialDays) || 0;
  if (trialDays > 0) {
    cfg.trialEndsAt = new Date(now.getTime() + trialDays * DAY_MS);
    cfg.lastBilledAt = cfg.trialEndsAt;
  } else {
    cfg.lastBilledAt = now;
  }

  // Ulanish to'lovi
  const activationFee = Number(tariff.activationFee) || 0;
  if (activationFee > 0) {
    await PromoBilling.create({
      restaurantId,
      service: 'dinein',
      periodStart: now,
      periodEnd: now,
      amount: activationFee,
      status: 'unpaid',
      note: 'Ulanish to‘lovi',
    });
  }

  await cfg.save();
  return cfg;
}

/**
 * Kechikkan billing davrlarini yaratadi.
 * Sinov muddatida hisob yozilmaydi.
 */
async function billOne(cfg, now) {
  if (cfg.status !== 'active') return 0;
  if (!cfg.subscriptionStartedAt || !cfg.lastBilledAt) return 0;

  // Sinov davom etyaptimi
  if (cfg.trialEndsAt && now < cfg.trialEndsAt) return 0;

  const periodMs = cfg.billingPeriod === 'daily' ? DAY_MS : 30 * DAY_MS;
  const price = cfg.dailyPrice || 99000;

  let created = 0;
  let cursor = new Date(cfg.lastBilledAt);

  while (cursor.getTime() + periodMs <= now.getTime()) {
    const periodStart = new Date(cursor);
    const periodEnd = new Date(cursor.getTime() + periodMs);

    try {
      await PromoBilling.create({
        restaurantId: cfg.restaurantId,
        service: 'dinein',
        periodStart,
        periodEnd,
        amount: price,
        status: 'unpaid',
      });
      created++;
    } catch (e) {
      if (e.code !== 11000) throw e;   // takroriy davr
    }

    cursor = periodEnd;
  }

  if (created > 0) {
    cfg.lastBilledAt = cursor;
    await cfg.save();

    getIO()?.to('admin').emit('dinein:billing', {
      restaurantId: String(cfg.restaurantId),
      periods: created,
    });
  }

  return created;
}

/** Barcha faol obunalar uchun billing. */
export async function runDineInBilling() {
  const configs = await DineInConfig.find({ status: 'active' });
  const now = new Date();

  let total = 0;
  for (const cfg of configs) {
    try {
      total += await billOne(cfg, now);
    } catch (e) {
      console.error(`[dinein-billing] ${cfg.restaurantId}:`, e.message);
    }
  }

  if (total > 0) console.log(`[dinein-billing] ${total} ta davr`);
  return total;
}

/** Restoran Dine-in qarzi. */
export async function getDineInDebt(restaurantId) {
  const rows = await PromoBilling.aggregate([
    { $match: { restaurantId, service: 'dinein', status: 'unpaid' } },
    { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
  ]);

  return { debt: rows[0]?.total || 0, periods: rows[0]?.count || 0 };
}

/**
 * Buyurtmadan komissiya — sozlamada yoqilgan bo'lsa.
 * Buyurtma yakunlanganda chaqiriladi.
 */
export async function recordDineInCommission(order) {
  const settings = await getSettings();
  const percent = Number(settings.dineIn?.commissionPercent) || 0;
  if (percent <= 0) return 0;

  const commission = Math.round((order.total || 0) * percent / 100);
  if (commission <= 0) return 0;

  await Ledger.create({
    type: 'commission',
    amount: commission,
    restaurantId: order.restaurantId,
    orderId: order._id,
    meta: { note: `Dine-in komissiyasi ${percent}%`, service: 'dinein' },
  });

  return commission;
}
