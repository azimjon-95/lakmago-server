/*
 * SIGN IN WITH APPLE — sozlamalar (faqat iOS ilovasi; Telegram kirishiga hech qanday aloqasi yo'q).
 *
 *   APPLE_SIGNIN_ENABLED=true   Standart: O'CHIQ. O'chiq bo'lsa /auth/apple/* 404, ilovada tugma ko'rinmaydi.
 *   APPLE_CLIENT_IDS=uz.lokmago.app
 *                               Identity token `aud` (audience) sifatida QABUL qilinadigan Bundle ID(lar), vergul bilan.
 *                               Native iOS ilova uchun audience = ilovaning Bundle ID'si. Services ID (web) QO'SHILMAYDI —
 *                               shunda web oqimidan olingan tokenlar rad etiladi.
 *
 * Maxfiy kalit/secret KERAK EMAS: identity token Apple'ning OMMAVIY kalitlari (JWKS) bilan tekshiriladi.
 * Env har chaqiruvda o'qiladi (testlarda almashtirish uchun).
 */
const bool = (v) => String(v || '').trim().toLowerCase() === 'true';
const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

export function getAppleConfig() {
  return {
    enabled: bool(process.env.APPLE_SIGNIN_ENABLED),
    clientIds: list(process.env.APPLE_CLIENT_IDS || 'uz.lokmago.app'),
    issuer: 'https://appleid.apple.com',
    jwksUrl: process.env.APPLE_JWKS_URL || 'https://appleid.apple.com/auth/keys',
    challengeTtlSec: 300,          // bir martalik challenge: 5 daqiqa
    maxTokenAgeSec: 900,           // identity token `iat` dan 15 daqiqadan eski bo'lmasin
    clockToleranceSec: 30,
  };
}
