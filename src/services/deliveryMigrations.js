import { Restaurant } from '../models/Restaurant.js';
import { CourierAccount } from '../models/CourierAccount.js';
import { DEFAULT_DISTRICT } from '../constants/districts.js';

/*
 * Bir martalik (IDEMPOTENT) moslashtirish — yetkazish rejimlari (2026-11) dan oldingi hujjatlar uchun.
 * Mongoose default'lari faqat YANGI hujjatlarga yoziladi; bazadagi eski hujjatlarda maydon yo'q bo'lsa, `district: 'pop'` kabi
 * filtrlar ularni topmasdi. Har ishga tushishda xavfsiz: faqat maydoni YO'Q hujjatlarga tegadi.
 *   • restoran:        district → 'pop' (standart), courierMode → 'own' (HOZIRGIDEK — o'z kuryeri, pul oqimi o'zgarmaydi)
 *   • kuryer akkaunti: workDistricts → [], tokenVersion → 0
 * Eski kuryerlar reyestri (Courier, Telegram/havola oqimi) ga TEGILMAYDI.
 */
export async function migrateDeliveryFields({ log = console.log } = {}) {
  const out = {};
  const r1 = await Restaurant.collection.updateMany({ district: { $exists: false } }, { $set: { district: DEFAULT_DISTRICT } });
  const r2 = await Restaurant.collection.updateMany({ courierMode: { $exists: false } }, { $set: { courierMode: 'own', lokmaFreeDelivery: false } });
  const a1 = await CourierAccount.collection.updateMany({ workDistricts: { $exists: false } }, { $set: { workDistricts: [] } });
  const a2 = await CourierAccount.collection.updateMany({ tokenVersion: { $exists: false } }, { $set: { tokenVersion: 0 } });
  out.restaurantsDistrict = r1.modifiedCount || 0;
  out.restaurantsMode = r2.modifiedCount || 0;
  out.courierAccounts = Math.max(a1.modifiedCount || 0, a2.modifiedCount || 0);
  if (Object.values(out).some(Boolean)) log(`✓ Yetkazish rejimi migratsiyasi: ${JSON.stringify(out)}`);
  return out;
}
