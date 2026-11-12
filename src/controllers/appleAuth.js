import { asyncHandler } from '../middleware/error.js';
import { AppleAuthError, createAppleChallenge, isAppleLoginEnabled, loginWithApple } from '../services/appleAuth.js';

/*
 * Sign in with Apple (faqat iOS ilovasi). Telegram kirishining controller'lariga (misc.js, tgLinkAuth.js) TEGILMAGAN.
 *   GET  /api/auth/apple/config      — ilova tugmani ko'rsatishi kerakmi: { enabled }
 *   POST /api/auth/apple/challenge   — bir martalik challenge (nonce)        Body: { platform:'ios', deviceId }
 *   POST /api/auth/apple             — kirish                                 Body: { challengeId, identityToken, platform:'ios', deviceId, givenName?, familyName? }
 * APPLE_SIGNIN_ENABLED=true bo'lmasa challenge/kirish 404 (standart — o'chiq).
 */
// Har bir rad etish logga yoziladi (token/sub/email YO'Q — faqat kod va xavfsiz tafsilot) — "nega kirib bo'lmadi?" serverda aniq ko'rinadi
const send = (res, e, stage) => {
  if (e instanceof AppleAuthError) {
    console.warn(`[apple-auth] ${stage}: ${e.status} ${e.code}`, e.logInfo ? JSON.stringify(e.logInfo) : '');
    return res.status(e.status).json(e.payload || { error: e.message, code: e.code });
  }
  console.error(`[apple-auth] ${stage}: kutilmagan xato`, e?.name, e?.code ?? '', e?.message);
  return res.status(500).json({ error: 'Server xatosi', code: 'SERVER_ERROR' });
};

export const appleAuthController = {
  config: (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ enabled: isAppleLoginEnabled() });
  },

  challenge: asyncHandler(async (req, res) => {
    if (!isAppleLoginEnabled()) return res.status(404).json({ error: 'Topilmadi' });
    try {
      res.json(await createAppleChallenge({ platform: req.body?.platform, deviceId: req.body?.deviceId }));
    } catch (e) { send(res, e, 'challenge'); }
  }),

  login: asyncHandler(async (req, res) => {
    if (!isAppleLoginEnabled()) return res.status(404).json({ error: 'Topilmadi' });
    const b = req.body || {};
    try {
      res.json(await loginWithApple({
        challengeId: b.challengeId, identityToken: b.identityToken, deviceId: b.deviceId, platform: b.platform,
        givenName: b.givenName, familyName: b.familyName,
      }));
    } catch (e) { send(res, e, 'login'); }
  }),
};
