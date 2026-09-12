import { Order } from '../models/Order.js';
import { Reservation } from '../models/Reservation.js';
import { Restaurant } from '../models/Restaurant.js';
import { RestaurantTelegramStaff } from '../models/RestaurantTelegramStaff.js';
import { RestaurantBotMessage } from '../models/RestaurantBotMessage.js';
import { DeliveryAssignment } from '../models/DeliveryAssignment.js';
import { getIO } from '../sockets/io.js';
import { orderLabel } from './orderNumber.js';
import { createShareLink, buildShareUrls } from './courierDispatch.js';
import { sendSignal } from './restaurantBotSignal.js';
import {
  isRestaurantBotEnabled,
  sendToStaff,
  editStaffMessage,
  answerCallback,
  esc,
  btn,
  urlBtn,
} from './restaurantBotApi.js';

/*
 * ═══════════════════════════════════════════════════════════
 * RESTORAN BOTI — BUYURTMALAR VA BRONLAR
 * ═══════════════════════════════════════════════════════════
 *
 * ─── ASOSIY QOIDA ───
 * Bu yerda buyurtma mantig'i YO'Q. Status o'zgartirish
 * services/orderFlow.js dagi changeOrderStatus() orqali —
 * panel ham aynan shuni ishlatadi (TZ 23-band). Kuryerga
 * ulashish — admin paneldagi bilan AYNAN bir servis
 * (services/courierDispatch.js).
 *
 * ─── BUYURTMA OQIMI (botda) ───
 *   pending    → [✅ Qabul qilish] [❌ Rad etish]
 *   accepted   → [🚴 Kuryerga ulashish] [✅ Tayyor]
 *   ready      → [🚴 Kuryerga ulashish] [🛵 Kuryerga topshirildi]
 *                (olib ketish: [🤝 Mijoz olib ketdi])
 *   delivering → tugmasiz (kuryer "Topshirdim" bosadi)
 *
 * Kuryerga ulashish OLIB KETISH buyurtmasida ko'rsatilmaydi —
 * u yerda kuryer yo'q. Kuryer topilgach ulashish tugmasi
 * yo'qoladi (ikkinchi kuryer chaqirilmasin).
 */

const som = (n) => new Intl.NumberFormat('ru-RU').format(Math.round(Number(n) || 0)).replace(/\u00a0/g, ' ');
const kb = (rows) => ({ inline_keyboard: rows.filter((r) => r && r.length) });
const DEFAULT_TZ = 'Asia/Tashkent';

/*
 * Rad etish sabablari — tayyor tugmalar: xodim telefonda tez
 * harakat qiladi va statistikada guruhlanadi.
 */
const REJECT_REASONS = {
  out: 'Taom tugagan',
  busy: 'Oshxona band',
  far: 'Manzil juda uzoq',
  closing: 'Yopilish vaqti',
  other: 'Boshqa sabab',
};

/* ═══ Restoran vaqt zonasi — qisqa kesh (har xabarda so'ramaslik uchun) ═══ */
const tzCache = new Map();
async function restaurantTz(restaurantId) {
  const key = String(restaurantId);
  const hit = tzCache.get(key);
  if (hit && hit.until > Date.now()) return hit.tz;
  const r = await Restaurant.findById(restaurantId).select('timezone').lean().catch(() => null);
  const tz = r?.timezone || DEFAULT_TZ;
  tzCache.set(key, { tz, until: Date.now() + 10 * 60_000 });
  return tz;
}

function fmtTime(date, tz) {
  if (!date) return '';
  try {
    return new Intl.DateTimeFormat('ru-RU', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(date));
  } catch {
    return '';
  }
}

function fmtDayMonth(date, tz) {
  try {
    return new Intl.DateTimeFormat('ru-RU', { timeZone: tz, day: '2-digit', month: '2-digit' }).format(new Date(date));
  } catch {
    return '';
  }
}

/* ═══════════════════════════════════════════════════════════
 * BUYURTMA — MATN
 * ═══════════════════════════════════════════════════════════
 *
 * Har doim BITTA joyda quriladi. Mijoz kiritgan HAR BIR qiymat
 * (taom izohi, manzil, izoh) esc() orqali o'tadi: avval `<`
 * belgili izoh HTML'ni buzardi va Telegram xabarni butunlay rad
 * etardi — xodimga buyurtma UMUMAN yetib bormasdi.
 */

