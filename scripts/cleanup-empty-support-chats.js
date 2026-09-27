/**
 * Bo'sh "Yordam xizmati" yozishmalarini tozalash.
 *
 * SABAB: avval mijoz panelni ochishning o'zida (hech narsa
 * yozmasdan) bazada bo'sh SupportChat yaratilib qolardi
 * (controllers/support.js — tuzatildi). Admin panelidagi "Faol"
 * ro'yxati shu bo'sh yozishmalar bilan to'lib ketgan edi.
 *
 * MUHIM: bu skript ISHLATILMASA ham admin ro'yxati ENDI TOZA —
 * `list` so'rovi endi "messages.0": {$exists:true} shartini
 * qo'llaydi, bo'sh yozishmalar RO'YXATDA ko'rinmaydi. Bu skript
 * faqat ularni bazadan HAQIQATAN o'chirib, joy bo'shatish uchun
 * (ixtiyoriy).
 *
 * Ishlatish:
 *   node scripts/cleanup-empty-support-chats.js          # ko'rish
 *   node scripts/cleanup-empty-support-chats.js --apply  # o'chirish
 */
import mongoose from 'mongoose';
import { config } from '../src/config/index.js';
import { SupportChat } from '../src/models/SupportChat.js';

const APPLY = process.argv.includes('--apply');

async function main() {
  await mongoose.connect(config.mongoUri);

  const filter = { $or: [{ messages: { $size: 0 } }, { messages: { $exists: false } }] };
  const count = await SupportChat.countDocuments(filter);

  if (!count) {
    console.log('✓ Bo‘sh yozishma yo‘q — tozalash shart emas.');
  } else if (!APPLY) {
    const sample = await SupportChat.find(filter).select('firstName username createdAt').limit(10).lean();
    console.log(`Topildi: ${count} ta bo‘sh yozishma (birinchi 10 tasi):`);
    sample.forEach((c) => console.log(`  - ${c.firstName || c.username || c._id} (${c.createdAt?.toISOString?.() || ''})`));
    console.log(`\nO‘chirish uchun: node scripts/cleanup-empty-support-chats.js --apply`);
  } else {
    const { deletedCount } = await SupportChat.deleteMany(filter);
    console.log(`✓ O‘chirildi: ${deletedCount} ta bo‘sh yozishma.`);
  }

  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
