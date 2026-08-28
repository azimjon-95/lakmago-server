import crypto from 'crypto';
import { config } from '../config/index.js';

/**
 * Maxfiy qiymatlarni shifrlash (AES-256-GCM).
 *
 * Restoranlarning merchant kalitlari va bank rekvizitlari bazada
 * ochiq matnda saqlanmasligi kerak: baza nusxasi sizib chiqsa
 * ular bilan pul o'tkazish mumkin bo'ladi.
 *
 * GCM tanlangan, chunki u shifrlash bilan birga butunlikni ham
 * tekshiradi — kimdir bazadagi qiymatni o'zgartirsa, ochishda
 * xato beradi.
 */

function key() {
  const raw = config.secretsKey || config.jwtSecret || '';
  if (!raw) throw new Error('SECRETS_ENCRYPTION_KEY sozlanmagan');
  // Har qanday uzunlikdagi matndan 32 baytli kalit
  return crypto.createHash('sha256').update(String(raw)).digest();
}

/** Ochiq matn → "v1:iv:tag:shifr" (base64). */
export function encryptSecret(plain) {
  if (plain === null || plain === undefined || plain === '') return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

/** Orqaga o'girish. Buzilgan bo'lsa xato beradi. */
export function decryptSecret(stored) {
  if (!stored) return '';
  const parts = String(stored).split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Shifrlangan qiymat formati noto‘g‘ri');
  }
  const [, ivB64, tagB64, dataB64] = parts;
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/** Panelda ko'rsatish uchun: "****4542" — uzunligini oshkor qilmaydi. */
export function maskTail(value, keep = 4) {
  const s = String(value || '');
  if (s.length <= keep) return '*'.repeat(s.length);
  return '****' + s.slice(-keep);
}
