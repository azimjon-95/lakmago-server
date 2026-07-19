import { config } from '../config/index.js';

const TG_API = `https://api.telegram.org/bot${config.telegramBotToken}`;

// Foydalanuvchiga push xabar yuborish (buyurtma statusi, bron tasdiqi)
export async function notifyUser(telegramId, text) {
  if (!config.telegramBotToken) {
    console.log(`[telegram demo] ${telegramId}: ${text}`);
    return;
  }
  try {
    await fetch(`${TG_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: telegramId,
        text,
        parse_mode: 'HTML'
      })
    });
  } catch (err) {
    console.error('Telegram xabar xatosi:', err);
  }
}

// WebApp tugmasi bilan xabar (ilovani ochish)
export async function sendWebAppButton(telegramId, webAppUrl) {
  if (!config.telegramBotToken) return;
  await fetch(`${TG_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: telegramId,
      text: 'LokmaGo — restoran va kafelar. Buyurtma bering, stol bron qiling!',
      reply_markup: {
        inline_keyboard: [[{ text: '🍽 Ilovani ochish', web_app: { url: webAppUrl } }]]
      }
    })
  });
}

// Bot webhook update'ini qayta ishlash (/start buyrug'i)








// Bot webhook update'ini qayta ishlash
export async function handleBotUpdate(update) {
  // 1) Bot guruhга admin qilinganини aniqlash (my_chat_member event)
  if (update.my_chat_member) {
    const { chat, new_chat_member, old_chat_member } = update.my_chat_member;
    const status = new_chat_member?.status;
    const prevStatus = old_chat_member?.status;

    console.log(`[bot] my_chat_member: chat=${chat?.id} (${chat?.type}) ` +
      `"${chat?.title || ''}" ${prevStatus} → ${status}`);

    // Faqat guruh/superguruh (shaxsiy chat emas)
    if (chat?.type !== 'group' && chat?.type !== 'supergroup') return;

    try {
      const { onBotPromotedToAdmin, registerGroup } = await import('./telegramGroup.js');
      const { GroupChat } = await import('../models/GroupChat.js');

      if (status === 'administrator' || status === 'creator') {
        // Bot admin qilindi — darhol reklama yuborib pin qilamiz
        await onBotPromotedToAdmin(chat);
      } else if (status === 'member') {
        // Bot qo'shildi, lekin admin emas — yozib qo'yamiz.
        // Keyin admin qilinsa my_chat_member yana keladi.
        await registerGroup(chat, false);
        console.log(`[bot] "${chat.title}" — qo'shildi, lekin ADMIN EMAS. ` +
          'Pin qilish uchun admin huquqi kerak.');
      } else if (status === 'left' || status === 'kicked') {
        await GroupChat.findOneAndUpdate(
          { chatId: String(chat.id) },
          { isActive: false, isBotAdmin: false },
        );
        console.log(`[bot] "${chat.title}" — bot chiqarildi`);
      }
    } catch (e) {
      console.error('[bot] guruh xatosi:', e.message, e.stack);
    }
    return;
  }

  // 2) Callback tugmalar
  if (update.callback_query) {
    const data = update.callback_query.data || '';
    try {
      // Obuna tasdiqlash
      if (data === 'check_sub') {
        const { handleCheckSubscription } = await import('./referralStart.js');
        await handleCheckSubscription(update.callback_query);
        return;
      }
      // Bron javoblari (boramiz / bora olmaymiz / yo'ldamiz / keldik)
      if (data.startsWith('resv_')) {
        const { handleReservationResponse } = await import('./reservationReminder.js');
        await handleReservationResponse(update.callback_query);
        return;
      }
      // Asosiy menyu tugmalari
      if (data.startsWith('menu_')) {
        const { handleMenuCallback } = await import('./botMenu.js');
        await handleMenuCallback(update.callback_query);
        return;
      }
    } catch (e) {
      console.error('[bot] callback xatosi:', e.message);
    }
    return;
  }

  // 3) Oddiy xabarlar (/start yoki /start ref_<id>)
  const message = update.message;
  if (!message?.text) return;

  if (message.text.startsWith('/start')) {
    const telegramId = String(message.chat.id);
    // Referal kodni ajratamiz: "/start ref_123"
    const parts = message.text.split(' ');
    const startParam = parts[1] || '';

    try {
      const { handleStartCommand } = await import('./referralStart.js');
      await handleStartCommand(telegramId, startParam, message.from);
    } catch (e) {
      // Xato jim yutilmasin — logga yozamiz va mijozga xabar beramiz
      console.error('[bot] /start xatosi:', e.message, e.stack);
      await sendPlainMessage(telegramId,
        'Kechirasiz, texnik nosozlik. Bir ozdan keyin /start ni qayta bosing.');
    }
  }
}

// Oddiy matnli xabar (xato holatlari uchun)
async function sendPlainMessage(chatId, text) {
  if (!config.telegramBotToken) return;
  try {
    await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch { /* jim */ }
}
