import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { getAppleConfig } from '../config/apple.js';
import { AppleAuthChallenge } from '../models/AppleAuthChallenge.js';
import { User } from '../models/User.js';
import { AuthIdentity } from '../models/AuthIdentity.js';
import { Session } from '../models/Session.js';
import { findIdentity, linkIdentity } from './authIdentity.js';
import { blockedPayload } from './customerBlock.js';
import { signToken, signAccessToken, generateRefreshToken, hashRefreshToken, refreshTokenExpiry } from '../middleware/auth.js';

/*
 * ═══ SIGN IN WITH APPLE (faqat iOS ilovasi) — ALOHIDA, QO'SHIMCHA KIRISH USULI ═══
 *
 * Telegram kirishiga (controllers/misc.js → completeTelegramAuth, services/tgLinkLogin.js) TEGILMAYDI va ular
 * o'zgartirilmagan. Bu modul faqat UMUMIY primitivlardan foydalanadi: token yordamchilari (middleware/auth.js),
 * Session modeli, AuthIdentity (services/authIdentity.js — aynan shu "Google/Apple/Phone" uchun mo'ljallangan edi).
 *
 * Xavfsizlik:
 *   • Identity token Apple'ning OMMAVIY kalitlari (JWKS) bilan RS256 imzosi bo'yicha tekshiriladi.
 *   • issuer = https://appleid.apple.com, audience = Bundle ID (APPLE_CLIENT_IDS), exp/iat tekshiriladi.
 *   • NONCE: server bergan bir martalik challenge'ning nonce'i token ichidagi `nonce` bilan MOS bo'lishi shart.
 *   • Challenge ATOMIK sarflanadi (findOneAndUpdate usedAt:null) → ikkinchi marta ishlamaydi; muddati 5 daqiqa;
 *     qurilma (deviceId) bilan bog'langan.
 *   • Identity provider=apple, providerUserId=sub sifatida ALOHIDA saqlanadi. Email bo'yicha akkaunt BIRLASHTIRILMAYDI
 *     (email umuman o'qilmaydi/saqlanmaydi): Apple akkaunti hech qachon boshqa (masalan Telegram) profilga o'zi qo'shilmaydi.
 */

export class AppleAuthError extends Error {
  constructor(status, code, message, payload, logInfo) {
    super(message);
    this.status = status;
    this.code = code;
    this.payload = payload;
    this.logInfo = logInfo;        // faqat server logi uchun (maxfiy emas: aud/iss/vaqt); javobga qo'shilmaydi
  }
}
const fail = (status, code, message, logInfo) => new AppleAuthError(status, code, message, undefined, logInfo);

