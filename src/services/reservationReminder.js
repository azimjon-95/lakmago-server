import { config } from '../config/index.js';
import { Reservation } from '../models/Reservation.js';
import { User } from '../models/User.js';
import { Restaurant } from '../models/Restaurant.js';
import { zonedToUtc } from './restaurantTime.js';
import { getIO } from '../sockets/io.js';

const TG_API = `https://api.telegram.org/bot${config.telegramBotToken}`;

async function tg(method, body) {
  if (!config.telegramBotToken) return null;
  try {
    const res = await fetch(`${TG_API}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return await res.json();
  } catch (e) {
    console.error(`[reservation] TG ${method}:`, e.message);
    return null;
  }
}

// Vaqt formatlash: 19:00
// 'uz-UZ' lokali Node'da bo'lmasligi mumkin — xato bo'lsa
// oddiy formatga qaytamiz
const fmtTime = (d) => {
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return '';
  try {
    return date.toLocaleTimeString('uz-UZ', { hour: '2-digit', minute: '2-digit', hour12: false });
  } catch {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }
};

/*
 * Bron vaqti — mijoz tanlagan soat (restoran vaqti) matn sifatida.
 * scheduledAt ni server zonasida formatlash noto'g'ri soat
 * ko'rsatardi (UTC serverda 10:00 o'rniga 05:00).
 */
const resTime = (r) => r.time || fmtTime(r.scheduledAt);

// ===== ESLATMA TURLARI =====
// Har biri o'z matni va tugmalari bilan
const REMINDERS = {
  h90: {
    minutes: 90,
    text: (r) => `⏰ <b>Eslatma</b>\n\n${r.restaurantName} restoranida bronigizga <b>1.5 soat</b> qoldi.\n\n📅 Vaqt: ${resTime(r)}\n👥 Mehmonlar: ${r.guests} kishi\n\nRejangiz o'zgarmadimi?`,
    buttons: (id) => [[
      { text: '✅ Boramiz', callback_data: `resv_coming_${id}` },
      { text: '❌ Bora olmaymiz', callback_data: `resv_not_coming_${id}` },
    ]],
  },
  h60: {
    minutes: 60,
    text: (r) => `⏰ <b>Eslatma</b>\n\n${r.restaurantName} — bronigizga <b>1 soat</b> qoldi.\n\n📅 Vaqt: ${resTime(r)}\n👥 Mehmonlar: ${r.guests} kishi`,
    buttons: (id) => [[
      { text: '✅ Boramiz', callback_data: `resv_coming_${id}` },
      { text: '❌ Bora olmaymiz', callback_data: `resv_not_coming_${id}` },
    ]],
  },
  m30: {
    minutes: 30,
    text: (r) => `🔔 <b>Tez orada!</b>\n\n${r.restaurantName} — bronigizga <b>30 daqiqa</b> qoldi.\n\n📅 Vaqt: ${resTime(r)}\n\nStolingiz tayyorlanmoqda.`,
    buttons: (id) => [[
      { text: '🚗 Yo‘ldamiz', callback_data: `resv_on_way_${id}` },
      { text: '❌ Bora olmaymiz', callback_data: `resv_not_coming_${id}` },
    ]],
  },
  arrival: {
    minutes: 0,
    text: (r) => `🍽 <b>Bron vaqti keldi!</b>\n\n${r.restaurantName} sizni kutmoqda.\n\n📅 ${resTime(r)}\n👥 ${r.guests} kishi`,
    buttons: (id) => [[
      { text: '🚗 Yo‘ldamiz', callback_data: `resv_on_way_${id}` },
      { text: '✅ Keldik', callback_data: `resv_arrived_${id}` },
    ]],
  },
};

// Bitta eslatmani yuborish
async function sendReminder(reservation, key) {
  const meta = REMINDERS[key];
  if (!meta) return false;

  const user = await User.findById(reservation.userId).select('telegramId').lean();
  if (!user?.telegramId) return false;

  const res = await tg('sendMessage', {
    chat_id: user.telegramId,
    text: meta.text(reservation),
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: meta.buttons(reservation._id) },
  });

  if (res?.ok) {
    reservation.reminders[key].sent = true;
    reservation.reminders[key].sentAt = new Date();
    await reservation.save();
    return true;
  }
  return false;
}

// ===== ASOSIY TEKSHIRUV =====
// Har 5 daqiqada ishlaydi: vaqti kelgan eslatmalarni yuboradi.
export async function checkReservationReminders() {
  if (!config.telegramBotToken) return { sent: 0 };

  const now = Date.now();
  let sent = 0;

  /*
   * Faqat faol bronlar. Oyna ATAYLAB keng (±14 soat): eski bronlarda
   * scheduledAt server zonasida xato yozilgan bo'lishi mumkin —
   * haqiqiy vaqt pastda date + time + restoran zonasidan hisoblanadi.
   */
  const active = await Reservation.find({
    scheduledAt: { $gte: new Date(now - 14 * 60 * 60_000), $lte: new Date(now + 16 * 60 * 60_000) },
    status: { $in: ['pending', 'confirmed', 'coming', 'on_way'] },
  });

  const restIds = [...new Set(active.map((r) => String(r.restaurantId)))];
  const tzMap = new Map((await Restaurant.find({ _id: { $in: restIds } }).select('timezone').lean())
    .map((x) => [String(x._id), x.timezone || 'Asia/Tashkent']));

  for (const r of active) {
    const trueAt = zonedToUtc(r.date, r.time, tzMap.get(String(r.restaurantId)) || 'Asia/Tashkent') || r.scheduledAt;
    if (!trueAt) continue;
    const minutesLeft = Math.round((new Date(trueAt).getTime() - now) / 60_000);

    for (const [key, meta] of Object.entries(REMINDERS)) {
      if (r.reminders?.[key]?.sent) continue;
      // Eslatma oynasi: belgilangan vaqtdan 5 daqiqa oldin/keyin
      const inWindow = key === 'arrival'
        ? minutesLeft <= 0 && minutesLeft > -15
        : minutesLeft <= meta.minutes && minutesLeft > meta.minutes - 6;

      if (inWindow) {
        try {
          if (await sendReminder(r, key)) sent++;
        } catch (e) {
          console.error(`[reservation] eslatma xatosi (${r._id}):`, e.message);
        }
      }
    }
  }

  return { sent, checked: active.length };
}

