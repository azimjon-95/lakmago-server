import { Order } from '../models/Order.js';
import { Reservation } from '../models/Reservation.js';
import { Restaurant } from '../models/Restaurant.js';
import { RestaurantTelegramStaff } from '../models/RestaurantTelegramStaff.js';
import { orderLabel } from './orderNumber.js';
import { zoneDate, zoneDayRange, addDaysYmd, hhmmToMinutes } from './restaurantTime.js';
import {
  isRestaurantBotEnabled,
  sendToStaff,
  editStaffMessage,
  answerCallback,
  esc,
  btn,
} from './restaurantBotApi.js';
import {
  activeStaff,
  sendReservationCard,
  fmtReservationDate,
  preOrderTotal,
  RESERVATION_ACTIVE,
  RESERVATION_STATUS,
} from './restaurantBotOrders.js';

/*
 * ═══════════════════════════════════════════════════════════
 * RESTORAN BOTI — PASTKI MENYU VA RO'YXATLAR
 * ═══════════════════════════════════════════════════════════
 *
 *   📅 Faol bronlar         — yopilmagan bronlar (bugun va keyin)
 *   🚴 Bugungi dostavkalar  — bugungi yetkazish/olib ketish buyurtmalari
 *
 * + Ertalabki eslatma: bron kuni restoran ish boshlashi bilan
 *   xodimlarga "shu mehmonlar keladi — qo'ng'iroq qilib
 *   aniqlashtiring" xabari va har bron uchun natija tugmalari.
 *
 * XAVFSIZLIK (TZ 6-band): menyu va ro'yxatlar FAQAT ulangan, faol
 * xodimga javob beradi. Begona odam yozsa bot jim turadi.
 */

export const MENU_VERSION = 1;
export const MENU = {
  reservations: '📅 Faol bronlar',
  today: '🚴 Bugungi dostavkalar',
};

const som = (n) => new Intl.NumberFormat('ru-RU').format(Math.round(Number(n) || 0)).replace(/\u00a0/g, ' ');
const MAX_TEXT = 3900; // Telegram chegarasi 4096 — zaxira bilan

export function mainMenuKeyboard() {
  return {
    keyboard: [[
      { text: MENU.reservations, style: 'primary' },
      { text: MENU.today, style: 'success' },
    ]],
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: 'Menyudan tanlang',
  };
}

export async function sendMainMenu(chatId, { restaurantName = '', intro = '' } = {}) {
  const text = intro || [
    `🏪 <b>${esc(restaurantName || 'Restoran')}</b> — xodim menyusi`,
    '',
    `${MENU.reservations} — yopilmagan bronlar, har birini ochib holatini belgilash`,
    `${MENU.today} — bugungi buyurtmalar va ularning holati`,
    '',
    'Yangi buyurtma va bronlar shu yerga avtomatik keladi.',
  ].join('\n');
  return sendToStaff(chatId, text, mainMenuKeyboard());
}

async function staffByTelegram(tgUserId) {
  return RestaurantTelegramStaff.findOne({ telegramUserId: String(tgUserId), isActive: true }).lean();
}

async function restaurantOf(staff) {
  return Restaurant.findById(staff.restaurantId).select('name timezone openTime').lean();
}

/*
 * ═══ MATNLI XABAR (menyu tugmasi) ═══
 * @returns true — javob berildi; false — begona foydalanuvchi (jim).
 */
export async function handleStaffMessage(msg) {
  const staff = await staffByTelegram(msg.from?.id);
  if (!staff) return false;

  const text = String(msg.text || '').trim();
  const restaurant = await restaurantOf(staff);

  // Tugma matni biroz o'zgargan eski menyu bo'lsa ham tanib olinadi
  if (text === MENU.reservations || /^\/bron/i.test(text) || /faol bron/i.test(text)) {
    await showActiveReservations(staff, restaurant);
    return true;
  }
  if (text === MENU.today || /^\/dostavka/i.test(text) || /bugungi (dostavka|buyurtma)/i.test(text)) {
    await showTodayOrders(staff, restaurant);
    return true;
  }

  await sendMainMenu(staff.telegramUserId, { restaurantName: restaurant?.name });
  return true;
}

