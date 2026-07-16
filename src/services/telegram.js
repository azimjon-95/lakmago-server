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
    const { chat, new_chat_member } = update.my_chat_member;
    const status = new_chat_member?.status;

    // Guruh yoki superguruhда bot admin bo'ldi
    if ((chat.type === 'group' || chat.type === 'supergroup')) {
      if (status === 'administrator') {
        // Bot admin qilindi — reklama yuborib pin qilamiz (bir marta)
        const { onBotPromotedToAdmin } = await import('./telegramGroup.js');
        try { await onBotPromotedToAdmin(chat); } catch (e) { console.error('Guruh promo xatosi:', e.message); }
      } else if (status === 'left' || status === 'kicked') {
        // Bot guruhdan chiqarildi — nofaol qilamiz
        const { GroupChat } = await import('../models/GroupChat.js');
        await GroupChat.findOneAndUpdate({ chatId: String(chat.id) }, { isActive: false, isBotAdmin: false });
      }
    }
    return;
  }

  // 2) Oddiy xabarlar (/start)
  const message = update.message;
  if (!message?.text) return;

  if (message.text === '/start') {
    const webAppUrl = config.webappUrl;
    await sendWebAppButton(String(message.chat.id), webAppUrl);
  }
}
