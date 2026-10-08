import { COMPLETABLE_STATUSES, CUSTOMER_ASK, planCustomerAsk } from './reminderRules.js';
import { orderLabel } from './orderNumber.js';
import { config } from '../config/index.js';
import { Order } from '../models/Order.js';
import { Restaurant } from '../models/Restaurant.js';
import { User } from '../models/User.js';
import { getIO } from '../sockets/io.js';
import { emitOrderToRestaurant } from './orderSocket.js';

const TG_API = `https://api.telegram.org/bot${config.telegramBotToken}`;

async function tg(method, body) {
  if (!config.telegramBotToken) return null;
  try {
    const res = await fetch(`${TG_API}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) console.error(`[delivery] ${method}: ${data.description}`);
    return data;
  } catch (e) {
    console.error(`[delivery] ${method}:`, e.message);
    return null;
  }
}

// So'rov oralig'i (qoidalar — reminderRules.js CUSTOMER_ASK): 1-marta (delivering: +20 daq,
// qabul qilingan buyurtma: qabuldan +60 daq), 2-marta +10 daq, 3-marta +30 daq
const INTERVALS = CUSTOMER_ASK.gapsMin;

const escHtml = (s = '') => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ===== 1. SO'ROV YUBORISH =====
async function askUser(order) {
  const user = await User.findById(order.userId).select('telegramId').lean();
  if (!user?.telegramId) return false;

  const n = order.deliveryCheck?.askedCount || 0;
  const prevAskedAt = order.deliveryCheck?.lastAskedAt || null;

  /*
   * Avval hisoblagich ATOMIK band qilinadi, keyin xabar yuboriladi: ikki jarayon
   * (yoki bir-biriga tegib ketgan ikki tekshiruv) bir vaqtda ishlasa ham mijozga
   * bitta so'rov boradi. Faol bo'lmagan yoki allaqachon tasdiqlangan buyurtmaga
   * umuman yuborilmaydi.
   */
  const claimed = await Order.findOneAndUpdate({
    _id: order._id,
    status: { $in: COMPLETABLE_STATUSES },
    'deliveryCheck.confirmed': { $ne: true },
    'deliveryCheck.askedCount': n === 0 ? { $not: { $gte: 1 } } : n,
  }, {
    $set: { 'deliveryCheck.askedCount': n + 1, 'deliveryCheck.lastAskedAt': new Date() },
  });
  if (!claimed) return false;

  const ref = `<b>${escHtml(order.restaurantName)}</b> · ${orderLabel(order)}`;
  const text = n === 0
    ? `🍽 ${ref}\n\nBuyurtmangizni qabul qildingizmi?`
    : `🔔 Eslatma\n\n${ref}\n\nBuyurtmangizni qabul qildingizmi?`;

  const res = await tg('sendMessage', {
    chat_id: user.telegramId,
    text,
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Ha, qabul qildim', callback_data: `dlv_got_${order._id}` },
        { text: '⏳ Kutyapman', callback_data: `dlv_not_${order._id}` },
      ]],
    },
  });

  if (res?.ok) return true;

  // Yuborilmadi (Telegram xatosi) — hisoblagich qaytariladi, keyingi tekshiruvda qayta uriniladi
  await Order.updateOne(
    { _id: order._id, 'deliveryCheck.askedCount': n + 1 },
    { $set: { 'deliveryCheck.askedCount': n, 'deliveryCheck.lastAskedAt': prevAskedAt } },
  ).catch(() => {});
  return false;
}

// ===== 2. VAQTI KELGANLARNI TEKSHIRISH =====
// Har 2 daqiqada ishlaydi.
export async function checkDeliveries(now = Date.now()) {
  if (!config.telegramBotToken) return { sent: 0 };

  let sent = 0;

  // Kuryer olib ketgan, hali tasdiqlanmagan, 3 martadan kam so'ralgan.
  // Faqat oxirgi 12 soat ichidagilar — eski buyurtmalar so'ralmaydi.
  const since = new Date(now - 12 * 60 * 60_000);
  const orders = await Order.find({
    status: 'delivering',
    createdAt: { $gte: since },
    'deliveryCheck.confirmed': false,
    'deliveryCheck.askedCount': { $lt: INTERVALS.length },
  }).limit(200);

  // 12 soatdan oshgan va tasdiqlanmagan buyurtmalarni avtomatik
  // yetkazilgan deb belgilaymiz — cheksiz osilib qolmasin.
  const stale = await Order.find({
    status: 'delivering', createdAt: { $lt: since },
  }).select('_id').lean();

  if (stale.length) {
    await Order.updateMany(
      { _id: { $in: stale.map((o) => o._id) } },
      { status: 'delivered', deliveredAt: new Date(), 'deliveryCheck.confirmed': true },
    );
    // Hisob-kitob — har biri uchun
    const { settleOrder } = await import('./billing.js');
    for (const o of stale) {
      await settleOrder(o._id).catch(() => {});
    }
  }

  /*
   * QABUL QILINGAN, lekin yetkazilgani belgilanmagan buyurtmalar (restoran
   * "Kuryerga topshirildi"ni bosmagan): qabuldan 1 soat o'tgach mijozdan so'raladi
   * (qoida — reminderRules.planCustomerAsk). `$ne: true` / `$not` — eski buyurtmalarda
   * deliveryCheck maydoni umuman bo'lmasligi mumkin (oddiy `false`/`$lt` ularni topmaydi).
   * Rejalashtirilgan buyurtma (ertangi tort) uchun scheduledFor ham hisobga olinadi.
   */
  const stuckSince = new Date(now - 24 * 60 * 60_000);
  const stuck = await Order.find({
    status: { $in: ['accepted', 'preparing', 'ready'] },
    fulfillment: 'delivery',
    userId: { $ne: null },
    $or: [{ createdAt: { $gte: stuckSince } }, { scheduledFor: { $gte: stuckSince } }],
    'deliveryCheck.confirmed': { $ne: true },
    'deliveryCheck.askedCount': { $not: { $gte: INTERVALS.length } },
  }).limit(200);

  for (const o of [...orders, ...stuck]) {
    try {
      if (planCustomerAsk(o, now).ask && await askUser(o)) sent++;
    } catch (e) {
      console.error(`[delivery] so'rov xatosi (${o._id}):`, e.message);
    }
  }
  return { sent, checked: orders.length + stuck.length };
}