const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
const safeEq = (a, b) => {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/* ───────────── Apple ommaviy kalitlari (JWKS): kesh + noma'lum kid bo'lsa bir marta yangilash ───────────── */
let keyCache = { keys: new Map(), fetchedAt: 0 };
let keyProvider = null;                       // testlar uchun: async (kid) => jwk | null
const KEYS_TTL_MS = 6 * 60 * 60 * 1000;
const KEYS_REFETCH_MIN_MS = 60 * 1000;        // noma'lum kid so'rovlari bilan Apple'ni bombardimon qilmaymiz

export function setAppleKeyProvider(fn) { keyProvider = fn || null; }
export function resetAppleKeyCache() { keyCache = { keys: new Map(), fetchedAt: 0 }; }

async function fetchKeys() {
  const { jwksUrl } = getAppleConfig();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(jwksUrl, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    if (!Array.isArray(j?.keys)) throw new Error('keys yo\'q');
    const map = new Map();
    for (const k of j.keys) if (k?.kid && k.kty === 'RSA') map.set(k.kid, k);
    keyCache = { keys: map, fetchedAt: Date.now() };
  } finally { clearTimeout(timer); }
}

async function getAppleKey(kid) {
  if (keyProvider) return keyProvider(kid);
  const fresh = Date.now() - keyCache.fetchedAt < KEYS_TTL_MS;
  if (fresh && keyCache.keys.has(kid)) return keyCache.keys.get(kid);
  const canRefetch = Date.now() - keyCache.fetchedAt > KEYS_REFETCH_MIN_MS;
  if (!fresh || canRefetch) {
    try { await fetchKeys(); } catch (e) {
      if (keyCache.keys.has(kid)) return keyCache.keys.get(kid);   // Apple vaqtincha javob bermasa — eski kesh
      throw fail(503, 'APPLE_KEYS_UNAVAILABLE', 'Apple bilan aloqa o\'rnatilmadi, keyinroq urinib ko\'ring', { url: getAppleConfig().jwksUrl, error: String(e?.message || e) });
    }
  }
  return keyCache.keys.get(kid) || null;
}

/* ───────────── Challenge ───────────── */
export const isAppleLoginEnabled = () => getAppleConfig().enabled;

const requireIos = (platform) => {
  if (platform !== 'ios') throw fail(400, 'PLATFORM_NOT_SUPPORTED', 'Apple orqali kirish faqat iOS ilovasida mavjud');
};
const cleanDevice = (v) => String(v || '').slice(0, 128);

/** Bir martalik challenge: { challengeId, nonce, expiresIn } */
export async function createAppleChallenge({ platform, deviceId } = {}) {
  requireIos(platform);
  const { challengeTtlSec } = getAppleConfig();
  const nonce = crypto.randomBytes(32).toString('base64url');
  const doc = await AppleAuthChallenge.create({
    nonce, platform: 'ios', deviceId: cleanDevice(deviceId), expiresAt: new Date(Date.now() + challengeTtlSec * 1000),
  });
  return { challengeId: String(doc._id), nonce, expiresIn: challengeTtlSec };
}

/** Challenge'ni ATOMIK sarflaydi. Yaroqsiz/eskirgan/ishlatilgan bo'lsa — aniq kodli xato. */
async function consumeChallenge(challengeId) {
  const now = new Date();
  let doc = null;
  try {
    doc = await AppleAuthChallenge.findOneAndUpdate(
      { _id: challengeId, usedAt: null, expiresAt: { $gt: now } },
      { $set: { usedAt: now } },
      { new: false },
    );
  } catch { throw fail(400, 'CHALLENGE_INVALID', 'Challenge noto\'g\'ri'); }
  if (doc) return doc;
  const existing = await AppleAuthChallenge.findById(challengeId).lean().catch(() => null);
  if (!existing) throw fail(400, 'CHALLENGE_INVALID', 'Challenge topilmadi');
  if (existing.usedAt) throw fail(409, 'CHALLENGE_USED', 'Challenge allaqachon ishlatilgan');
  throw fail(410, 'CHALLENGE_EXPIRED', 'Challenge muddati tugagan — qaytadan urinib ko\'ring');
}

/* ───────────── Identity token ───────────── */
/**
 * Imzo (RS256, Apple kaliti), issuer, audience, exp, iat va NONCE tekshiriladi. Qaytaradi: token payload.
 * @param {string} token Apple identity token (JWT)
 * @param {{ expectedNonce: string }} opts
 */
export async function verifyAppleIdentityToken(token, { expectedNonce }) {
  const cfg = getAppleConfig();
  if (typeof token !== 'string' || token.length < 20 || token.length > 8192) throw fail(401, 'TOKEN_INVALID', 'Apple tokeni noto\'g\'ri');
  const decoded = jwt.decode(token, { complete: true });
  const kid = decoded?.header?.kid;
  if (!decoded || decoded.header.alg !== 'RS256' || typeof kid !== 'string') throw fail(401, 'TOKEN_INVALID', 'Apple tokeni noto\'g\'ri');

  const jwk = await getAppleKey(kid);
  if (!jwk) throw fail(401, 'TOKEN_INVALID', 'Apple tokeni noto\'g\'ri (kalit topilmadi)');

  let payload;
  try {
    const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    payload = jwt.verify(token, publicKey, {
      algorithms: ['RS256'], issuer: cfg.issuer, audience: cfg.clientIds, clockTolerance: cfg.clockToleranceSec,
    });
  } catch (e) {
    const p = decoded.payload || {};
    const info = { aud: p.aud, iss: p.iss, expected: cfg.clientIds, jwt: e?.message };
    if (e?.name === 'TokenExpiredError') throw fail(401, 'TOKEN_EXPIRED', 'Apple tokeni muddati tugagan', info);
    if (/audience/i.test(e?.message)) throw fail(401, 'AUDIENCE_MISMATCH', 'Apple tokeni boshqa ilova uchun berilgan', info);
    if (/issuer/i.test(e?.message)) throw fail(401, 'ISSUER_MISMATCH', 'Apple tokeni noto\'g\'ri (issuer)', info);
    if (/signature/i.test(e?.message)) throw fail(401, 'SIGNATURE_INVALID', 'Apple tokeni imzosi noto\'g\'ri', info);
    throw fail(401, 'TOKEN_INVALID', 'Apple tokeni tekshiruvdan o\'tmadi', info);
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.iat !== 'number') throw fail(401, 'TOKEN_INVALID', 'Apple tokeni noto\'g\'ri (iat yo\'q)');   // Apple tokenlarida iat doim bor
  if (payload.iat > now + cfg.clockToleranceSec || now - payload.iat > cfg.maxTokenAgeSec) {
    throw fail(401, 'TOKEN_EXPIRED', 'Apple tokeni juda eski', { iat: payload.iat, serverNow: now, diffSec: now - payload.iat });   // server soati noto'g'ri bo'lsa shu ko'rinadi
  }
  if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 255) throw fail(401, 'TOKEN_INVALID', 'Apple tokeni noto\'g\'ri (sub)');

  // NONCE: token ichidagi qiymat bizning challenge nonce'imizga (yoki uning SHA-256 hex ko'rinishiga) teng bo'lishi shart
  const n = payload.nonce;
  if (typeof n !== 'string' || !n || !(safeEq(n, expectedNonce) || safeEq(n, sha256hex(expectedNonce)))) {
    throw fail(401, 'NONCE_MISMATCH', 'Apple tokenidagi nonce mos kelmadi', { hasNonce: typeof n === 'string' && n.length > 0, nonceLen: typeof n === 'string' ? n.length : 0 });
  }
  return payload;
}

