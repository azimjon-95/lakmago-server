import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

// CORS origin'lar: client (5173) va admin panel (5174) — vergul bilan ajratiladi
const originsRaw = process.env.CORS_ORIGINS
  ?? process.env.CLIENT_ORIGIN
  ?? 'http://localhost:5173,http://localhost:5174,http://127.0.0.1:5173,http://127.0.0.1:5174';
const corsOrigins = originsRaw.split(',').map((s) => s.trim()).filter(Boolean);

export const config = {
  port: Number(process.env.PORT ?? 4000),
  mongoUri: process.env.MONGO_URI ?? 'mongodb://localhost:27017/lokmago',
  jwtSecret: process.env.JWT_SECRET ?? 'dev-secret',
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
  clientOrigin: corsOrigins[0],
  corsOrigins,

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
  webappUrl: process.env.WEBAPP_URL ?? process.env.CLIENT_ORIGIN ?? corsOrigins[0],

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
