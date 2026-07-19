import { config } from '../config/index.js';
import { User } from '../models/User.js';
import { Order } from '../models/Order.js';
import { Reservation } from '../models/Reservation.js';

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
    console.error(`[botMenu] ${method}:`, e.message);
    return null;
  }
}

const som = (n) => (n ?? 0).toLocaleString('ru-RU');

const ORDER_STATUS = {
  pending: '🕐 Kutilmoqda',
  accepted: '✅ Qabul qilindi',
  preparing: '👨‍🍳 Tayyorlanmoqda',
  ready: '📦 Tayyor',
  delivering: '🚗 Yo\u2018lda',
  delivered: '✅ Yetkazildi',
  cancelled: '❌ Bekor qilindi',
};

const RESV_STATUS = {
  pending: '🕐 Tasdiq kutilmoqda',
  confirmed: '✅ Tasdiqlandi',
  rejected: '❌ Rad etildi',
  cancelled: '❌ Bekor qilindi',
  coming: '✅ Boramiz',
  not_coming: '❌ Bora olmaymiz',
  on_way: '🚗 Yo\u2018ldamiz',
  arrived: '🎉 Keldik',
  completed: '✅ Yakunlandi',
};

// Orqaga qaytish tugmasi
const backButton = () => ([[{ text: '◀️ Orqaga', callback_data: 'menu_main' }]]);

// ===== BUYURTMALARIM =====
async function showOrders(chatId, user) {
  const orders = await Order.find({ userId: user._id })
    .sort({ createdAt: -1 })
    .limit(5)
    .lean();

  if (!orders.length) {
    return tg('sendMessage', {
      chat_id: chatId,
      text: '📦 <b>Buyurtmalarim</b>\n\nHozircha buyurtma bermagansiz.\n\nIlovaga kirib birinchi buyurtmangizni bering!',
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🍽 Buyurtma berish', web_app: { url: config.webappUrl } }],
          ...backButton(),
        ],
      },
    });
  }

  const lines = orders.map((o) => {
    const d = new Date(o.createdAt).toLocaleDateString('uz-UZ', { day: '2-digit', month: '2-digit' });
    const items = (o.items || []).map((i) => `${i.name}×${i.quantity}`).join(', ');
    return `${ORDER_STATUS[o.status] || o.status}\n🏪 ${o.restaurantName}\n🍽 ${items}\n💰 ${som(o.total)} so'm · ${d}`;
  });

  return tg('sendMessage', {
    chat_id: chatId,
    text: `📦 <b>Oxirgi buyurtmalaringiz</b>\n\n${lines.join('\n\n')}`,
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '🍽 Yangi buyurtma', web_app: { url: config.webappUrl } }],
        ...backButton(),
      ],
    },
  });
}

// ===== BRONLARIM =====
async function showReservations(chatId, user) {
  const list = await Reservation.find({ userId: user._id })
    .sort({ scheduledAt: -1 })
    .limit(5)
    .lean();

  if (!list.length) {
    return tg('sendMessage', {
      chat_id: chatId,
      text: '📅 <b>Bronlarim</b>\n\nHozircha stol bron qilmagansiz.\n\nRestoran sahifasidan stol bron qilishingiz mumkin.',
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🍽 Restoranlar', web_app: { url: config.webappUrl } }],
          ...backButton(),
        ],
      },
    });
  }

  const lines = list.map((r) =>
    `${RESV_STATUS[r.status] || r.status}\n🏪 ${r.restaurantName}\n📅 ${r.date} · ${r.time}\n👥 ${r.guests} kishi`);

  return tg('sendMessage', {
    chat_id: chatId,
    text: `📅 <b>Bronlaringiz</b>\n\n${lines.join('\n\n')}`,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: backButton() },
  });
}

