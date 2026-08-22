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
/**
 * Telegram WebApp initData'ni tasdiqlaydi.
 *
 * XAVFSIZLIK (2026-08 audit natijasida qattiqlashtirildi):
 *  1) Hash solishtirish crypto.timingSafeEqual orqali — oddiy
 *     !== operatori satrlarni belgima-belgi solishtiradi,
 *     nazariy jihatdan vaqt-hujumiga (timing attack) ochiq
 *     qoldiradi (tashqi tarmoq orqali amalda amalga oshirish
 *     juda qiyin bo'lsa-da, to'g'ri usul shu).
 *  2) auth_date tekshiriladi — Telegram'ning o'zi tavsiya
 *     qiladigan choralardan: eski, biroq TO'G'RI imzolangan
 *     initData satri (masalan brauzer tarixidan yoki log
 *     fayldan olingan) qayta ishlatilishining (replay attack)
 *     oldini oladi. 24 soatdan eski bo'lsa rad etiladi.
 */
export function verifyTelegramInitData(initData) {
  if (!config.telegramBotToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
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

  // Doimiy-vaqtli solishtirish — uzunlik farq qilsa ham xato
  // tashlamasligi uchun avval uzunlikni tekshiramiz
  const computedBuf = Buffer.from(computed, 'hex');
  const hashBuf = Buffer.from(hash, 'hex');
  if (computedBuf.length !== hashBuf.length) return null;
  if (!crypto.timingSafeEqual(computedBuf, hashBuf)) return null;

  // Eskirganini tekshirish — 24 soatdan katta bo'lsa rad etamiz
  const authDate = Number(params.get('auth_date'));
  const MAX_AGE_SEC = 24 * 60 * 60;
  if (!authDate || Date.now() / 1000 - authDate > MAX_AGE_SEC) return null;

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

/**
 * Ofitsiant YOKI restoran admini — ikkalasi ham stol boshqaruvi
 * (mehmon qabul qilish, taom kiritish, chek yopish) qila oladi.
 *
 * NEGA KERAK (2026-08): avval bu amallar FAQAT waiterAuth bilan
 * himoyalangan edi — restoran o'z admin akkaunti bilan kirsa ham
 * stolga bosib buyurtma ololmasdi, ofitsiant yollanishi SHART
 * edi. Endi ikkalasi ham xuddi shu endpointlardan foydalanadi:
 *
 *   role==='waiter'     -> req.waiterId TO'LDIRILADI (avvalgidek,
 *                          "faqat o'ziga biriktirilgan stollar"
 *                          cheklovi ishlaydi)
 *   role==='restaurant' -> req.waiterId NULL qoladi — kontroller
 *                          buni "cheklovsiz, BARCHA stollarga
 *                          ruxsat" deb talqin qiladi (mavjud
 *                          kodda allaqachon shunday yozilgan:
 *                          `if (req.waiterId) { ... tekshiruv }`)
 *
 * Boshqa rol (admin/staff/customer) — rad etiladi. Bu FAQAT
 * restoranning o'zi va uning ofitsiantlari uchun.
 */
export const waiterOrRestaurantAuth = async (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'Kirish kerak' });

  try {
    const payload = jwt.verify(token, config.jwtSecret);

    if (payload.role === 'restaurant') {
      if (!payload.restaurantId) return res.status(403).json({ error: 'Ruxsat yo\u2018q' });
      req.role = 'restaurant';
      req.userId = payload.userId;
      req.restaurantId = String(payload.restaurantId);
      return next();
    }

    if (payload.role === 'waiter') {
      const { Waiter } = await import('../models/Waiter.js');
      const waiter = await Waiter.findById(payload.waiterId)
        .select('deviceId isActive restaurantId').lean();
      if (!waiter || !waiter.isActive) {
        return res.status(403).json({ error: 'Akkaunt faol emas' });
      }
      if (waiter.deviceId && waiter.deviceId !== payload.deviceId) {
        return res.status(403).json({ error: 'Qurilma o\u2018zgargan. Qayta kiring.', code: 'DEVICE_MISMATCH' });
      }
      req.role = 'waiter';
      req.waiterId = payload.waiterId;
      req.restaurantId = String(waiter.restaurantId);
      return next();
    }

    return res.status(403).json({ error: 'Ruxsat yo\u2018q' });
  } catch {
    return res.status(401).json({ error: 'Sessiya tugagan' });
  }
};
