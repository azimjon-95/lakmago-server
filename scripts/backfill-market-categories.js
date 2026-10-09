/**
 * Do'kon mahsulotlariga Market kategoriyasini yozib chiqish (bir martalik, ixtiyoriy).
 *
 * SABAB: Lokma Market'dan OLDIN qo'shilgan do'kon mahsulotlarida `marketCategory`
 * yo'q — do'kon sahifasida hammasi bitta "Boshqa" guruhda chiqardi. Mijoz ilovasi
 * uchun bu skript SHART EMAS: server (GET /restaurants/:id/dishes) kategoriyani
 * umumiy katalogdan o'zi aniqlab javobga qo'shadi. Skript buni bazaga DOIMIY yozadi
 * (do'kon panelida ham, Market kategoriya chiplarida ham to'g'ri ko'rinishi uchun).
 *
 * Faqat: do'konlar, `marketCategory` yo'q, katalogga bog'langan (catalogProductId).
 * Katalogga bog'lanmagan mahsulotlarga TEGILMAYDI (egasi panelda o'zi tanlaydi).
 *
 * Ishlatish:
 *   node scripts/backfill-market-categories.js          # ko'rish (hech narsa yozilmaydi)
 *   node scripts/backfill-market-categories.js --apply  # yozish
 */
import mongoose from 'mongoose';
import { config } from '../src/config/index.js';
import { Restaurant } from '../src/models/Restaurant.js';
import { Dish } from '../src/models/Dish.js';
import { CatalogProduct } from '../src/models/CatalogProduct.js';
import { ONLY_STORE } from '../src/services/storeRules.js';
import { MARKET_CATEGORIES, marketSuggestion } from '../src/constants/marketCategories.js';

const APPLY = process.argv.includes('--apply');

async function main() {
  await mongoose.connect(config.mongoUri);
  const stores = await Restaurant.find(ONLY_STORE).select('_id name').lean();
  console.log(`Do'konlar: ${stores.length} ta`);

  let total = 0; let changed = 0; let skipped = 0;
  for (const store of stores) {
    const dishes = await Dish.find({
      restaurantId: store._id,
      marketCategory: null,
      catalogProductId: { $exists: true, $ne: null },
    }).select('_id name catalogProductId unit').lean();
    if (!dishes.length) continue;

    const cats = await CatalogProduct.find({ _id: { $in: dishes.map((d) => d.catalogProductId) } }).select('category').lean();
    const byId = new Map(cats.map((c) => [String(c._id), c.category]));

    const ops = [];
    for (const d of dishes) {
      total += 1;
      const cat = byId.get(String(d.catalogProductId));
      if (!cat) { skipped += 1; continue; }
      const sug = marketSuggestion(cat);
      const label = MARKET_CATEGORIES.find((c) => c.value === sug.marketCategory);
      ops.push({
        updateOne: {
          filter: { _id: d._id, marketCategory: null },
          update: { $set: {
            marketCategory: sug.marketCategory,
            ...(d.unit ? {} : { unit: sug.unit }),
            category: 'boshqa',                       // restoran taom filtrlariga aralashmasin
            section: label?.label || 'Mahsulotlar',
          } },
        },
      });
    }
    changed += ops.length;
    console.log(`  ${store.name}: ${dishes.length} ta mahsulot kategoriyasiz → ${ops.length} tasi aniqlandi`);
    if (APPLY && ops.length) await Dish.bulkWrite(ops, { ordered: false });
  }

  console.log(`\nJami kategoriyasiz: ${total} · aniqlandi: ${changed} · katalogsiz (tegilmadi): ${skipped}`);
  console.log(APPLY ? '✓ Yozildi.' : 'Yozish uchun: node scripts/backfill-market-categories.js --apply');
  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