function orderStatusLine(order, actorName = '') {
  const by = actorName ? ` · ${esc(actorName)}` : '';
  const pickup = order.fulfillment === 'pickup';
  switch (order.status) {
    case 'accepted': return `✅ <b>Qabul qilindi</b>${by}`;
    case 'preparing': return `🍳 <b>Tayyorlanmoqda</b>${by}`;
    case 'ready': return `📦 <b>Tayyor</b>${by}`;
    case 'delivering': return pickup ? `🤝 <b>Mijoz olib ketdi</b>${by}` : `🛵 <b>Kuryer yo‘lda</b>${by}`;
    case 'delivered': return pickup ? '✅ <b>Olib ketildi</b>' : '✅ <b>Yetkazildi</b>';
    case 'cancelled': {
      const reason = order.cancelReason ? `\n📝 Sabab: ${esc(order.cancelReason)}` : '';
      return `❌ <b>Bekor qilindi</b>${by}${reason}`;
    }
    default: return '';
  }
}

function courierLine(order, assignment) {
  if (order.fulfillment !== 'delivery' || !assignment) return '';
  if (!['accepted', 'preparing', 'ready'].includes(order.status)) return '';
  if (assignment.status === 'assigned') return '🛵 <b>Kuryer topildi</b> — taomni olib ketishga keladi';
  if (assignment.status === 'searching') return '🔎 Kuryer qidirilmoqda (havola ulashildi)';
  return '';
}

export function buildOrderText(order, { actorName = '', assignment = null, tz = DEFAULT_TZ, note = '' } = {}) {
  const lines = [];
  const isPickup = order.fulfillment === 'pickup';

  lines.push(`🔔 <b>BUYURTMA ${esc(orderLabel(order))}</b>`);
  if (order.timingMode === 'scheduled' && order.scheduledFor) {
    lines.push(`⏰ <b>Belgilangan vaqt: ${fmtTime(order.scheduledFor, tz)}</b> (${fmtDayMonth(order.scheduledFor, tz)})`);
  }
  lines.push('');

  for (const it of order.items || []) {
    const sum = (Number(it.unitPrice) || 0) * (Number(it.quantity) || 0);
    lines.push(`${Number(it.quantity) || 0}× ${esc(it.name)} — ${som(sum)} so‘m`);
    if (it.note) lines.push(`   <i>${esc(it.note)}</i>`);
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
    lines.push(`📍 ${esc(order.address || '—')}`);
  }
  if (order.phone) lines.push(`📞 ${esc(order.phone)}`);
  if (order.addressNote) lines.push(`📝 ${esc(order.addressNote)}`);
  if (order.note) lines.push(`💬 ${esc(order.note)}`);

  const status = orderStatusLine(order, actorName);
  const courier = courierLine(order, assignment);
  if (status || courier || note) lines.push('');
  if (status) lines.push(status);
  if (courier) lines.push(courier);
  if (note) lines.push(note);

  return lines.join('\n');
}

/* ═══ BUYURTMA — TUGMALAR (joriy statusga qarab) ═══ */
export function buildOrderKeyboard(order, assignment = null) {
  const id = String(order._id);
  const isDelivery = order.fulfillment === 'delivery';
  const courierFound = assignment?.status === 'assigned';
  const shareBtn = isDelivery && !courierFound
    ? [btn(assignment ? '🔁 Kuryerga qayta ulashish' : '🚴 Kuryerga ulashish', `o:share:${id}`, 'primary')]
    : null;

  switch (order.status) {
    case 'pending':
      return kb([
        [btn('✅ Qabul qilish', `o:accept:${id}`, 'success')],
        [btn('❌ Rad etish', `o:rejectmenu:${id}`, 'danger')],
      ]);
    case 'accepted':
    case 'preparing':
      return kb([shareBtn, [btn('✅ Tayyor', `o:ready:${id}`, 'success')]]);
    case 'ready':
      if (!isDelivery) return kb([[btn('🤝 Mijoz olib ketdi', `o:delivering:${id}`, 'success')]]);
      return kb([shareBtn, [btn('🛵 Kuryerga topshirildi', `o:delivering:${id}`, 'success')]]);
    default:
      return null;
  }
}

/** Buyurtmaning so'nggi kuryer biriktiruvi (bo'lsa). */
async function latestAssignment(orderId) {
  return DeliveryAssignment.findOne({ orderId, status: { $in: ['searching', 'assigned', 'delivered'] } })
    .sort({ createdAt: -1 })
    .select('status token deliverySnapshot createdAt')
    .lean();
}