// ===== 3. YAKUNLASH — MIJOZ, RESTORAN VA AVTOMATIK =====
/*
 * Buyurtmani "yetkazildi" qiladi, komissiyani hisoblaydi, real-time
 * yangilaydi va (bir marta) baho so'raydi.
 *
 * UCH YO'LDAN chaqiriladi — mantiq bir joyda:
 *   'customer'   — mijoz botda "✅ Oldim" (handleDeliveryResponse);
 *   'restaurant' — xodim eslatmaga "✅ Yakunlandi" (restaurantReminders.js);
 *   'auto'       — eslatmalarga javob bo'lmadi (restaurantReminders.js).
 *
 * ATOMIK: holat tekshiruvi va yozuv BITTA findOneAndUpdate'da
 * (kuryer oqimi courierDispatch.deliverShare bilan bir xil naqsh).
 * Avval holat alohida o'qilib, keyin saqlanardi — orada buyurtma
 * bekor qilinsa ham "yetkazildi" bo'lib, komissiya hisoblanardi
 * (mijoz bekor qilingan buyurtmada eski "Oldim"ni bossa — shunday
 * bo'lardi). Endi faqat faol holatdagi buyurtma yakunlanadi.
 * settleOrder o'zi ham takroriy hisobdan himoyalangan.
 *
 * @param {string|ObjectId} orderId
 * @param {'customer'|'restaurant'|'auto'} confirmedBy
 * @param {{ restaurantId?: string }} [opts] — berilsa, egalik ham filtrda
 * @returns {Promise<object|null>} yakunlangan buyurtma yoki null
 *   (topilmadi / allaqachon yakunlangan / bekor qilingan)
 */
