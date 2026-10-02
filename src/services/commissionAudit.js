import { Order } from '../models/Order.js';
import { Restaurant } from '../models/Restaurant.js';
import { CommissionAgreement } from '../models/CommissionAgreement.js';
import { Payment } from '../models/Payment.js';
import { Ledger } from '../models/Ledger.js';
import { getSettings } from '../models/Settings.js';

/*
 * ═══════════════════════════════════════════════════════════
 * KOMISSIYA AUDITI — HAR RESTORAN O'Z KELISHUVIDAN HISOBLANYAPTIMI
 * ═══════════════════════════════════════════════════════════
 * FAQAT O'QIYDI (hech narsa yozmaydi). Haqiqiy bazada ishga tushiriladi:
 *   node scripts/audit-commission.js [--since=2026-08-01] [--json]
 *
 * Tekshiradi (har restoran uchun):
 *  1. Buyurtma snapshot'idagi foiz (finance) == buyurtma YARATILGAN paytda amalda bo'lgan
 *     kelishuv. Farq — kimdir/nimadir kelishuvdan boshqa foiz qo'llagan.
 *  2. Payment.lokmaPercentApplied == buyurtma foizi.
 *  3. Jurnaldagi 'commission' yozuvi (meta.commissionPercent) == buyurtma foizi.
 *  4. Faol kelishuvi YO'Q restoranlar (komissiya 0% bo'lib ketadi).
 *  5. Ikkinchi, eski manba (Restaurant.commissionPercent) kelishuvdan farq qiladimi.
 *  6. Global foizlar (Settings) — qiymatlari ko'rsatiladi.
 *  "10% shubhalisi": kutilgan foiz 10 emas, lekin qo'llangani 10.
 */

const EPS = 0.001;
const near = (a, b) => Math.abs((Number(a) || 0) - (Number(b) || 0)) <= EPS;
const fmt = (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000));

export async function auditCommission({ since = null, sampleLimit = 15 } = {}) {
  const settings = await getSettings();
  const restaurants = await Restaurant.find()
    .select('name commissionPercent commissionMode deliveryMarkupPercent').lean();
  const agreements = await CommissionAgreement.find().sort({ effectiveFrom: -1 }).lean();

  const agreementsOf = new Map();
  for (const a of agreements) {
    const k = String(a.restaurantId);
    if (!agreementsOf.has(k)) agreementsOf.set(k, []);
    agreementsOf.get(k).push(a);
  }
  const agreementAtDate = (rid, date) => (agreementsOf.get(String(rid)) || []).find((a) => (
    new Date(a.effectiveFrom) <= date && (!a.effectiveTo || new Date(a.effectiveTo) > date)
  )) || null;

  const stats = new Map();
  for (const r of restaurants) {
    const current = agreementAtDate(r._id, new Date());
    stats.set(String(r._id), {
      restaurantId: String(r._id),
      name: r.name,
      agreement: current
        ? { restaurant: current.restaurantCommissionPercent, customer: current.customerFeePercent, total: current.totalSplitPercent, from: current.effectiveFrom, status: current.status }
        : null,
      legacyPercent: r.commissionPercent ?? null,
      orders: { total: 0, snapshot: 0, legacy: 0, noAgreement: 0 },
      percentsUsed: {},          // "5+5" → buyurtmalar soni (kelishuv tarixi)
    });
  }

  const sample = (bucket, item) => { bucket.count += 1; if (bucket.sample.length < sampleLimit) bucket.sample.push(item); };
  const anomalies = {
    snapshotVsAgreement: { count: 0, sample: [] },
    paymentPercent: { count: 0, sample: [] },
    ledgerPercent: { count: 0, sample: [] },
    static10Suspects: { count: 0, sample: [] },
  };
  const suspect10 = (kind, actual, expected, item) => {
    if (near(actual, 10) && !near(expected, 10)) sample(anomalies.static10Suspects, { kind, ...item });
  };

  // ── 1) Buyurtmalar ──
  const orderFilter = { fulfillment: { $ne: 'dinein' }, status: { $nin: ['cancelled', 'awaiting_payment'] } };
  if (since) orderFilter.createdAt = { $gte: new Date(since) };
  const expectedByOrder = new Map(); // orderId → { sum, source }
  const cursor = Order.find(orderFilter)
    .select('restaurantId createdAt finance.model finance.restaurantCommissionPercent finance.customerFeePercent finance.commissionAgreementId')
    .lean().cursor();
  for await (const o of cursor) {
    const st = stats.get(String(o.restaurantId));
    if (!st) continue;
    st.orders.total += 1;
    const created = new Date(o.createdAt);
    const ag = agreementAtDate(o.restaurantId, created);
    const expRest = ag ? ag.restaurantCommissionPercent : 0;
    const expCust = ag ? ag.customerFeePercent : 0;

    if (o.finance?.model === 'v2') {
      st.orders.snapshot += 1;
      const rp = Number(o.finance.restaurantCommissionPercent) || 0;
      const cp = Number(o.finance.customerFeePercent) || 0;
      const key = `${fmt(rp)}+${fmt(cp)}`;
      st.percentsUsed[key] = (st.percentsUsed[key] || 0) + 1;
      if (!ag) st.orders.noAgreement += 1;
      if (!near(rp, expRest) || !near(cp, expCust)) {
        sample(anomalies.snapshotVsAgreement, {
          orderId: String(o._id), restaurant: st.name, createdAt: created.toISOString(),
          applied: `${fmt(rp)}+${fmt(cp)}`, agreementAtThatTime: ag ? `${fmt(expRest)}+${fmt(expCust)}` : 'kelishuv yo‘q',
        });
        suspect10('snapshot', rp + cp, expRest + expCust, { orderId: String(o._id), restaurant: st.name });
      }
      expectedByOrder.set(String(o._id), { sum: rp + cp, source: 'snapshot' });
    } else {
      st.orders.legacy += 1;
      if (!ag) st.orders.noAgreement += 1;
      expectedByOrder.set(String(o._id), { sum: expRest + expCust, source: 'agreement-at-order-time' });
    }
  }

  // ── 2) To'lovlar ──
  const payCursor = Payment.find({ status: 'SUCCESS' }).select('orderId lokmaPercentApplied').lean().cursor();
  for await (const p of payCursor) {
    const exp = expectedByOrder.get(String(p.orderId));
    if (!exp) continue;
    if (!near(p.lokmaPercentApplied, exp.sum)) {
      sample(anomalies.paymentPercent, { orderId: String(p.orderId), recorded: p.lokmaPercentApplied, expected: exp.sum, source: exp.source });
      suspect10('payment', p.lokmaPercentApplied, exp.sum, { orderId: String(p.orderId) });
    }
  }

  // ── 3) Jurnal (komissiya yozuvlari): faqat snapshot'li buyurtmalarda taqqoslanadi ──
  const ledCursor = Ledger.find({ type: 'commission' }).select('orderId meta.commissionPercent').lean().cursor();
  for await (const l of ledCursor) {
    const exp = expectedByOrder.get(String(l.orderId));
    if (!exp || exp.source !== 'snapshot') continue;
    if (!near(l.meta?.commissionPercent, exp.sum)) {
      sample(anomalies.ledgerPercent, { orderId: String(l.orderId), recorded: l.meta?.commissionPercent, expected: exp.sum });
      suspect10('ledger', l.meta?.commissionPercent, exp.sum, { orderId: String(l.orderId) });
    }
  }

  const rows = [...stats.values()].sort((a, b) => b.orders.total - a.orders.total);
  return {
    generatedAt: new Date().toISOString(),
    since,
    globals: {
      settingsCommissionPercent: settings.commissionPercent ?? 0,
      dineInCommissionPercent: settings.dineIn?.commissionPercent ?? 0,
      envSplitLokmaPercent: process.env.SPLIT_LOKMA_PERCENT || null,   // endi ishlatilmaydi
    },
    restaurants: rows,
    withoutAgreement: rows.filter((r) => !r.agreement).map((r) => ({ restaurantId: r.restaurantId, name: r.name, orders: r.orders.total })),
    legacyDiffers: rows.filter((r) => r.agreement && r.legacyPercent != null && !near(r.legacyPercent, r.agreement.restaurant))
      .map((r) => ({ name: r.name, legacy: r.legacyPercent, agreement: r.agreement.restaurant })),
    anomalies,
  };
}