/** Shu restoranning ulangan, faol xodimlari. */
export async function activeStaff(restaurantId) {
  return RestaurantTelegramStaff.find({
    restaurantId,
    isActive: true,
    telegramUserId: { $ne: null },
  }).select('telegramUserId firstName username signals').lean();
}

async function rememberMessage(res, { refId, telegramUserId, kind }) {
  const messageId = res?.result?.message_id;
  if (!messageId) return;
  await RestaurantBotMessage.create({ orderId: refId, telegramUserId: String(telegramUserId), messageId, kind })
    .catch(() => {});
}

/*
 * ═══ YANGI BUYURTMA ═══
 * Dine-in yuborilmaydi (zalda ofitsiant bor). To'lanmagan
 * karta buyurtmasi ham — pul kelgach qayta chaqiriladi.
 */
export async function notifyNewOrder(orderId) {
  if (!isRestaurantBotEnabled()) return;

  const order = await Order.findById(orderId).lean();
  if (!order || order.fulfillment === 'dinein' || order.status === 'awaiting_payment') return;

  const staff = await activeStaff(order.restaurantId);
  if (!staff.length) return;

  const tz = await restaurantTz(order.restaurantId);
  const text = buildOrderText(order, { tz });
  const keyboard = buildOrderKeyboard(order);

  // Parallel — 5 xodimga ketma-ket yuborish bir necha soniya olardi
  await Promise.all(staff.map(async (s) => {
    const res = await sendToStaff(s.telegramUserId, text, keyboard);
    await rememberMessage(res, { refId: order._id, telegramUserId: s.telegramUserId, kind: 'order' });
  }));

  /*
   * Ovozli signal — kartadan KEYIN (xodim avval buyurtmani
   * ko'rsin). Signal bir marta ketadi; xatosi buyurtma oqimiga
   * ta'sir qilmaydi, shuning uchun kutilmaydi.
   */
  sendSignal('order', order._id, staff)
    .catch((e) => console.error('[signal] buyurtma:', e.message));
}

/*
 * ═══ BARCHA XABARLARNI YANGILASH ═══
 * Status qayerdan o'zgarganidan qat'i nazar (bot, panel, kuryer
 * sahifasi) chaqiriladi — barcha xodimlar bir xil holatni ko'radi.
 */
export async function refreshOrderMessages(orderId, actorName = '') {
  if (!isRestaurantBotEnabled()) return;

  const order = await Order.findById(orderId).lean();
  if (!order || order.fulfillment === 'dinein') return;

  const msgs = await RestaurantBotMessage.find({ orderId, kind: 'order' }).lean();
  if (!msgs.length) return;

  const [assignment, tz] = await Promise.all([latestAssignment(order._id), restaurantTz(order.restaurantId)]);
  const text = buildOrderText(order, { actorName, assignment, tz });
  const keyboard = buildOrderKeyboard(order, assignment);

  await Promise.all(msgs.map((m) => editStaffMessage(m.telegramUserId, m.messageId, text, keyboard)));
}

/** Buyurtma kartasini xodimga yangidan yuborish (ro'yxatdan ochilganda). */
export async function sendOrderCard(order, telegramUserId) {
  const [assignment, tz] = await Promise.all([latestAssignment(order._id), restaurantTz(order.restaurantId)]);
  const res = await sendToStaff(
    telegramUserId,
    buildOrderText(order, { assignment, tz }),
    buildOrderKeyboard(order, assignment),
  );
  await rememberMessage(res, { refId: order._id, telegramUserId, kind: 'order' });
  return res;
}

/* ═══════════════════════════════════════════════════════════
 * KURYERGA ULASHISH — admin paneldagi bilan bir xil
 * ═══════════════════════════════════════════════════════════
 *
 * Bitta havola yaratiladi, xodim uni O'Z Telegram/WhatsApp
 * akkaunti orqali xohlagan kuryer(lar)ga yuboradi. Birinchi
 * "Qabul qilaman" bosgan kuryer buyurtmani oladi (atomik,
 * courierDispatch.acceptShare).
 *
 * Qayta bosilsa YANGI havola yaratilmaydi — mavjud (hali hech
 * kim olmagan) havola qayta beriladi. Aks holda bir buyurtmaga
 * bir nechta ochiq havola paydo bo'lib, ikki kuryer ikkalasi
 * ham "qabul qildim" deb kelishi mumkin edi.
 */
