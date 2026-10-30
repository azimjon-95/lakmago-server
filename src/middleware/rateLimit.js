import rateLimit from 'express-rate-limit';

/**
 * So'rovlar sonini cheklash — brute-force va suiiste'mol
 * (abuse) hujumlaridan himoya.
 *
 * XAVFSIZLIK AUDITI (2026-08): loyihada UMUMAN rate limiting
 * yo'q edi — bu degani /auth/login endpointiga cheksiz parol
 * urinishi (brute-force) qilish mumkin edi. Endi uch daraja:
 *
 *   1) loginLimiter — login/parol tekshiruvchi endpointlar
 *      uchun QATTIQ chegara (IP bo'yicha)
 *   2) apiLimiter — umumiy API uchun YENGIL, asosiy DoS/skript
 *      hujumlaridan himoya (oddiy foydalanuvchi hech qachon
 *      duch kelmaydi)
 *   3) writeLimiter — POST/PATCH/DELETE (yozuv) so'rovlari
 *      uchun o'rtacha — spam/avtomatlashtirilgan hujumlarni
 *      sekinlashtiradi
 */

// Standart javob — front-end tushunadigan, oddiy JSON
function limitHandler(req, res) {
  res.status(429).json({
    error: 'Juda ko‘p urinish. Birozdan keyin qayta urinib ko‘ring.',
  });
}

/** Login/parol — 15 daqiqada IP boshiga 10 ta urinish. */
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: limitHandler,
  // Muvaffaqiyatli so'rovlar hisoblanmaydi — faqat xato/noto'g'ri
  // urinishlar hisobga olinadi, haqiqiy foydalanuvchi tez-tez
  // kirib-chiqsa ham bloklanib qolmasin
  skipSuccessfulRequests: true,
});

/** Umumiy API — daqiqada IP boshiga 300 so'rov (keng, oddiy foydalanish uchun sezilmaydi). */
/*
 * TO'LOV CALLBACK'LARI cheklovdan CHIQARILADI.
 *
 * Click/Payme/Paynet so'rovlari bitta IP to'plamidan keladi va
 * band paytda ular ko'p bo'lishi mumkin. Cheklovga yetsa server
 * 429 qaytaradi — shlyuz esa buni "server ishlamayapti" deb
 * qabul qiladi.
 *
 * Oqibati og'ir: mijoz puli yechilgan, lekin Complete
 * yetib bormagani uchun buyurtma restoranga CHIQMAYDI va
 * hech kim buni payqamaydi.
 *
 * Bu yo'llar imzo bilan himoyalangan (md5 + maxfiy kalit),
 * ya'ni cheklovsiz ham suiiste'mol qilib bo'lmaydi — imzosiz
 * so'rov baribir rad etiladi.
 */
const WEBHOOK_PATHS = [
  '/payments/click/prepare',
  '/payments/click/complete',
  '/payments/payme',
  '/payments/paynet',   // startsWith orqali /payments/paynet/uws ham qamraladi
];

export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  handler: limitHandler,
  skip: (req) => WEBHOOK_PATHS.some((p) => req.path.startsWith(p)),
});

/** Yozuv amallari (buyurtma, to'lov va h.k.) — daqiqada 60. */
export const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: limitHandler,
});

/**
 * Kuryer jonli joylashuvi — har ~8 soniyada bitta so'rov (daqiqada ~8), ehtiyot bilan 40.
 * Havola tokeni bo'yicha cheklanadi (bir nechta kuryer bir IP ortida bo'lishi mumkin).
 */
export const courierLocationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 40,
  keyGenerator: (req) => `loc:${req.params.token || req.ip}`,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { keyGeneratorIpFallback: false },
  handler: limitHandler,
});

/** Telegram havolasi orqali kirishni BOSHLASH — IP boshiga 10 daqiqada 20 ta (spam so'rovlar bazani to'ldirmasin). */
export const tgLinkStartLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: limitHandler,
});

/** Marshrut (Google Routes — har so'rov pullik): bitta IP dan daqiqada 40 ta. Oddiy foydalanuvchi buncha so'ramaydi. */
export const mapsRouteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  handler: limitHandler,
});

/** Kirish holatini SO'RASH (ilova ~1.5 s da so'raydi) — daqiqada 150 ta; oddiy foydalanuvchi hech qachon duch kelmaydi. */
export const tgLinkPollLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 150,
  standardHeaders: true,
  legacyHeaders: false,
  handler: limitHandler,
});
