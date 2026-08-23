import { DeliveryAssignment, CourierInvite, generateInviteToken } from '../models/DeliveryAssignment.js';
import { Courier } from '../models/Courier.js';
import { Order } from '../models/Order.js';
import { config } from '../config/index.js';
import { getIO } from '../sockets/io.js';

const TG_API = `https://api.telegram.org/bot${config.telegramBotToken}`;

/**
 * Bir buyurtmani bir nechta kuryerga BIR VAQTDA yuboradi.
 *
 * Har biriga ALOHIDA token (CourierInvite) yaratiladi — barchasi
 * BITTA DeliveryAssignment'ga ishora qiladi. Birinchi qabul
 * qilgan kuryer buyurtmani oladi (acceptInvite() da atomik
 * tekshiriladi), qolganlariga keyinroq ular o'z havolasini
 * ochganda "band qilindi" ko'rsatiladi.
 */
export async function dispatchToCouriers(orderId, courierIds) {
  const order = await Order.findById(orderId)
    .populate('restaurantId', 'name address lat lng')
    .lean();
  if (!order) throw new Error('Buyurtma topilmadi');

  const restaurant = order.restaurantId || {};
  const itemsSummary = (order.items || [])
    .map((i) => `${i.quantity}x ${i.name}`)
    .join(', ');

  const assignment = await DeliveryAssignment.create({
    orderId: order._id,
    restaurantId: restaurant._id || order.restaurantId,
    status: 'searching',
    deliverySnapshot: {
      addressLabel: order.address || '',
      lat: order.addressLat ?? null,
      lng: order.addressLng ?? null,
      addressNote: order.addressNote || '',
      customerPhone: order.phone || '',
      restaurantName: restaurant.name || '',
      restaurantAddress: restaurant.address || '',
      restaurantLat: restaurant.lat ?? null,
      restaurantLng: restaurant.lng ?? null,
      itemsSummary,
      total: order.total || 0,
    },
  });

  const couriers = await Courier.find({ _id: { $in: courierIds }, isActive: true }).lean();

  const invites = await Promise.all(couriers.map(async (courier) => {
    const token = generateInviteToken();
    const invite = await CourierInvite.create({
      assignmentId: assignment._id,
      courierId: courier._id,
      token,
    });

    await sendInviteMessage(courier, token, order.dineInNumber || String(order._id).slice(-6));
    return invite;
  }));

  return { assignment, invites, sentTo: couriers.length };
}

/**
 * Kuryerga Telegram orqali xabar + havola tugmasi yuboradi.
 *
 * `courierAppUrl` — kuryer sahifasi joylashgan domen
 * (config.courierAppUrl, .env dagi COURIER_APP_URL — masalan
 * https://kuryer.lokma.uz). Bu YANGI, ALOHIDA lokma-courier
 * loyihasining manzili.
 */
async function sendInviteMessage(courier, token, orderLabel) {
  if (!config.telegramBotToken || !courier.telegramChatId) return;

  const url = `${config.courierAppUrl}/t/${token}`;
  try {
    await fetch(`${TG_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: courier.telegramChatId,
        text: `\ud83d\udce6 Yangi buyurtma #${orderLabel}\n\nQabul qilish uchun quyidagi tugmani bosing. Birinchi bosgan kuryer buyurtmani oladi.`,
        reply_markup: {
          inline_keyboard: [[{ text: '\ud83d\udeb4 Buyurtmani ko\u2018rish', url }]],
        },
      }),
    });
  } catch (err) {
    console.error('[courier] Telegram xabar xatosi:', err.message);
  }
}

/**
 * TOKEN bo'yicha kuryerga ko'rsatiladigan holatni aniqlaydi.
 *
 * Qaytariladigan `view` qiymatlari:
 *   'offer'      — hali hech kim olmagan, qabul qilish mumkin
 *   'mine'       — SHU kuryer allaqachon qabul qilgan, yetkazish jarayonida
 *   'taken'      — BOSHQA kuryer olib ulgurgan
 *   'delivered'  — bu buyurtma allaqachon topshirilgan (shu kuryer tomonidan)
 *   'closed'     — buyurtma boshqa yo'l bilan yakunlangan/eskirgan
 *   'not_found'  — token noto'g'ri
 */