/** Odam o'qiydigan hisobot. */
export function formatAudit(a) {
  const L = [];
  L.push(`KOMISSIYA AUDITI · ${a.generatedAt}${a.since ? ` · ${a.since} dan` : ''}`);
  L.push('');
  L.push('Global foizlar (kelishuvdan MUSTAQIL manbalar):');
  L.push(`  Settings.commissionPercent        = ${a.globals.settingsCommissionPercent}  (faqat snapshot'siz ESKI buyurtmalar uchun zaxira)`);
  L.push(`  Settings.dineIn.commissionPercent = ${a.globals.dineInCommissionPercent}  (zal xizmati; hamma restoranga bir xil)`);
  if (a.globals.envSplitLokmaPercent) L.push(`  .env SPLIT_LOKMA_PERCENT=${a.globals.envSplitLokmaPercent}  → ENDI ISHLATILMAYDI, .env dan olib tashlang`);
  L.push('');
  L.push('Restoranlar:');
  for (const r of a.restaurants) {
    const ag = r.agreement ? `restoran ${fmt(r.agreement.restaurant)}% + mijoz ${fmt(r.agreement.customer)}% = ${fmt(r.agreement.total)}%` : 'KELISHUV YO‘Q';
    const used = Object.entries(r.percentsUsed).map(([k, n]) => `${k}%×${n}`).join(', ') || '—';
    L.push(`  • ${r.name}: ${ag}`);
    L.push(`      buyurtma: ${r.orders.total} (snapshot ${r.orders.snapshot}, eski ${r.orders.legacy}); qo‘llangan foizlar: ${used}`);
  }
  L.push('');
  const A = a.anomalies;
  L.push(`Farqlar: snapshot≠kelishuv ${A.snapshotVsAgreement.count} · to‘lov foizi ${A.paymentPercent.count} · jurnal foizi ${A.ledgerPercent.count} · 10% shubhalisi ${A.static10Suspects.count}`);
  for (const [k, v] of Object.entries(A)) for (const s of v.sample) L.push(`    [${k}] ${JSON.stringify(s)}`);
  if (a.withoutAgreement.length) L.push(`\nFaol kelishuvi YO‘Q (komissiya 0%): ${a.withoutAgreement.map((r) => `${r.name} (${r.orders} buyurtma)`).join(', ')}`);
  if (a.legacyDiffers.length) L.push(`Eski maydon (Restaurant.commissionPercent) kelishuvdan FARQ qiladi (faqat eski buyurtmalarga ta'sir): ${a.legacyDiffers.map((r) => `${r.name} ${r.legacy}% ≠ ${r.agreement}%`).join(', ')}`);
  const clean = !A.snapshotVsAgreement.count && !A.paymentPercent.count && !A.ledgerPercent.count && !A.static10Suspects.count;
  L.push(`\n${clean ? '✓ HAMMASI MOS: har buyurtma o‘z restorani kelishuvi foizida hisoblangan' : '✗ FARQLAR BOR — yuqoridagi namunalarga qarang'}`);
  return L.join('\n');
}