// ===== BONUS VA DO'STLAR =====
async function showBonus(chatId, user) {
  const link = `https://t.me/${config.botUsername}?start=ref_${user._id}`;
  const count = user.referralCount || 0;
  const balance = user.bonusBalance || 0;

  return tg('sendMessage', {
    chat_id: chatId,
    text:
      '💰 <b>Bonus va do\u2018stlar</b>\n\n' +
      `Hisobingiz: <b>${som(balance)} so'm</b>\n` +
      `Taklif qilganlar: <b>${count} ta</b>\n\n` +
      `Do'stingiz sizning havolangiz orqali qo'shilса:\n` +
      `• Siz — <b>+${som(config.referralReward)} so'm</b>\n` +
      `• Do'stingiz — <b>+${som(config.referralWelcomeBonus)} so'm</b>\n\n` +
      `🔗 Havolangiz:\n<code>${link}</code>\n\n` +
      'Bonusni buyurtmada ishlatishingiz mumkin.',
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '📤 Do\u2018stlarga yuborish', url: `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent('🍽 LokmaGo — mazali taomlar tez yetkaziladi! Havolam orqali qo\u2018shiling va bonus oling 👇')}` }],
        ...backButton(),
      ],
    },
  });
}

// ===== MANZILLARIM =====
async function showAddresses(chatId, user) {
  const list = user.addresses || [];

  if (!list.length) {
    return tg('sendMessage', {
      chat_id: chatId,
      text: '📍 <b>Manzillarim</b>\n\nHozircha manzil qo\u2018shmagansiz.\n\nIlovada manzil qo\u2018shsangiz — keyingi buyurtmalarda avtomatik ishlatiladi.',
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '📍 Manzil qo\u2018shish', web_app: { url: config.webappUrl } }],
          ...backButton(),
        ],
      },
    });
  }

  const lines = list.map((a, i) => {
    const parts = [a.address];
    if (a.entrance) parts.push(`${a.entrance}-kirish`);
    if (a.floor) parts.push(`${a.floor}-qavat`);
    if (a.flat) parts.push(`xon. ${a.flat}`);
    return `${i + 1}. <b>${a.title || 'Manzil'}</b>\n   ${parts.filter(Boolean).join(', ')}`;
  });

  return tg('sendMessage', {
    chat_id: chatId,
    text: `📍 <b>Saqlangan manzillaringiz</b>\n\n${lines.join('\n\n')}`,
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '⚙️ Boshqarish', web_app: { url: config.webappUrl } }],
        ...backButton(),
      ],
    },
  });
}

// ===== YORDAM =====
async function showHelp(chatId) {
  return tg('sendMessage', {
    chat_id: chatId,
    text:
      '☎️ <b>Yordam</b>\n\n' +
      '<b>Qanday buyurtma beraman?</b>\n' +
      '1. "Taom buyurtma qilish" tugmasini bosing\n' +
      '2. Restoran va taomlarni tanlang\n' +
      '3. Manzil va to\u2018lov usulini kiriting\n' +
      '4. Buyurtmani kuzatib boring\n\n' +
      '<b>Stol bron qilish</b>\n' +
      'Restoran sahifasida "Stol bron qilish" tugmasi bor. ' +
      'Bron vaqtidan oldin bot sizga eslatma yuboradi.\n\n' +
      '<b>Bonus</b>\n' +
      'Do\u2018stlaringizni taklif qiling — ikkalangiz ham bonus olasiz.\n\n' +
      '<b>Muammo bormi?</b>\n' +
      'Ilova ichidagi qo\u2018llab-quvvatlash tugmasi orqali yozing.',
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '💬 Qo\u2018llab-quvvatlash', web_app: { url: config.webappUrl } }],
        ...backButton(),
      ],
    },
  });
}

// ===== ASOSIY BOSHQARUVCHI =====
// Menyu tugmalari bosilganda chaqiriladi.
export async function handleMenuCallback(callbackQuery) {
  const data = callbackQuery.data || '';
  if (!data.startsWith('menu_')) return false;

  const chatId = String(callbackQuery.from.id);
  const user = await User.findOne({ telegramId: chatId });

  await tg('answerCallbackQuery', { callback_query_id: callbackQuery.id });

  if (!user) {
    await tg('sendMessage', {
      chat_id: chatId,
      text: 'Iltimos, avval /start buyrug\u2018ini bosing.',
    });
    return true;
  }

  switch (data) {
    case 'menu_orders': await showOrders(chatId, user); break;
    case 'menu_reservations': await showReservations(chatId, user); break;
    case 'menu_bonus': await showBonus(chatId, user); break;
    case 'menu_addresses': await showAddresses(chatId, user); break;
    case 'menu_help': await showHelp(chatId); break;
    case 'menu_main': {
      const { sendWebAppEntry } = await import('./referralStart.js');
      await sendWebAppEntry(chatId, user);
      break;
    }
    default: return false;
  }
  return true;
}
