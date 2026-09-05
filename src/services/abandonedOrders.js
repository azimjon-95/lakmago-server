import { Order } from '../models/Order.js';
import { Transaction } from '../models/Transaction.js';

/*
 * ═══ TASHLAB KETILGAN TO'LOVLARNI TOZALASH ═══
 *
 * Mijoz karta bilan to'lashni boshlaganda buyurtma
 * `status: 'awaiting_payment'` bilan yaratiladi va restoranga
 * KO'RINMAYDI. Agar mijoz Click sahifasida to'lamasdan chiqib
 * ketsa, bu yozuv bazada ABADIY qolib ketardi.
 *
 * Zarari to'g'ridan-to'g'ri emas (pul harakati yo'q, restoran
 * ko'rmaydi), lekin:
 *   • baza vaqt o'tishi bilan keraksiz yozuvlar bilan to'lib boradi
 *   • hisobotlarda shovqin hosil qiladi
 *   • qo'lda tekshirishda "bu buyurtma nega osilib qolgan?" degan
 *     savol tug'diradi
 *
 * XAVFSIZLIK — ENG MUHIM QISM:
 * Buyurtma FAQAT quyidagi hamma shart bajarilgandagina bekor
 * qilinadi:
 *   1. status hali ham 'awaiting_payment'
 *   2. isPaid = false
 *   3. TUGALLANMAGAN yoki muvaffaqiyatli tranzaksiyasi YO'Q
 *
 * Uchinchi shart hal qiluvchi: agar Click prepare yuborgan bo'lsa
 * (tranzaksiya state=1) yoki to'lov o'tgan bo'lsa (state=2), buyurtma
 * TEGILMAYDI. Aks holda mijoz to'lash arafasida turganda yoki
 * webhook kechikkanda buyurtmasini bekor qilib yuborgan bo'lardik.
 */

// Necha soatdan keyin tashlab ketilgan hisoblanadi
const ABANDON_AFTER_HOURS = 24;

export async function cancelAbandonedPayments() {
  const cutoff = new Date(Date.now() - ABANDON_AFTER_HOURS * 60 * 60 * 1000);

  const candidates = await Order.find({
    status: 'awaiting_payment',
    isPaid: false,
    createdAt: { $lt: cutoff },
  }).select('_id').lean();

  if (!candidates.length) return { checked: 0, cancelled: 0 };

  const ids = candidates.map((o) => o._id);

  /*
   * Boshlangan yoki tugagan tranzaksiyasi bor buyurtmalarni
   * ro'yxatdan CHIQARAMIZ. state < 0 (bekor qilingan) hisobga
   * olinmaydi — u to'lov amalga oshmaganini bildiradi, demak
   * buyurtmani bekor qilish xavfsiz.
   */
  const active = await Transaction.find({
    orderId: { $in: ids },
    state: { $gte: 1 },
  }).select('orderId').lean();

  const blocked = new Set(active.map((t) => String(t.orderId)));
  const toCancel = ids.filter((id) => !blocked.has(String(id)));

  if (!toCancel.length) return { checked: ids.length, cancelled: 0 };

  /*
   * Yana bir bor status tekshiriladi (`status: 'awaiting_payment'`).
   * Yuqoridagi so'rov bilan shu qator orasida webhook kelib
   * buyurtmani to'langan qilgan bo'lishi mumkin — bu shart
   * o'sha holatda yozuvni himoya qiladi.
   */
  const res = await Order.updateMany(
    { _id: { $in: toCancel }, status: 'awaiting_payment', isPaid: false },
    {
      status: 'cancelled',
      cancelReason: 'To‘lov amalga oshirilmadi',
      cancelledAt: new Date(),
    },
  );

  return { checked: ids.length, cancelled: res.modifiedCount ?? 0 };
}