const MAX_BUTTON_URL = 1900;

async function handleShare(cq, staff, orderId) {
  const order = await Order.findOne({ _id: orderId, restaurantId: staff.restaurantId }).lean();
  if (!order) {
    await answerCallback(cq.id, 'Buyurtma topilmadi', { alert: true });
    return;
  }
  if (order.fulfillment !== 'delivery') {
    await answerCallback(cq.id, 'Olib ketish buyurtmasiga kuryer kerak emas', { alert: true });
    return;
  }
  if (!['accepted', 'preparing', 'ready'].includes(order.status)) {
    await answerCallback(cq.id, 'Bu holatdagi buyurtmani kuryerga ulashib bo‘lmaydi', { alert: true });
    await refreshOrderMessages(orderId);
    return;
  }

  const existing = await DeliveryAssignment.findOne({ orderId: order._id, status: { $in: ['searching', 'assigned'] } })
    .sort({ createdAt: -1 })
    .lean();
  if (existing?.status === 'assigned') {
    await answerCallback(cq.id, '🛵 Bu buyurtmaga kuryer allaqachon topilgan', { alert: true });
    await refreshOrderMessages(orderId);
    return;
  }

  const { token, snapshot } = existing
    ? { token: existing.token, snapshot: existing.deliverySnapshot }
    : await createShareLink(order._id);

  let urls = buildShareUrls(token, snapshot);
  // Juda uzun URL'ni Telegram tugmada rad etishi mumkin — ixcham variant
  if (urls.telegram.length > MAX_BUTTON_URL || urls.whatsapp.length > MAX_BUTTON_URL) {
    urls = { ...buildShareUrls(token, { ...snapshot, items: [] }), text: urls.text };
  }

  await answerCallback(cq.id, '📤 Ulashish havolasi tayyor');

  const text = [
    `🚴 <b>KURYER UCHUN E’LON — ${esc(orderLabel(order))}</b>`,
    '',
    'Pastdagi tugma orqali kuryeringizga yuboring — <b>Telegram</b> yoki <b>WhatsApp</b>.',
    'Bir nechta kuryerga yuborsangiz ham bo‘ladi: <b>birinchi qabul qilgani</b> buyurtmani oladi.',
    '',
    `<blockquote>${esc(urls.text)}</blockquote>`,
    '',
    `🔗 ${esc(urls.link)}`,
  ].join('\n');

  const keyboard = kb([
    [urlBtn('✈️ Telegram orqali yuborish', urls.telegram, 'primary')],
    [urlBtn('💬 WhatsApp orqali yuborish', urls.whatsapp, 'success')],
  ]);

  const replyTo = cq.message?.message_id
    ? { reply_parameters: { message_id: cq.message.message_id, allow_sending_without_reply: true } }
    : {};

  const res = await sendToStaff(staff.telegramUserId, text, keyboard, replyTo);
  if (!res?.ok) {
    // Zaxira: tugmasiz — xodim xabarni o'zi forward qiladi yoki havolani nusxalaydi
    await sendToStaff(staff.telegramUserId, `${text}\n\n<i>Bu xabarni kuryerga forward qiling.</i>`, null, replyTo);
  }

  // Barcha xodimlarda "🔎 Kuryer qidirilmoqda" va "Qayta ulashish" chiqadi
  await refreshOrderMessages(orderId);
}

/* ═══ BUYURTMA TUGMASI BOSILDI ═══ */
const ORDER_ACTIONS = {
  accept: { status: 'accepted', toast: '✅ Buyurtma qabul qilindi' },
  preparing: { status: 'preparing', toast: '🍳 Tayyorlanmoqda' },
  ready: { status: 'ready', toast: '✅ Tayyor deb belgilandi' },
  delivering: { status: 'delivering', toast: '🛵 Buyurtma yo‘lga chiqdi' },
  reject: { status: 'cancelled', toast: '❌ Buyurtma rad etildi' },
};

async function findStaff(cq) {
  const staff = await RestaurantTelegramStaff.findOne({
    telegramUserId: String(cq.from?.id),
    isActive: true,
  }).lean();
  if (!staff) await answerCallback(cq.id, 'Sizning akkauntingiz ulanmagan', { alert: true });
  return staff;
}