/* ═══ MENYU CALLBACK'LARI (m:...) — ro'yxatni joyida yangilash ═══ */
export async function handleMenuCallback(cq) {
  const staff = await staffByTelegram(cq.from?.id);
  if (!staff) {
    await answerCallback(cq.id, 'Sizning akkauntingiz ulanmagan', { alert: true });
    return;
  }
  const restaurant = await restaurantOf(staff);
  const [, action] = String(cq.data || '').split(':');
  const editMessageId = cq.message?.message_id;

  if (action === 'resv') {
    await answerCallback(cq.id, '🔄 Yangilandi');
    await showActiveReservations(staff, restaurant, { editMessageId });
    return;
  }
  if (action === 'today') {
    await answerCallback(cq.id, '🔄 Yangilandi');
    await showTodayOrders(staff, restaurant, { editMessageId });
    return;
  }
  await answerCallback(cq.id);
}

async function sendOrEdit(staff, text, keyboard, editMessageId) {
  if (editMessageId) {
    const res = await editStaffMessage(staff.telegramUserId, editMessageId, text, keyboard);
    // Xabar juda eski/o'chirilgan bo'lsa — yangisini yuboramiz
    if (res?.ok || /not modified/i.test(res?.description || '')) return;
  }
  await sendToStaff(staff.telegramUserId, text, keyboard);
}

function clip(lines) {
  const out = [];
  let len = 0;
  for (const l of lines) {
    if (len + l.length + 1 > MAX_TEXT) {
      out.push('…');
      break;
    }
    out.push(l);
    len += l.length + 1;
  }
  return out.join('\n');
}

/* ═══════════════════════════════════════════════════════════
 * 📅 FAOL BRONLAR
 * ═══════════════════════════════════════════════════════════
 * Yopilmagan (pending/confirmed/coming/on_way/arrived) bronlar:
 * bugun va keyingi kunlar + KECHAGI yopilmay qolganlari
 * ("⚠️" bilan — xodim ularni yakunlashi yoki "kelmadi" deb
 * belgilashi kerak). Har bron tugma orqali ochiladi.
 */
const RESV_LIMIT = 30;

export async function showActiveReservations(staff, restaurant, { editMessageId } = {}) {
  const tz = restaurant?.timezone || 'Asia/Tashkent';
  const { ymd: today } = zoneDate(tz);
  const yesterday = addDaysYmd(today, -1);
  const tomorrow = addDaysYmd(today, 1);

  const list = await Reservation.find({
    restaurantId: staff.restaurantId,
    status: { $in: RESERVATION_ACTIVE },
    date: { $gte: yesterday },
  })
    .sort({ date: 1, time: 1 })
    .limit(RESV_LIMIT + 1)
    .lean();

  const refreshRow = [btn('🔄 Yangilash', 'm:resv', 'primary')];

  if (!list.length) {
    await sendOrEdit(staff, '📅 <b>Faol bronlar yo‘q</b>\n\nYangi bron kelsa shu yerga darhol xabar beriladi.', { inline_keyboard: [refreshRow] }, editMessageId);
    return;
  }

  const shown = list.slice(0, RESV_LIMIT);
  const lines = [`📅 <b>Faol bronlar — ${list.length > RESV_LIMIT ? `${RESV_LIMIT}+` : shown.length} ta</b>`];
  const buttons = [];
  let currentDate = '';

  shown.forEach((r, i) => {
    if (r.date !== currentDate) {
      currentDate = r.date;
      const dayLabel = r.date === today ? 'BUGUN'
        : r.date === tomorrow ? 'ERTAGA'
          : r.date === yesterday ? '⚠️ KECHA — yopilmagan' : '';
      lines.push('');
      lines.push(`<b>${fmtReservationDate(r.date)}${dayLabel ? ` · ${dayLabel}` : ''}</b>`);
    }
    const st = RESERVATION_STATUS[r.status] || { icon: '•', label: r.status };
    const preCount = (r.preOrder || []).length;
    const pre = preCount ? ` · 🍽 ${preCount} ta taom (${som(preOrderTotal(r))} so‘m)` : '';
    lines.push(`${i + 1}. 🕐 <b>${esc(r.time)}</b> · 👥 ${Number(r.guests) || 0} · ${esc(r.name)}`);
    lines.push(`    📞 ${esc(r.phone)} · ${st.icon} ${st.label}${pre}`);

    const shortName = String(r.name || '').slice(0, 18);
    buttons.push([btn(
      `${i + 1}. ${st.icon} ${r.time} · ${shortName}`,
      `r:view:${r._id}`,
      r.status === 'pending' ? 'primary' : undefined,
    )]);
  });

  lines.push('');
  lines.push('👇 Bronni ochib, holatini belgilang');
  await sendOrEdit(staff, clip(lines), { inline_keyboard: [...buttons, refreshRow] }, editMessageId);
}

