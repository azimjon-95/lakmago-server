import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

// ===== FRONTEND MANZILLARI (aniq ajratilган) =====
//
//  WEBAPP_URL    → mijoz webapp'и (Telegram Mini App). Bitta manzil.
//                  Telegram tugmalari shu manzilга o'tkazadi + CORS'ga qo'shiladi.
//
//  CORS_ORIGINS  → admin panellar (dastur admini + restoran admini).
//                  Vergul bilan bir nechта manzil (ular alohida deploy).
//
// Ikkаласи ham CORS ro'yxatига tushadi — har biri o'z frontendига javob beradi.

const trim = (s) => String(s || '').trim().replace(/\/$/, '');

// 1) Webapp manzili (mijoz Mini App)
const webappOrigin = trim(process.env.WEBAPP_URL);

// 2) Admin panellar manzillari (vergul bilan)
const adminOrigins = String(process.env.CORS_ORIGINS ?? process.env.CLIENT_ORIGIN ?? '')
  .split(',')
  .map(trim)
  .filter(Boolean);

// 3) Lokal ishlab chiqish (har doim ruxsat)
const localOrigins = [
  'http://localhost:5173', 'http://localhost:5174',
  'http://127.0.0.1:5173', 'http://127.0.0.1:5174',
];

// Umumiy ruxsat ro'yxati
const corsOrigins = [
  ...(webappOrigin ? [webappOrigin] : []),
  ...adminOrigins,
  ...localOrigins,
];

// Origin ruxsat etilganmi?
// Aniq ro'yxat + Vercel/Netlify deploylar + Telegram (Mini App ichи).
export function isAllowedOrigin(origin) {
  if (!origin) return true; // server-to-server yoki Postman
  const clean = trim(origin);
  if (corsOrigins.includes(clean)) return true;
  try {
    const host = new URL(clean).hostname;
    // Vercel/Netlify (production va preview deploylar — webapp/admin ikkаласи)
    if (/\.vercel\.app$/i.test(host)) return true;
    if (/\.netlify\.app$/i.test(host)) return true;
    // Telegram Mini App ichida ba'zan telegram domeni keladi
    if (/(^|\.)telegram\.org$/i.test(host)) return true;
    if (/(^|\.)t\.me$/i.test(host)) return true;
  } catch { /* noto'g'ri origin */ }
  return false;
}

/** Muhit o'zgaruvchisidan son. Noto'g'ri bo'lsa — standart qiymat. */
function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/*
 * XAVFSIZLIK (2026-08 audit): JWT_SECRET ishlab chiqarishda
 * MAJBURIY. Avval o'rnatilmasa jim tarzda 'dev-secret' (barchaga
 * ma'lum, taxmin qilish oson) qiymatga o'tar edi — bu degani
 * kimdir shu qiymatni bilsa, ADMIN huquqli token ham SOXTALASHTIRA
 * olardi. Endi: production'da o'rnatilmasa server UMUMAN
 * ISHGA TUSHMAYDI (jim ishlashdan ko'ra darhol, ochiq xato
 * berish xavfsizroq). Faqat lokal ishlab chiqishda (NODE_ENV
 * !== 'production') qulaylik uchun standart qiymat qoldi.
 */
const isProd = process.env.NODE_ENV === 'production';
const jwtSecretFromEnv = process.env.JWT_SECRET;
if (isProd && (!jwtSecretFromEnv || jwtSecretFromEnv === 'dev-secret')) {
  throw new Error(
    "[XAVFSIZLIK] JWT_SECRET production muhitida o'rnatilishi SHART "
    + '(kuchli, tasodifiy qiymat — masalan `openssl rand -hex 32`). '
    + "Server ataylab ishga tushmaydi, chunki bu qiymatsiz JWT tokenlar "
    + 'oson soxtalashtiriladi.',
  );
}
const jwtSecret = jwtSecretFromEnv || 'dev-secret';