export async function handleOrderCallback(cq) {
  const [, action, orderId, extra] = String(cq.data || '').split(':');
  if (!/^[a-f\d]{24}$/i.test(orderId || '')) {
    await answerCallback(cq.id);
    return;
  }

  /*
   * XAVFSIZLIK (TZ 20-band): restaurantId Telegram xabaridan
   * emas, BAZADAN olinadi — callback_data ni o'zgartirib boshqa
   * restoran buyurtmasini ochib bo'lmaydi.
   */
  const staff = await findStaff(cq);
  if (!staff) return;
  const actorName = staff.firstName || staff.username;

  if (action === 'share') {
    await handleShare(cq, staff, orderId);
    return;
  }

  if (action === 'show') {
    const order = await Order.findOne({ _id: orderId, restaurantId: staff.restaurantId }).lean();
    if (!order) {
      await answerCallback(cq.id, 'Buyurtma topilmadi', { alert: true });
      return;
    }
    await answerCallback(cq.id, `📦 ${orderLabel(order)}`);
    await sendOrderCard(order, staff.telegramUserId);
    return;
  }

  // Rad etish sabablari — faqat bosgan xodimning xabarida
  if (action === 'rejectmenu') {
    const order = await Order.findOne({ _id: orderId, restaurantId: staff.restaurantId }).lean();
    if (!order || order.status !== 'pending') {
      await answerCallback(cq.id, 'Buyurtma allaqachon ko‘rib chiqilgan', { alert: true });
      await refreshOrderMessages(orderId);
      return;
    }
    await answerCallback(cq.id, 'Sababni tanlang');
    const tz = await restaurantTz(order.restaurantId);
    await editStaffMessage(
      staff.telegramUserId,
      cq.message?.message_id,
      buildOrderText(order, { tz, note: '❓ <b>Rad etish sababini tanlang:</b>' }),
      kb([
        ...Object.entries(REJECT_REASONS).map(([key, label]) => [btn(`❌ ${label}`, `o:reject:${orderId}:${key}`, 'danger')]),
        [btn('‹ Ortga', `o:back:${orderId}`)],
      ]),
    );
    return;
  }

  if (action === 'back') {
    await answerCallback(cq.id);
    await refreshOrderMessages(orderId);
    return;
  }

  const meta = ORDER_ACTIONS[action];
  if (!meta) {
    await answerCallback(cq.id);
    return;
  }

  try {
    const { changeOrderStatus } = await import('./orderFlow.js');
    const { order, changed } = await changeOrderStatus({
      orderId,
      restaurantId: staff.restaurantId,
      status: meta.status,
      actorName,
      cancelReason: action === 'reject' ? (REJECT_REASONS[extra] || REJECT_REASONS.other) : undefined,
    });

    /*
     * changed=false — buyurtma ALLAQACHON shu holatda (boshqa xodim
     * bir oniy oldin bosdi yoki tugma ikki marta bosildi). Xodimga
     * "bajarildi" deyish yolg'on bo'lardi — rostini aytamiz.
     */
    if (!changed) {
      await answerCallback(cq.id, 'Buyurtma allaqachon shu holatda — boshqa xodim ulgurdi', { alert: true });
      await refreshOrderMessages(orderId);
      return;
    }

    const pickup = order?.fulfillment === 'pickup';
    const toast = action === 'delivering' && pickup ? '🤝 Mijoz olib ketdi' : meta.toast;
    await answerCallback(cq.id, toast);

    await RestaurantTelegramStaff.updateOne({ _id: staff._id }, { lastActionAt: new Date() });
    /*
     * Xabarlar changeOrderStatus ichidan yangilanadi
     * (orderFlow -> refreshOrderMessages). Bu yerda qayta
     * chaqirilmaydi — ikki marta tahrirlash ortiqcha.
     */
  } catch (e) {
    // Boshqa xodim ulgurdi (TZ 18) — odatiy holat, xato emas
    if (e.code === 'RACE_LOST' || e.code === 'WRONG_STATE' || e.code === 'NOT_FOUND') {
      await answerCallback(cq.id, 'Buyurtma holati allaqachon o‘zgargan — xabar yangilandi', { alert: true });
      await refreshOrderMessages(orderId);
      return;
    }
    console.error('[restaurantBot] order callback:', e.message);
    await answerCallback(cq.id, '⚠️ Xatolik yuz berdi, qayta urinib ko‘ring', { alert: true });
  }
}