export async function getInviteView(token) {
  const invite = await CourierInvite.findOne({ token }).populate('courierId', 'name').lean();
  if (!invite) return { view: 'not_found' };

  const assignment = await DeliveryAssignment.findById(invite.assignmentId).lean();
  if (!assignment) return { view: 'not_found' };

  if (assignment.status === 'delivered') {
    return {
      view: invite.courierId._id.toString() === String(assignment.assignedCourierId) ? 'delivered' : 'closed',
      assignment,
    };
  }

  if (assignment.status === 'assigned') {
    const isMine = String(assignment.assignedCourierId) === String(invite.courierId._id);
    return { view: isMine ? 'mine' : 'taken', assignment, invite };
  }

  // status === 'searching' — hali hech kim olmagan
  return { view: 'offer', assignment, invite };
}

/**
 * Kuryer "Qabul qilaman" bosganda chaqiriladi.
 *
 * ATOMIK YOZUV — POYGA HOLATI (race condition) YECHIMI:
 * `findOneAndUpdate` bilan FILTR ichida `status: 'searching'`
 * shart qilib qo'yiladi. Agar ikkita kuryer AYNI BIR PAYTDA
 * "qabul qilaman" bossa, MongoDB ikkala so'rovni ham qabul
 * qiladi, lekin FAQAT BIRINCHISI filtrga mos keladi (chunki u
 * status'ni "searching"dan "assigned"ga o'zgartirgan payt
 * ikkinchisi endi "searching" holatini topa olmaydi — natija
 * null bo'ladi). Oddiy "avval o'qib, keyin yozish" (read-then-
 * write) usuli BU YERDA XAVFLI bo'lardi — ikkala so'rov ham
 * "hali bo'sh" deb o'qishi va ikkalasi ham o'ziga yozib qo'yishi
 * mumkin edi.
 */
export async function acceptInvite(token) {
  const invite = await CourierInvite.findOne({ token }).lean();
  if (!invite) return { ok: false, error: 'Havola topilmadi' };

  const won = await DeliveryAssignment.findOneAndUpdate(
    { _id: invite.assignmentId, status: 'searching' },   // ATOMIK SHART
    { status: 'assigned', assignedCourierId: invite.courierId, assignedAt: new Date() },
    { new: true },
  );

  if (!won) {
    // Kimdir bizdan oldin oldi — bu taklifni "yutqazdi" deb belgilaymiz
    await CourierInvite.updateOne({ token }, { status: 'lost', respondedAt: new Date() });
    return { ok: false, error: 'Bu buyurtmani boshqa kuryer allaqachon oldi' };
  }

  await CourierInvite.updateOne({ token }, { status: 'accepted', respondedAt: new Date() });

  // Boshqa takliflarni "lost" deb belgilaymiz (ular hali "pending" bo'lsa)
  await CourierInvite.updateMany(
    { assignmentId: invite.assignmentId, token: { $ne: token }, status: 'pending' },
    { status: 'lost', respondedAt: new Date() },
  );

  // Buyurtmaning o'z holatini ham yangilaymiz — restoran/admin panelda ko'rinsin
  await Order.findByIdAndUpdate(won.orderId, { status: 'delivering' });

  getIO()?.to('admin').emit('order:update', { _id: won.orderId, status: 'delivering' });
  getIO()?.to(`restaurant:${won.restaurantId}`).emit('order:update', { _id: won.orderId, status: 'delivering' });

  return { ok: true, assignment: won };
}

/** Kuryer "Topshirdim" bosib, "Ha" bilan tasdiqlaganda. */
export async function deliverInvite(token) {
  const invite = await CourierInvite.findOne({ token }).lean();
  if (!invite) return { ok: false, error: 'Havola topilmadi' };

  const assignment = await DeliveryAssignment.findOne({ _id: invite.assignmentId }).lean();
  if (!assignment) return { ok: false, error: 'Topshiriq topilmadi' };
  if (String(assignment.assignedCourierId) !== String(invite.courierId)) {
    return { ok: false, error: 'Bu buyurtma sizga tegishli emas' };
  }
  if (assignment.status === 'delivered') {
    return { ok: true, alreadyDelivered: true };
  }

  const updated = await DeliveryAssignment.findOneAndUpdate(
    { _id: assignment._id, status: 'assigned' },
    { status: 'delivered', deliveredAt: new Date() },
    { new: true },
  );
  if (!updated) return { ok: false, error: 'Holat allaqachon o\u2018zgargan' };

  await Order.findByIdAndUpdate(assignment.orderId, { status: 'delivered', deliveredAt: new Date() });
  await Courier.findByIdAndUpdate(invite.courierId, { $inc: { totalDeliveries: 1 } });

  getIO()?.to('admin').emit('order:update', { _id: assignment.orderId, status: 'delivered' });
  getIO()?.to(`restaurant:${assignment.restaurantId}`).emit('order:update', { _id: assignment.orderId, status: 'delivered' });

  return { ok: true, assignment: updated };
}
