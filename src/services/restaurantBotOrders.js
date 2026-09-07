import { Order } from '../models/Order.js';
import { RestaurantTelegramStaff } from '../models/RestaurantTelegramStaff.js';
import { RestaurantBotMessage } from '../models/RestaurantBotMessage.js';
import { orderLabel } from './orderNumber.js';
import {
  isRestaurantBotEnabled,
  sendToStaff,
  editStaffMessage,
  answerCallback,
} from './restaurantBot.js';

/*
 * ═══════════════════════════════════════════════════════════
 * RESTORAN BOTI — BUYURTMALAR
 * ═══════════════════════════════════════════════════════════
 *
 * Bu fayl buyurtmani xodimlarga yuborish va tugmalar orqali
 * status o'zgartirish bilan shug'ullanadi.
 *
 * ─── ASOSIY QOIDA ───
 * Bu yerda buyurtma mantig'i YO'Q. Status o'zgartirish
 * services/orderFlow.js dagi changeOrderStatus() orqali
 * bajariladi — panel ham aynan shuni ishlatadi. Shu sababli
 * ikkita interfeys hech qachon bir-biridan farq qilmaydi
 * (TZ 23-band).
 */

const som = (n) => new Intl.NumberFormat('uz-UZ').format(Math.round(n || 0));

/*
 * Rad etish sabablari.
 *
 * Nima uchun erkin matn emas: xodim telefonда tez harakat
 * qiladi, matn yozish uchun vaqti yo'q. Tayyor tugmalar
 * bir bosishda tanlanadi va statistikada guruhlanadi —
 * "eng ko'p qaysi sabab" degan savolga javob beradi.
 */
const REJECT_REASONS = {
  out: 'Taom tugagan',
  busy: 'Oshxona band',
  far: 'Manzil juda uzoq',
  closing: 'Yopilish vaqti',
  other: 'Boshqa sabab',
};

/*
 * ═══ XABAR MATNI ═══
 *
 * Har doim BITTA joyda quriladi — status o'zgarganda ham shu
 * funksiya chaqiriladi. Shuning uchun xabar hech qachon
 * eskirmaydi va formatlar bir-biridan farq qilmaydi.
 */
function buildOrderText(order, extra = '') {
  const lines = [];

  const label = orderLabel(order);
  const isPickup = order.fulfillment === 'pickup';

  lines.push(`🔔 <b>BUYURTMA ${label}</b>`);
  lines.push('');

  for (const it of order.items || []) {
    const sum = (it.unitPrice || 0) * (it.quantity || 0);
    lines.push(`${it.quantity}× ${it.name} — ${som(sum)} so‘m`);
    if (it.note) lines.push(`   <i>${it.note}</i>`);
  }

  lines.push('');
  lines.push(`🍽 Taomlar: ${som(order.subtotal)} so‘m`);
  if (order.deliveryFee > 0) lines.push(`🚴 Yetkazish: ${som(order.deliveryFee)} so‘m`);
  if (order.bonusUsed > 0) lines.push(`🎁 Bonus: −${som(order.bonusUsed)} so‘m`);
  lines.push(`💰 <b>Jami: ${som(order.total)} so‘m</b>`);

  const paid = order.isPaid ? 'To‘langan' : 'To‘lanmagan';
  const method = order.paymentMethod === 'cash' ? '💵 Naqd' : '💳 Karta';
  lines.push(`${method} · ${paid}`);

  lines.push('');
  if (isPickup) {
    lines.push('🏃 <b>Mijoz o‘zi olib ketadi</b>');
  } else {
    lines.push(`📍 ${order.address || '—'}`);
  }
  if (order.phone) lines.push(`📞 ${order.phone}`);
  if (order.addressNote) lines.push(`📝 ${order.addressNote}`);

  if (extra) {
    lines.push('');
    lines.push(extra);
  }

  return lines.join('\n');
}

/*
 * ═══ TUGMALAR ═══
 *
 * Tugmalar joriy statusga qarab quriladi. Shu sababli xodim
 * mantiqan mumkin bo'lmagan amalni bosa olmaydi — masalan
 * qabul qilinmagan buyurtmani "Tayyor" deb belgilay olmaydi.
 */