/* ═══════════════════════════════════════════════════════════
 * BRON (TZ 17-band)
 * ═══════════════════════════════════════════════════════════
 *
 * Bron hayot sikli (xodim nuqtai nazaridan):
 *   pending   → [✅ Qabul qilish] [❌ Rad etish]
 *   confirmed → [📞 Keladi] [🚫 Kelmaydi] + [🙋 Keldi — yakunlash]
 *               (qo'ng'iroq qilib aniqlashtirilgach)
 *   coming / on_way / arrived → [🙋 Keldi — yakunlash] [🚫 Kelmadi]
 *   completed / not_coming / rejected / cancelled → yopiq
 */

const WEEKDAYS = ['yakshanba', 'dushanba', 'seshanba', 'chorshanba', 'payshanba', 'juma', 'shanba'];

export function fmtReservationDate(ymd) {
  const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return esc(ymd || '—');
  const wd = WEEKDAYS[new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay()];
  return `${m[3]}.${m[2]}.${m[1]} (${wd})`;
}

export const RESERVATION_ACTIVE = ['pending', 'confirmed', 'coming', 'on_way', 'arrived'];

export const RESERVATION_STATUS = {
  pending: { icon: '🕓', label: 'Javob kutilmoqda' },
  confirmed: { icon: '✅', label: 'Qabul qilingan' },
  coming: { icon: '📞', label: 'Keladi (tasdiqlandi)' },
  on_way: { icon: '🚗', label: 'Mijoz yo‘lda' },
  arrived: { icon: '🙋', label: 'Mijoz keldi' },
  completed: { icon: '🏁', label: 'Yakunlandi' },
  not_coming: { icon: '🚫', label: 'Kelmaydi' },
  rejected: { icon: '❌', label: 'Rad etildi' },
  cancelled: { icon: '🚫', label: 'Mijoz bekor qildi' },
};

const RESERVATION_REJECT_REASONS = {
  full: 'Bo‘sh stol yo‘q',
  time: 'Bu vaqtda qabul qila olmaymiz',
  other: 'Boshqa sabab',
};

export function preOrderTotal(r) {
  return (r.preOrder || []).reduce((s, p) => s + (Number(p.price) || 0) * (Number(p.quantity) || 0), 0);
}

export function buildReservationText(r, { title = '', actorName = '', note = '' } = {}) {
  const heading = title || (r.status === 'pending' ? '🔔 <b>YANGI BRON</b>' : '📅 <b>BRON</b>');
  const lines = [
    heading,
    '',
    `👤 ${esc(r.name)}`,
    `📞 ${esc(r.phone)}`,
    `📅 ${fmtReservationDate(r.date)}`,
    `🕐 ${esc(r.time)}`,
    `👥 ${Number(r.guests) || 0} kishi`,
  ];
  if (r.note) lines.push(`📝 ${esc(r.note)}`);

  /*
   * OLDINDAN TANLANGAN TAOMLAR — restoran mehmon kelishiga
   * tayyorlab qo'yishi uchun. Avval bu ma'lumot bazada bor edi,
   * lekin botda UMUMAN ko'rsatilmasdi.
   */
  const pre = (r.preOrder || []).filter((p) => p?.name);
  lines.push('');
  if (pre.length) {
    lines.push('🍽 <b>Oldindan tanlangan taomlar:</b>');
    for (const p of pre) {
      const q = Number(p.quantity) || 1;
      const sum = (Number(p.price) || 0) * q;
      lines.push(`• ${q}× ${esc(p.name)}${sum ? ` — ${som(sum)} so‘m` : ''}`);
    }
    const total = preOrderTotal(r);
    if (total) lines.push(`💰 <b>Taomlar jami: ${som(total)} so‘m</b>`);
  } else {
    lines.push('🍽 Oldindan taom tanlanmagan');
  }

  const st = RESERVATION_STATUS[r.status];
  if (st && r.status !== 'pending') {
    lines.push('');
    lines.push(`${st.icon} <b>${st.label}</b>${actorName ? ` · ${esc(actorName)}` : ''}`);
    if (r.status === 'rejected' && r.rejectReason) lines.push(`📝 Sabab: ${esc(r.rejectReason)}`);
  }
  if (note) {
    lines.push('');
    lines.push(note);
  }
  return lines.join('\n');
}

