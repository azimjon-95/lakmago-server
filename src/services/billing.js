import { Ledger } from '../models/Ledger.js';
import { Order } from '../models/Order.js';
import { Restaurant } from '../models/Restaurant.js';
import { getSettings } from '../models/Settings.js';
import { getIO } from '../sockets/io.js';

/**
 * Hisob-kitob tizimi.
 *
 * OQIM (Yandex Eda / Wolt / Uzum Tezkor modeli):
 *
 *   1. Mijoz to'laydi          → pul platformada, jurnalga yoziladi
 *   2. Restoran qabul qiladi   → hech nima o'zgarmaydi
 *   3. Buyurtma YETKAZILADI    → restoran ulushi balansga qo'shiladi
 *   4. Admin to'laydi          → balansdan yechiladi
 *
 *   Restoran rad etsa yoki bekor bo'lsa → pul mijozga qaytariladi,
 *   restoranga hech nima hisoblanmaydi.
 *
 * BALANS mantiqi:
 *   musbat  → biz restoranga qarzdormiz (karta to'lovlari)
 *   manfiy  → restoran bizga qarzdor (naqd to'lovlar komissiyasi)
 */

/** Restoran uchun komissiya sozlamalari. */
export async function resolveCommission(restaurant) {
  const settings = await getSettings();

  // Restoranda o'z qiymati bo'lsa u ustun. 0 ham to'g'ri qiymat —
  // ba'zi restoranlardan komissiya olinmaydi.
  const percent = restaurant.commissionPercent != null
    ? restaurant.commissionPercent
    : (settings.commissionPercent || 0);

  const mode = restaurant.commissionMode
    || (settings.commissionMode !== 'none' ? settings.commissionMode : 'deduct');

  return { percent, mode };
}

/**
 * Komissiyani hisoblaydi.
 * Faqat TAOMLAR summasidan olinadi — yetkazish va xizmat haqi
 * platformaga tegishli.
 */
