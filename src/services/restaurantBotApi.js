import crypto from 'node:crypto';
import { config } from '../config/index.js';

/*
 * ═══════════════════════════════════════════════════════════
 * RESTORAN BOTI — TELEGRAM TRANSPORT QATLAMI
 * ═══════════════════════════════════════════════════════════
 *
 * Telegram API bilan ishlashning YAGONA joyi. Boshqa bot
 * fayllari (ulanish, buyurtmalar, menyu) faqat shu yerdan
 * import qiladi — shuning uchun ular orasida aylanma
 * bog'liqlik yo'q.
 *
 * Hech bir funksiya xato TASHLAMAYDI: Telegram javob bermasa
 * yoki rad etsa — log yoziladi, `null`/`{ ok:false }`
 * qaytadi. Bot xatosi buyurtma oqimini hech qachon to'xtatmaydi.
 */

const TG = () => `https://api.telegram.org/bot${config.restaurantBotToken}`;
const TIMEOUT_MS = 10_000;

/** Bot sozlanganmi. Sozlanmagan bo'lsa hech narsa qilinmaydi. */
export function isRestaurantBotEnabled() {
  return Boolean(config.restaurantBotToken);
}

/*
 * Bu javoblar XATO EMAS — odatiy holat, logga yozilmaydi:
 *   • "message is not modified" — ikki manba bir xil matn bilan
 *     yangiladi (masalan bot va panel bir vaqtda);
 *   • "query is too old" — tugma bosilganidan ancha keyin javob.
 */
const QUIET_ERRORS = [/message is not modified/i, /query is too old/i, /query ID is invalid/i];

/** Umumiy Telegram chaqiruvi. */
export async function tgCall(method, body) {
  if (!isRestaurantBotEnabled()) return null;
  try {
    const r = await fetch(`${TG()}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const j = await r.json().catch(() => ({ ok: false, description: `HTTP ${r.status}` }));
    if (!j.ok && !QUIET_ERRORS.some((re) => re.test(j.description || ''))) {
      console.error(`[restaurantBot] ${method}: ${j.description || 'noma’lum xato'}`);
    }
    return j;
  } catch (e) {
    console.error(`[restaurantBot] ${method}:`, e.message);
    return null;
  }
}

/**
 * Xabar yuborish. `extra` — qo'shimcha Telegram parametrlari
 * (reply_parameters, link_preview_options ...).
 */
export async function sendToStaff(chatId, text, replyMarkup = null, extra = {}) {
  return tgCall('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    ...extra,
  });
}

/**
 * Mavjud xabarni tahrirlash. `replyMarkup` null bo'lsa inline
 * tugmalar olib tashlanadi (yakunlangan holat).
 */
export async function editStaffMessage(chatId, messageId, text, replyMarkup = null) {
  return tgCall('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

/**
 * Tugma bosilganini tasdiqlash — "soat" belgisini o'chiradi va
 * xodimga qisqa xabar (toast) ko'rsatadi. `alert: true` —
 * muhim ogohlantirish (OK tugmali oyna).
 *
 * HAR BIR callback'ga javob berilishi SHART: aks holda tugma
 * 15 soniyagacha "yuklanmoqda" holatida qotib turadi va xodim
 * bosildi-bosilmadi bilmay qayta-qayta bosadi.
 */
export async function answerCallback(callbackId, text = '', { alert = false } = {}) {
  if (!callbackId) return;
  await tgCall('answerCallbackQuery', {
    callback_query_id: callbackId,
    ...(text ? { text: String(text).slice(0, 190) } : {}),
    ...(alert ? { show_alert: true } : {}),
  });
}

/** HTML parse_mode uchun xavfsiz matn (mijoz kiritgan har qanday qiymat). */
export function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/*
 * ═══ RANGLI TUGMALAR (Bot API 9.4) ═══
 *
 * style: 'success' (yashil) · 'danger' (qizil) · 'primary' (ko'k).
 * Eski Telegram ilovalari bu maydonni e'tiborsiz qoldiradi —
 * tugma oddiy rangda chiqadi, hech narsa buzilmaydi.
 */
export function btn(text, data, style) {
  return { text, callback_data: data, ...(style ? { style } : {}) };
}

export function urlBtn(text, url, style) {
  return { text, url, ...(style ? { style } : {}) };
}

/*
 * ═══ WEBHOOK HIMOYASI (secret_token) ═══
 *
 * Avval /restaurant-bot/webhook ga istalgan kishi POST yuborib,
 * `from.id` ni xodimniki qilib ko'rsatsa — buyurtmani uning
 * nomidan qabul/bekor qila olardi. Endi Telegram har so'rovga
 * `X-Telegram-Bot-Api-Secret-Token` sarlavhasini qo'shadi va
 * server uni tekshiradi.
 *
 * Maxfiy qiymat bot tokenidan HMAC bilan olinadi — yangi .env
 * o'zgaruvchisi kerak emas, barcha server nusxalarida bir xil.
 *
 * Qattiq tekshiruv faqat setWebhook(secret_token) MUVAFFAQIYATLI
 * o'rnatilgandan keyin yoqiladi. O'rnatib bo'lmasa (WEBHOOK_BASE
 * yo'q, tarmoq xatosi) — bot ishlashda davom etadi (eski
 * xatti-harakat) va logga ogohlantirish yoziladi.
 */
let secretEnforced = false;

export function restaurantWebhookSecret() {
  if (!config.restaurantBotToken) return '';
  return crypto
    .createHmac('sha256', 'lokma-restaurant-bot-webhook')
    .update(config.restaurantBotToken)
    .digest('hex');
}

export function markWebhookSecretActive() {
  secretEnforced = true;
}

export function verifyRestaurantWebhook(headerValue) {
  const expected = restaurantWebhookSecret();
  const got = typeof headerValue === 'string' ? headerValue : '';
  if (got && expected && got.length === expected.length) {
    return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
  }
  // Sarlavha yo'q/noto'g'ri: faqat himoya hali yoqilmagan bo'lsa o'tkaziladi
  return !secretEnforced && !got;
}