export function buildReservationKeyboard(r) {
  const id = String(r._id);
  switch (r.status) {
    case 'pending':
      return kb([
        [btn('✅ Qabul qilish', `r:confirm:${id}`, 'success')],
        [btn('❌ Rad etish', `r:rejectmenu:${id}`, 'danger')],
      ]);
    case 'confirmed':
      return kb([
        [btn('📞 Keladi', `r:coming:${id}`, 'success'), btn('🚫 Kelmaydi', `r:notcoming:${id}`, 'danger')],
        [btn('🙋 Keldi — yakunlash', `r:done:${id}`, 'primary')],
      ]);
    case 'coming':
    case 'on_way':
    case 'arrived':
      return kb([
        [btn('🙋 Keldi — yakunlash', `r:done:${id}`, 'success')],
        [btn('🚫 Kelmadi', `r:notcoming:${id}`, 'danger')],
      ]);
    default:
      return null;
  }
}

export async function notifyNewReservation(reservationId) {
  if (!isRestaurantBotEnabled()) return;

  const r = await Reservation.findById(reservationId).lean();
  if (!r || r.status !== 'pending') return;

  const staff = await activeStaff(r.restaurantId);
  if (!staff.length) return;

  const text = buildReservationText(r);
  const keyboard = buildReservationKeyboard(r);

  await Promise.all(staff.map(async (s) => {
    const res = await sendToStaff(s.telegramUserId, text, keyboard);
    await rememberMessage(res, { refId: r._id, telegramUserId: s.telegramUserId, kind: 'reservation' });
  }));

  // Ovozli signal — bron kartasidan keyin, bir marta
  sendSignal('reservation', r._id, staff)
    .catch((e) => console.error('[signal] bron:', e.message));
}

/** Bron kartasini bitta xodimga yuborish (ro'yxat / ertalabki eslatma). */
export async function sendReservationCard(r, telegramUserId, { title = '' } = {}) {
  const res = await sendToStaff(telegramUserId, buildReservationText(r, { title }), buildReservationKeyboard(r));
  await rememberMessage(res, { refId: r._id, telegramUserId, kind: 'reservation' });
  return res;
}

export async function refreshReservationMessages(reservationId, actorName = '') {
  if (!isRestaurantBotEnabled()) return;

  const r = await Reservation.findById(reservationId).lean();
  if (!r) return;

  const msgs = await RestaurantBotMessage.find({ orderId: reservationId, kind: 'reservation' }).lean();
  if (!msgs.length) return;

  const text = buildReservationText(r, { actorName });
  const keyboard = buildReservationKeyboard(r);
  await Promise.all(msgs.map((m) => editStaffMessage(m.telegramUserId, m.messageId, text, keyboard)));
}

/*
 * Mijoz o'zi bekor qilsa / "bora olmaymiz" desa — xodimlarga
 * ALOHIDA xabar (tahrir bildirishnoma bermaydi, yangi xabar esa
 * beradi — xodim stolni boshqaga bera olishi uchun darhol bilishi kerak).
 */
export async function notifyReservationChangedByCustomer(reservationId) {
  if (!isRestaurantBotEnabled()) return;
  const r = await Reservation.findById(reservationId).lean();
  if (!r) return;

  await refreshReservationMessages(reservationId);
  if (!['cancelled', 'not_coming'].includes(r.status)) return;

  const staff = await activeStaff(r.restaurantId);
  const head = r.status === 'cancelled' ? '🚫 <b>Mijoz bronni bekor qildi</b>' : '🚫 <b>Mijoz kela olmasligini bildirdi</b>';
  const text = `${head}\n\n👤 ${esc(r.name)} · 📞 ${esc(r.phone)}\n📅 ${fmtReservationDate(r.date)} · 🕐 ${esc(r.time)} · 👥 ${Number(r.guests) || 0} kishi`;
  await Promise.all(staff.map((s) => sendToStaff(s.telegramUserId, text)));
}

const RESERVATION_ACTIONS = {
  confirm: { to: 'confirmed', from: ['pending'], toast: '✅ Bron qabul qilindi' },
  reject: { to: 'rejected', from: ['pending'], toast: '❌ Bron rad etildi' },
  coming: { to: 'coming', from: ['confirmed'], toast: '📞 "Keladi" deb belgilandi' },
  notcoming: { to: 'not_coming', from: ['confirmed', 'coming', 'on_way', 'arrived'], toast: '🚫 "Kelmaydi" deb belgilandi' },
  done: { to: 'completed', from: ['confirmed', 'coming', 'on_way', 'arrived'], toast: '🏁 Bron yakunlandi' },
};

