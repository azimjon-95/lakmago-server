import { config } from '../config/index.js';

// Bot to'g'ri ishlashi uchun ZARUR update turlari.
// callback_query bo'lmasa — barcha tugmalar ishlamaydi.
// my_chat_member bo'lmasa — guruh aniqlash ishlamaydi.
const REQUIRED = ['message', 'callback_query', 'inline_query', 'my_chat_member', 'chat_member'];

async function tg(method, params) {
  const res = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params || {}),
  });
  return res.json();
}

// Webhook manzilini aniqlaymiz: WEBHOOK_BASE yoki WEBAPP_URL emas,
// balki API domeni kerak. .env da WEBHOOK_BASE bo'lsa o'shani olamiz.
function resolveBase() {
  const raw = process.env.WEBHOOK_BASE || process.env.API_PUBLIC_URL || '';
  return raw.trim().replace(/\/+$/, '');
}

/**
 * Server ishga tushganda webhook'ni tekshiradi va kerak bo'lsa
 * AVTOMATIK to'g'rilaydi. Qo'lda buyruq yozish shart emas.
 */
export async function ensureWebhook() {
  if (!config.telegramBotToken) return;

  try {
    const info = await tg('getWebhookInfo');
    const w = info.result || {};
    const allowed = w.allowed_updates || [];

    // Bo'sh ro'yxat = Telegram default, unda my_chat_member YO'Q
    const missing = allowed.length === 0
      ? ['my_chat_member', 'chat_member']
      : REQUIRED.filter((u) => !allowed.includes(u));

    // Hammasi joyida — tegmaymiz
    if (w.url && missing.length === 0) {
      console.log('✓ Telegram webhook to‘g‘ri sozlangan');
      return;
    }

    // Manzilni aniqlaymiz: mavjud webhook'dan yoki .env dan
    const base = resolveBase();
    const url = w.url || (base ? `${base}/bot/webhook` : '');

    if (!url) {
      console.warn(
        '⚠ Telegram webhook o‘rnatilmagan va WEBHOOK_BASE .env da yo‘q.\n' +
        '  Tugmalar va guruh aniqlash ISHLAMAYDI.\n' +
        '  Yechim: .env ga qo‘shing → WEBHOOK_BASE=https://api.domeningiz.uz\n' +
        '  yoki bir marta: npm run webhook https://api.domeningiz.uz',
      );
      return;
    }

    if (missing.length) {
      console.log(`⚠ Webhook'da yetishmayapti: ${missing.join(', ')} — tuzatilmoqda...`);
    }

    const set = await tg('setWebhook', {
      url,
      allowed_updates: REQUIRED,
      drop_pending_updates: false,
    });

    if (set.ok) {
      console.log(`✓ Telegram webhook avtomatik to‘g‘rilandi: ${url}`);
    } else {
      console.error(`✗ Webhook o‘rnatilmadi: ${set.description}`);
    }
  } catch (e) {
    console.error('✗ Webhook tekshiruvi xatosi:', e.message);
  }
}
