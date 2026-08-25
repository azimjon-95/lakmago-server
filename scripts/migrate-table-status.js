/**
 * Stol holatlarini 3 taga o'tkazish.
 *
 * ESKI (5 ta)                YANGI (3 ta)
 *   available    ─────────►  free
 *   closed       ─────────►  free
 *   occupied     ─────────►  occupied
 *   ordering     ─────────►  occupied   (buyurtma kiritilyapti — baribir band)
 *   waiting      ─────────►  occupied   (hisob so'ralgan — mehmon hamon o'tiribdi)
 *
 * 'reserved' ga hech narsa ko'chirilmaydi: eski modelda bron
 * uchun holat umuman yo'q edi. U faqat oldinga qarab ishlatiladi.
 *
 * MUHIM: bu skript ISHLATILMASA stollar eski qiymatlar bilan
 * qolib ketadi. Mongoose enum validatsiyasi faqat YOZISHDA
 * ishlaydi, o'qishда emas — ya'ni xato ko'rinmaydi, lekin
 * frontend 'available' ni tanimay stolni rangsiz chizadi.
 *
 * Ishlatish:
 *   node scripts/migrate-table-status.js          # ko'rish
 *   node scripts/migrate-table-status.js --apply  # yozish
 */
import mongoose from 'mongoose';
import { config } from '../src/config/index.js';

const MAP = {
  available: 'free',
  closed: 'free',
  occupied: 'occupied',
  ordering: 'occupied',
  waiting: 'occupied',
};

const apply = process.argv.includes('--apply');

async function main() {
  await mongoose.connect(config.mongoUri);
  console.log('✓ MongoDB ulandi\n');

  // Model orqali emas, to'g'ridan-to'g'ri kolleksiya bilan:
  // eski qiymatlar yangi enum'dan o'tmaydi va Mongoose
  // ularni o'qishda ham rad etishi mumkin.
  const col = mongoose.connection.collection('tables');

  let total = 0;
  for (const [oldVal, newVal] of Object.entries(MAP)) {
    const count = await col.countDocuments({ status: oldVal });
    if (!count) continue;

    total += count;
    console.log(`  ${oldVal.padEnd(10)} → ${newVal.padEnd(9)} ${count} ta`);

    if (apply) {
      await col.updateMany({ status: oldVal }, { $set: { status: newVal } });
    }
  }

  // Kutilmagan qiymatlar — xавfsizlik uchun 'free' ga
  const unknown = await col.countDocuments({
    status: { $nin: [...Object.keys(MAP), 'free', 'reserved', 'occupied'] },
  });
  if (unknown) {
    console.log(`  ${'(noma\u2018lum)'.padEnd(10)} → free      ${unknown} ta`);
    total += unknown;
    if (apply) {
      await col.updateMany(
        { status: { $nin: [...Object.keys(MAP), 'free', 'reserved', 'occupied'] } },
        { $set: { status: 'free' } },
      );
    }
  }

  console.log(
    total === 0
      ? '\nO\u2018zgartirish kerak emas — barcha stollar yangi formatда.'
      : apply
        ? `\n✓ ${total} ta stol yangilandi.`
        : `\n${total} ta stol o\u2018zgaradi. Yozish uchun: --apply`,
  );

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error('✗', e.message);
  process.exit(1);
});
