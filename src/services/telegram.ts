import { config } from '../config/index.js';

const TG_API = `https://api.telegram.org/bot${config.telegramBotToken}`;

// Foydalanuvchiga push xabar yuborish (buyurtma statusi, bron tasdiqi)
export async function notifyUser(telegramId: string, text: string): Promise<void> {
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
        parse_mode: 'HTML',
      }),
    });
  } catch (err) {
    console.error('Telegram xabar xatosi:', err);
  }
}

// WebApp tugmasi bilan xabar (ilovani ochish)
export async function sendWebAppButton(telegramId: string, webAppUrl: string): Promise<void> {
  if (!config.telegramBotToken) return;
  await fetch(`${TG_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: telegramId,
      text: 'LokmaGo — restoran va kafelar. Buyurtma bering, stol bron qiling!',
      reply_markup: {
        inline_keyboard: [[{ text: '🍽 Ilovani ochish', web_app: { url: webAppUrl } }]],
      },
    }),
  });
}

// Bot webhook update'ini qayta ishlash (/start buyrug'i)
interface TelegramUpdate {
  message?: {
    chat: { id: number };
    text?: string;
    from?: { id: number; first_name?: string };
  };
}

export async function handleBotUpdate(update: TelegramUpdate): Promise<void> {
  const message = update.message;
  if (!message?.text) return;

  if (message.text === '/start') {
    const webAppUrl = config.clientOrigin;
    await sendWebAppButton(String(message.chat.id), webAppUrl);
  }
}