function buildKeyboard(order) {
  const id = String(order._id);

  switch (order.status) {
    case 'pending':
      return {
        inline_keyboard: [
          [{ text: '✅ Qabul qilish', callback_data: `o:accept:${id}` }],
          [{ text: '❌ Rad etish', callback_data: `o:rejectmenu:${id}` }],
        ],
      };
    case 'accepted':
      return { inline_keyboard: [[{ text: '🍳 Tayyorlanmoqda', callback_data: `o:preparing:${id}` }]] };
    case 'preparing':
      return { inline_keyboard: [[{ text: '✅ Tayyor', callback_data: `o:ready:${id}` }]] };
    case 'ready':
      // Olib ketishda kuryer yo'q — tugma ham kerak emas
      if (order.fulfillment === 'pickup') return null;
      return { inline_keyboard: [[{ text: '🚴 Yo‘lga chiqdi', callback_data: `o:delivering:${id}` }]] };
    default:
      return null;
  }
}

function statusLine(order, actorName = '') {
  const by = actorName ? ` · ${actorName}` : '';
  switch (order.status) {
    case 'accepted': return `✅ <b>Qabul qilindi</b>${by}`;
    case 'preparing': return `🍳 <b>Tayyorlanmoqda</b>${by}`;
    case 'ready': return `✅ <b>Tayyor</b>${by}`;
    case 'delivering': return `🚴 <b>Yo‘lga chiqdi</b>${by}`;
    case 'delivered': return '✅ <b>Yetkazildi</b>';
    case 'cancelled': return `❌ <b>Bekor qilindi</b>${by}`;
    default: return '';
  }
}

/** Shu restoranning ulangan, faol xodimlari. */
async function activeStaff(restaurantId) {
  return RestaurantTelegramStaff.find({
    restaurantId,
    isActive: true,
    telegramUserId: { $ne: null },
  }).select('telegramUserId firstName username').lean();
}

/*
 * ═══ YANGI BUYURTMA ═══
 *
 * DINE-IN YUBORILMAYDI: zalda ofitsiant va oshxona ekrani
 * bor, ular buyurtmani allaqachon ko'rib turishadi. Botga
 * yuborish shovqin qo'shardi.
 */
export async function notifyNewOrder(orderId) {
  if (!isRestaurantBotEnabled()) return;

  const order = await Order.findById(orderId).lean();
  if (!order) return;
  if (order.fulfillment === 'dinein') return;

  /*
   * To'lanmagan karta buyurtmasi yuborilmaydi. U pul kelgach
   * qayta chaqiriladi (paymentRecord.js). Aks holda restoran
   * to'lanmagan buyurtmani tayyorlab qo'yardi.
   */
  if (order.status === 'awaiting_payment') return;

  const staff = await activeStaff(order.restaurantId);
  if (!staff.length) return;

  const text = buildOrderText(order);
  const keyboard = buildKeyboard(order);

  /*
   * Parallel yuboriladi — 5 ta xodim bo'lsa ketma-ket yuborish
   * bir necha soniya olardi va birinchi xodim oxirgisidan
   * ancha oldin ko'rardi.
   */
  await Promise.all(staff.map(async (s) => {
    const res = await sendToStaff(s.telegramUserId, text, keyboard);
    const messageId = res?.result?.message_id;
    if (!messageId) return;
    await RestaurantBotMessage.create({
      orderId: order._id,
      telegramUserId: s.telegramUserId,
      messageId,
    }).catch(() => {});
  }));
}

/*
 * ═══ BARCHA XABARLARNI YANGILASH ═══
 *
 * Status QAYERDAN o'zgarganidan qat'i nazar chaqiriladi:
 * botdan ham, paneldan ham. Shu sababli TZ 12-bandidagi
 * ikki tomonlama sinxronizatsiya avtomatik ta'minlanadi —
 * paneldan status o'zgartirilsa, xodimlarning Telegram
 * xabari ham darhol yangilanadi.
 */
