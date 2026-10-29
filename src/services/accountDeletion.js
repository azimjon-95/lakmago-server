import { User } from '../models/User.js';
import { Order } from '../models/Order.js';
import { Session } from '../models/Session.js';
import { AuthIdentity } from '../models/AuthIdentity.js';
import { PushSubscription } from '../models/PushSubscription.js';
import { Address } from '../models/Address.js';
import { SupportChat } from '../models/SupportChat.js';

/*
 * ═══ HISOBNI O'CHIRISH (App Store Guideline 5.1.1(v)) ═══
 *
 * Mijoz profilidan o'z hisobini o'chiradi. Nima bo'ladi:
 *   • Shaxsiy ma'lumotlar TOZALANADI: ism, username, rasm, telefon, manzillar (ikkala joyda), saqlangan kartalar, sevimlilar,
 *     bonus, qo'llab-quvvatlash yozishmalari;
 *   • barcha sessiyalar (qurilmalar) bekor qilinadi, push obunalari o'chiriladi;
 *   • Telegram bog'lanishi bo'shatiladi — xohlasa keyin YANGI hisob sifatida qayta kira oladi;
 *   • buyurtma tarixi hisob-kitob va restoranlar bilan hisoblashish uchun SAQLANADI (qonuniy talab), lekin hisobga
 *     bog'lanmagan ("o'chirilgan foydalanuvchi") bo'lib qoladi.
 *
 * Suiiste'molga qarshi: bloklangan yoki naqd to'lovi o'chirilgan mijoz cheklovdan qutulish uchun hisobini o'chirib qayta
 * ro'yxatdan o'tolmaydi — ularda Telegram bog'lanishi (faqat cheklov uchun) saqlanadi, qayta kirsa cheklov o'z kuchida.
 *
 * Faol buyurtma bor bo'lsa — o'chirib bo'lmaydi (restoran va kuryer buyurtmani bajarayotgan bo'ladi).
 * Demo hisob (App Store) va panel hisoblari (admin/restoran) bu yo'l bilan o'chirilmaydi.
 */
const IN_PROGRESS = ['awaiting_payment', 'pending', 'accepted', 'preparing', 'ready', 'delivering'];

const fail = (status, code, message) => Object.assign(new Error(message), { status, code });

export async function deleteAccount(userId) {
  const user = await User.findById(userId);
  if (!user) throw fail(404, 'NOT_FOUND', 'Foydalanuvchi topilmadi');
  if (user.status === 'DELETED') return { ok: true, already: true };
  if (user.role && user.role !== 'customer') throw fail(403, 'NOT_ALLOWED', 'Bu hisobni ilovadan o‘chirib bo‘lmaydi');
  if (user.isDemo) throw fail(403, 'DEMO_ACCOUNT', 'Demo hisobni o‘chirib bo‘lmaydi');

  // userId filtri bor — standart qamrov bu so'rovni demo buyurtmalardan ham o'tkazadi (ahamiyatsiz, demo bu yerga kelmaydi)
  if (await Order.exists({ userId: user._id, status: { $in: IN_PROGRESS } })) {
    throw fail(409, 'ACTIVE_ORDERS', 'Faol buyurtmangiz bor — yakunlangach hisobni o‘chirishingiz mumkin');
  }

  const restricted = user.status === 'BLOCKED' || Boolean(user.cashDisabled?.active);
  const now = new Date();
  const $set = {
    deletedAt: now, firstName: 'Foydalanuvchi', lastName: '', username: '', photoUrl: '', phone: '', phoneVerified: false,
    languageCode: '', addresses: [], favorites: [], cards: [], bonusBalance: 0, isSubscribed: false,
  };
  if (user.status !== 'BLOCKED') $set.status = 'DELETED';   // bloklangan bo'lsa — bloklanganicha qoladi
  const $unset = { defaultAddressId: 1, clickToken: 1, phoneVerifiedAt: 1 };
  if (!restricted) $unset.telegramId = 1;                    // bo'shatiladi: keyin yangi hisob sifatida kira oladi

  await User.updateOne({ _id: user._id }, { $set, $unset });
  await Session.updateMany({ userId: user._id, revokedAt: null }, { $set: { revokedAt: now } });   // revokedAt standarti null
  await PushSubscription.deleteMany({ userId: user._id });
  await Address.deleteMany({ userId: user._id });      // saqlangan manzillar (alohida kolleksiya)
  await SupportChat.deleteMany({ userId: user._id });   // qo'llab-quvvatlash bilan yozishmalar (shaxsiy matn bo'lishi mumkin)
  if (!restricted) await AuthIdentity.deleteMany({ userId: user._id });
  return { ok: true, retainedRestriction: restricted };
}
