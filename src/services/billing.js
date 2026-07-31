import { Ledger } from '../models/Ledger.js';
import { Restaurant } from '../models/Restaurant.js';
import { getSettings } from '../models/Settings.js';
import { getIO } from '../sockets/io.js';

/**
 * Hisob-kitob: komissiya, restoran ulushi, moliyaviy jurnal.
 */

/**
 * Restoran uchun komissiya sozlamalarini aniqlaydi.
 * Restoranda o'z qiymati bo'lsa u ustun, aks holda umumiy.
 */
export async function resolveCommission(restaurant) {
  const settings = await getSettings();

  const percent = restaurant.commissionPercent != null
    ? restaurant.commissionPercent
    : (settings.commissionPercent || 0);

  const mode = restaurant.commissionMode
    || (settings.commissionMode !== 'none' ? settings.commissionMode : 'deduct');

  return { percent, mode };
}

/**
 * Buyurtma summasidan komissiyani hisoblaydi.
 *
 * deduct — mijoz ko'rgan narxni to'laydi, komissiya restoran
 *          ulushidan yechiladi
 * markup — komissiya taom narxiga qo'shiladi, mijoz ko'proq to'laydi
 *
 * Komissiya faqat TAOMLAR summasidan olinadi. Yetkazish haqi va
 * xizmat haqi platformaga tegishli, restoranga bormaydi.
 */
export function calcCommission(subtotal, percent, mode) {
  const p = Number(percent) || 0;
  if (p <= 0) return { commission: 0, restaurantShare: subtotal, customerExtra: 0 };

  if (mode === 'markup') {
    // Mijoz qo'shimcha to'laydi, restoran to'liq oladi
    const extra = Math.round(subtotal * p / 100);
    return { commission: extra, restaurantShare: subtotal, customerExtra: extra };
  }

  // deduct — restoran ulushidan yechiladi
  const commission = Math.round(subtotal * p / 100);
  return { commission, restaurantShare: subtotal - commission, customerExtra: 0 };
}

/**
 * To'lov tasdiqlangandan keyin chaqiriladi.
 * Jurnalga yozadi va restoran balansini oshiradi.
 */
export async function recordPayment(order, provider, transactionId = null) {
  const restaurant = await Restaurant.findById(order.restaurantId);
  if (!restaurant) {
    console.error(`[billing] Restoran topilmadi: ${order.restaurantId}`);
    return null;
  }

  const { percent, mode } = await resolveCommission(restaurant);
  const { commission, restaurantShare } = calcCommission(order.subtotal, percent, mode);

  const meta = {
    orderTotal: order.total,
    commissionPercent: percent,
    commissionMode: mode,
  };

  // 1. Mijoz to'lovi — platforma hisobiga kirdi
  await Ledger.create({
    type: 'payment_in',
    amount: order.total,
    orderId: order._id,
    restaurantId: restaurant._id,
    userId: order.userId,
    provider,
    transactionId,
    meta,
  });

  // 2. Platforma komissiyasi
  if (commission > 0) {
    await Ledger.create({
      type: 'commission',
      amount: commission,
      orderId: order._id,
      restaurantId: restaurant._id,
      meta: { ...meta, note: `${percent}% (${mode})` },
    });
  }

  // 3. Restoranga qarz — buyurtma yetkazilgach to'lanadi
  await Ledger.create({
    type: 'restaurant_due',
    amount: restaurantShare,
    orderId: order._id,
    restaurantId: restaurant._id,
    meta,
  });

  // Balansni oshiramiz
  restaurant.balance = (restaurant.balance || 0) + restaurantShare;
  await restaurant.save();

  getIO()?.to('admin').emit('billing:update', {
    restaurantId: String(restaurant._id),
    balance: restaurant.balance,
  });

  return { commission, restaurantShare, percent, mode };
}

/**
 * Pul qaytarilganda — teskari yozuvlar.
 * Asl yozuvlar o'chirilmaydi, ustiga qaytarish yoziladi.
 */
export async function recordRefund(order, provider, transactionId = null) {
  const restaurant = await Restaurant.findById(order.restaurantId);
  if (!restaurant) return null;

  const { percent, mode } = await resolveCommission(restaurant);
  const { restaurantShare } = calcCommission(order.subtotal, percent, mode);

  await Ledger.create({
    type: 'refund',
    amount: -order.total,
    orderId: order._id,
    restaurantId: restaurant._id,
    userId: order.userId,
    provider,
    transactionId,
    meta: { orderTotal: order.total, note: 'Mijozga qaytarildi' },
  });

  // Restoran qarzini kamaytiramiz
  await Ledger.create({
    type: 'restaurant_due',
    amount: -restaurantShare,
    orderId: order._id,
    restaurantId: restaurant._id,
    meta: { note: 'Qaytarish sababli bekor qilindi' },
  });

  restaurant.balance = (restaurant.balance || 0) - restaurantShare;
  await restaurant.save();

  getIO()?.to('admin').emit('billing:update', {
    restaurantId: String(restaurant._id),
    balance: restaurant.balance,
  });

  return { refunded: order.total, restaurantShare };
}

/**
 * Restoranga pul o'tkazildi — admin qo'lda belgilaydi.
 */
export async function recordPayout(restaurantId, amount, adminId, note = '') {
  const restaurant = await Restaurant.findById(restaurantId);
  if (!restaurant) throw new Error('Restoran topilmadi');
  if (amount <= 0) throw new Error('Summa musbat bo\u2018lishi kerak');
  if (amount > restaurant.balance) {
    throw new Error(`Balansda yetarli mablag\u2018 yo\u2018q (${restaurant.balance} so\u2018m)`);
  }

  await Ledger.create({
    type: 'payout',
    amount: -amount,
    restaurantId,
    createdBy: adminId,
    meta: { note: note || 'Restoranga o\u2018tkazildi' },
  });

  restaurant.balance -= amount;
  restaurant.totalPaidOut = (restaurant.totalPaidOut || 0) + amount;
  await restaurant.save();

  getIO()?.to('admin').emit('billing:update', {
    restaurantId: String(restaurantId),
    balance: restaurant.balance,
  });

  return { balance: restaurant.balance, paidOut: amount };
}

/**
 * Restoran bo'yicha moliyaviy xulosa.
 */
export async function getRestaurantSummary(restaurantId, from, to) {
  const match = { restaurantId };
  if (from || to) {
    match.createdAt = {};
    if (from) match.createdAt.$gte = new Date(from);
    if (to) match.createdAt.$lte = new Date(to);
  }

  const rows = await Ledger.aggregate([
    { $match: match },
    { $group: { _id: '$type', total: { $sum: '$amount' }, count: { $sum: 1 } } },
  ]);

  const byType = Object.fromEntries(rows.map((r) => [r._id, r.total]));
  const restaurant = await Restaurant.findById(restaurantId)
    .select('name balance totalPaidOut commissionPercent commissionMode')
    .lean();

  return {
    restaurant,
    tushum: byType.payment_in || 0,        // mijozlar to'lovi
    komissiya: byType.commission || 0,     // platforma ulushi
    restoranUlushi: byType.restaurant_due || 0,
    tolangan: Math.abs(byType.payout || 0),
    qaytarilgan: Math.abs(byType.refund || 0),
    balans: restaurant?.balance || 0,      // hozir qarzimiz
  };
}