/* ═══════════════════════════════════════════════════════════
 * 🚴 BUGUNGI DOSTAVKALAR
 * ═══════════════════════════════════════════════════════════
 * Restoran vaqt zonasi bo'yicha BUGUN yaratilgan yoki bugunga
 * rejalashtirilgan buyurtmalar (yetkazish + olib ketish).
 * Faollar tepada — har birini tugma orqali ochib boshqarish
 * mumkin (asl xabar chatda yuqorida qolib ketgan bo'lsa ham).
 */
const ORDER_STATUS_SHORT = {
  pending: '🆕 Yangi',
  accepted: '✅ Qabul qilingan',
  preparing: '🍳 Tayyorlanmoqda',
  ready: '📦 Tayyor',
  delivering: '🛵 Yo‘lda',
  delivered: '✅ Yetkazildi',
  cancelled: '❌ Bekor',
};
const ORDER_ACTIVE = ['pending', 'accepted', 'preparing', 'ready', 'delivering'];

export async function showTodayOrders(staff, restaurant, { editMessageId } = {}) {
  const tz = restaurant?.timezone || 'Asia/Tashkent';
  const { ymd, start, end } = zoneDayRange(tz);

  const orders = await Order.find({
    restaurantId: staff.restaurantId,
    fulfillment: { $in: ['delivery', 'pickup'] },
    status: { $ne: 'awaiting_payment' },
    $or: [
      { createdAt: { $gte: start, $lt: end } },
      { scheduledFor: { $gte: start, $lt: end } },
    ],
  })
    .select('status fulfillment total dailyNumber createdAt scheduledFor timingMode address paymentMethod isPaid')
    .sort({ createdAt: 1 })
    .limit(100)
    .lean();

  const refreshRow = [btn('🔄 Yangilash', 'm:today', 'primary')];
  const [y, m, d] = ymd.split('-');

  if (!orders.length) {
    await sendOrEdit(staff, `🚴 <b>Bugungi dostavkalar</b> · ${d}.${m}.${y}\n\nBugun hali buyurtma yo‘q.`, { inline_keyboard: [refreshRow] }, editMessageId);
    return;
  }

  const active = orders.filter((o) => ORDER_ACTIVE.includes(o.status));
  const delivered = orders.filter((o) => o.status === 'delivered');
  const cancelled = orders.filter((o) => o.status === 'cancelled');
  const revenue = delivered.reduce((s, o) => s + (Number(o.total) || 0), 0);

  const time = (dt) => new Intl.DateTimeFormat('ru-RU', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(dt));
  const kind = (o) => (o.fulfillment === 'pickup' ? '🏃' : '🚴');

  const lines = [
    `🚴 <b>Bugungi dostavkalar</b> · ${d}.${m}.${y}`,
    '',
    `Jami: <b>${orders.length}</b> · Faol: <b>${active.length}</b> · Yetkazildi: <b>${delivered.length}</b> · Bekor: <b>${cancelled.length}</b>`,
    `💰 Yakunlanganlar summasi: <b>${som(revenue)} so‘m</b>`,
  ];

  if (active.length) {
    lines.push('', '<b>⏳ FAOL</b>');
    for (const o of active) {
      const when = o.timingMode === 'scheduled' && o.scheduledFor ? `⏰ ${time(o.scheduledFor)}` : time(o.createdAt);
      lines.push(`${kind(o)} <b>${esc(orderLabel(o))}</b> · ${when} · ${som(o.total)} so‘m · ${ORDER_STATUS_SHORT[o.status] || o.status}`);
      if (o.fulfillment === 'delivery' && o.address) {
        const addr = String(o.address);
        lines.push(`    📍 ${esc(addr.length > 48 ? `${addr.slice(0, 48)}…` : addr)}`);
      }
    }
  }

  if (delivered.length || cancelled.length) {
    lines.push('', '<b>✔️ YAKUNLANGAN</b>');
    for (const o of [...delivered, ...cancelled]) {
      lines.push(`${ORDER_STATUS_SHORT[o.status]} · ${esc(orderLabel(o))} · ${time(o.createdAt)} · ${som(o.total)} so‘m`);
    }
  }

  const buttons = active.slice(0, 40).map((o) => [btn(
    `${kind(o)} ${orderLabel(o)} · ${ORDER_STATUS_SHORT[o.status] || o.status}`,
    `o:show:${o._id}`,
    o.status === 'pending' ? 'primary' : undefined,
  )]);

  if (active.length) lines.push('', '👇 Faol buyurtmani ochib boshqarish');
  await sendOrEdit(staff, clip(lines), { inline_keyboard: [...buttons, refreshRow] }, editMessageId);
}