// Ro'yxat services/reminderRules.js da (sof modul); mavjud importlar buzilmasin deb qayta eksport
export { COMPLETABLE_STATUSES };

export async function confirmOrderDelivered(orderId, confirmedBy = 'customer', { restaurantId } = {}) {
  const now = new Date();
  const filter = { _id: orderId, status: { $in: COMPLETABLE_STATUSES } };
  if (restaurantId) filter.restaurantId = restaurantId;

  const order = await Order.findOneAndUpdate(filter, {
    $set: {
      status: 'delivered',
      deliveredAt: now,
      'deliveryCheck.confirmed': true,
      'deliveryCheck.confirmedAt': now,
      'deliveryCheck.confirmedBy': confirmedBy,
    },
  }, { new: true });
  if (!order) return null;

  const { settleOrder } = await import('./billing.js');
  await settleOrder(order._id).catch((e) =>
    console.error('[billing] settleOrder:', e.message));

  const io = getIO();
  const payload = { orderId: String(order._id), status: 'delivered' };
  io?.to(`order:${order._id}`).emit('order:status', payload);
  if (order.userId) io?.to(`user:${order.userId}`).emit('order:status', payload);
  await emitOrderToRestaurant(io, 'order:update', order);
  io?.to('admin').emit('order:update', order);

  // Baho — bir marta (askRatingForOrder o'zi tekshiradi)
  await askRatingForOrder(order).catch(() => {});
  return order;
}

/** Mijoz yakunlagach restoran botidagi eslatma tugmalarini olib tashlaydi va kartani yangilaydi (xatosi jim) */
async function syncRestaurantBot(orderId) {
  try {
    // Dinamik import — restaurantReminders.js bu faylni import qiladi (aylanma bog'liqlik bo'lmasin)
    const { clearReminderButtons } = await import('./restaurantReminders.js');
    const { refreshOrderMessages } = await import('./restaurantBotOrders.js');
    await clearReminderButtons(orderId);
    await refreshOrderMessages(orderId);
  } catch (e) {
    console.error('[delivery] restoran boti yangilanmadi:', e.message);
  }
}

// ===== 4. MIJOZ JAVOBI =====
export async function handleDeliveryResponse(cq) {
  const data = cq.data || '';
  const m = data.match(/^dlv_(got|not)_(.+)$/);
  if (!m) return false;

  const [, action, orderId] = m;
  console.log(`[delivery] javob: ${action} · buyurtma ${orderId}`);

  const order = await Order.findById(orderId);
  if (!order) {
    await tg('answerCallbackQuery', {
      callback_query_id: cq.id, text: 'Buyurtma topilmadi', show_alert: true,
    });
    return true;
  }

  // Allaqachon tasdiqlangan bo'lsa — eski so'rovga qayta javob berilgan
  if (order.deliveryCheck?.confirmed || order.status === 'delivered') {
    await tg('answerCallbackQuery', {
      callback_query_id: cq.id,
      text: 'Bu buyurtma allaqachon yakunlangan',
      show_alert: true,
    });
    if (cq.message) {
      await tg('editMessageReplyMarkup', {
        chat_id: cq.message.chat.id,
        message_id: cq.message.message_id,
        reply_markup: { inline_keyboard: [] },
      });
    }
    return true;
  }

  // Eski buyurtmalarda deliveryCheck bo'lmasligi mumkin
  if (!order.deliveryCheck) {
    order.deliveryCheck = {
      askedCount: 0, lastAskedAt: null, confirmed: false,
      confirmedAt: null, reviewAsked: false, pendingRating: null,
    };
  }

  // Tugmalarni olib tashlaymiz (takror bosilmasin)
  if (cq.message) {
    await tg('editMessageReplyMarkup', {
      chat_id: cq.message.chat.id,
      message_id: cq.message.message_id,
      reply_markup: { inline_keyboard: [] },
    });
  }

  if (action === 'not') {
    const left = INTERVALS.length - order.deliveryCheck.askedCount;
    await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Tushunarli' });
    await tg('sendMessage', {
      chat_id: cq.from.id,
      text: left > 0
        ? '⏳ Yaxshi, biroz kutamiz va yana so‘raymiz.'
        : '⏳ Muammo bo‘lsa qo‘llab-quvvatlashga yozing.',
    });
    return true;
  }

  // === Ha, qabul qildim ===
  const done = await confirmOrderDelivered(order._id, 'customer');
  await tg('answerCallbackQuery', {
    callback_query_id: cq.id,
    text: done ? 'Rahmat!' : 'Bu buyurtma yakunlangan yoki bekor qilingan',
    show_alert: !done,
  });
  // Restoran botidagi "Yetkazdingizmi?" tugmalari va buyurtma kartasi yangilanadi (xodim ikki marta bosmasin)
  if (done) await syncRestaurantBot(done._id);
  return true;
}

