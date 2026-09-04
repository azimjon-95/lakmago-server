/**
 * Mavjud Telegram foydalanuvchilar uchun AuthIdentity yozuvlarini
 * to'ldiradi (backfill).
 *
 * NEGA KERAK: yangi Auth fundamenti (AuthIdentity/Session modellari)
 * qo'shilishidan OLDIN yaratilgan barcha User hujjatlari
 * (User.telegramId orqali) hali AuthIdentity'ga ega EMAS. Bu
 * o'z-o'zidan MUAMMO EMAS — controllers/misc.js authController.telegram
 * "lazy migration" qiladi: har bir foydalanuvchi KEYINGI safar
 * login qilganda AuthIdentity avtomatik yaratiladi. Lekin bu skript
 * BARCHA mavjud foydalanuvchilarni DARHOL qoplash uchun — masalan
 * admin panelida AuthIdentity orqali qidirish/statistika kerak
 * bo'lsa, ular login qilishini kutish shart emas.
 *
 * XAVFSIZ: HECH QANDAY User hujjati yaratilmaydi yoki o'zgartirilmaydi
 * — faqat AuthIdentity qo'shiladi, va faqat AGAR hali mavjud bo'lmasa
 * (upsert, provider+providerUserId unique index tufayli takrorlanish
 * mumkin emas).
 *
 * Ishlatish:
 *   node scripts/migrate-auth-identities.js          # ko'rish
 *   node scripts/migrate-auth-identities.js --apply   # yozish
 */
import mongoose from 'mongoose';
import { config } from '../src/config/index.js';
import { User } from '../src/models/User.js';
import { AuthIdentity } from '../src/models/AuthIdentity.js';

const apply = process.argv.includes('--apply');

async function main() {
  await mongoose.connect(config.mongoUri);
  console.log('✓ MongoDB ulandi\n');

  const users = await User.find({ telegramId: { $ne: null, $exists: true } })
    .select('_id telegramId firstName username')
    .lean();

  console.log(`Telegram orqali ro'yxatdan o'tgan User: ${users.length} ta`);

  const existing = await AuthIdentity.find({ provider: 'telegram' }).select('providerUserId').lean();
  const alreadyLinked = new Set(existing.map((a) => a.providerUserId));

  const missing = users.filter((u) => !alreadyLinked.has(String(u.telegramId)));
  console.log(`AuthIdentity hali yo'q bo'lganlar: ${missing.length} ta\n`);

  if (missing.length === 0) {
    console.log('O\u2018zgartirish kerak emas — barchasi allaqachon bog\u2018langan.');
    await mongoose.disconnect();
    return;
  }

  if (apply) {
    const ops = missing.map((u) => ({
      updateOne: {
        filter: { provider: 'telegram', providerUserId: String(u.telegramId) },
        update: {
          $setOnInsert: {
            userId: u._id,
            provider: 'telegram',
            providerUserId: String(u.telegramId),
          },
        },
        upsert: true,
      },
    }));
    const res = await AuthIdentity.bulkWrite(ops, { ordered: false });
    console.log(`✓ ${res.upsertedCount} ta AuthIdentity yaratildi.`);
  } else {
    console.log('Namuna (ilk 5 tasi):');
    missing.slice(0, 5).forEach((u) => {
      console.log(`  ${u.firstName || u.username || u._id} — telegramId=${u.telegramId}`);
    });
    console.log(`\nYozish uchun: --apply`);
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error('✗', e.message);
  process.exit(1);
});
