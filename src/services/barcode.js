import crypto from 'node:crypto';
import { Dish } from '../models/Dish.js';

/*
 * ═══ SHTRIX-KOD (do'kon mahsulotlari) ═══
 *
 * Majburiy emas. Egasi o'zi yozishi mumkin (mahsulot ustidagi haqiqiy kod),
 * yoki "Yaratish" tugmasi bilan tizim bergan kodni oladi:
 *   EAN-13, prefiks "200" — GS1 qoidasiga ko'ra 20–29 oralig'i do'kon ICHKI
 *   foydalanishi uchun ajratilgan, ya'ni haqiqiy ishlab chiqaruvchi kodi
 *   bilan hech qachon to'qnashmaydi. Oxirgi raqam — nazorat raqami, shuning
 *   uchun oddiy shtrix-kod skaneri/printeri ham qabul qiladi.
 *
 * Takrorlanmaslik:
 *   • TIZIM YARATGAN kod — hamma do'konlar bo'yicha unikal (bazada tekshiriladi);
 *   • qo'lda yozilgan kod — bitta do'kon ichida takrorlanmaydi (bir xil tovar
 *     turli do'konlarda bir xil ishlab chiqaruvchi kodiga ega bo'lishi tabiiy).
 */

/** EAN-13 nazorat raqami (dastlabki 12 raqam bo'yicha). */
export function ean13CheckDigit(d12) {
  let sum = 0;
  for (let i = 0; i < 12; i += 1) sum += Number(d12[i]) * (i % 2 === 0 ? 1 : 3);
  return String((10 - (sum % 10)) % 10);
}

export const BARCODE_RE = /^[0-9A-Za-z-]{4,32}$/;

/** Bazada shu kod (istalgan do'konda) bormi. */
async function existsAnywhere(code) {
  return Boolean(await Dish.exists({ barcode: code }));
}

/** Unikal ichki EAN-13. Ketma-ket urinish; tasodifiy raqam kriptografik manbadan. */
export async function generateUniqueBarcode() {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const body = `200${String(crypto.randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
    const code = body + ean13CheckDigit(body);
    if (!(await existsAnywhere(code))) return code;
  }
  throw new Error('Unikal shtrix-kod yaratib bo‘lmadi, qayta urinib ko‘ring');
}

/** Shu do'konda boshqa mahsulot shu kodni ishlatyaptimi (exceptId — tahrirlanayotgan mahsulot). */
export async function barcodeTakenInStore(restaurantId, code, exceptId = null) {
  if (!code) return false;
  const q = { restaurantId, barcode: code };
  if (exceptId) q._id = { $ne: exceptId };
  return Boolean(await Dish.exists(q));
}

/** Kiritilgan kodni tozalaydi: faqat harf/raqam/-, bo'sh bo'lsa ''. */
export function cleanBarcode(v) {
  return typeof v === 'string' ? v.trim().replace(/[^0-9A-Za-z-]/g, '').slice(0, 32) : '';
}
