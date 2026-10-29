/*
 * ═══ DEMO BUYURTMALAR: STANDART QAMROV (default scope) ═══
 *
 * App Store tekshiruvi uchun demo hisob buyurtma beradi (services/demoAccount.js). Bu buyurtmalar HAQIQIY hisobotlarga
 * (daromad, komissiya, statistika, monitor, eslatmalar, avto-bekor) tushmasligi shart. Har bir so'rovga alohida filtr
 * qo'shish o'rniga (biri esa unutilib qolishi mumkin) — Order modelining BARCHA so'rovlariga standart filtr qo'yiladi:
 *
 *      isDemo !== true
 *
 * ISTISNOLAR (demo buyurtma ko'rinadigan holatlar):
 *   • so'rov filtrida `userId` bor      — mijoz o'z buyurtmalarini ko'radi (ro'yxat, kuzatuv, bekor qilish);
 *   • so'rov filtrida `isDemo` bor      — demo xizmatlari o'zi aniq so'raydi (simulyator, tozalash);
 *   • so'rov `{ includeDemo: true }` opsiyasi bilan — qo'lda (setOptions / aggregate.option).
 *
 * Mavjud (eski) buyurtmalarda `isDemo` maydoni YO'Q — `$ne: true` ularga mos keladi: hech narsa o'zgarmaydi.
 */
const OPS = /^(find|count|countDocuments|distinct|update|updateOne|updateMany|delete|deleteOne|deleteMany|replaceOne)/;
const has = (obj, key) => Boolean(obj) && Object.prototype.hasOwnProperty.call(obj, key);

export function demoScope(schema) {
  schema.pre(OPS, function applyDemoScope() {
    if (this.getOptions?.().includeDemo) return;
    const filter = this.getFilter?.() || {};
    if (has(filter, 'userId') || has(filter, 'isDemo')) return;
    this.where({ isDemo: { $ne: true } });
  });

  schema.pre('aggregate', function applyDemoScopeAggregate() {
    if (this.options?.includeDemo) return;
    const pipeline = this.pipeline();
    const first = pipeline[0]?.$match;
    if (first && (has(first, 'userId') || has(first, 'isDemo'))) return;
    // $geoNear/$search birinchi bosqich bo'lishi SHART — filtr undan keyin qo'yiladi
    const at = pipeline[0] && (pipeline[0].$geoNear || pipeline[0].$search) ? 1 : 0;
    pipeline.splice(at, 0, { $match: { isDemo: { $ne: true } } });
  });
}
