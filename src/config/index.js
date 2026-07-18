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

export const config = {
  port: Number(process.env.PORT ?? 4000),
  mongoUri: process.env.MONGO_URI ?? 'mongodb://localhost:27017/lokmago',
  jwtSecret: process.env.JWT_SECRET ?? 'dev-secret',
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
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