// ===== 4. BAHO SO'RASH =====
async function askRating(chatId, order) {
  await tg('sendMessage', {
    chat_id: chatId,
    text:
      `🎉 Yoqimli ishtaha!\n\n<b>${order.restaurantName}</b> ga baho bering.\n` +
      '<i>Bu ixtiyoriy — xohlamasangiz o‘tkazib yuboring.</i>',
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '⭐', callback_data: `rate_1_${order._id}` },
          { text: '⭐⭐', callback_data: `rate_2_${order._id}` },
          { text: '⭐⭐⭐', callback_data: `rate_3_${order._id}` },
        ],
        [
          { text: '⭐⭐⭐⭐', callback_data: `rate_4_${order._id}` },
          { text: '⭐⭐⭐⭐⭐', callback_data: `rate_5_${order._id}` },
        ],
        [{ text: "O'tkazib yuborish", callback_data: `rate_skip_${order._id}` }],
      ],
    },
  });
}

/**
 * Restoran buyurtmani "yetkazildi" deb belgilaganda baho so'rash.
 *
 * Avval baho faqat bitta yo'l bilan so'ralardi: mijoz botdagi
 * "Oldim" tugmasini bosganda. Lekin odatda restoran o'zi
 * "Yetkazildi" ni bosadi — u holda buyurtma 'delivering' dan
 * chiqib ketadi, checkDeliveries uni boshqa ko'rmaydi va mijoz
 * hech qachon baho so'ralmaydi. Olib ketish (pickup) va zal
 * buyurtmalarida esa 'delivering' holati umuman bo'lmaydi.
 */
export async function askRatingForOrder(orderOrId) {
  if (!config.telegramBotToken) return false;

  const order = typeof orderOrId === 'object' && orderOrId?._id
    ? orderOrId
    : await Order.findById(orderOrId);
  if (!order) return false;

  // Zal buyurtmasida mijoz hisobi bo'lmaydi
  if (!order.userId) return false;

  if (!order.deliveryCheck) {
    order.deliveryCheck = {
      askedCount: 0, lastAskedAt: null, confirmed: false,
      confirmedAt: null, reviewAsked: false, pendingRating: null,
    };
  }

  // Ikki marta so'ramaymiz
  if (order.deliveryCheck.reviewAsked) return false;

  const user = await User.findById(order.userId).select('telegramId').lean();
  if (!user?.telegramId) return false;

  order.deliveryCheck.reviewAsked = true;
  order.deliveryCheck.confirmed = true;
  order.deliveryCheck.confirmedAt = order.deliveryCheck.confirmedAt || new Date();
  await order.save();

  await askRating(user.telegramId, order);
  return true;
}

