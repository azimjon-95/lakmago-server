/**
 * Buyurtma narxi diagnostikasi — FAQAT O'QIYDI, bazaga hech narsa yozmaydi.
 *
 *   node scripts/diagnose-order.js G1794657454060388     # bitta buyurtma (groupId yoki Order _id)
 *   node scripts/diagnose-order.js --markup              # ustamali restoranlar + ustamasiz yozilgan buyurtmalar
 *   node scripts/diagnose-order.js --markup --since=2026-11-01
 *
 * Hodisa (2026-11-14): menyuda 89 100 (81 000 + restoran ustamasi 10%) ko'ringan pitsa buyurtmada 81 000 bo'lib qoldi —
 * buyurtma yaratishda `deliveryMarkupPercent` bazadan o'qilmagan edi (misc.js select). Bu skript:
 *   • bitta buyurtmada: pozitsiyalar, tanlangan hajm, restoran/mijoz narxi, moliya snapshoti, taomning HOZIRGI nomi va hajmlari;
 *   • --markup: ustamasi > 0 restoranlar va ustama 0 bilan yozilgan buyurtmalar (restoran ololmagan ustama summasi).
 */
import mongoose from 'mongoose';
import { config } from '../src/config/index.js';
import { Order } from '../src/models/Order.js';
import { Dish } from '../src/models/Dish.js';
import { Restaurant } from '../src/models/Restaurant.js';
import { activeAgreement } from '../src/models/CommissionAgreement.js';

const som = (n) => (Math.round(Number(n) || 0)).toLocaleString('ru-RU');
const tiyin = (n) => Math.round((Number(n) || 0) / 100);
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] || null;

async function one(key) {
  const q = /^[a-f\d]{24}$/i.test(key) ? { _id: key } : { groupId: key };
  const orders = await Order.find(q).lean();
  if (!orders.length) { console.log(`Topilmadi: ${key}`); return; }
  for (const o of orders) {
    const rest = await Restaurant.findById(o.restaurantId).select('name deliveryMarkupPercent').lean();
    const ag = await activeAgreement(o.restaurantId).catch(() => null);
    console.log(`\n══ Buyurtma ${o._id} · ${o.groupId} · ${o.restaurantName} · ${o.status} · ${new Date(o.createdAt).toISOString()}`);
    console.log(`Restoran ustamasi (hozir): ${rest?.deliveryMarkupPercent ?? 0}% · mijoz haqi (kelishuv): ${ag?.customerFeePercent ?? 0}% · komissiya: ${ag?.restaurantCommissionPercent ?? 0}%`);
    for (const it of o.items || []) {
      const v = (it.selectedOptions || []).filter((x) => x.variant).map((x) => x.name);
      const a = (it.selectedOptions || []).filter((x) => !x.variant).map((x) => `${x.name}(+${som(x.price)})`);
      console.log(`  • "${it.name}" ×${it.quantity} · restoran narxi ${som(it.unitPrice)} · mijoz narxi ${it.customerUnitPrice != null ? som(it.customerUnitPrice) : '— (eski buyurtma)'}`
        + ` · hajm: ${v.join(', ') || '— (tanlanmagan/yozilmagan)'}${a.length ? ` · qo'shimcha: ${a.join(', ')}` : ''}`);
      const d = it.dishId ? await Dish.findById(it.dishId).select('name price optionGroups updatedAt').lean() : null;
      if (d) {
        console.log(`    taom HOZIR: "${d.name}" · narx ${som(d.price)} · o'zgargan: ${d.updatedAt ? new Date(d.updatedAt).toISOString() : '?'}`);
        for (const g of d.optionGroups || []) {
          console.log(`      [${g.kind || 'aniqlanmagan'}] ${g.title}: ${(g.options || []).map((x) => `${x.name}=${som(x.price)}`).join(', ')}`);
        }
        if (d.name !== it.name) console.log(`    ⚠ Buyurtmadagi nom bazadagi hozirgi nomdan farq qiladi — taom buyurtmadan KEYIN qayta nomlangan.`);
      }
    }
    const f = o.finance || {};
    console.log(`  Taomlar (subtotal): ${som(o.subtotal)} · yetkazish: ${som(o.deliveryFee)} · JAMI: ${som(o.total)} · to'lov: ${o.paymentMethod}`);
    if (f.model) {
      console.log(`  Moliya: baza ${som(tiyin(f.foodBase))} + ustama ${som(tiyin(f.deliveryMarkupAmount))} + mijoz haqi ${som(tiyin(f.customerFeeAmount))}`
        + ` · restoranga ${som(tiyin(f.restaurantPayout))}`);
      if ((rest?.deliveryMarkupPercent || 0) > 0 && !f.deliveryMarkupAmount) {
        const lost = Math.round(tiyin(f.foodBase) * rest.deliveryMarkupPercent / 100);
        console.log(`  ⚠ USTAMA YOZILMAGAN: restoran ${rest.deliveryMarkupPercent}% ustamasi (~${som(lost)} so'm) olinmagan — tuzatilgan xato.`);
      }
    }
  }
}

async function markupReport() {
  const since = arg('since') ? new Date(arg('since')) : new Date(Date.now() - 30 * 864e5);
  const rests = await Restaurant.find({ deliveryMarkupPercent: { $gt: 0 } }).select('name deliveryMarkupPercent').lean();
  console.log(`Ustamasi > 0 restoranlar: ${rests.length}`);
  let totalLost = 0; let totalOrders = 0;
  for (const r of rests) {
    const orders = await Order.find({
      restaurantId: r._id, createdAt: { $gte: since }, 'finance.model': 'v2', status: { $ne: 'cancelled' },
    }).select('finance.foodBase finance.deliveryMarkupAmount').lean();
    const bad = orders.filter((o) => !o.finance?.deliveryMarkupAmount && o.finance?.foodBase > 0);
    const lost = bad.reduce((s, o) => s + Math.round(tiyin(o.finance.foodBase) * r.deliveryMarkupPercent / 100), 0);
    totalLost += lost; totalOrders += bad.length;
    console.log(`  • ${r.name}: ustama ${r.deliveryMarkupPercent}% · ${since.toISOString().slice(0, 10)} dan buyon buyurtma ${orders.length}, ustamasiz ${bad.length} · olinmagan ~${som(lost)} so'm`);
  }
  console.log(`JAMI: ustamasiz yozilgan buyurtma ${totalOrders}, restoran ololmagan ustama ~${som(totalLost)} so'm (bekor qilinganlarsiz)`);
}

async function main() {
  await mongoose.connect(config.mongoUri);
  if (process.argv.includes('--markup')) await markupReport();
  const key = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (key) await one(key);
  if (!key && !process.argv.includes('--markup')) console.log('Foydalanish: node scripts/diagnose-order.js <groupId|orderId> [--markup] [--since=YYYY-MM-DD]');
  await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
