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

export function signToken(userId, role) {
  return jwt.sign({ userId, role }, config.jwtSecret, { expiresIn: '30d' });
}