// ===== MIJOZ JAVOBI (tugma bosilganda) =====
export async function handleReservationResponse(callbackQuery) {
  const data = callbackQuery.data || '';
  const m = data.match(/^resv_(coming|not_coming|on_way|arrived)_(.+)$/);
  if (!m) return false;

  const [, action, reservationId] = m;
  const telegramId = String(callbackQuery.from.id);
  if (!/^[a-f\d]{24}$/i.test(reservationId)) return false;

  const reservation = await Reservation.findById(reservationId);
  if (!reservation) {
    await tg('answerCallbackQuery', {
      callback_query_id: callbackQuery.id,
      text: 'Bron topilmadi',
      show_alert: true,
    });
    return true;
  }

  // Faqat bron EGASI javob bera oladi (telegramId avval o'qilib, tekshirilmasdi)
  const owner = await User.findById(reservation.userId).select('telegramId').lean();
  if (!owner?.telegramId || String(owner.telegramId) !== telegramId) {
    await tg('answerCallbackQuery', {
      callback_query_id: callbackQuery.id,
      text: 'Bu bron sizga tegishli emas',
      show_alert: true,
    });
    return true;
  }

  // Yopilgan bronni mijoz eski eslatma tugmasi bilan qayta "ochib" yubormasin
  if (['rejected', 'cancelled', 'completed'].includes(reservation.status)) {
    await tg('answerCallbackQuery', {
      callback_query_id: callbackQuery.id,
      text: 'Bu bron allaqachon yopilgan',
      show_alert: true,
    });
    return true;
  }

  // Holatni yangilaymiz
  reservation.status = action;
  reservation.responses.push({ action, at: new Date() });
  await reservation.save();

  // Mijozga tasdiq
  const LABELS = {
    coming: '✅ Rahmat! Restoranga xabar berdik.',
    not_coming: '❌ Bron bekor qilindi. Boshqa safar kutamiz!',
    on_way: '🚗 Yaxshi yo‘l! Restoran sizni kutmoqda.',
    arrived: '🎉 Xush kelibsiz! Yoqimli ishtaha.',
  };
  await tg('answerCallbackQuery', {
    callback_query_id: callbackQuery.id,
    text: LABELS[action] || 'Qabul qilindi',
  });

  // Xabar tugmalarini olib tashlaymiz (takror bosilmasin)
  if (callbackQuery.message) {
    await tg('editMessageReplyMarkup', {
      chat_id: callbackQuery.message.chat.id,
      message_id: callbackQuery.message.message_id,
      reply_markup: { inline_keyboard: [] },
    });
    // Javobni xabar ostiga qo'shamiz
    await tg('sendMessage', {
      chat_id: callbackQuery.message.chat.id,
      text: LABELS[action] || 'Qabul qilindi',
    });
  }

  import('./notifications.js')
    .then((m) => m.resolveReservationNotification(reservation))
    .catch(() => {});

  // Restoran botidagi xodimlar kartasi yangilanadi ("bora olmaymiz" — alohida xabar ham)
  import('./restaurantBotOrders.js')
    .then((m) => m.notifyReservationChangedByCustomer(reservation._id))
    .catch((e) => console.error('[restaurantBot] mijoz javobi:', e.message));

  // Restoranga real-time xabar
  const io = getIO();
  io?.to(`restaurant:${reservation.restaurantId}`).emit('reservation:update', {
    reservationId: String(reservation._id),
    status: action,
    name: reservation.name,
    time: reservation.time,
    guests: reservation.guests,
  });
  io?.to('admin').emit('reservation:update', { reservationId: String(reservation._id), status: action });

  return true;
}

// ===== RESTORAN JAVOBI (tasdiqlash/rad etish) =====
// Mijozga bot orqali xabar yuboradi.
export async function notifyReservationDecision(reservation, decision, reason = '') {
  const user = await User.findById(reservation.userId).select('telegramId').lean();
  if (!user?.telegramId) return false;

  const text = decision === 'confirmed'
    ? `✅ <b>Bron tasdiqlandi!</b>\n\n${reservation.restaurantName}\n📅 ${reservation.date} · ${reservation.time}\n👥 ${reservation.guests} kishi\n\nSizni kutamiz!`
    : `❌ <b>Bron rad etildi</b>\n\n${reservation.restaurantName}\n📅 ${reservation.date} · ${reservation.time}\n${reason ? `\nSabab: ${reason}` : ''}\n\nBoshqa vaqt yoki restoran tanlashingiz mumkin.`;

  await tg('sendMessage', {
    chat_id: user.telegramId,
    text,
    parse_mode: 'HTML',
  });
  return true;
}
