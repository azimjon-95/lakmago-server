import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

export const config = {
  port: Number(process.env.PORT ?? 4000),
  mongoUri: process.env.MONGO_URI ?? 'mongodb://localhost:27017/lokmago',
  jwtSecret: process.env.JWT_SECRET ?? 'dev-secret',
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
  clientOrigin: process.env.CLIENT_ORIGIN ?? 'http://localhost:5173'
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