export function calcCommission(subtotal, percent, mode) {
  const p = Number(percent) || 0;
  if (p <= 0) {
    return { commission: 0, restaurantShare: subtotal, customerExtra: 0 };
  }

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
 * 1-QADAM: mijoz to'ladi.
 * Faqat jurnalga yoziladi — balans HALI o'zgarmaydi.
 * Restoran buyurtmani bajarmagunicha pul "yo'lda" hisoblanadi.
 */
export async function recordPayment(order, provider, transactionId = null) {
  // Takroriy yozuvdan himoya
  const exists = await Ledger.findOne({ orderId: order._id, type: 'payment_in' });
  if (exists) return null;

  await Ledger.create({
    type: 'payment_in',
    amount: order.total,
    orderId: order._id,
    restaurantId: order.restaurantId,
    userId: order.userId,
    provider,
    transactionId,
    meta: { orderTotal: order.total, note: 'To‘lov qabul qilindi' },
  });

  getIO()?.to('admin').emit('billing:update', { orderId: String(order._id) });
  return { recorded: order.total };
}

/**
 * 2-QADAM: buyurtma YETKAZILDI — restoran ulushi hisoblanadi.
 *
 * Aynan shu paytda pul restoran balansiga qo'shiladi. Avval emas —
 * chunki buyurtma bekor bo'lishi mumkin.
 *
 * Naqd to'lovda: pul restoranda qolgan, shuning uchun komissiya
 * miqdorida restoran BIZGA qarzdor bo'ladi (balans manfiyga ketadi).
 */
export async function settleOrder(orderId) {
  const order = await Order.findById(orderId);
  if (!order) return null;

  // Takroriy hisob-kitobdan himoya
  const already = await Ledger.findOne({ orderId: order._id, type: 'restaurant_due' });
  if (already) return null;

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

  const isCash = order.paymentMethod === 'cash';

  // Komissiya yozuvi (bor bo'lsa)
  if (commission > 0) {
    await Ledger.create({
      type: 'commission',
      amount: commission,
      orderId: order._id,
      restaurantId: restaurant._id,
      meta: { ...meta, note: `${percent}% · ${mode}${isCash ? ' · naqd' : ''}` },
    });
  }

  if (isCash) {
    // NAQD: pul restoranda qoldi. Bizga faqat komissiya qarz.
    // Balans manfiyga ketadi — keyingi karta to'lovlaridan yopiladi.
    if (commission > 0) {
      await Ledger.create({
        type: 'restaurant_due',
        amount: -commission,
        orderId: order._id,
        restaurantId: restaurant._id,
        meta: { ...meta, note: 'Naqd to‘lov — komissiya qarzi' },
      });
      restaurant.balance = (restaurant.balance || 0) - commission;
    } else {
      // Komissiya yo'q — hech kim hech kimga qarzdor emas
      await Ledger.create({
        type: 'restaurant_due',
        amount: 0,
        orderId: order._id,
        restaurantId: restaurant._id,
        meta: { ...meta, note: 'Naqd to‘lov — komissiyasiz' },
      });
    }
  } else {
    // KARTA: pul bizda. Restoran ulushini balansga qo'shamiz.
    await Ledger.create({
      type: 'restaurant_due',
      amount: restaurantShare,
      orderId: order._id,
      restaurantId: restaurant._id,
      meta,
    });
    restaurant.balance = (restaurant.balance || 0) + restaurantShare;
  }

  restaurant.totalOrders = (restaurant.totalOrders || 0) + 1;
  await restaurant.save();

  // Mijozga bonus — buyurtma yetkazilgandan keyin
  if (order.userId) {
    const { grantBonus } = await import('./promotions.js');
    grantBonus(order.userId, restaurant._id, order.total)
      .catch((e) => console.error('[bonus]', e.message));
  }

  getIO()?.to('admin').emit('billing:update', {
    restaurantId: String(restaurant._id),
    balance: restaurant.balance,
  });

  return { commission, restaurantShare, percent, mode, isCash };
}

/**
 * Pul qaytarish — buyurtma bekor qilinganda yoki restoran rad etganda.
 * Asl yozuvlar o'chirilmaydi, teskari yozuv qo'shiladi.
 */
export async function recordRefund(order, provider, transactionId = null) {
  const exists = await Ledger.findOne({ orderId: order._id, type: 'refund' });
  if (exists) return null;

  await Ledger.create({
    type: 'refund',
    amount: -order.total,
    orderId: order._id,
    restaurantId: order.restaurantId,
    userId: order.userId,
    provider,
    transactionId,
    meta: { orderTotal: order.total, note: 'Mijozga qaytarildi' },
  });

  // Agar hisob-kitob qilingan bo'lsa — teskari yozamiz
  const settled = await Ledger.findOne({
    orderId: order._id, type: 'restaurant_due',
  });

  if (settled && settled.amount !== 0) {
    const restaurant = await Restaurant.findById(order.restaurantId);
    if (restaurant) {
      await Ledger.create({
        type: 'restaurant_due',
        amount: -settled.amount,
        orderId: order._id,
        restaurantId: restaurant._id,
        meta: { note: 'Qaytarish sababli bekor qilindi' },
      });
      restaurant.balance = (restaurant.balance || 0) - settled.amount;
      await restaurant.save();
    }
  }

  getIO()?.to('admin').emit('billing:update', {
    restaurantId: String(order.restaurantId),
  });

  return { refunded: order.total };
}

/** Restoranga pul o'tkazildi — admin qo'lda belgilaydi. */
export async function recordPayout(restaurantId, amount, adminId, note = '') {
  const restaurant = await Restaurant.findById(restaurantId);
  if (!restaurant) throw new Error('Restoran topilmadi');
  if (amount <= 0) throw new Error('Summa musbat bo‘lishi kerak');
  if (amount > restaurant.balance) {
    throw new Error(
      `Balansda yetarli emas. Hozir: ${restaurant.balance} so‘m`,
    );
  }

  // Mijozlarni jalb qilish qarzini ushlab qolamiz (sozlama yoqilgan bo'lsa).
  // Ikki marta yechilmasligi uchun PromoBilling yozuvlari 'paid'
  // bo'lib belgilanadi va Ledger bilan bog'lanadi.
  const { deductFromSettlement } = await import('./promoBilling.js');
  const deducted = await deductFromSettlement(restaurantId, amount);
  const payoutAmount = amount - deducted;

  if (payoutAmount > 0) {
    await Ledger.create({
      type: 'payout',
      amount: -payoutAmount,
      restaurantId,
      createdBy: adminId,
      meta: {
        note: note || 'Bank hisobiga o‘tkazildi',
        ...(deducted > 0 ? { promoDebtDeducted: deducted } : {}),
      },
    });
  }

  // Balansdan to'liq summa yechiladi (qarz + o'tkazma)
  restaurant.balance -= amount;
  restaurant.totalPaidOut = (restaurant.totalPaidOut || 0) + payoutAmount;
  await restaurant.save();

  getIO()?.to('admin').emit('billing:update', {
    restaurantId: String(restaurantId),
    balance: restaurant.balance,
  });

  return {
    balance: restaurant.balance,
    paidOut: payoutAmount,
    promoDebtDeducted: deducted,
  };
}

/*
 * Barcha restoranlar bo'yicha naqd/karta buyurtma soni —
 * LokmaGo admin paneli uchun (yagona so'rovda hammasi, N+1
 * so'rov muammosi bo'lmasin).
 */
export async function getAllRestaurantsOrderCounts(from, to) {
  const match = { status: 'delivered' };
  if (from || to) {
    match.updatedAt = {};
    if (from) match.updatedAt.$gte = new Date(from);
    if (to) match.updatedAt.$lte = new Date(to);
  }

  const rows = await Order.aggregate([
    { $match: match },
    {
      $group: {
        _id: {
          restaurantId: '$restaurantId',
          method: { $cond: [{ $eq: ['$paymentMethod', 'cash'] }, 'cash', 'card'] },
        },
        count: { $sum: 1 },
      },
    },
  ]);

  const byRestaurant = new Map();
  for (const r of rows) {
    const id = String(r._id.restaurantId);
    if (!byRestaurant.has(id)) byRestaurant.set(id, { cashCount: 0, cardCount: 0 });
    const bucket = byRestaurant.get(id);
    if (r._id.method === 'cash') bucket.cashCount = r.count;
    else bucket.cardCount = r.count;
  }
  return byRestaurant;
}

/** Restoran bo'yicha moliyaviy xulosa. */
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
    tushum: byType.payment_in || 0,
    komissiya: byType.commission || 0,
    restoranUlushi: byType.restaurant_due || 0,
    tolangan: Math.abs(byType.payout || 0),
    qaytarilgan: Math.abs(byType.refund || 0),
    balans: restaurant?.balance || 0,
  };
}

