import { AuthIdentity } from '../models/AuthIdentity.js';

/**
 * Account linking fundamenti (Auth 3-bosqich).
 *
 * IKKITA ANIQ FARQLI SSENARIY bor, ular chalkashtirilmasligi kerak:
 *
 *   1) LOGIN — hali autentifikatsiya qilinmagan so'rov. Identity
 *      orqali User topiladi (yoki topilmasa, chaqiruvchi YANGI
 *      User yaratadi — bu authController.telegram/telegramWeb
 *      ichida, o'zgarishsiz qoladi, chunki "yangi User yaratish"
 *      bu funksiyaning ishi emas).
 *
 *   2) LINKING — ALLAQACHON autentifikatsiya qilingan foydalanuvchi
 *      (req.userId mavjud) o'z akkauntiga YANGI provayder identity
 *      qo'shmoqchi (masalan kelajakda: Telegram bilan kirgan
 *      foydalanuvchi Google'ni ham bog'lamoqchi). BU YERDA XAVFSIZLIK
 *      MUHIM: agar o'sha Google identity ALLAQACHON boshqa User'ga
 *      bog'langan bo'lsa, jimgina o'sha identityni "olib qo'yish"
 *      YO'L QO'YILMAYDI — bu ikkita alohida mijozning akkauntlarini
 *      kimdir ataylab yoki tasodifan birlashtirib yuborishi bo'lardi.
 *
 * Hozircha faqat 'telegram' provayderi ishlaydi (login oqimi
 * quyidagi linkIdentity()'ni chaqiradi — nazariy emas, HAQIQIY
 * ishlatiladi). Google/Apple/Phone provayderlari implement
 * qilinganda, ularning controller'lari (auth qilingan so'rovda)
 * shu FUNKSIYANING O'ZINI chaqiradi — auth arxitekturasi qayta
 * yozilmaydi, faqat yangi provider-validation qatlami qo'shiladi.
 */

/**
 * Berilgan userId'ga provider+providerUserId identity'ni bog'laydi.
 *
 * - Identity mavjud emas -> yaratiladi, shu userId'ga bog'lanadi.
 * - Identity ALLAQACHON shu userId'ga bog'langan -> no-op (idempotent).
 * - Identity BOSHQA userId'ga bog'langan -> xato tashlanadi
 *   (kod: IDENTITY_ALREADY_LINKED, status 409) — chaqiruvchi buni
 *   ushlab, mos javob qaytarishi kerak ("Bu Telegram/Google akkaunt
 *   allaqachon boshqa profilga bog'langan").
 *
 * @returns {{ identity, alreadyLinked: boolean }}
 */
export async function linkIdentity(userId, provider, providerUserId) {
  const existing = await AuthIdentity.findOne({ provider, providerUserId });

  if (existing) {
    if (String(existing.userId) === String(userId)) {
      return { identity: existing, alreadyLinked: true };
    }
    const err = new Error(
      `Bu ${provider} akkaunt allaqachon boshqa LokmaGo profiliga bog'langan`,
    );
    err.status = 409;
    err.code = 'IDENTITY_ALREADY_LINKED';
    throw err;
  }

  const identity = await AuthIdentity.create({ userId, provider, providerUserId });
  return { identity, alreadyLinked: false };
}

/**
 * Provider+providerUserId bo'yicha AuthIdentity'ni topadi (LOGIN
 * oqimi uchun — hali qaysi User ekanligi noma'lum bo'lganda).
 * Topilmasa null — chaqiruvchi buni "yangi foydalanuvchi" deb
 * talqin qiladi.
 */
export async function findIdentity(provider, providerUserId) {
  return AuthIdentity.findOne({ provider, providerUserId }).lean();
}
