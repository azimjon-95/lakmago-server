import { z } from 'zod';
import { asyncHandler } from '../middleware/error.js';
import { startLogin, pollLogin } from '../services/tgLinkLogin.js';
import { completeTelegramAuth } from './misc.js';

/*
 * Telegram bot havolasi orqali kirish (services/tgLinkLogin.js). Javoblar keshlanmaydi.
 *   POST /auth/tg-link/start  { platform?, deviceId?, lang?, ref? }  → { code, pollSecret, appLink, deepLink, expiresIn }
 *   POST /auth/tg-link/poll   { code, pollSecret }                   → { status: pending|expired|cancelled|used|ok, ...tokenlar }
 */
const startSchema = z.object({
  platform: z.enum(['web', 'android', 'ios']).optional(),
  deviceId: z.string().max(80).optional(),
  lang: z.enum(['uz', 'uzc', 'ru']).optional(),
  ref: z.string().max(64).optional(),
});

export const tgLinkAuthController = {
  start: asyncHandler(async (req, res) => {
    const parsed = startSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Ma‘lumot noto‘g‘ri' });
    const out = await startLogin({ ...parsed.data, ip: req.ip, userAgent: req.get('user-agent') });
    res.set('Cache-Control', 'no-store').json(out);
  }),

  poll: asyncHandler(async (req, res) => {
    const r = await pollLogin(req.body, { complete: completeTelegramAuth });
    res.set('Cache-Control', 'no-store').status(r.http).json(r.body);
  }),
};
