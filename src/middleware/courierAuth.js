import { Courier } from '../models/Courier.js';
import { readCourierToken } from '../services/courierAuth.js';

/*
 * LokmaGo kuryeri ilovasi so'rovlari. Har so'rovda bazadan tekshiriladi:
 *  • kuryer mavjud va status 'active' (bloklangan/kutilayotgan — 403);
 *  • tokenVersion mos (PIN almashgan yoki bloklangan bo'lsa eski token — 401, qayta kirish).
 * req.courierId, req.courier (lean: name, phone, workDistricts, isOnline, debtLimitSom, status).
 */
export async function courierAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const payload = header.startsWith('Bearer ') ? readCourierToken(header.slice(7)) : null;
  if (!payload) return res.status(401).json({ error: 'Kirish kerak', code: 'AUTH_REQUIRED' });
  const courier = await Courier.findById(payload.courierId)
    .select('name phone workDistricts isOnline debtLimitSom status tokenVersion vehicle totalDeliveries')
    .lean()
    .catch(() => null);
  if (!courier || Number(courier.tokenVersion || 0) !== Number(payload.v || 0)) {
    return res.status(401).json({ error: 'Sessiya tugagan. Qayta kiring.', code: 'SESSION_EXPIRED' });
  }
  if (courier.status !== 'active') {
    return res.status(403).json({
      error: courier.status === 'pending' ? 'Akkaunt hali tasdiqlanmagan' : 'Akkaunt bloklangan',
      code: courier.status === 'pending' ? 'COURIER_PENDING' : 'COURIER_BLOCKED',
    });
  }
  req.courierId = String(courier._id);
  req.courier = courier;
  return next();
}
