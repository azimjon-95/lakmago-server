import { Restaurant } from '../models/Restaurant.js';
import { Courier, normalizePhone } from '../models/Courier.js';
import { DEFAULT_DISTRICT } from '../constants/districts.js';

/*
 * Bir martalik (IDEMPOTENT) moslashtirish — yetkazish rejimlari (2026-11) dan oldingi hujjatlar uchun.
 * Mongoose default'lari faqat YANGI hujjatlarga yoziladi; bazadagi eski restoranlarda maydon yo'q bo'lsa,
 * `district: 'pop'` filtri ularni topmasdi. Har ishga tushishda xavfsiz: faqat maydoni YO'Q hujjatlarga tegadi.
 *   • restoran: district → 'pop' (standart), courierMode → 'own' (HOZIRGIDEK — o'z kuryeri, pul oqimi o'zgarmaydi)
 *   • kuryer:   status → isActive bo'yicha ('active'/'blocked'), phoneKey → telefondan (kirish uchun)
 */
export async function migrateDeliveryFields({ log = console.log } = {}) {
  const out = {};
  const r1 = await Restaurant.collection.updateMany({ district: { $exists: false } }, { $set: { district: DEFAULT_DISTRICT } });
  const r2 = await Restaurant.collection.updateMany({ courierMode: { $exists: false } }, { $set: { courierMode: 'own', lokmaFreeDelivery: false } });
  const c1 = await Courier.collection.updateMany({ status: { $exists: false }, isActive: false }, { $set: { status: 'blocked' } });
  const c2 = await Courier.collection.updateMany({ status: { $exists: false } }, { $set: { status: 'active' } });
  out.restaurantsDistrict = r1.modifiedCount || 0;
  out.restaurantsMode = r2.modifiedCount || 0;
  out.couriersStatus = (c1.modifiedCount || 0) + (c2.modifiedCount || 0);

  const noKey = await Courier.collection.find({ $or: [{ phoneKey: { $exists: false } }, { phoneKey: '' }], phone: { $nin: [null, ''] } })
    .project({ phone: 1 }).toArray();
  let keyed = 0;
  for (const c of noKey) {
    const phoneKey = normalizePhone(c.phone);
    if (phoneKey.length !== 9) continue;
    // Takror telefon bo'lsa — kalit yozilmaydi (admin qo'lda hal qiladi), kirish noaniq bo'lib qolmasin
    if (await Courier.collection.findOne({ phoneKey, _id: { $ne: c._id } })) { log(`[migratsiya] kuryer ${c._id}: telefon takror, phoneKey yozilmadi`); continue; }
    await Courier.collection.updateOne({ _id: c._id }, { $set: { phoneKey } });
    keyed += 1;
  }
  out.couriersPhoneKey = keyed;
  if (Object.values(out).some(Boolean)) log(`✓ Yetkazish rejimi migratsiyasi: ${JSON.stringify(out)}`);
  return out;
}