/* ───────────── Foydalanuvchi ───────────── */
const cleanName = (v) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
const DEFAULT_FIRST_NAME = 'Mijoz';

async function createAppleUser({ givenName, familyName }) {
  return User.create({
    role: 'customer', status: 'ACTIVE', languageCode: 'uz',
    firstName: cleanName(givenName) || DEFAULT_FIRST_NAME, lastName: cleanName(familyName) || undefined,
  });
}

/** Sessiya: Telegram oqimidagi bilan BIR XIL shakl (completeTelegramAuth → { token, accessToken, refreshToken, user, isNewUser }) */
async function issueSession(user, deviceId) {
  const role = user.role ?? 'customer';
  const token = signToken(String(user._id), role);
  const accessToken = signAccessToken(String(user._id), role);
  const refreshToken = generateRefreshToken();
  await Session.create({
    userId: user._id, refreshTokenHash: hashRefreshToken(refreshToken), deviceId: cleanDevice(deviceId), platform: 'ios', expiresAt: refreshTokenExpiry(),
  });
  return { token, accessToken, refreshToken };
}

/**
 * Apple orqali kirish. Mavjud foydalanuvchi (provider=apple, sub bo'yicha) yoki yangi.
 * @returns {{ token, accessToken, refreshToken, user, isNewUser }}
 */
export async function loginWithApple({ challengeId, identityToken, deviceId, platform, givenName, familyName } = {}) {
  requireIos(platform);
  if (!challengeId || !identityToken) throw fail(400, 'BAD_REQUEST', 'challengeId va identityToken kerak');

  const challenge = await consumeChallenge(challengeId);
  if (challenge.deviceId && challenge.deviceId !== cleanDevice(deviceId)) throw fail(400, 'CHALLENGE_DEVICE_MISMATCH', 'Challenge boshqa qurilma uchun berilgan');

  const payload = await verifyAppleIdentityToken(identityToken, { expectedNonce: challenge.nonce });
  const sub = payload.sub;

  let user = null;
  let isNewUser = false;
  const identity = await findIdentity('apple', sub);
  if (identity) user = await User.findById(identity.userId);

  if (!user) {
    try {
      user = await createAppleUser({ givenName, familyName });
    } catch (e) {
      if (e?.code === 11000) {
        // Masalan: eski bazada telegramId indeksi sparse EMAS (loyiha boshida required+unique edi) → Telegram ID'siz
        // ikkinchi foydalanuvchi yaratib bo'lmaydi. Yechim: scripts/apple-diagnose.js --fix-telegram-index
        throw fail(500, 'USER_CREATE_DUPLICATE', 'Hisob yaratib bo\'lmadi (server sozlamasi)', { keyPattern: e.keyPattern, index: e.message?.match(/index: (\S+)/)?.[1] });
      }
      throw e;
    }
    isNewUser = true;
    if (identity) {
      // Identity bor, lekin foydalanuvchi hujjati yo'q (nomuvofiqlik): identity'ni yangi foydalanuvchiga ko'chiramiz
      await AuthIdentity.updateOne({ provider: 'apple', providerUserId: sub }, { $set: { userId: user._id } });
    } else {
      try {
        await linkIdentity(user._id, 'apple', sub);
      } catch (e) {
        // Poyga: bir vaqtda ikkinchi so'rov shu sub bilan allaqachon foydalanuvchi yaratib bo'lgan → o'shanikini ishlatamiz,
        // o'zimiz yaratganini o'chiramiz (yetim hisob qolmaydi).
        await User.deleteOne({ _id: user._id }).catch(() => {});
        const winner = await findIdentity('apple', sub);
        if (!winner) throw e;
        user = await User.findById(winner.userId);
        isNewUser = false;
        if (!user) throw e;
      }
    }
  }

  if (user.status === 'BLOCKED') {
    const p = blockedPayload(user);
    throw new AppleAuthError(403, 'BLOCKED', p?.error || 'Hisob bloklangan', p);
  }
  // Hisob o'chirilgan edi (cheklov tufayli identity saqlangan) — Telegram oqimidagidek yangi bo'sh profil sifatida tiklanadi
  if (user.status === 'DELETED') { user.status = 'ACTIVE'; user.deletedAt = undefined; await user.save(); }

  const session = await issueSession(user, deviceId);
  return { ...session, user, isNewUser };
}