/*
 * ═══════════════════════════════════════════════════════════
 * RESTORAN O'ZI KO'RADIGAN HISOBOT
 *
 * Yuqoridagi getRestaurantSummary() LokmaGo admini uchun edi
 * (Ledger tur bo'yicha yig'indi). Bu yerdagilar esa RESTORAN
 * paneliga xos: "nechta buyurtma", "nechtasi naqd/karta",
 * "qachon qancha o'tkazildi" — savolga JAVOB shaklida.
 *
 * XAVFSIZLIK: bu funksiyalar restaurantId ni har doim
 * controller orqali (auth token'dan, rid(req)) oladi —
 * so'rovdan emas. Restoran boshqa restoran ID'sini yozib
 * kira olmasligi shu yerda emas, controller darajasida
 * ta'minlanadi (controllers/restaurantBilling.js).
 * ═══════════════════════════════════════════════════════════
 */

/**
 * Sana oralig'ini "kun" chegaralariga aylantiradi.
 *
 * `from`/`to` berilmasa — BUGUN (restoran o'z mahalliy vaqtida
 * kiritadi, server esa UTC bilan ishlaydi; frontend allaqachon
 * to'g'ri ISO sanalarni yuboradi, bu yerda faqat standart
 * qiymat qo'yiladi).
 */
function dayRange(from, to) {
  const start = from ? new Date(from) : new Date();
  const end = to ? new Date(to) : new Date();
  if (!from) start.setHours(0, 0, 0, 0);
  if (!to) end.setHours(23, 59, 59, 999);
  return { start, end };
}

/**
 * Restoran uchun buyurtma statistikasi: jami, naqd, karta —
 * SON va SUMMA bilan. Faqat YAKUNLANGAN (yetkazilgan/topshirilgan)
 * buyurtmalar hisoblanadi — bekor qilinganlar kirmaydi, chunki
 * ularga hech qanday pul harakati bo'lmagan.
 */