/* ═══════════════════════════════════════════════════════════
 * 🌅 ERTALABKI ESLATMA — bron kuni, ish boshlanishida
 * ═══════════════════════════════════════════════════════════
 *
 * QACHON: restoran ochilish vaqtida (openTime, restoran vaqt
 * zonasi bo'yicha). Bron vaqti ochilish vaqtidan OLDIN bo'lsa
 * (tungi restoran: 22:00–11:00, bron 10:00) — bron vaqtidan
 * 3 soat oldin.
 *
 * QACHON YUBORILMAYDI (va qayta tekshirilmasligi uchun
 * belgilanadi):
 *   • bron o'sha kuni eslatma vaqtidan KEYIN yaratilgan — xodim
 *     uni "YANGI BRON" sifatida hozirgina ko'rgan;
 *   • server ertalab ishlamay qolgan va bron vaqti o'tib
 *     ketgan — kechikkan eslatma chalg'itadi.
 *
 * BIR MARTALIK: har bron atomik "band qilinadi"
 * (reminders.staffMorning.sent) — bir nechta server nusxasi
 * bo'lsa ham ikki marta ketmaydi.
 */
const MORNING_STATUSES = ['pending', 'confirmed', 'coming'];
const DEFAULT_OPEN = 9 * 60;

function morningNoticeMinute(restaurant, resMinutes) {
  const open = hhmmToMinutes(restaurant?.openTime) ?? DEFAULT_OPEN;
  return resMinutes > open ? open : Math.max(0, resMinutes - 180);
}

async function claimMorning(reservationId) {
  return Reservation.findOneAndUpdate(
    { _id: reservationId, 'reminders.staffMorning.sent': { $ne: true } },
    { $set: { 'reminders.staffMorning.sent': true, 'reminders.staffMorning.sentAt': new Date() } },
    { new: true },
  ).lean();
}

export async function runReservationMorningNotices() {
  if (!isRestaurantBotEnabled()) return { sent: 0 };

  const now = new Date();
  const utcToday = now.toISOString().slice(0, 10);
  // Har qanday vaqt zonasidagi "bugun" shu uch kun ichida
  const dates = [addDaysYmd(utcToday, -1), utcToday, addDaysYmd(utcToday, 1)];

  const candidates = await Reservation.find({
    date: { $in: dates },
    status: { $in: MORNING_STATUSES },
    'reminders.staffMorning.sent': { $ne: true },
  }).select('_id restaurantId date time createdAt').lean();
  if (!candidates.length) return { sent: 0 };

  const byRestaurant = new Map();
  for (const r of candidates) {
    const key = String(r.restaurantId);
    if (!byRestaurant.has(key)) byRestaurant.set(key, []);
    byRestaurant.get(key).push(r);
  }

  const restaurants = await Restaurant.find({ _id: { $in: [...byRestaurant.keys()] } })
    .select('name timezone openTime').lean();
  let sent = 0;

  for (const restaurant of restaurants) {
    try {
      sent += await noticeForRestaurant(restaurant, byRestaurant.get(String(restaurant._id)) || [], now);
    } catch (e) {
      console.error(`[restaurantBot] ertalabki eslatma (${restaurant._id}):`, e.message);
    }
  }
  return { sent };
}

