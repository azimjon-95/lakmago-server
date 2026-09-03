/**
 * Umumiy katalog (CatalogProduct) kategoriyalarini eski
 * taom-uslubidagi enum'dan yangi 70 ta oziq-ovqat kategoriyasiga
 * o'tkazadi.
 *
 * NEGA KERAK: CatalogProduct.category eski enum'i (20 ta:
 * 'milliy', 'osh', 'shashlik', 'salqin', 'koffe' va h.k.) YANGI
 * 70 ta kategoriya ro'yxatida UMUMAN YO'Q. Bu skript ishlatilmasa:
 *
 *   1. Restoran paneli (GET /panel/catalog) endi HAR DOIM
 *      filter.category = 'ichimliklar' qo'yadi (kind !== 'shop'
 *      bo'lsa) — eski qiymatli hujjatlar bu filtrga MOS KELMAYDI
 *      va restoranga UMUMAN ko'RINMAY QOLADI (masalan mavjud
 *      Coca-Cola, Fanta, Chortoq suv yozuvlari).
 *   2. Admin panelidan ularni tahrirlashga urinilsa, Mongoose
 *      enum validatsiyasi ishga tushadi va 400 xato qaytaradi
 *      (eski qiymat yangi enum'da yo'q).
 *
 * Barcha mavjud yozuvlar 'ichimliklar'ga o'tkaziladi — chunki
 * bu tizim hozirgacha FAQAT restoranlar uchun ishlagan (do'kon
 * funksiyasi hali yo'q), demak eski BARCHA mahsulotlar mantiqan
 * "restoranga ko'rinadigan tayyor mahsulot" toifasiga to'g'ri
 * keladi. Migratsiyadan keyin admin xohlasa har birini aniqroq
 * kategoriyaga (masalan "Gazli ichimliklar") qo'lda o'zgartirishi
 * mumkin — bu endi vayron qiluvchi emas, oddiy tahrirlash.
 *
 * MUHIM: bu skript ISHLATILMASA mavjud katalog mahsulotlari
 * restoran panelidan yo'qolib qoladi. YANGI KATEGORIYA
 * o'zgarishini (lakmago-server commit f1b1ba6) deploy qilishdan
 * OLDIN yoki DARHOL KEYIN ishga tushirish shart.
 *
 * Ishlatish:
 *   node scripts/migrate-catalog-categories.js          # ko'rish
 *   node scripts/migrate-catalog-categories.js --apply  # yozish
 */
import mongoose from 'mongoose';
import { config } from '../src/config/index.js';
import { CATALOG_CATEGORY_VALUES, DRINKS_CATEGORY } from '../src/constants/catalogCategories.js';

const apply = process.argv.includes('--apply');

async function main() {
  await mongoose.connect(config.mongoUri);
  console.log('✓ MongoDB ulandi\n');

  // Model orqali emas, to'g'ridan-to'g'ri kolleksiya bilan: eski
  // qiymatlar yangi enum'dan o'tmaydi, Mongoose modeli orqali
  // find() qilinsa ham validatsiya xato berishi mumkin.
  const col = mongoose.connection.collection('catalogproducts');

  const newValues = new Set(CATALOG_CATEGORY_VALUES);
  const stale = await col.find({ category: { $nin: [...newValues] } }).toArray();

  if (stale.length === 0) {
    console.log('O\u2018zgartirish kerak emas — barcha mahsulotlar yangi kategoriyada.');
    await mongoose.disconnect();
    return;
  }

  // Qaysi eski qiymat nechta hujjatda uchraganini ko'rsatamiz
  const counts = {};
  for (const doc of stale) counts[doc.category] = (counts[doc.category] || 0) + 1;
  for (const [oldVal, count] of Object.entries(counts)) {
    console.log(`  ${String(oldVal).padEnd(16)} → ${DRINKS_CATEGORY.padEnd(12)} ${count} ta`);
  }

  if (apply) {
    const res = await col.updateMany(
      { category: { $nin: [...newValues] } },
      { $set: { category: DRINKS_CATEGORY } },
    );
    console.log(`\n✓ ${res.modifiedCount} ta mahsulot "${DRINKS_CATEGORY}" ga o'tkazildi.`);
  } else {
    console.log(`\n${stale.length} ta mahsulot o\u2018zgaradi. Yozish uchun: --apply`);
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error('✗', e.message);
  process.exit(1);
});