export async function getRestaurantOrderStats(restaurantId, from, to) {
  const { start, end } = dayRange(from, to);

  /*
   * Faqat 'delivered' — Order modelidagi YAGONA yakunlangan
   * holat (models/Order.js). 'completed' bu sxemada UMUMAN
   * mavjud emas — settleOrder() ham faqat shu holatga
   * o'tishda chaqiriladi (controllers/restaurantPanel.js).
   */
  const rows = await Order.aggregate([
    {
      $match: {
        restaurantId,
        status: 'delivered',
        updatedAt: { $gte: start, $lte: end },
      },
    },
    {
      $group: {
        _id: { $cond: [{ $eq: ['$paymentMethod', 'cash'] }, 'cash', 'card'] },
        count: { $sum: 1 },
        total: { $sum: '$total' },
      },
    },
  ]);

  const cash = rows.find((r) => r._id === 'cash') || { count: 0, total: 0 };
  const card = rows.find((r) => r._id === 'card') || { count: 0, total: 0 };

  return {
    from: start,
    to: end,
    ordersTotal: cash.count + card.count,
    cash: { count: cash.count, amount: cash.total },
    card: { count: card.count, amount: card.total },
  };
}

/**
 * Kunlik moliyaviy jadval — "qachon qancha o'tkazildi" savoliga
 * javob. Har kun uchun: shu kunda yozilgan tushum, komissiya,
 * o'tkazma (payout), va O'SHA KUN OXIRIDAGI balans.
 *
 * Balans oxirgi yozuv qiymatidan olinadi (Ledger yozuvlari
 * xronologik ketma-ketlikda kelgani uchun kunning so'nggi
 * o'zgarishi = kun oxiridagi holat).
 */
export async function getRestaurantDailyLedger(restaurantId, from, to) {
  const { start, end } = dayRange(from, to);

  const rows = await Ledger.aggregate([
    { $match: { restaurantId, createdAt: { $gte: start, $lte: end } } },
    {
      $group: {
        _id: {
          day: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          type: '$type',
        },
        total: { $sum: '$amount' },
        count: { $sum: 1 },
      },
    },
    { $sort: { '_id.day': 1 } },
  ]);

  const byDay = new Map();
  for (const r of rows) {
    const day = r._id.day;
    if (!byDay.has(day)) {
      byDay.set(day, {
        day,
        tushum: 0, komissiya: 0, restoranUlushi: 0, tolangan: 0, qaytarilgan: 0,
      });
    }
    const bucket = byDay.get(day);
    if (r._id.type === 'payment_in') bucket.tushum = r.total;
    if (r._id.type === 'commission') bucket.komissiya = r.total;
    if (r._id.type === 'restaurant_due') bucket.restoranUlushi = r.total;
    if (r._id.type === 'payout') bucket.tolangan = Math.abs(r.total);
    if (r._id.type === 'refund') bucket.qaytarilgan = Math.abs(r.total);
  }

  return [...byDay.values()].sort((a, b) => b.day.localeCompare(a.day));
}

/**
 * Karta orqali kelgan, lekin HALI restoranga o'tkazilmagan
 * summa — "karta orqali to'langan pullarni Lokma restoran
 * hisobiga o'tqazib berdimi" savoliga to'g'ridan-to'g'ri javob.
 *
 * Bu Restaurant.balance bilan BIR XIL EMAS: balans naqd
 * komissiya qarzini ham o'z ichiga oladi (manfiy tomonga
 * suradi). Bu yerda esa faqat "karta orqali kelib, hali
 * o'tkazilmagan" qismi ajratib ko'rsatiladi — restoran
 * "menga qachon pul kelishi kerak" deb so'raganda aniq
 * javob berish uchun.
 */
export async function getRestaurantPendingPayout(restaurantId) {
  const restaurant = await Restaurant.findById(restaurantId)
    .select('balance totalPaidOut')
    .lean();

  return {
    // Balans musbat bo'lsa — LokmaGo restoranga qarzdor (kelishi
    // kerak bo'lgan pul). Manfiy bo'lsa — restoran LokmaGoga
    // qarzdor (naqd buyurtmalar komissiyasi hali ushlanmagan).
    balance: restaurant?.balance || 0,
    pendingToReceive: Math.max(0, restaurant?.balance || 0),
    owedToLokma: Math.max(0, -(restaurant?.balance || 0)),
    totalPaidOutSoFar: restaurant?.totalPaidOut || 0,
  };
}
