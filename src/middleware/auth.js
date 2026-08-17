import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { config } from '../config/index.js';






export function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Avtorizatsiya talab qilinadi' });
  }
  try {
    const token = header.slice(7);
    const payload = jwt.verify(token, config.jwtSecret);
    req.userId = payload.userId;
    req.role = payload.role;
    req.restaurantId = payload.restaurantId ?? null;
    req.department = payload.department ?? null;
    next();
  } catch {
    return res.status(401).json({ error: 'Token yaroqsiz' });
  }
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.role || !roles.includes(req.role)) {
      return res.status(403).json({ error: 'Ruxsat yo‘q' });
    }
    next();
  };
}

// Telegram WebApp initData'ni tekshirish (xavfsiz login)
export function verifyTelegramInitData(initData) {
  if (!config.telegramBotToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  params.delete('hash');
  const dataCheckString = Array.from(params.entries()).
  sort(([a], [b]) => a.localeCompare(b)).
  map(([k, v]) => `${k}=${v}`).
  join('\n');
  const secretKey = crypto.
  createHmac('sha256', 'WebAppData').
  update(config.telegramBotToken).
  digest();
  const computed = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  if (computed !== hash) return null;
  return Object.fromEntries(params.entries());
}

export function signToken(userId, role, restaurantId = null, department = null) {
  return jwt.sign({ userId, role, restaurantId, department }, config.jwtSecret, { expiresIn: '30d' });
}

/**
 * Sahifa darajasidagi ruxsat — xodim (staff) faqat o'z bo'limiga
 * tegishli sahifalarga kira oladi. Admin va restoran uchun
 * cheklovsiz o'tadi (ular alohida requireRole bilan himoyalangan).
 *
 * Ishlatish: router.get('/admin/billing/...', auth, requireRole('admin','staff'), requirePage('billing'), ctrl)
 */
export function requirePage(pageKey) {
  return async (req, res, next) => {
    if (req.role !== 'staff') return next();   // faqat staff uchun qo'shimcha tekshiruv
    const { canAccessPage } = await import('../config/permissions.js');
    if (!canAccessPage('staff', req.department, pageKey)) {
      return res.status(403).json({ error: 'Bu bo\u2018limga ruxsatingiz yo\u2018q' });
    }
    next();
  };
}


/**
 * Ofitsiant autentifikatsiyasi.
 *
 * Qurilma tokendagi bilan mos kelishi SERVERDA tekshiriladi —
 * token o'g'irlansa ham boshqa qurilmadan ishlamaydi.
 */
export const waiterAuth = async (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';

  if (!token) return res.status(401).json({ error: 'Kirish kerak' });

  try {
    const payload = jwt.verify(token, config.jwtSecret);
    if (payload.role !== 'waiter') {
      return res.status(403).json({ error: 'Ruxsat yo\u2018q' });
    }

    const { Waiter } = await import('../models/Waiter.js');
    const waiter = await Waiter.findById(payload.waiterId)
      .select('deviceId isActive restaurantId').lean();

    if (!waiter || !waiter.isActive) {
      return res.status(403).json({ error: 'Akkaunt faol emas' });
    }

    // Qurilma almashtirilgan bo'lsa eski token ishlamaydi
    if (waiter.deviceId && waiter.deviceId !== payload.deviceId) {
      return res.status(403).json({
        error: 'Qurilma o\u2018zgargan. Qayta kiring.',
        code: 'DEVICE_MISMATCH',
      });
    }

    req.waiterId = payload.waiterId;
    req.restaurantId = String(waiter.restaurantId);
    next();
  } catch {
    return res.status(401).json({ error: 'Sessiya tugagan' });
  }
};
