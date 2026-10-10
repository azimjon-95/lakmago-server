/*
 * Restoran QABUL QILMAGAN (pending) buyurtmani rad etish sabablari — yagona ro'yxat
 * (restoran boti va restoran paneli). Sabab Order.cancelReason (matn) va
 * Order.cancelReasonCode (kod — tahlil uchun) ga yoziladi.
 *
 * no_answer / not_confirmed — naqd buyurtmada restoran mijozga qo'ng'iroq qilib
 * tasdiqlay olmagan holatlar: takroriy holatlarni aniqlash uchun alohida kod.
 */
export const REJECT_REASONS = {
  no_answer: 'Mijoz telefonga javob bermadi',
  not_confirmed: 'Mijoz buyurtmani tasdiqlamadi',
  out: 'Taom tugagan',
  busy: 'Oshxona band',
  far: 'Manzil juda uzoq',
  closing: 'Yopilish vaqti',
  other: 'Boshqa sabab',
};
