import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import { CourierAccount } from '../models/CourierAccount.js';

/** `v` — tokenVersion: parol almashsa yoki bloklansa oshiriladi, eski tokenlar DARHOL bekor bo'ladi (eski tokenlarda `v` yo'q = 0). */
export const signCourierToken = (accountId, version = 0) => jwt.sign({ cid: String(accountId), role: 'courier', v: Number(version) || 0 }, config.courierJwtSecret, { expiresIn: '30d' });

/**
 * Kuryer ilovasi middleware'i. Mavjud `auth` BILAN ARALASHMAYDI: boshqa kalit, boshqa payload. Har so'rovda akkaunt faol ekani
 * tekshiriladi (admin bloklasa, token tugashini kutmasdan darhol to'xtaydi).
 */
export async function courierAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Avtorizatsiya talab qilinadi' });
  let payload;
  try { payload = jwt.verify(header.slice(7), config.courierJwtSecret); } catch { return res.status(401).json({ error: 'Token yaroqsiz' }); }
  if (payload.role !== 'courier' || !payload.cid) return res.status(401).json({ error: 'Token yaroqsiz' });
  try {
    const acc = await CourierAccount.findById(payload.cid).select('name phone vehicle isActive activeShiftId workDistricts debtLimitSom tokenVersion').lean();
    if (!acc) return res.status(401).json({ error: 'Token yaroqsiz' });
    if (Number(acc.tokenVersion || 0) !== Number(payload.v || 0)) return res.status(401).json({ error: 'Sessiya tugagan. Qayta kiring.', code: 'SESSION_EXPIRED' });
    if (!acc.isActive) return res.status(403).json({ error: 'Akkaunt bloklangan. Administrator bilan bog‘laning.' });
    req.courier = acc; req.courierId = String(acc._id);
    next();
  } catch (e) { next(e); }
}
