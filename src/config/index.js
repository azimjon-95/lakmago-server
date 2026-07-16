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
