import { config } from '../config/index.js';
import { Reservation } from '../models/Reservation.js';
import { User } from '../models/User.js';
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
const fmtTime = (d) => new Date(d).toLocaleTimeString('uz-UZ', {
  hour: '2-digit', minute: '2-digit', hour12: false,
});

// ===== ESLATMA TURLARI =====
// Har biri o'z matni va tugmalari bilan
const REMINDERS = {
  h90: {
    minutes: 90,
    text: (r) => `⏰ <b>Eslatma</b>\n\n${r.restaurantName} restoranida bronigizga <b>1.5 soat</b> qoldi.\n\n📅 Vaqt: ${fmtTime(r.scheduledAt)}\n👥 Mehmonlar: ${r.guests} kishi\n\nRejangiz o'zgarmadimi?`,
    buttons: (id) => [[
      { text: '✅ Boramiz', callback_data: `resv_coming_${id}` },
      { text: '❌ Bora olmaymiz', callback_data: `resv_not_coming_${id}` },
    ]],
  },
  h60: {
    minutes: 60,
    text: (r) => `⏰ <b>Eslatma</b>\n\n${r.restaurantName} — bronigizga <b>1 soat</b> qoldi.\n\n📅 Vaqt: ${fmtTime(r.scheduledAt)}\n👥 Mehmonlar: ${r.guests} kishi`,
    buttons: (id) => [[
      { text: '✅ Boramiz', callback_data: `resv_coming_${id}` },
      { text: '❌ Bora olmaymiz', callback_data: `resv_not_coming_${id}` },
    ]],
  },
  m30: {
    minutes: 30,
    text: (r) => `🔔 <b>Tez orada!</b>\n\n${r.restaurantName} — bronigizga <b>30 daqiqa</b> qoldi.\n\n📅 Vaqt: ${fmtTime(r.scheduledAt)}\n\nStolingiz tayyorlanmoqda.`,
    buttons: (id) => [[
      { text: '🚗 Yo\u2018ldamiz', callback_data: `resv_on_way_${id}` },
      { text: '❌ Bora olmaymiz', callback_data: `resv_not_coming_${id}` },
    ]],
  },
  arrival: {
    minutes: 0,
    text: (r) => `🍽 <b>Bron vaqti keldi!</b>\n\n${r.restaurantName} sizni kutmoqda.\n\n📅 ${fmtTime(r.scheduledAt)}\n👥 ${r.guests} kishi`,
    buttons: (id) => [[
      { text: '🚗 Yo\u2018ldamiz', callback_data: `resv_on_way_${id}` },
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

  // Faqat faol bronlar (rad etilgan/bekor qilinganlar emas)
  const active = await Reservation.find({
    scheduledAt: { $gte: new Date(now - 30 * 60_000), $lte: new Date(now + 2 * 60 * 60_000) },
    status: { $in: ['pending', 'confirmed', 'coming', 'on_way'] },
  });

  for (const r of active) {
    if (!r.scheduledAt) continue;
    const minutesLeft = Math.round((new Date(r.scheduledAt).getTime() - now) / 60_000);

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

  if (sent > 0) console.log(`✓ Bron eslatmalari: ${sent} ta yuborildi`);
  return { sent, checked: active.length };
}

// ===== MIJOZ JAVOBI (tugma bosilganda) =====
export async function handleReservationResponse(callbackQuery) {
  const data = callbackQuery.data || '';
  const m = data.match(/^resv_(coming|not_coming|on_way|arrived)_(.+)$/);
  if (!m) return false;

  const [, action, reservationId] = m;
  const telegramId = String(callbackQuery.from.id);

  const reservation = await Reservation.findById(reservationId);
  if (!reservation) {
    await tg('answerCallbackQuery', {
      callback_query_id: callbackQuery.id,
      text: 'Bron topilmadi',
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
    on_way: '🚗 Yaxshi yo\u2018l! Restoran sizni kutmoqda.',
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
