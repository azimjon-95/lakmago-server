/*
 * MIJOZGA QAYTADIGAN BUYURTMA — moliya snapshotisiz.
 *
 * Order.finance — ichki hisob-kitob: LokmaGo netto daromadi (lokmaNetCommission), Click haqi,
 * shlyuz residuali, restoran ulushi. Mijoz ilovasi `order.finance` ni UMUMAN o'qimaydi (summani
 * `total`, `subtotal`, `deliveryFee` dan oladi), shu bilan birga avval mijozning o'z buyurtmalari
 * ro'yxati, tafsiloti, "Ha, oldim" va yaratish javoblari hammasini xom hujjat bilan qaytarardi.
 * Endi hammasi shu funksiyadan o'tadi (res.json hujjat uchun toJSON ishlatadi — shakl o'zgarmaydi).
 */
export function customerOrderView(order) {
  if (!order) return order;
  const o = typeof order.toJSON === 'function' ? order.toJSON() : { ...order };
  delete o.finance;
  return o;
}
