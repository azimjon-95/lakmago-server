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








export async function handleBotUpdate(update) {
  const message = update.message;
  if (!message?.text) return;

  if (message.text === '/start') {
    const webAppUrl = config.clientOrigin;
    await sendWebAppButton(String(message.chat.id), webAppUrl);
  }
}
