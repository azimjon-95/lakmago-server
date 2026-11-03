import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import { CourierAccount } from '../models/CourierAccount.js';

export const signCourierToken = (accountId) => jwt.sign({ cid: String(accountId), role: 'courier' }, config.courierJwtSecret, { expiresIn: '30d' });

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
    const acc = await CourierAccount.findById(payload.cid).select('name phone vehicle isActive activeShiftId').lean();
    if (!acc) return res.status(401).json({ error: 'Token yaroqsiz' });
    if (!acc.isActive) return res.status(403).json({ error: 'Akkaunt bloklangan. Administrator bilan bog‘laning.' });
    req.courier = acc; req.courierId = String(acc._id);
    next();
  } catch (e) { next(e); }
}
