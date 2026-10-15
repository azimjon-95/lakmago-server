import { config } from '../config/index.js';
import { Order } from '../models/Order.js';
import { Restaurant } from '../models/Restaurant.js';

/*
 * ═══ RESTORAN BILAN BOG'LANISH (Telegram Mini App) ═══
 * Mini App ichida tel: havolalari ishonchli ishlamaydi (Telegram openLink faqat http(s) ni ochadi).
 * Shuning uchun mijozga restoran raqami TELEGRAM KONTAKT KARTASI sifatida botdan yuboriladi
 * (sendContact): kartadagi raqamni bosish — telefon qo'ng'iroq oynasini ochadi.
 * Faqat shu buyurtma egasiga, restoran buyurtmani QABUL QILGANDAN keyin va yakunlanmaguncha.
 */
const TG_API = () => `https://api.telegram.org/bot${config.telegramBotToken}`;
const CALLABLE = ['accepted', 'preparing', 'ready', 'delivering'];

/** Telefonni xalqaro formatga: +998XXXXXXXXX (bo'shliq, qavs, tire olib tashlanadi) */
export function normalizeUzPhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 9) return `+998${digits}`;
  if (digits.length === 12 && digits.startsWith('998')) return `+${digits}`;
  if (digits.length >= 10 && digits.length <= 15) return `+${digits}`;
  return '';
}

/**
 * @returns {Promise<{ ok: boolean, code?: 'NOT_FOUND'|'NOT_ALLOWED'|'NO_PHONE'|'NO_TELEGRAM'|'SEND_FAILED' }>}
 */
export async function sendRestaurantContact(orderId, userId, telegramId) {
  const order = await Order.findOne({ _id: orderId, userId }).select('restaurantId status').lean();
  if (!order) return { ok: false, code: 'NOT_FOUND' };
  if (!CALLABLE.includes(order.status)) return { ok: false, code: 'NOT_ALLOWED' };
  const rest = await Restaurant.findById(order.restaurantId).select('name phone').lean();
  const phone = normalizeUzPhone(rest?.phone);
  if (!phone) return { ok: false, code: 'NO_PHONE' };
  if (!telegramId || !config.telegramBotToken) return { ok: false, code: 'NO_TELEGRAM' };

  try {
    const res = await fetch(`${TG_API()}/sendContact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: telegramId,
        phone_number: phone,
        first_name: String(rest.name || 'Restoran').slice(0, 64),
        last_name: 'LokmaGo',
      }),
      signal: AbortSignal.timeout(6000),
    });
    const j = await res.json().catch(() => ({}));
    return j?.ok ? { ok: true, phone } : { ok: false, code: 'SEND_FAILED' };
  } catch {
    return { ok: false, code: 'SEND_FAILED' };
  }
}
