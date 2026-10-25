import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import { User } from '../models/User.js';

/*
 * ═══ RESTORAN ILOVASI — SOKETDA TOKEN BILAN XONAGA QO'SHILISH ═══
 *
 * Restoran ilovasi (Android/iOS) ulanishda handshake'da JWT yuboradi:
 *     io(url, { auth: { token } })
 * Server tokenni tekshiradi va restoranni O'ZINING `restaurant:<id>` xonasiga qo'shadi.
 * restaurantId FAQAT tokendan (va bazadagi foydalanuvchidan) olinadi — client hech qachon
 * restoran ID yubormaydi, demak boshqa restoranning buyurtmalarini eshita olmaydi.
 *
 * Token yo'q/yaroqsiz — ulanish UZILMAYDI (mijozlar va panel ham shu soketdan foydalanadi),
 * shunchaki hech qanday restoran xonasiga qo'shilmaydi.
 *
 * Bazadan qayta tekshiriladi: bloklangan yoki boshqa restoranga ko'chirilgan akkaunt
 * (eski, hali muddati tugamagan token bilan) xonaga kira olmaydi.
 */
export async function restaurantRoomFromToken(token, { verify = (t) => jwt.verify(t, config.jwtSecret), findUser = (id) => User.findById(id).select('role isActive restaurantId').lean() } = {}) {
  if (typeof token !== 'string' || !token) return null;
  let payload;
  try { payload = verify(token); } catch { return null; }
  if (payload?.role !== 'restaurant' || !payload.restaurantId || !payload.userId) return null;
  const user = await findUser(payload.userId).catch(() => null);
  if (!user || !user.isActive || user.role !== 'restaurant' || String(user.restaurantId) !== String(payload.restaurantId)) return null;
  return `restaurant:${payload.restaurantId}`;
}