async function noticeForRestaurant(restaurant, list, now) {
  const tz = restaurant.timezone || 'Asia/Tashkent';
  const { ymd: today, minutes: nowMin } = zoneDate(tz, now);

  const due = [];
  for (const r of list) {
    if (r.date !== today) continue;
    const resMin = hhmmToMinutes(r.time);
    if (resMin === null) continue;
    const noticeAt = morningNoticeMinute(restaurant, resMin);
    if (nowMin < noticeAt) continue;

    const created = zoneDate(tz, r.createdAt || now);
    const createdAfterNotice = created.ymd === today && created.minutes >= noticeAt;
    const tooLate = nowMin > resMin + 30;
    if (createdAfterNotice || tooLate) {
      await claimMorning(r._id); // yubormasdan belgilanadi
      continue;
    }
    due.push(r);
  }
  if (!due.length) return 0;

  // Xodim yo'q — band qilinmaydi (ulanishi bilan keyingi tekshiruvda yuboriladi)
  const staff = await activeStaff(restaurant._id);
  if (!staff.length) return 0;

  const claimed = [];
  for (const r of due) {
    const full = await claimMorning(r._id);
    if (full && MORNING_STATUSES.includes(full.status)) claimed.push(full);
  }
  if (!claimed.length) return 0;
  claimed.sort((a, b) => String(a.time).localeCompare(String(b.time)));

  const guests = claimed.reduce((s, r) => s + (Number(r.guests) || 0), 0);
  const header = [
    `🌅 <b>BUGUNGI BRONLAR — ${claimed.length} ta</b> (${guests} mehmon)`,
    `${fmtReservationDate(today)}`,
    '',
    'Bugun quyidagi mehmonlar kelishi kutilmoqda.',
    '📞 Iltimos, har biriga <b>qo‘ng‘iroq qilib</b>, kelish-kelmasligini aniqlashtirib oling va natijani tugma bilan belgilang.',
    '',
    ...claimed.map((r) => `🕐 <b>${esc(r.time)}</b> · 👥 ${Number(r.guests) || 0} · ${esc(r.name)} · 📞 ${esc(r.phone)}`),
  ].join('\n');

  await Promise.all(staff.map(async (s) => {
    await sendToStaff(s.telegramUserId, header);
    for (const r of claimed) {
      await sendReservationCard(r, s.telegramUserId, {
        title: r.status === 'pending'
          ? '🔔 <b>BUGUNGI BRON — hali javob berilmagan!</b>'
          : '📞 <b>BUGUNGI BRON — qo‘ng‘iroq qilib aniqlashtiring</b>',
      });
    }
  }));
  return claimed.length;
}

/*
 * ═══ MENYUNI MAVJUD XODIMLARGA YETKAZISH ═══
 * Pastki menyu faqat xabar bilan birga yuboriladi. Oldin ulangan
 * xodimlarda u yo'q — server ishga tushganda (MENU_VERSION
 * oshganda) har biriga BIR MARTA yuboriladi. Atomik belgi —
 * bir nechta server nusxasida ham takrorlanmaydi.
 */
export async function ensureStaffMenus() {
  if (!isRestaurantBotEnabled()) return;
  const pending = await RestaurantTelegramStaff.find({
    isActive: true,
    telegramUserId: { $ne: null },
    menuVersion: { $not: { $gte: MENU_VERSION } },
  }).select('_id telegramUserId restaurantId').lean();

  for (const s of pending) {
    const claimed = await RestaurantTelegramStaff.findOneAndUpdate(
      { _id: s._id, menuVersion: { $not: { $gte: MENU_VERSION } } },
      { $set: { menuVersion: MENU_VERSION } },
    );
    if (!claimed) continue;
    const restaurant = await Restaurant.findById(s.restaurantId).select('name').lean();
    await sendMainMenu(s.telegramUserId, {
      intro: [
        '🆕 <b>Bot yangilandi</b>',
        '',
        `Pastda yangi menyu paydo bo‘ldi (<b>${esc(restaurant?.name || 'Restoran')}</b>):`,
        `${MENU.reservations} — yopilmagan bronlar`,
        `${MENU.today} — bugungi buyurtmalar`,
        '',
        'Endi buyurtmani qabul qilgach <b>🚴 Kuryerga ulashish</b> tugmasi ham bor.',
      ].join('\n'),
    });
  }
}
