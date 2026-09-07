import crypto from 'node:crypto';
import { config } from '../config/index.js';
import { RestaurantTelegramStaff } from '../models/RestaurantTelegramStaff.js';
import { Restaurant } from '../models/Restaurant.js';

/*
 * ═══════════════════════════════════════════════════════════
 * RESTORAN TELEGRAM BOTI — ULANISH QISMI
 * ═══════════════════════════════════════════════════════════
 *
 * Bu fayl faqat XODIMNI ULASH bilan shug'ullanadi:
 * deep-link, /start, username tekshiruvi, tasdiqlash.
 *
 * Buyurtma yuborish va status tugmalari alohida faylda
 * bo'ladi — shunda bu yerdagi mantiq sodda qoladi.
 */

const TG = () => `https://api.telegram.org/bot${config.restaurantBotToken}`;

/** Bot sozlanganmi. Sozlanmagan bo'lsa hech narsa qilinmaydi. */
export function isRestaurantBotEnabled() {
  return Boolean(config.restaurantBotToken);
}

let cachedUsername = null;

/** Bot username'i — deep-link qurish uchun. */
export async function getRestaurantBotUsername() {
  if (cachedUsername) return cachedUsername;
  if (!isRestaurantBotEnabled()) return null;
  try {
    const r = await fetch(`${TG()}/getMe`);
    const j = await r.json();
    cachedUsername = j?.result?.username || null;
    return cachedUsername;
  } catch {
    return null;
  }
}

/** Telegram'ga xabar yuborish. Xato bo'lsa jimgina o'tadi. */
export async function sendToStaff(chatId, text, replyMarkup = null) {
  if (!isRestaurantBotEnabled()) return null;
  try {
    const r = await fetch(`${TG()}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      }),
    });
    return await r.json();
  } catch (e) {
    console.error('[restaurantBot] sendMessage:', e.message);
    return null;
  }
}

/** Mavjud xabarni tahrirlash — tugma bosilgach holatni yangilash uchun. */
export async function editStaffMessage(chatId, messageId, text, replyMarkup = null) {
  if (!isRestaurantBotEnabled()) return null;
  try {
    const r = await fetch(`${TG()}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: 'HTML',
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      }),
    });
    return await r.json();
  } catch (e) {
    console.error('[restaurantBot] editMessageText:', e.message);
    return null;
  }
}