// ===== 5. BAHO JAVOBI =====
export async function handleRatingResponse(cq) {
  const data = cq.data || '';
  const m = data.match(/^rate_(\d|skip)_(.+)$/);
  if (!m) return false;

  const [, value, orderId] = m;
  console.log(`[delivery] baho: ${value} · buyurtma ${orderId}`);

  const order = await Order.findById(orderId);
  if (!order) return true;
  if (!order.deliveryCheck) {
    order.deliveryCheck = {
      askedCount: 0, lastAskedAt: null, confirmed: true,
      confirmedAt: new Date(), reviewAsked: true, pendingRating: null,
    };
  }

  // Tugmalarni olib tashlaymiz
  if (cq.message) {
    await tg('editMessageReplyMarkup', {
      chat_id: cq.message.chat.id,
      message_id: cq.message.message_id,
      reply_markup: { inline_keyboard: [] },
    });
  }

  if (value === 'skip') {
    await tg('answerCallbackQuery', { callback_query_id: cq.id });
    await tg('sendMessage', {
      chat_id: cq.from.id,
      text: 'Yaxshi, rahmat! Yana buyurtma kutamiz 🍽',
    });
    return true;
  }

  const stars = Number(value);
  order.rating = stars;
  order.ratedAt = new Date();
  // Matn kutilmoqda — keyingi xabar izoh bo'ladi
  order.deliveryCheck.pendingRating = stars;
  await order.save();

  await tg('answerCallbackQuery', { callback_query_id: cq.id, text: `${stars} ⭐` });
  await tg('sendMessage', {
    chat_id: cq.from.id,
    text:
      `${'⭐'.repeat(stars)}\n\nRahmat! Izoh yozmoqchimisiz?\n` +
      '<i>Shu yerga yozing yoki o‘tkazib yuboring.</i>',
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[
        { text: "Izohsiz yuborish", callback_data: `cmt_skip_${order._id}` },
      ]],
    },
  });

  await recalcRestaurantRating(order.restaurantId);
  return true;
}

// ===== 6. IZOH MATNI =====
// Foydalanuvchi oddiy matn yozganda chaqiriladi.
export async function handleReviewText(telegramId, text) {
  const user = await User.findOne({ telegramId }).select('_id').lean();
  if (!user) return false;

  // Izoh kutilayotgan oxirgi buyurtma
  const order = await Order.findOne({
    userId: user._id,
    'deliveryCheck.pendingRating': { $ne: null },
  }).sort({ ratedAt: -1 });

  if (!order) return false;

  order.comment = text.slice(0, 500);
  order.deliveryCheck.pendingRating = null;
  await order.save();

  await tg('sendMessage', {
    chat_id: telegramId,
    text: '✅ Izohingiz uchun rahmat! Restoran sahifasida ko‘rinadi.',
  });
  return true;
}

// Izohsiz yuborish
export async function handleCommentSkip(cq) {
  const m = (cq.data || '').match(/^cmt_skip_(.+)$/);
  if (!m) return false;

  const order = await Order.findById(m[1]);
  if (order) {
    order.deliveryCheck.pendingRating = null;
    await order.save();
  }
  if (cq.message) {
    await tg('editMessageReplyMarkup', {
      chat_id: cq.message.chat.id,
      message_id: cq.message.message_id,
      reply_markup: { inline_keyboard: [] },
    });
  }
  await tg('answerCallbackQuery', { callback_query_id: cq.id });
  await tg('sendMessage', { chat_id: cq.from.id, text: 'Rahmat! Yana kutamiz 🍽' });
  return true;
}

// ===== 7. RESTORAN REYTINGINI QAYTA HISOBLASH =====
async function recalcRestaurantRating(restaurantId) {
  const stats = await Order.aggregate([
    { $match: { restaurantId, rating: { $gte: 1 } } },
    { $group: { _id: null, avg: { $avg: '$rating' }, count: { $sum: 1 } } },
  ]);
  if (!stats.length) return;

  await Restaurant.findByIdAndUpdate(restaurantId, {
    rating: Math.round(stats[0].avg * 10) / 10,
    reviewCount: stats[0].count,
  });
  getIO()?.to('admin').emit('restaurant:update', { _id: String(restaurantId) });
}