export async function refreshOrderMessages(orderId, actorName = '') {
  if (!isRestaurantBotEnabled()) return;

  const order = await Order.findById(orderId).lean();
  if (!order || order.fulfillment === 'dinein') return;

  const msgs = await RestaurantBotMessage.find({ orderId, kind: 'order' }).lean();
  if (!msgs.length) return;

  const text = buildOrderText(order, statusLine(order, actorName));
  const keyboard = buildKeyboard(order);

  await Promise.all(msgs.map((m) =>
    editStaffMessage(m.telegramUserId, m.messageId, text, keyboard)));
}

/*
 * ═══ TUGMA BOSILDI ═══
 */
export async function handleOrderCallback(cq) {
  const parts = String(cq.data || '').split(':');
  const action = parts[1];
  const orderId = parts[2];
  const tgUserId = String(cq.from?.id);

  /*
   * XAVFSIZLIK (TZ 20-band): xodim FAQAT o'z restorani
   * buyurtmasiga tegishi mumkin. restaurantId Telegram
   * xabaridan emas, BAZADAN olinadi — callback_data ni
   * o'zgartirib boshqa restoran buyurtmasini ochib bo'lmaydi.
   */
  const staff = await RestaurantTelegramStaff.findOne({
    telegramUserId: tgUserId,
    isActive: true,
  }).lean();

  if (!staff) {
    await answerCallback(cq.id, 'Sizning akkauntingiz ulanmagan');
    return;
  }

  const actorName = staff.firstName || staff.username;

  // Rad etish sabablari menyusi
  if (action === 'rejectmenu') {
    await answerCallback(cq.id);
    await editStaffMessage(
      tgUserId,
      cq.message.message_id,
      cq.message.text ? `${cq.message.text}\n\n❓ <b>Rad etish sababi:</b>` : 'Rad etish sababi:',
      {
        inline_keyboard: [
          ...Object.entries(REJECT_REASONS).map(([key, label]) => (
            [{ text: label, callback_data: `o:reject:${orderId}:${key}` }]
          )),
          [{ text: '‹ Ortga', callback_data: `o:back:${orderId}` }],
        ],
      },
    );
    return;
  }

  if (action === 'back') {
    await answerCallback(cq.id);
    await refreshOrderMessages(orderId);
    return;
  }

  const statusMap = {
    accept: 'accepted',
    preparing: 'preparing',
    ready: 'ready',
    delivering: 'delivering',
    reject: 'cancelled',
  };
  const status = statusMap[action];
  if (!status) {
    await answerCallback(cq.id);
    return;
  }

  try {
    const { changeOrderStatus } = await import('./orderFlow.js');
    await changeOrderStatus({
      orderId,
      restaurantId: staff.restaurantId,
      status,
      actorName,
    });

    if (action === 'reject') {
      const reasonKey = parts[3];
      const reason = REJECT_REASONS[reasonKey] || REJECT_REASONS.other;
      await Order.updateOne({ _id: orderId }, { cancelReason: reason });
    }

    await answerCallback(cq.id, 'Bajarildi');

    await RestaurantTelegramStaff.updateOne(
      { _id: staff._id },
      { lastActionAt: new Date() },
    );

    /*
     * Xabarlar changeOrderStatus ichidan ham yangilanadi
     * (orderFlow -> refreshOrderMessages). Bu yerda qayta
     * chaqirilmaydi — ikki marta tahrirlash Telegram'da
     * "message is not modified" xatosini beradi.
     */
  } catch (e) {
    /*
     * RACE_LOST — boshqa xodim ulgurdi (TZ 18-band).
     * Bu XATO EMAS, odatiy holat: uch xodimga bir xabar
     * borgan va ikkitasi bir vaqtda bosgan.
     */
    if (e.code === 'RACE_LOST' || e.code === 'WRONG_STATE') {
      await answerCallback(cq.id, 'Buyurtmani boshqa xodim allaqachon o‘zgartirdi');
      await refreshOrderMessages(orderId);
      return;
    }
    console.error('[restaurantBot] callback:', e.message);
    await answerCallback(cq.id, 'Xatolik yuz berdi');
  }
}

/*
 * ═══════════════════════════════════════════════════════════
 * BRON (TZ 17-band)
 * ═══════════════════════════════════════════════════════════
 *
 * Buyurtma bilan bir xil mexanizm: barcha xodimlarga
 * yuboriladi, biri javob bersa qolganlarining xabari
 * yangilanadi.
 *
 * Bron statuslari buyurtmadan boshqacha (confirmed/rejected),
 * shuning uchun changeOrderStatus ishlatilmaydi — bron uchun
 * alohida, lekin xuddi shunday atomik shart qo'llanadi.
 */

