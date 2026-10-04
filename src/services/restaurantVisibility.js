/*
 * ═══ RESTORANGA QAYSI BUYURTMA KO'RINADI — YAGONA QOIDA ═══
 *
 * CLAUDE.md 1-QOIDA: pul yechilmaguncha buyurtma restoranga hech
 * qanday yo'l bilan bormaydi.
 *
 * Avval ro'yxatlarda faqat `status: { $ne: 'awaiting_payment' }`
 * turardi. Ikki teshik bor edi:
 *
 *  1. To'lanmay qolib BEKOR bo'lgan karta buyurtmasi (mijoz o'zi
 *     bekor qildi yoki 24 soatlik tozalash — abandonedOrders.js)
 *     status 'cancelled' bo'lib qoladi va restoran ro'yxatiga
 *     "Bekor" bo'lib tushardi — restoran hech qachon ko'rmagan,
 *     puli yechilmagan buyurtma.
 *
 *  2. `?status=awaiting_payment` so'rovi `$ne` filtrini USTIDAN
 *     yozib yuborardi va to'lanmagan buyurtmalar qaytardi.
 *
 * `$nor` alohida kalit bo'lgani uchun `filter.status = ...` uni
 * bosib ketmaydi.
 *
 * "Restoranga hech chiqmagan" belgisi: karta buyurtmasi, bekor,
 * kunlik raqami YO'Q va to'langan vaqti YO'Q. Kunlik raqam faqat
 * restoranga chiqarilganda beriladi (misc.js, paymentRecord.js),
 * pul qaytarilganda ham o'chirilmaydi — shuning uchun to'lanib,
 * keyin qaytarilgan buyurtma restoran ro'yxatida QOLADI.
 */
export const NEVER_RELEASED_CANCELLED = {
  status: 'cancelled',
  paymentMethod: { $ne: 'cash' },
  dailyNumber: null,
  paidAt: null,
};

export const RESTAURANT_HIDDEN = {
  $nor: [
    { status: 'awaiting_payment' },
    NEVER_RELEASED_CANCELLED,
  ],
};