export async function handleReservationCallback(cq) {
  const [, action, reservationId, extra] = String(cq.data || '').split(':');
  if (!/^[a-f\d]{24}$/i.test(reservationId || '')) {
    await answerCallback(cq.id);
    return;
  }

  const staff = await findStaff(cq);
  if (!staff) return;
  const actorName = staff.firstName || staff.username;

  if (action === 'view') {
    const r = await Reservation.findOne({ _id: reservationId, restaurantId: staff.restaurantId }).lean();
    if (!r) {
      await answerCallback(cq.id, 'Bron topilmadi', { alert: true });
      return;
    }
    await answerCallback(cq.id, `📅 ${r.name}`);
    await sendReservationCard(r, staff.telegramUserId);
    return;
  }

  if (action === 'back') {
    await answerCallback(cq.id);
    await refreshReservationMessages(reservationId);
    return;
  }

  /*
   * Rad etish: sabab tanlanmagan bo'lsa (yangi "Rad etish" tugmasi
   * yoki eski xabardagi `r:reject:<id>`) — avval sabablar menyusi.
   * Sabab mijozga yuboriladi.
   */
  if (action === 'rejectmenu' || (action === 'reject' && !extra)) {
    const r = await Reservation.findOne({ _id: reservationId, restaurantId: staff.restaurantId }).lean();
    if (!r || r.status !== 'pending') {
      await answerCallback(cq.id, 'Bron allaqachon ko‘rib chiqilgan', { alert: true });
      await refreshReservationMessages(reservationId);
      return;
    }
    await answerCallback(cq.id, 'Sababni tanlang');
    await editStaffMessage(
      staff.telegramUserId,
      cq.message?.message_id,
      buildReservationText(r, { note: '❓ <b>Rad etish sababini tanlang:</b>' }),
      kb([
        ...Object.entries(RESERVATION_REJECT_REASONS).map(([key, label]) => [btn(`❌ ${label}`, `r:reject:${reservationId}:${key}`, 'danger')]),
        [btn('‹ Ortga', `r:back:${reservationId}`)],
      ]),
    );
    return;
  }

  const meta = RESERVATION_ACTIONS[action];
  if (!meta) {
    await answerCallback(cq.id);
    return;
  }

  const update = {
    $set: { status: meta.to },
    $push: { responses: { action: `staff_${meta.to}`, at: new Date() } },
  };
  const reason = action === 'reject' ? (RESERVATION_REJECT_REASONS[extra] || RESERVATION_REJECT_REASONS.other) : '';
  if (reason) update.$set.rejectReason = reason;

  /*
   * Atomik: joriy status filtrda. Ikki xodim bir vaqtda bossa,
   * ikkinchisi null oladi. restaurantId ham filtrda — boshqa
   * restoran broniga tegib bo'lmaydi.
   */
  const updated = await Reservation.findOneAndUpdate(
    { _id: reservationId, restaurantId: staff.restaurantId, status: { $in: meta.from } },
    update,
    { new: true },
  );

  if (!updated) {
    await answerCallback(cq.id, 'Bron holati allaqachon o‘zgargan — xabar yangilandi', { alert: true });
    await refreshReservationMessages(reservationId);
    return;
  }

  await answerCallback(cq.id, meta.toast);
  await RestaurantTelegramStaff.updateOne({ _id: staff._id }, { lastActionAt: new Date() });

  // Mijozga xabar — paneldagi bilan bir xil (avval botdan qabul qilinganda mijoz bilmay qolardi)
  if (meta.to === 'confirmed' || meta.to === 'rejected') {
    try {
      const { notifyReservationDecision } = await import('./reservationReminder.js');
      await notifyReservationDecision(updated, meta.to, reason);
    } catch (e) {
      console.error('[restaurantBot] bron mijoz xabari:', e.message);
    }
  }

  // Panel bildirishnomasi yopiladi — paneldagi ovoz to'xtaydi
  import('./notifications.js')
    .then((m) => m.resolveReservationNotification(updated))
    .catch(() => {});

  // Panel, admin va mijoz ilovasi real-time yangilanadi
  const io = getIO();
  const payload = { reservationId: String(updated._id), status: updated.status };
  io?.to(`restaurant:${staff.restaurantId}`).emit('reservation:update', updated);
  io?.to('admin').emit('reservation:update', payload);
  io?.to(`user:${updated.userId}`).emit('reservation:status', payload);

  await refreshReservationMessages(reservationId, actorName);
}