export const config = {
  port: Number(process.env.PORT ?? 4000),
  mongoUri: process.env.MONGO_URI ?? 'mongodb://localhost:27017/lokmago',
  jwtSecret,
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? '',

  /*
   * Kuryer sahifasi manzili — YANGI, ALOHIDA lokma-courier
   * loyihasi shu subdomenda joylashadi. Standart qiymat
   * ishlab chiqish uchun (localhost) — production'da
   * COURIER_APP_URL=https://kuryer.lokma.uz o'rnatiladi.
   */
  courierAppUrl: (process.env.COURIER_APP_URL || 'http://localhost:5175').replace(/\/$/, ''),
  // Frontend manzillari (aniq ajratilган)
  webappOrigin,            // mijoz webapp'и (WEBAPP_URL)
  adminOrigins,            // admin panellar (CORS_ORIGINS)
  corsOrigins,             // umumiy CORS ruxsat ro'yxati
  clientOrigin: webappOrigin || corsOrigins[0], // eski kod mosligи uchun

  // Default admin (dastur egasi) login/parol — .env dan olinadi
  adminLogin: process.env.ADMIN_LOGIN ?? 'admin',
  adminPassword: process.env.ADMIN_PASSWORD ?? 'admin123',

  // Cloudinary — rasm saqlash (API Secret hech qachon frontendга tushmaydi!)
  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME ?? '',
    apiKey: process.env.CLOUDINARY_API_KEY ?? '',
    apiSecret: process.env.CLOUDINARY_API_SECRET ?? '',
    uploadPreset: process.env.CLOUDINARY_UPLOAD_PRESET ?? 'lokmago_unsigned',
  },

  // Telegram webapp public URL (guruhga yuboriladigan tugma shu manzilга o'tkazadi)
  // Masalan: https://t.me/LokmaGoBot/app  yoki webapp domeni
  // Telegram tugmalari shu manzilга o'tkazadi (mijoz webapp'и)
  webappUrl: webappOrigin || corsOrigins[0],

  // ===== ASOSIY KANAL + REFERRAL =====
  // Majburiy obuna kanали/guruhи (@username yoki -100... chat id).
  // Referal orqali kelgan yangi foydalanuvchi shunga obuna bo'lishi shart.
  mainChannel: process.env.MAIN_CHANNEL ?? '', // masalan: @LokmaGoUz
  mainChannelUrl: process.env.MAIN_CHANNEL_URL ?? '', // masalan: https://t.me/LokmaGoUz
  botUsername: process.env.BOT_USERNAME ?? 'LokmaGoBot', // referal havola uchun
  webappName: process.env.WEBAPP_NAME ?? 'app', // Mini App qisqa nomi (startapp deep-link uchun)
  // Referal bonusи (so'mда): taklif qiluvchiga va yangi kelganga
  referralReward: Number(process.env.REFERRAL_REWARD ?? 5000),      // taklif qiluvchiga
  referralWelcomeBonus: Number(process.env.REFERRAL_WELCOME ?? 3000), // yangi kelganga

  // ===== TO'LOV TIZIMLARI =====
  // Kabinetdan olinadi, .env ga yoziladi
  payme: {
    merchantId: process.env.PAYME_MERCHANT_ID || '',
    login: process.env.PAYME_LOGIN || 'Paycom',
    key: process.env.PAYME_KEY || '',            // ishlab chiqarish
    testKey: process.env.PAYME_TEST_KEY || '',   // sinov
    returnUrl: process.env.PAYME_RETURN_URL || '',
  },

  click: {
    enabled: process.env.CLICK_ENABLED !== 'false',
    serviceId: process.env.CLICK_SERVICE_ID || '',
    merchantId: process.env.CLICK_MERCHANT_ID || '',
    merchantUserId: process.env.CLICK_MERCHANT_USER_ID || '',
    secretKey: process.env.CLICK_SECRET_KEY || '',
    returnUrl: process.env.CLICK_RETURN_URL || '',
  },

  paynet: {
    // Paynet rasmiy hujjati kelgach to'ldiriladi
    enabled: process.env.PAYNET_ENABLED === 'true',
    merchantId: process.env.PAYNET_MERCHANT_ID || '',
    serviceId: process.env.PAYNET_SERVICE_ID || '',
    secretKey: process.env.PAYNET_SECRET_KEY || '',
    baseUrl: process.env.PAYNET_BASE_URL || '',
    returnUrl: process.env.PAYNET_RETURN_URL || '',
  },

  /**
   * Bo'linish foizlari — HECH QAYERDA qattiq yozilmaydi.
   *
   * Standart qiymatlar biznes modelidan (2026-08-17 tasdiqlangan):
   *   Click:  1.5% umumiy summadan
   *   Paynet: 1% umumiy summadan
   *   Ikkalasi ham split QILMAYDI — to'liq summa LokmaGo hisobiga
   *   tushadi (shlyuz o'z haqini ushlab qolgandan keyin), restoran
   *   ulushi HAR KUNI QO'LDA (bank orqali) o'tkaziladi — Moliya
   *   bo'limidagi kunlik hisobot shuni ko'rsatadi.
   *
   * Restoran o'z to'liq kelishilgan ulushini oladi — qaysi shlyuz
   * ishlatilganidan qat'i nazar. Shlyuz haqi LokmaGo ulushidan
   * "yeyiladi" (LokmaGo netto kamayadi), restoran ulushiga
   * TA'SIR QILMAYDI.
   *
   * Restoran bo'yicha alohida shartnoma bo'lsa
   * CommissionAgreement ustun keladi.
   */
  /**
   * Reklama (banner) — kunlik narx, so'mda.
   *
   * SODDA: bitta umumiy narx, hammaga bir xil (restoran yoki
   * taom reklamasi bo'lishidan qat'i nazar). Kelajakda turlarga
   * qarab farqlantirilsa, shu yerga kengaytiriladi.
   */
  adPricePerDaySom: num(process.env.AD_PRICE_PER_DAY, 20000),

  split: {
    defaultLokmaPercent: num(process.env.SPLIT_LOKMA_PERCENT, 10),

    /** Paynet haqi 1%, UMUMIY summadan (Click bilan bir xil qoida). */
    paynetFeePercent: num(process.env.PAYNET_FEE_PERCENT, 1),
    paynetFeeBase: process.env.PAYNET_FEE_BASE || 'TOTAL',

    /** Click haqi UMUMIY summadan olinadi (1.5% = 1 500). */
    clickFeePercent: num(process.env.CLICK_FEE_PERCENT, 1.5),
    clickFeeBase: process.env.CLICK_FEE_BASE || 'TOTAL',
  },

  /**
   * Restoran merchant kalitlarini shifrlash uchun.
   * Berilmasa jwtSecret dan hosil qilinadi — ishlab chiqarishda
   * albatta alohida kalit qo'ying.
   */
  secretsKey: process.env.SECRETS_ENCRYPTION_KEY || '',

  // Yandex Maps — xarita va manzil aniqlash.
  // Kalitlar developer.tech.yandex.ru dan olinadi (bepul tarif bor).
  yandex: {
    // JavaScript API — xarita ko'rsatish
    mapsKey: process.env.YANDEX_MAPS_KEY || '',
    // Geocoder API — koordinata ↔ manzil
    geocoderKey: process.env.YANDEX_GEOCODER_KEY || process.env.YANDEX_MAPS_KEY || '',
    // Routing API — haqiqiy yo'l masofasi uchun
    routingKey: process.env.YANDEX_ROUTING_KEY || process.env.YANDEX_GEOCODER_KEY || '',
  },
  // Mijoz ilovasi manzili — QR havolalari uchun
  customerBaseUrl: process.env.CUSTOMER_BASE_URL || 'https://lokma.uz',

  // Web Push (VAPID). Kalitlar bo'lmasa push jim o'chadi —
  // qolgan tizim ishlayveradi.
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY || '',
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY || '',
  vapidSubject: process.env.VAPID_SUBJECT || 'mailto:support@lokma.uz',
};

export async function connectDB() {
  try {
    await mongoose.connect(config.mongoUri);
    console.log('✓ MongoDB ulandi');
  } catch (err) {
    console.error('✗ MongoDB ulanish xatosi:', err);
    process.exit(1);
  }
}
