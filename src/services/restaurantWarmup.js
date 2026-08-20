import { cacheSet, cacheDelPattern, isCacheReady, KEYS, TTL } from './cache.js';
import { Restaurant } from '../models/Restaurant.js';
import { Dish } from '../models/Dish.js';

/**
 * Restoran ma'lumotlarini Redisga oldindan yuklash ("warm-up").
 *
 * QACHON: restoran login qilgan paytda (panelAuth.js).
 *
 * NEGA: login qilgandan keyin restoran darhol bir necha
 * sahifani ochadi (buyurtmalar, menyu, stop-list, profil).
 * Har biri alohida bazaga borsa — bir necha o'nlab so'rov.
 * Login paytida hammasini BIR MARTA olib keshga qo'ysak,
 * keyingi sahifalar bazaga umuman tegmaydi.
 *
 * MUHIM: bu jarayon login javobini KUTKAZMAYDI — fon rejimida
 * ishlaydi (login darhol javob qaytaradi). Agar warm-up
 * muvaffaqiyatsiz bo'lsa ham login normal ishlaydi, shunchaki
 * keyingi so'rovlar bazadan o'qiydi.
 */
export async function warmupRestaurant(restaurantId) {
  if (!isCacheReady() || !restaurantId) return false;

  const id = String(restaurantId);
  try {
    // Ikkala so'rovni PARALLEL yuboramiz — ketma-ket emas
    const [restaurant, dishes] = await Promise.all([
      Restaurant.findById(id).lean(),
      Dish.find({ restaurantId: id }).lean(),
    ]);

    if (!restaurant) return false;

    await Promise.all([
      cacheSet(KEYS.restaurantFull(id), restaurant, TTL.restaurantFull),
      cacheSet(KEYS.restaurantDishes(id), dishes, TTL.dishes),
    ]);

    console.log(`[warmup] restoran ${id}: profil + ${dishes.length} taom keshlandi`);
    return true;
  } catch (e) {
    console.warn('[warmup] xato (login baribir ishlaydi):', e.message);
    return false;
  }
}

/**
 * Restoran keshini bekor qilish.
 *
 * QACHON CHAQIRILADI: menyu o'zgarganda, stop-list yangilanganda,
 * restoran sozlamalari saqlanganda — ya'ni keshdagi ma'lumot
 * eskirganda.
 *
 * Bu ENG MUHIM qism: kesh yangilanmasa, restoran menyuni
 * o'zgartiradi-yu, mijoz eski menyuni ko'raveradi. Shuning
 * uchun har bir yozuv amalidan keyin chaqirilishi SHART.
 */
export async function invalidateRestaurant(restaurantId) {
  if (!restaurantId) return;
  await cacheDelPattern(KEYS.restaurantAny(String(restaurantId)));
  // Mijoz ko'radigan katalog ro'yxati ham eskirdi
  await cacheDelPattern(KEYS.catalogAny());
}
