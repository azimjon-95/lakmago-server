import { Dish } from '../models/Dish.js';
import { getIO } from '../sockets/io.js';

/**
 * Menyu o'zgardi → shu restoranning telefonlari va panelini DARHOL xabardor qiladi.
 *
 * `updateDish` (PATCH /panel/dishes/:id) va Ertalabki eslatma boti (`setDishAvailability`) allaqachon shu ikki hodisani
 * yuboradi; STOP almashtirgich (`toggleStop`), taom qo'shish va o'chirish esa yubormas edi, shuning uchun boshqa
 * qurilmadagi «Stop List» soni va ro'yxati faqat qo'lda yangilanganda to'g'rilanardi. Hodisalar AYNAN o'sha:
 *   • `dish:stop`   → faqat `restaurant:<id>` xonasiga, { dishId, isAvailable, stoppedCount }
 *   • `dish:update` → hammaga (mijozlar ilovasi menyuni yangilaydi), { restaurantId }
 *
 * Bu faqat XABAR: ma'lumot, narx, buyurtma yoki to'lovga tegmaydi. Xato bo'lsa ham API javobi buzilmasin deb yutiladi.
 * Qaytaradi: to'xtatilgan taomlar soni (yoki hisoblab bo'lmasa null).
 *
 * @param deps  testlar uchun almashtirish mumkin: { Dish, io }
 */
export async function announceDish(restaurantId, dish, deps = {}) {
  const Model = deps.Dish ?? Dish;
  const io = 'io' in deps ? deps.io : getIO();
  const rid = String(restaurantId);
  try {
    const stoppedCount = await Model.countDocuments({ restaurantId, isAvailable: false });
    io?.to(`restaurant:${rid}`).emit('dish:stop', { dishId: String(dish._id), isAvailable: dish.isAvailable, stoppedCount });
    io?.emit('dish:update', { restaurantId: rid });
    return stoppedCount;
  } catch (e) {
    console.warn('[dish] hodisa yuborilmadi:', e?.message || e);
    return null;
  }
}
