/*
 * FAQAT TEST: FerretDB (test bazasi) `$group: { $addToSet }` ni qo'llamaydi.
 * catalog.js dagi `dishCategories` aggregatsiyasi haqiqiy MongoDB'da to'g'ri ishlaydi;
 * bu fayl uni test serverida (node --import) oddiy JS bilan AYNAN SHU NATIJAGA keltiradi.
 * Mahsulot kodiga TEGILMAGAN.
 */
import { Dish } from '../src/models/Dish.js';

const original = Dish.aggregate.bind(Dish);
Dish.aggregate = async function patched(pipeline, ...rest) {
  const group = pipeline?.[1]?.$group;
  if (group?.categories?.$addToSet) {
    const rows = await Dish.find(pipeline[0].$match).select('restaurantId category').lean();
    const byRestaurant = new Map();
    for (const r of rows) {
      const key = String(r.restaurantId);
      if (!byRestaurant.has(key)) byRestaurant.set(key, { _id: r.restaurantId, categories: new Set() });
      byRestaurant.get(key).categories.add(r.category);
    }
    return [...byRestaurant.values()].map((x) => ({ _id: x._id, categories: [...x.categories] }));
  }
  return original(pipeline, ...rest);
};