/** Tugma bosilganini tasdiqlash — bosilgandagi "soat" belgisini o'chiradi. */
async function answerCallback(callbackId, text = '') {
  if (!isRestaurantBotEnabled()) return;
  try {
    await fetch(`${TG()}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackId, text }),
    });
  } catch { /* muhim emas */ }
}

/*
 * ═══ ULANISH TOKENI ═══
 *
 * Admin panelda "Telegram botga ulash" bosilganda chaqiriladi.
 *
 * Token 24 soat yashaydi. Nima uchun muddat qo'yilgan: link
 * chatga yuborilib, keyin unutilib ketishi mumkin. Muddatsiz
 * token esa abadiy ochiq eshik bo'lib qolardi.
 */
export async function createConnectLink(staffId) {
  const token = crypto.randomBytes(16).toString('hex');

  const staff = await RestaurantTelegramStaff.findByIdAndUpdate(
    staffId,
    {
      connectToken: token,
      connectTokenExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
    { new: true },
  );
  if (!staff) return null;

  const botUsername = await getRestaurantBotUsername();
  if (!botUsername) return null;

  return `https://t.me/${botUsername}?start=${token}`;
}

/*
 * ═══ /start <token> ═══
 *
 * TZ 6-BAND — ENG MUHIM QOIDA:
 * Username admin panelda ro'yxatdan o'tmagan bo'lsa, bot
 * HECH QANDAY javob bermaydi. Salomlashmaydi, "siz kimsiz?"
 * demaydi, restoranlar ro'yxatini ko'rsatmaydi.
 *
 * Sabab xavfsizlik: bot havolasi ochiq, uni istalgan odam
 * bosishi mumkin. Har qanday javob — hatto "sizga ruxsat yo'q"
 * ham — botning mavjudligini va u restoranlar bilan
 * ishlashini oshkor qiladi. Jim turish eng xavfsizi.
 */
export async function handleStart(msg, token) {
  const from = msg.from || {};
  const tgUserId = String(from.id);
  const username = (from.username || '').toLowerCase();

  // Token yo'q — oddiy /start. Jim.
  if (!token) return;

  const staff = await RestaurantTelegramStaff.findOne({
    connectToken: token,
    connectTokenExpiresAt: { $gt: new Date() },
  });

  // Token noto'g'ri yoki muddati o'tgan — jim.
  if (!staff) return;

  /*
   * IKKINCHI QATLAM: token to'g'ri bo'lsa ham, username mos
   * kelishi shart. Link boshqa odamga yuborilgan bo'lishi
   * mumkin — o'shanda u ulanib olmasligi kerak.
   */
  if (!username || username !== staff.username) return;

  // Bu Telegram akkaunt boshqa restoranga ulanganmi (TZ 20-band)
  const taken = await RestaurantTelegramStaff.findOne({
    telegramUserId: tgUserId,
    isActive: true,
    _id: { $ne: staff._id },
  });
  if (taken) {
    await sendToStaff(
      tgUserId,
      'Bu Telegram akkaunt allaqachon boshqa restoranga ulangan.\n'
      + 'Avval o‘sha restoran panelidan uzing.',
    );
    return;
  }

  const restaurant = await Restaurant.findById(staff.restaurantId).select('name').lean();
  if (!restaurant) return;

  // Vaqtincha saqlab qo'yamiz — tasdiqlash tugmasi uchun
  staff.telegramUserId = tgUserId;
  staff.firstName = from.first_name || '';
  staff.lastName = from.last_name || '';
  await staff.save();

  await sendToStaff(
    tgUserId,
    `👋 Assalomu alaykum, ${from.first_name || username}!\n\n`
    + `🏪 Siz <b>${restaurant.name}</b> restorani xodimisiz?`,
    {
      inline_keyboard: [[
        { text: '✅ Ha', callback_data: `connect:yes:${staff._id}` },
        { text: '❌ Yo‘q', callback_data: `connect:no:${staff._id}` },
      ]],
    },
  );
}

/*
 * ═══ TASDIQLASH TUGMASI ═══
 */
export async function handleConnectCallback(cq) {
  const [, answer, staffId] = String(cq.data || '').split(':');
  const tgUserId = String(cq.from?.id);

  const staff = await RestaurantTelegramStaff.findById(staffId);
  if (!staff || staff.telegramUserId !== tgUserId) {
    await answerCallback(cq.id);
    return;
  }

  if (answer === 'no') {
    // Bog'lanishni bekor qilamiz — yozuv qoladi, lekin ulanmagan
    staff.telegramUserId = null;
    staff.connectToken = null;
    await staff.save();

    await answerCallback(cq.id, 'Bekor qilindi');
    await editStaffMessage(tgUserId, cq.message.message_id, 'Ulanish bekor qilindi.');
    return;
  }

  const restaurant = await Restaurant.findById(staff.restaurantId).select('name').lean();

  /*
   * Token BIR MARTALIK: tasdiqlangach o'chiriladi, shunda
   * o'sha link bilan ikkinchi marta ulanib bo'lmaydi.
   */
  staff.connectToken = null;
  staff.connectTokenExpiresAt = null;
  staff.isActive = true;
  staff.connectedAt = new Date();
  await staff.save();

  await answerCallback(cq.id, 'Ulandi');
  await editStaffMessage(
    tgUserId,
    cq.message.message_id,
    `✅ Telegram akkauntingiz <b>${restaurant?.name || ''}</b> restoraniga ulandi.\n\n`
    + 'Endi bu restoranga keladigan buyurtmalar shu bot orqali sizga yuboriladi.',
  );
}

/*
 * ═══ WEBHOOK KIRISH NUQTASI ═══
 *
 * Faqat ulanish bilan bog'liq yangilanishlarni qayta ishlaydi.
 * Buyurtma tugmalari keyingi bosqichda shu yerga qo'shiladi.
 */
export async function handleRestaurantBotUpdate(update) {
  try {
    if (update.message?.text) {
      const text = update.message.text.trim();
      if (text.startsWith('/start')) {
        const token = text.split(/\s+/)[1] || '';
        await handleStart(update.message, token);
      }
      // Boshqa har qanday matnga javob bermaymiz (TZ 6-band)
      return;
    }

    if (update.callback_query) {
      const data = String(update.callback_query.data || '');
      if (data.startsWith('connect:')) {
        await handleConnectCallback(update.callback_query);
      }
    }
  } catch (e) {
    console.error('[restaurantBot] update:', e.message);
  }
}
