/*
 * Admin guruhi posti uchun havolalar (services/adminOrderMonitor.js): mijoz Telegram'i, manzil → Google Maps, buyurtma turi.
 * Toza funksiyalar (DB/tarmoqsiz) — tests/order-contact-links.test.mjs.
 */
const finite = (n) => typeof n === 'number' && Number.isFinite(n);

/**
 * Yaroqli koordinata → { lat, lng } (6 xona ≈ 0,1 m), aks holda null.
 * Rad etiladi: son emas, (0,0) ("null island"), diapazondan tashqari. Lat/lng almashib qolgan bo'lsa (O'zbekiston: lat 37–46,
 * lng 55–74) — to'g'rilanadi.
 */
export function cleanCoords(lat, lng) {
  const a = typeof lat === 'string' && lat.trim() !== '' ? Number(lat) : lat;
  const b = typeof lng === 'string' && lng.trim() !== '' ? Number(lng) : lng;
  if (!finite(a) || !finite(b)) return null;
  if (Math.abs(a) < 1e-6 && Math.abs(b) < 1e-6) return null;
  let la = a; let lo = b;
  if (la >= 55 && la <= 74 && lo >= 37 && lo <= 46) { la = b; lo = a; }   // almashgan
  if (Math.abs(la) > 90 || Math.abs(lo) > 180) return null;
  return { lat: Number(la.toFixed(6)), lng: Number(lo.toFixed(6)) };
}

/** Google Maps: koordinata bo'lsa aniq nuqta (pin), bo'lmasa manzil matni bo'yicha qidiruv, ikkisi ham yo'q — null. */
export function mapsUrl({ lat, lng, address } = {}) {
  const c = cleanCoords(lat, lng);
  if (c) return `https://www.google.com/maps/search/?api=1&query=${c.lat},${c.lng}`;
  const text = String(address || '').trim();
  if (text.length >= 5) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(text)}`;
  return null;
}

/** HTML atribut uchun (parse_mode: HTML) */
export const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;
const TG_ID_RE = /^\d{3,15}$/;

/**
 * Mijozga o'tish tugmasi:
 *   • username bor → https://t.me/username (har kim ocha oladi);
 *   • username yo'q, Telegram ID bor → tg://user?id=ID (bot bilan yozishgan mijoz profiliga);
 *   • hech biri yo'q (veb/telefon bilan kirgan) → null.
 */
export function customerTelegramButton(user) {
  const username = String(user?.username || '').replace(/^@/, '').trim();
  if (USERNAME_RE.test(username)) return { text: '👤 Mijoz Telegram', url: `https://t.me/${username}`, kind: 'username' };
  const id = String(user?.telegramId || '').trim();
  if (TG_ID_RE.test(id)) return { text: '👤 Mijoz profili (Telegram)', url: `tg://user?id=${id}`, kind: 'id' };
  return null;
}

/** Buyurtma turi qatori. */
export function fulfillmentLine(order) {
  switch (order?.fulfillment) {
    case 'pickup': return '🚶 <b>O‘zi olib ketadi</b>';
    case 'dinein': return '🍽 <b>Zalda (joyida)</b>';
    default: return '🛵 <b>Yetkazib berish</b>';
  }
}
