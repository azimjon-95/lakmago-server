import { User } from '../models/User.js';
import { notifyUser } from './telegram.js';

/*
 * ═══ TELEFON ↔ TELEGRAM HISOBI: ishonchli tekshiruv ═══
 *
 * Mijoz ilovada (bir marta, ixtiyoriy) Telegram'ning "raqamni ulashish" oynasida
 * rozilik bersa, Telegram botga KONTAKT xabarini yuboradi. Bu xabar bot webhook'i
 * orqali keladi (mijoz ilovasi uni soxtalashtira olmaydi) va unda:
 *   contact.user_id — raqam egasining Telegram ID'si,
 *   from.id         — xabarni yuborgan hisob.
 * Ikkisi teng bo'lsa — raqam aynan shu Telegram hisobiga tegishli → phoneVerified.
 * Boshqa odamning kontakti yuborilsa — qabul qilinmaydi.
 *
 * Bu buyurtma jarayonining qismi EMAS: rad etilsa ham hech narsa to'xtamaydi.
 */
export function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length < 9 || digits.length > 15) return '';
  return `+${digits.length === 9 ? `998${digits}` : digits}`;
}

export async function handleSharedContact(message) {
  const c = message?.contact;
  const fromId = message?.from?.id;
  if (!c || !fromId) return false;

  if (!c.user_id || String(c.user_id) !== String(fromId)) {
    notifyUser(fromId, '⚠️ Faqat o‘zingizning telefon raqamingizni ulashing (“Raqamni ulashish” tugmasi orqali).');
    return true;
  }
  const phone = normalizePhone(c.phone_number);
  if (!phone) return true;

  const user = await User.findOneAndUpdate(
    { telegramId: String(fromId) },
    { $set: { phone, phoneVerified: true, phoneVerifiedAt: new Date() } },
    { new: true },
  ).select('_id');
  if (user) notifyUser(fromId, `✅ Telefon raqamingiz tasdiqlandi: ${phone}`);
  return true;
}
