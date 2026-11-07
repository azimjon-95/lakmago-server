import { Dish } from '../models/Dish.js';
import { CatalogProduct } from '../models/CatalogProduct.js';
import { catalogCategoryFor } from '../constants/marketCategories.js';

/*
 * Do'kon mahsulotlariga `catalogCategory` (aniq katalog kaliti) yozish — Market bosh sahifasidagi yumaloq kategoriyalar uchun.
 * IDEMPOTENT: faqat marketCategory bor, catalogCategory yo'q mahsulotlarga tegadi; har ishga tushishda xavfsiz.
 *   1) katalogdan qo'shilgan (catalogProductId) → katalog mahsulotining kategoriyasi (aniq);
 *   2) o'zi yaratgan → marketCategory dan eng yaqin katalog kaliti (MARKET_TO_CATALOG);
 *   3) mos kalit yo'q ('boshqa', 'halol') → tegilmaydi (shu ishga tushish davomida qayta o'qilmaydi).
 * Restoran taomlariga (marketCategory yo'q) TEGILMAYDI.
 */
export async function backfillCatalogCategory({ batch = 500, log = console.log } = {}) {
  let fromCatalog = 0; let fromMarket = 0; const skipped = [];
  for (;;) {
    const rows = await Dish.find({ marketCategory: { $ne: null }, catalogCategory: null, ...(skipped.length ? { _id: { $nin: skipped } } : {}) })
      .select('marketCategory catalogProductId').limit(batch).lean();
    if (!rows.length) break;
    const ids = [...new Set(rows.map((r) => r.catalogProductId).filter(Boolean).map(String))];
    const cps = ids.length ? await CatalogProduct.find({ _id: { $in: ids } }).select('category').lean() : [];
    const byId = new Map(cps.map((c) => [String(c._id), c.category]));
    const ops = [];
    for (const r of rows) {
      const fromCp = r.catalogProductId ? byId.get(String(r.catalogProductId)) : null;
      const key = catalogCategoryFor({ catalogCategory: fromCp, marketCategory: r.marketCategory });
      if (!key) { skipped.push(r._id); continue; }
      if (fromCp) fromCatalog += 1; else fromMarket += 1;
      ops.push({ updateOne: { filter: { _id: r._id, catalogCategory: null }, update: { $set: { catalogCategory: key } } } });
    }
    if (ops.length) await Dish.bulkWrite(ops, { ordered: false });
    if (rows.length < batch && !ops.length) break;
  }
  const out = { fromCatalog, fromMarket, skipped: skipped.length };
  if (fromCatalog || fromMarket) log(`✓ Katalog kategoriyasi: ${JSON.stringify(out)}`);
  return out;
}