function buildReservationText(r, extra = '') {
  const lines = [
    '🔔 <b>YANGI BRON</b>',
    '',
    `👤 ${r.name}`,
    `📞 ${r.phone}`,
    `📅 ${r.date}`,
    `🕐 ${r.time}`,
    `👥 ${r.guests} kishi`,
  ];
  if (r.note) lines.push(`📝 ${r.note}`);
  if (extra) { lines.push(''); lines.push(extra); }
  return lines.join('\n');
}

export async function notifyNewReservation(reservationId) {
  if (!isRestaurantBotEnabled()) return;

  const { Reservation } = await import('../models/Reservation.js');
  const r = await Reservation.findById(reservationId).lean();
  if (!r || r.status !== 'pending') return;

  const staff = await activeStaff(r.restaurantId);
  if (!staff.length) return;

  const text = buildReservationText(r);
  const keyboard = {
    inline_keyboard: [[
      { text: '✅ Qabul qilish', callback_data: `r:confirm:${r._id}` },
      { text: '❌ Rad etish', callback_data: `r:reject:${r._id}` },
    ]],
  };

  await Promise.all(staff.map(async (s) => {
    const res = await sendToStaff(s.telegramUserId, text, keyboard);
    const messageId = res?.result?.message_id;
    if (!messageId) return;
    await RestaurantBotMessage.create({
      orderId: r._id,
      telegramUserId: s.telegramUserId,
      messageId,
      kind: 'reservation',
    }).catch(() => {});
  }));
}

export async function refreshReservationMessages(reservationId, actorName = '') {
  if (!isRestaurantBotEnabled()) return;

  const { Reservation } = await import('../models/Reservation.js');
  const r = await Reservation.findById(reservationId).lean();
  if (!r) return;

  const msgs = await RestaurantBotMessage.find({
    orderId: reservationId,
    kind: 'reservation',
  }).lean();
  if (!msgs.length) return;

  const by = actorName ? ` · ${actorName}` : '';
  const line = r.status === 'confirmed'
    ? `✅ <b>Qabul qilindi</b>${by}`
    : r.status === 'rejected'
      ? `❌ <b>Rad etildi</b>${by}`
      : '';

  const text = buildReservationText(r, line);
  await Promise.all(msgs.map((m) =>
    editStaffMessage(m.telegramUserId, m.messageId, text, null)));
}

export async function handleReservationCallback(cq) {
  const [, action, reservationId] = String(cq.data || '').split(':');
  const tgUserId = String(cq.from?.id);

  const staff = await RestaurantTelegramStaff.findOne({
    telegramUserId: tgUserId,
    isActive: true,
  }).lean();
  if (!staff) {
    await answerCallback(cq.id, 'Sizning akkauntingiz ulanmagan');
    return;
  }

  const status = action === 'confirm' ? 'confirmed' : 'rejected';
  const { Reservation } = await import('../models/Reservation.js');

  /*
   * Atomik: `status: 'pending'` filtrda. Ikki xodim bir vaqtda
   * bossa, ikkinchisi null oladi va ogohlantiriladi.
   * restaurantId ham filtrda — boshqa restoran broniga
   * tegib bo'lmaydi.
   */
  const updated = await Reservation.findOneAndUpdate(
    { _id: reservationId, restaurantId: staff.restaurantId, status: 'pending' },
    { status },
    { new: true },
  );

  if (!updated) {
    await answerCallback(cq.id, 'Bronni boshqa xodim allaqachon ko‘rib chiqqan');
    await refreshReservationMessages(reservationId);
    return;
  }

  await answerCallback(cq.id, 'Bajarildi');

  // Panel real-time yangilanadi
  const { getIO } = await import('../sockets/io.js');
  getIO()?.to(`restaurant:${staff.restaurantId}`).emit('reservation:update', updated);
  getIO()?.to('admin').emit('reservation:update', updated);

  await refreshReservationMessages(reservationId, staff.firstName || staff.username);
}
