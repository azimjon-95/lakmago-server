import { cacheDelPattern, isCacheReady } from '../services/cache.js';

/**
 * Kesh bekor qilish — MODEL DARAJASIDA, avtomatik.
 *
 * NEGA SHUNDAY, kontrollerlarda qo'lda emas:
 *
 * Agar har bir kontrollerda qo'lda `invalidateRestaurant(...)`
 * yozilsa, ertami-kechmi kimdir (yoki men) BIRONTASINI UNUTADI.
 * Natijada eng yomon xato turi yuzaga keladi: restoran menyuni
 * o'zgartiradi, lekin mijoz eski menyuni ko'rib buyurtma beradi —
 * bu pul va ishonch yo'qotishga olib keladi, va topish juda
 * qiyin (chunki "ba'zan ishlaydi, ba'zan yo'q").
 *
 * Model plaginida esa: Dish yoki Restaurant qanday yo'l bilan
 * o'zgartirilsa ham (save, findOneAndUpdate, deleteOne,
 * updateMany, insertMany — hattoki hali yozilmagan kelajakdagi
 * kod ham) kesh AVTOMATIK tozalanadi. Unutish imkoni yo'q.
 */

/** Berilgan hujjat(lar)dan restaurantId larni yig'ib, keshni tozalaydi. */
async function purge(ids) {
  if (!isCacheReady()) return;
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  await Promise.all([
    ...unique.map((id) => cacheDelPattern(`rest:${id}:*`)),
    // Mijoz ko'radigan katalog ro'yxati ham eskirdi
    cacheDelPattern('catalog:*'),
  ]);
}

/**
 * @param {'dish'|'restaurant'} kind
 *   dish       — hujjatdagi restaurantId ishlatiladi
 *   restaurant — hujjatning O'Z _id si restoran identifikatori
 */
export function cacheInvalidationPlugin(schema, { kind }) {
  const idOf = (doc) => (kind === 'restaurant' ? doc?._id : doc?.restaurantId);

  // create() va doc.save()
  schema.post('save', async function postSave(doc) {
    await purge([idOf(doc)]);
  });

  // insertMany()
  schema.post('insertMany', async function postInsertMany(docs) {
    await purge((docs || []).map(idOf));
  });

  // findOneAndUpdate / findByIdAndUpdate / findOneAndDelete / findByIdAndDelete
  schema.post(/^findOneAnd/, async function postFindOneAnd(doc) {
    if (doc) await purge([idOf(doc)]);
  });

  /*
   * updateOne / updateMany / deleteOne / deleteMany.
   *
   * Bu amallar hujjatni QAYTARMAYDI — shuning uchun qaysi
   * restoranga tegishli ekanini bilolmaymiz. Filtrdan
   * aniqlashga urinamiz; aniqlanmasa xavfsiz tomonga o'tib
   * BUTUN katalog keshini tozalaymiz (kam uchraydigan holat,
   * eski ma'lumot ko'rsatishdan ko'ra ortiqcha tozalash
   * yaxshiroq).
   */
  schema.post(/^(updateOne|updateMany|deleteOne|deleteMany)$/, async function postBulk() {
    const filter = this.getFilter?.() || {};
    const id = kind === 'restaurant' ? filter._id : filter.restaurantId;
    if (id && typeof id !== 'object') {
      await purge([id]);
    } else if (isCacheReady()) {
      // Aniq bilmadik — hammasini tozalaymiz (xavfsiz yo'l)
      await cacheDelPattern('rest:*');
      await cacheDelPattern('catalog:*');
    }
  });
}
