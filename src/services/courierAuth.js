import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';

/*
 * ═══ LOKMAGO KURYERI: KIRISH (telefon + PIN) ═══
 *
 * • PIN faqat HASH holida (scrypt + tasodifiy tuz) saqlanadi — `scrypt$<tuz>$<hash>`; solishtirish doimiy-vaqtli.
 * • Token: JWT { role: 'courier', courierId, v } — `v` (tokenVersion) PIN almashganda / bloklanganda oshiriladi va
 *   eski tokenlar DARHOL ishlamay qoladi (middleware har so'rovda bazadan tekshiradi).
 * • PIN: 4–8 raqam. Oddiy "1111/1234" lar admin tomonidan berilmasin — validatsiyada rad etiladi.
 */
const SCRYPT_N = 16384;
const KEYLEN = 32;

export function isPinAcceptable(pin) {
  const p = String(pin ?? '');
  if (!/^\d{4,8}$/.test(p)) return false;
  if (/^(\d)\1+$/.test(p)) return false;                       // 1111, 000000
  const asc = '0123456789012'; const desc = '9876543210987';
  if (asc.includes(p) || desc.includes(p)) return false;       // 1234, 4321, 6789
  return true;
}

export function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pin), salt, KEYLEN, { N: SCRYPT_N }).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPin(pin, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hash] = parts;
  const want = Buffer.from(hash, 'hex');
  let got;
  try { got = crypto.scryptSync(String(pin ?? ''), salt, KEYLEN, { N: SCRYPT_N }); } catch { return false; }
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

export function signCourierToken(courier) {
  return jwt.sign(
    { role: 'courier', courierId: String(courier._id), v: Number(courier.tokenVersion) || 0 },
    config.jwtSecret,
    { expiresIn: '30d' },
  );
}

/** Token → payload (yaroqsiz bo'lsa null). Bazaga murojaat qilmaydi. */
export function readCourierToken(token) {
  try {
    const p = jwt.verify(String(token || ''), config.jwtSecret);
    return p?.role === 'courier' && p.courierId ? p : null;
  } catch {
    return null;
  }
}
