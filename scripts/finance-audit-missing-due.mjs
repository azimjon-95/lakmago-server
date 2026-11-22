/*
 * ═══════════════════════════════════════════════════════════════════════════
 * MOLIYAVIY AUDIT — "restaurant_due YOZILMAGAN" 3 BUYURTMA (FAQAT O'QIYDI, READ-ONLY)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   FINANCE_AUDIT_URI='mongodb+srv://<READONLY_USER>:<PAROL>@<cluster>/' \
 *     node finance-audit-missing-due.mjs --db=test [--out=missing-due.json] [--json]
 *
 * Doira (SCOPE, kod ichida qat'iy): Osiyo kafe'dagi 2 ta va Volidam Osiyo'dagi 1 ta buyurtma — ular "yetkazilgan, lekin
 * restaurant_due yozuvi yo'q" deb topilgan (chuqurlashtirilgan audit, 2026-11-22) — va shu ikki restoranning o'zi (balans konteksti).
 * Boshqa restoran/buyurtma so'ralmaydi.
 *
 * Bazaga HECH NARSA yozmaydi. finance-audit.mjs dagi UCHTA MUSTAQIL himoya qatlami saqlangan:
 *  1) HUQUQ DARVOZASI — kolleksiyalarga murojaatdan OLDIN `connectionStatus {showPrivileges:true}`; faqat o'qish huquqi bo'lmasa kod 4.
 *  2) BUYRUQ RUXSAT RO'YXATI — har bir wire buyrug'i yuborilishidan oldin; ro'yxatdan tashqari buyruq yoki aggregate ichida `$out`/`$merge` → kod 3.
 *  3) KOD — faqat `mongodb` drayveri, yozish metodlari yo'q, `.env` o'qilmaydi, mongoose yo'q; faqat `find`.
 * Mijozning shaxsiy ma'lumoti (telefon, manzil, ism, userId, karta) so'ralmaydi. Hech narsa tuzatilmaydi.
 *
 * Hisobot FAKT / TAXMIN / NOMA'LUM bo'limlariga ajratilgan. Taxmin hech qachon fakt sifatida ko'rsatilmaydi.
 * Qoidalar production (`main`) kodiga asoslangan (billing.js settleOrder, orderFlow.js, deliveryCheck.js, courierDispatch.js).
 */
import { MongoClient, ObjectId } from 'mongodb';
import { writeFileSync, existsSync } from 'node:fs';

const EXIT = { OK: 0, USAGE: 2, FORBIDDEN_COMMAND: 3, NOT_READ_ONLY: 4, ERROR: 1 };

/* ─── Tekshiruv doirasi: FAQAT shular ─── */
export const SCOPE = Object.freeze({
  restaurants: Object.freeze([
    '6ab76b5a8be3984b83624122',   // Osiyo kafe
    '6a9fc10fa6ae8a984c7552b9',   // Volidam Osiyo
  ]),
  orders: Object.freeze({           // buyurtma → u tegishli bo'lishi kerak bo'lgan restoran
    '6accaad699f996bdedf9a8f6': '6ab76b5a8be3984b83624122',
    '6af6c7f0debad38f7c96a004': '6ab76b5a8be3984b83624122',
    '6af8557b58b6a44f3d4ab09c': '6a9fc10fa6ae8a984c7552b9',
  }),
});

/** Oldingi auditdan (2026-11-22) — FAQAT solishtirish uchun, bu skript ularni qayta o'qimaydi (ESKI DO'STLAR doiradan tashqari). */
export const PRIOR_AUDIT = Object.freeze({
  '6ab76b5a8be3984b83624122': 166350,
  '6a9fc10fa6ae8a984c7552b9': -82020,
  '6af5b0e45ae9fa1dc1263324': 5100,
  net: 89430,
});

export const ALLOWED_COMMANDS = new Set([
  'hello', 'ismaster', 'isMaster', 'ping', 'buildInfo', 'buildinfo',
  'saslStart', 'saslContinue', 'authenticate', 'getnonce',
  'connectionStatus',
  'find', 'aggregate', 'getMore', 'killCursors', 'endSessions',
]);
export const READ_ACTIONS = new Set([
  'find', 'listCollections', 'listIndexes', 'listSearchIndexes', 'collStats', 'dbStats', 'dbHash',
  'killCursors', 'changeStream', 'listDatabases', 'planCacheRead', 'indexStats',
]);
const FORBIDDEN_STAGES = ['$out', '$merge'];

const argv = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.length ? v.join('=') : true];
}));
const die = (code, msg) => { process.stderr.write(`\n⛔ ${msg}\n`); process.exit(code); };

export function pipelineHasWriteStage(node) {
  if (Array.isArray(node)) return node.some(pipelineHasWriteStage);
  if (node && typeof node === 'object') {
    return Object.keys(node).some((k) => FORBIDDEN_STAGES.includes(k) || pipelineHasWriteStage(node[k]));
  }
  return false;
}

export function analyzePrivileges(status) {
  const users = status?.authInfo?.authenticatedUsers || [];
  const privs = status?.authInfo?.authenticatedUserPrivileges || [];
  const actions = new Set(privs.flatMap((p) => p.actions || []));
  const nonRead = [...actions].filter((a) => !READ_ACTIONS.has(a)).sort();
  return {
    users: users.map((u) => `${u.user}@${u.db}`),
    roles: (status?.authInfo?.authenticatedUserRoles || []).map((r) => `${r.role}@${r.db}`),
    actions: [...actions].sort(),
    nonRead,
    ok: users.length > 0 && actions.size > 0 && nonRead.length === 0,
  };
}

const redact = (uri) => String(uri).replace(/\/\/([^@/]*)@/, '//***:***@');

/* ═══════════════════════════════════════════════════════════════════════════
 * TAHLIL MANTIG'I (sof funksiyalar)
 * ═══════════════════════════════════════════════════════════════════════════ */
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const sId = (v) => (v == null ? null : String(v));
const ts = (d) => (d ? new Date(d).getTime() : null);
const iso = (d) => (d ? new Date(d).toISOString() : null);
const tiyinToSom = (t) => (Number(t) || 0) / 100;
const PROMO_NOTE = /jalb qilish qarzi — delivery tushumidan/;
export const STALE_JOB_MS = 12 * 3600 * 1000;      // deliveryCheck: 12 soatdan oshgan "yo'lda" buyurtmalar avtomatik yetkazilgan deb belgilanadi
export const NEIGHBOR_MS = 10 * 60 * 1000;

/** Jurnal yozuvining Restaurant.balance ga ta'siri — main kodi bo'yicha (finance-audit-drilldown.mjs bilan bir xil). */
export function balanceEffect(l) {
  const amt = Number(l.amount) || 0;
  if (l.type === 'restaurant_due' || l.type === 'bonus_compensation' || l.type === 'payout') return amt;
  if (l.type === 'adjustment' && PROMO_NOTE.test(l.meta?.note || '')) return -amt;
  return 0;
}

/**
 * settleOrder (main) bu buyurtma uchun NIMA yozgan BO'LARDI. Faqat v2 snapshot bo'lsa hisoblanadi;
 * legacy buyurtmada komissiya Restaurant/Settings sozlamasidan olinadi — bazada saqlanmagan, hisoblab BO'LMAYDI.
 */
export function expectedSettlement(order) {
  const fin = order?.finance?.model === 'v2' ? order.finance : null;
  if (!fin) return { known: false, reason: 'snapshot (finance.model=v2) yo‘q: komissiya joriy sozlamadan hisoblanadi, bazada saqlanmagan' };
  const commission = tiyinToSom(fin.lokmaGrossCommission);
  const share = tiyinToSom(fin.restaurantPayout);
  const isCash = order.paymentMethod === 'cash' && order.courierParty !== 'lokma';
  const dueAmount = isCash ? (commission > 0 ? -commission : 0) : share;
  const bonus = (order.bonusItems || []).reduce((s, g) => s + (Number(g.reimburse) || 0) * (Number(g.quantity) || 0), 0);
  return {
    known: true, isCash, commission: r2(commission), restaurantShare: r2(share), dueAmount: r2(dueAmount), bonusCompensation: r2(bonus),
    balanceEffect: r2(dueAmount + bonus),
    rule: isCash ? 'naqd: restaurant_due = −komissiya (komissiya 0 bo‘lsa 0)' : 'karta/LokmaGo kuryeri: restaurant_due = +restoran ulushi',
  };
}

const autoLike = (o) => o?.deliveryCheck?.confirmed === true && !o?.deliveryCheck?.confirmedBy && !o?.deliveryCheck?.confirmedAt;
export const traitsOf = (o) => ({
  paymentMethod: o.paymentMethod || '?',
  courierParty: o.courierParty || 'yo‘q',
  fulfillment: o.fulfillment || '?',
  orderSource: o.orderSource || 'yo‘q',
  yakunlash: autoLike(o) ? 'avtomatik-ish izi' : (o.deliveryCheck?.confirmedBy || 'belgilanmagan'),
  snapshot: o.finance?.model || 'legacy',
  demo: o.isDemo === true ? 'ha' : 'yo‘q',
});

/** Restoranning yetkazilgan buyurtmalari: har bir belgi qiymati bo'yicha "restaurant_due bor/yo'q" soni. */
export function peerStats(delivered, dueOrderIds) {
  const stats = {};
  for (const o of delivered) {
    const has = dueOrderIds.has(String(o._id));
    for (const [k, v] of Object.entries(traitsOf(o))) {
      stats[k] = stats[k] || {};
      stats[k][v] = stats[k][v] || { withDue: 0, withoutDue: 0 };
      stats[k][v][has ? 'withDue' : 'withoutDue'] += 1;
    }
  }
  return stats;
}

/** Bir xil millisekundda yetkazilgan deb belgilangan buyurtmalar guruhlari (updateMany izi). */
export function deliveredClusters(delivered, dueOrderIds) {
  const g = new Map();
  for (const o of delivered) {
    const t = ts(o.deliveredAt);
    if (t == null) continue;
    if (!g.has(t)) g.set(t, []);
    g.get(t).push(o);
  }
  return [...g.entries()].filter(([, v]) => v.length > 1).map(([t, v]) => ({
    deliveredAt: iso(t), count: v.length,
    orders: v.map((o) => ({ orderId: sId(o._id), hasDue: dueOrderIds.has(String(o._id)) })),
  }));
}

/**
 * Bitta buyurtma: nima uchun restaurant_due yo'q?
 * d = { orderId, expectedRestaurantId, order, ledgers[] (shu buyurtmaning BARCHA restoranlardagi yozuvlari), payments[],
 *       restaurant, restLedgers[], restPayouts[], restDelivered[] }
 */
export function analyzeMissingDueOrder(d) {
  const order = d.order;
  const fact = []; const hypotheses = []; const unknown = [];
  const oid = d.orderId;
  if (!order) {
    return { orderId: oid, facts: ['Buyurtma hujjati TOPILMADI'], hypotheses: [], unknown: ['Buyurtma holati'], conclusion: 'tahlil qilib bo‘lmadi' };
  }
  const ledgers = [...(d.ledgers || [])].sort((a, b) => ts(a.createdAt) - ts(b.createdAt));
  const payments = d.payments || [];
  const restLedgers = [...(d.restLedgers || [])].sort((a, b) => ts(a.createdAt) - ts(b.createdAt));
  const delivered = d.restDelivered || [];
  const dueOrderIds = new Set(restLedgers.filter((l) => l.type === 'restaurant_due' && l.orderId).map((l) => String(l.orderId)));

  const own = (type) => ledgers.filter((l) => l.type === type);
  const dueHere = own('restaurant_due');
  const commissionHere = own('commission');
  const exp = expectedSettlement(order);
  const wrongRestaurant = d.expectedRestaurantId && sId(order.restaurantId) !== d.expectedRestaurantId;

  fact.push(`Holat: ${order.status}; to‘lov: ${order.paymentMethod}${order.courierParty ? `/${order.courierParty}` : ''}; isPaid=${order.isPaid === true}; jami ${order.total}, taom ${order.subtotal}, yetkazish ${order.deliveryFee}`);
  fact.push(`Yetkazish turi: ${order.fulfillment || '?'}; manba: ${order.orderSource || 'yo‘q'}; demo: ${order.isDemo === true ? 'ha' : 'yo‘q'}; oxirgi o‘zgartirgan roli: ${order.updatedByRole || '—'}`);
  fact.push(`Vaqtlar: yaratildi ${iso(order.createdAt)}, qabul ${iso(order.acceptedAt)}, yo‘lga chiqdi ${iso(order.deliveringAt)}, yetkazildi ${iso(order.deliveredAt)}, oxirgi yangilanish ${iso(order.updatedAt)}`);
  fact.push(`deliveryCheck: so‘ralgan ${order.deliveryCheck?.askedCount ?? '—'} marta, confirmed=${order.deliveryCheck?.confirmed ?? '—'}, confirmedBy=${order.deliveryCheck?.confirmedBy ?? '—'}, confirmedAt=${iso(order.deliveryCheck?.confirmedAt) ?? '—'}`);
  if (order.lokmaCourier) fact.push(`LokmaGo kuryeri: claimedAt=${iso(order.lokmaCourier.claimedAt)}, deliveredAt=${iso(order.lokmaCourier.deliveredAt)}, settledAt=${iso(order.lokmaCourier.settledAt)}`);
  fact.push(`Moliya snapshot: ${order.finance?.model || 'YO‘Q (legacy)'}; financeSettlement: ${order.financeSettlement ? JSON.stringify(order.financeSettlement) : 'yo‘q (main kodida bu maydon yo‘q)'}`);
  fact.push(`Buyurtma restorani: ${sId(order.restaurantId)}${wrongRestaurant ? ` ≠ kutilgan ${d.expectedRestaurantId}` : ' (kutilgan bilan mos)'}`);
  fact.push(`Shu buyurtmaning jurnal yozuvlari (barcha restoranlar bo‘yicha): ${ledgers.length ? ledgers.map((l) => `${l.type} ${r2(l.amount)} [rest ${sId(l.restaurantId)}]`).join('; ') : 'YO‘Q'}`);
  fact.push(`restaurant_due: ${dueHere.length} ta; commission: ${commissionHere.length} ta; payment_in: ${own('payment_in').length} ta`);
  fact.push(payments.length ? `Payment: ${payments.map((p) => `${p.status}/${p.provider}/${p.amount}t`).join(', ')}` : 'Payment hujjati yo‘q');
  if (exp.known) fact.push(`settleOrder (main) yozgan BO‘LARDI: ${exp.rule}; komissiya ${exp.commission}, restoran ulushi ${exp.restaurantShare}, restaurant_due ${exp.dueAmount}, sovg‘a-bonus ${exp.bonusCompensation} → balansga ta‘siri ${exp.balanceEffect}`);
  else fact.push(`settleOrder yozgan summani hisoblab bo‘lmaydi: ${exp.reason}`);

  // Yaqin atrofdagi yozuvlar (shu restoran)
  const anchor = ts(order.deliveredAt) ?? ts(order.updatedAt);
  const neighbors = anchor == null ? [] : restLedgers.filter((l) => Math.abs(ts(l.createdAt) - anchor) <= NEIGHBOR_MS).map((l) => ({
    at: iso(l.createdAt), gapSec: r2((ts(l.createdAt) - anchor) / 1000), type: l.type, amount: r2(l.amount), orderId: sId(l.orderId),
  }));
  fact.push(`Yetkazilish vaqti (±10 daqiqa) atrofida shu restoran jurnalida ${neighbors.length} ta yozuv`);
  let runAt = 0;
  if (anchor != null) for (const l of restLedgers) if (ts(l.createdAt) <= anchor) runAt = r2(runAt + balanceEffect(l));
  const nearPayouts = anchor == null ? [] : (d.restPayouts || []).filter((p) => Math.abs(ts(p.createdAt) - anchor) <= 3600000).map((p) => ({ at: iso(p.createdAt), amount: p.amount, status: p.status }));

  // Tengdoshlar: shu restoranning boshqa yetkazilgan buyurtmalari
  const stats = peerStats(delivered, dueOrderIds);
  const myTraits = traitsOf(order);
  const peerLines = Object.entries(myTraits).map(([k, v]) => {
    const c = stats[k]?.[v] || { withDue: 0, withoutDue: 0 };
    return { belgi: k, qiymat: v, withDue: c.withDue, withoutDue: c.withoutDue };
  });
  const clusters = deliveredClusters(delivered, dueOrderIds);
  const myCluster = clusters.find((c) => c.orders.some((x) => x.orderId === oid));
  fact.push(`Tengdoshlar (shu restoranning yetkazilgan buyurtmalari): ${peerLines.map((p) => `${p.belgi}=${p.qiymat}: due bor ${p.withDue} / yo‘q ${p.withoutDue}`).join('; ')}`);
  fact.push(myCluster ? `Bu buyurtma bilan BIR XIL millisekundda (${myCluster.deliveredAt}) yetkazilgan deb belgilangan buyurtmalar: ${myCluster.count} ta (shundan restaurant_due yo‘q: ${myCluster.orders.filter((x) => !x.hasDue).length})` : 'Boshqa buyurtma bilan bir xil millisekundda yetkazilgan deb belgilanmagan');

  /* ── TAXMIN-lar ── */
  const hyp = (h, evidence, status) => { hypotheses.push({ ...h, evidence, status: evidence.length ? (status || 'izlar bor (tasdiqlanmagan)') : 'izlar topilmadi' }); };

  const longWait = order.deliveredAt && order.createdAt && ts(order.deliveredAt) - ts(order.createdAt) >= STALE_JOB_MS;
  const evA = [];
  if (autoLike(order)) evA.push('deliveryCheck.confirmed=true, lekin confirmedBy/confirmedAt yo‘q (avtomatik ish faqat `confirmed` ni belgilaydi)');
  if (longWait) evA.push(`yaratilganidan yetkazilgunicha ≥12 soat (${r2((ts(order.deliveredAt) - ts(order.createdAt)) / 3600000)} soat)`);
  if (myCluster) evA.push(`bir millisekundda ${myCluster.count} ta buyurtma yetkazilgan deb belgilangan (updateMany izi)`);
  hyp({
    id: 'M-A', claim: 'Buyurtma 12 soatlik AVTOMATIK yakunlash ishi (deliveryCheck) orqali "yetkazildi" qilingan, keyin settleOrder xato bergan va xato YUTILGAN',
    code: 'main:deliveryCheck.js — barcha eskirgan buyurtmalar bitta updateMany bilan (status:delivered, deliveredAt: hozir) yetkazilgan qilinadi, keyin har biri uchun settleOrder chaqiriladi va `.catch` bo‘sh funksiya: xato HECH QAYERGA yozilmaydi',
    evidenceNeeded: ['Ish ishga tushgan vaqt (pm2 logida deliveryCheck izi bo‘lsa) — lekin xatosi logga TUSHMAYDI', 'Staging’da shu holatni takrorlash (yangi kodda xato yutilmasligi tekshirilgan)'],
  }, evA);

  const evB = [];
  if (!autoLike(order) && order.courierParty !== 'lokma' && order.status === 'delivered') evB.push('avtomatik-ish izi yo‘q, LokmaGo kuryeri emas → odatiy yo‘l (orderFlow.runSideEffects)');
  if (order.deliveryCheck?.confirmedBy) evB.push(`yakunlagan: ${order.deliveryCheck.confirmedBy}`);
  hyp({
    id: 'M-B', claim: 'Odatiy yo‘l (panel/bot status o‘zgarishi): settleOrder chaqirilgan, lekin xato bergan (xato faqat konsolga yozilgan)',
    code: 'main:orderFlow.js runSideEffects — `settleOrder(...).catch(e => console.error("[billing] settleOrder:", e.message))`',
    evidenceNeeded: ['pm2 error log: "[billing] settleOrder:" qatori shu buyurtma yetkazilgan vaqtda (log aylantirilgan bo‘lishi mumkin)'],
  }, evB);

  const evC = [];
  if (order.courierParty === 'lokma') evC.push('courierParty = lokma');
  if (order.lokmaCourier?.claimedAt) evC.push('lokmaCourier.claimedAt mavjud');
  if (order.lokmaCourier?.settledAt) evC.push('lokmaCourier.settledAt mavjud (kuryer hisobi alohida yo‘l)');
  hyp({
    id: 'M-C', claim: 'Kuryer "Topshirdim" yo‘li: settleOrder chaqirilgan (courierDispatch), xato bergan yoki chaqirilmagan',
    code: 'main:courierDispatch.js — `import(billing).then(settleOrder).catch(console.error("[billing] settleOrder (kuryer):"))`',
    evidenceNeeded: ['pm2 error log: "[billing] settleOrder (kuryer):"', 'DeliveryAssignment hujjati (bu skript doirasidan tashqari — alohida ruxsat kerak)'],
  }, evC);

  const evD = [];
  if (commissionHere.length && !dueHere.length) evD.push(`commission yozuvi ${commissionHere.length} ta bor, restaurant_due yo‘q → settle ikki yozuv orasida uzilgan`);
  hyp({
    id: 'M-D', claim: 'settleOrder yarim qolgan: komissiya yozilgan, restaurant_due yozilmagan',
    code: 'main:settleOrder — Ledger.create(commission) → Ledger.create(restaurant_due) → restaurant.save chaqiruvi; orasida xato/uzilish bo‘lsa takror urinish `already` tekshiruvida emas (due yo‘q), lekin yetkazilgan holat qayta chaqirilmaydi',
    evidenceNeeded: ['pm2 logi: shu vaqtdagi Ledger/validatsiya xatosi', 'Jarayon qayta ishga tushgan vaqt (pm2 ls — restartlar soni/uptime)'],
  }, evD);

  const evE = [];
  for (const l of ledgers) if (l.type === 'restaurant_due' && sId(l.restaurantId) !== sId(order.restaurantId)) evE.push(`restaurant_due boshqa restoranga yozilgan: ${sId(l.restaurantId)}`);
  if (wrongRestaurant) evE.push('buyurtma kutilgan restoranga tegishli emas');
  hyp({
    id: 'M-E', claim: 'restaurant_due boshqa restoran nomiga yozilgan (noto‘g‘ri bog‘lanish)',
    code: 'main:settleOrder — Ledger.restaurantId = Restaurant.findById(order.restaurantId)', evidenceNeeded: ['restaurant_due yozuvining restaurantId va orderId qiymatlari'],
  }, evE);

  const evH = [];
  if (order.fulfillment && order.fulfillment !== 'delivery') evH.push(`yetkazish turi: ${order.fulfillment}`);
  if (order.orderSource) evH.push(`dine-in manba: ${order.orderSource}`);
  if (order.isDemo === true) evH.push('demo buyurtma');
  hyp({
    id: 'M-F', claim: 'Standart bo‘lmagan oqim (olib ketish / zalda / demo): settleOrder chaqiriladigan yo‘l bu oqimda yo‘q bo‘lishi mumkin',
    code: 'main:settleOrder chaqiruvchilar: orderFlow.js, courierDispatch.js, deliveryCheck.js — boshqa yo‘l topilmadi', evidenceNeeded: ['Shu oqimda "yetkazildi" holatini o‘rnatadigan kod yo‘li (dineInOrder/pickup)'],
  }, evH);

  const evL = [];
  if (!exp.known) evL.push('finance snapshot yo‘q (legacy)');
  hyp({
    id: 'M-G', claim: 'Legacy buyurtma (snapshot yo‘q): hisob joriy sozlamadan olinadi — summani hisoblab bo‘lmaydi',
    code: 'main:settleOrder — `fin` bo‘lmasa resolveCommission(restaurant)', evidenceNeeded: ['Shu paytdagi restoran komissiya sozlamasi (tarixi saqlanmaydi)'],
  }, evL);

  const leading = hypotheses.filter((h) => h.evidence.length).map((h) => h.id);
  unknown.push('settleOrder shu buyurtma uchun chaqirilganmi va qanday xato bilan to‘xtaganini bazadan aniqlab bo‘lmaydi — xato bazada saqlanmaydi');
  unknown.push('Ilova logi (pm2) bazadan tashqarida; log aylantirilgan (rotate) bo‘lishi mumkin');
  if (!exp.known) unknown.push('Legacy buyurtma: yozilishi kerak bo‘lgan summa noma‘lum');
  const conclusion = `ANIQ SABAB bazadan TASDIQLANMADI. Izlar bor: ${leading.length ? leading.join(', ') : 'yo‘q'}. Eng ishonchli dalil — pm2 logi.`;

  return {
    orderId: oid, restaurantId: sId(order.restaurantId), facts: fact, hypotheses, unknown, conclusion,
    numbers: { expected: exp, runningExpectedBalanceAtDelivery: runAt, hasDue: dueHere.length > 0 },
    neighbors, nearPayouts, peers: peerLines, sameMillisecondCluster: myCluster || null,
    order: {
      status: order.status, paymentMethod: order.paymentMethod, courierParty: order.courierParty || null, isPaid: order.isPaid === true,
      total: order.total, subtotal: order.subtotal, deliveryFee: order.deliveryFee, fulfillment: order.fulfillment || null, orderSource: order.orderSource || null,
      createdAt: iso(order.createdAt), deliveredAt: iso(order.deliveredAt), updatedAt: iso(order.updatedAt), deliveryCheck: order.deliveryCheck || null,
      financeModel: order.finance?.model || null, finance: order.finance || null,
    },
    ledgers: ledgers.map((l) => ({ at: iso(l.createdAt), type: l.type, amount: r2(l.amount), restaurantId: sId(l.restaurantId), note: l.meta?.note || null })),
    payments: payments.map((p) => ({ provider: p.provider, status: p.status, amountTiyin: p.amount, payoutStatus: p.payoutStatus, createdAt: iso(p.createdAt) })),
  };
}

/** Restoran darajasidagi bog'lanish: yo'qolgan yozuvlar ↔ balans farqi (89 430 bilan). */
export function analyzeRelation(d) {
  const ledgers = d.restLedgers || [];
  const derived = r2(ledgers.reduce((s, l) => s + balanceEffect(l), 0));
  const balance = r2(d.restaurant?.balance);
  const diff = r2(balance - derived);
  const rid = sId(d.restaurant?._id);
  const miss = d.orderResults.filter((o) => o.restaurantId === rid && o.numbers?.hasDue === false);
  const unknownAmount = miss.some((o) => !o.numbers.expected?.known);
  const expectedSum = unknownAmount ? null : r2(miss.reduce((s, o) => s + o.numbers.expected.balanceEffect, 0));
  const prior = PRIOR_AUDIT[rid] ?? null;
  const facts = [
    `Hozirgi balans ${balance}; jurnaldan hisoblangan ${derived}; farq (balans − jurnal) = ${diff}${prior != null ? ` (oldingi audit: ${prior}${r2(prior) === diff ? ' — o‘zgarmagan' : ' — O‘ZGARGAN'})` : ''}`,
    `restaurant_due yozilmagan buyurtmalar (shu doirada): ${miss.length} ta`,
  ];
  if (expectedSum != null) {
    facts.push(`Ular uchun settleOrder yozgan BO‘LARDI: jami balansga ta‘siri ${expectedSum}`);
    facts.push(diff !== 0 && expectedSum === diff ? `ARIFMETIK TENGLIK: farq (${diff}) = yozilmagan yozuvlar yig‘indisi (${expectedSum})`
      : (diff !== 0 && expectedSum === -diff ? `Farq (${diff}) yozilmagan yozuvlar yig‘indisiga (${expectedSum}) MODUL bo‘yicha teng, ishorasi teskari`
        : `Farq (${diff}) yozilmagan yozuvlar yig‘indisiga (${expectedSum}) TENG EMAS`));
    facts.push(`Agar shu yozuvlar jurnalda bo‘lganida, farq ${r2(diff - expectedSum)} bo‘lardi`);
  } else facts.push('Yozilmagan yozuvlar summasi hisoblanmadi (legacy buyurtma bor)');
  const taxmin = [];
  if (expectedSum != null && diff !== 0 && expectedSum === diff) {
    taxmin.push('Balans yozilmagan yozuvlar summasiga OSHGAN, jurnal esa yo‘q. Bu "balans yangilangan, jurnal yozilmagan" tarkibini ko‘rsatadi — lekin main kodida bunday tartib yo‘q (jurnal balansdan OLDIN yoziladi). Tenglik tasodif bo‘lishi ham mumkin.');
  } else if (diff !== 0) taxmin.push('Farq yozilmagan yozuvlar bilan tushuntirilmaydi: boshqa sabab (oldingi auditdagi H-C/H-D) qoladi.');
  const unknown = [
    'Balans qiymati tarixda qanday o‘zgargani bazada saqlanmaydi (Atlas oplog/backup kerak)',
    ...(unknownAmount ? ['Legacy buyurtma summasi noma‘lum'] : []),
  ];
  return { restaurantId: rid, name: d.restaurant?.name ?? null, balance, ledgerDerived: derived, diff, priorDiff: prior, missingOrderIds: miss.map((o) => o.orderId), expectedSum, facts, taxmin, unknown };
}

/* ═══════════════════════════════════════════════════════════════════════════
 * O'QISH (faqat find) — SCOPE bilan cheklangan, projection oq ro'yxat
 * ═══════════════════════════════════════════════════════════════════════════ */
const PROJ = {
  restaurant: { name: 1, balance: 1, totalPaidOut: 1, totalOrders: 1 },
  ledger: { type: 1, amount: 1, orderId: 1, restaurantId: 1, provider: 1, isCash: 1, createdAt: 1, 'meta.note': 1, 'meta.financeModel': 1 },
  order: {
    restaurantId: 1, status: 1, paymentMethod: 1, courierParty: 1, isPaid: 1, total: 1, subtotal: 1, deliveryFee: 1, fulfillment: 1, orderSource: 1,
    isDemo: 1, finance: 1, financeSettlement: 1, createdAt: 1, updatedAt: 1, acceptedAt: 1, deliveringAt: 1, deliveredAt: 1, updatedByRole: 1,
    'deliveryCheck.askedCount': 1, 'deliveryCheck.confirmed': 1, 'deliveryCheck.confirmedAt': 1, 'deliveryCheck.confirmedBy': 1,
    'lokmaCourier.claimedAt': 1, 'lokmaCourier.deliveredAt': 1, 'lokmaCourier.settledAt': 1, 'bonusItems.quantity': 1, 'bonusItems.reimburse': 1,
  },
  orderLite: {
    restaurantId: 1, status: 1, paymentMethod: 1, courierParty: 1, fulfillment: 1, orderSource: 1, isDemo: 1, 'finance.model': 1, total: 1,
    createdAt: 1, deliveringAt: 1, deliveredAt: 1, updatedAt: 1, 'deliveryCheck.confirmed': 1, 'deliveryCheck.confirmedAt': 1, 'deliveryCheck.confirmedBy': 1,
  },
  payment: { orderId: 1, provider: 1, status: 1, amount: 1, payoutStatus: 1, createdAt: 1 },
  payout: { restaurantId: 1, amount: 1, status: 1, lastError: 1, createdAt: 1 },
};
const LIMIT = 5000;

async function collect(db, T) {
  const oid = (s) => new ObjectId(s);
  const RIDS = SCOPE.restaurants.map(oid);
  const OIDS = Object.keys(SCOPE.orders).map(oid);
  const find = async (coll, filter, projection, sort = null) => {
    let c = db.collection(coll).find(filter, { projection, limit: LIMIT, maxTimeMS: T });
    if (sort) c = c.sort(sort);
    const rows = await c.toArray();
    return { rows, truncated: rows.length >= LIMIT };
  };
  const orders = (await find('orders', { _id: { $in: OIDS } }, PROJ.order)).rows;
  const orderLedgers = (await find('ledgers', { orderId: { $in: OIDS } }, PROJ.ledger, { createdAt: 1 })).rows;
  const orderPayments = (await find('payments', { orderId: { $in: OIDS } }, PROJ.payment)).rows;
  const perRestaurant = {};
  let truncated = false;
  for (const rid of RIDS) {
    const restaurant = (await find('restaurants', { _id: rid }, PROJ.restaurant)).rows[0] || null;
    const L = await find('ledgers', { restaurantId: rid }, PROJ.ledger, { createdAt: 1 });
    const payouts = (await find('payouts', { restaurantId: rid }, PROJ.payout)).rows;
    const del = await find('orders', { restaurantId: rid, status: 'delivered' }, PROJ.orderLite);
    truncated = truncated || L.truncated || del.truncated;
    perRestaurant[String(rid)] = { restaurant, restLedgers: L.rows, restPayouts: payouts, restDelivered: del.rows };
  }
  return { orders, orderLedgers, orderPayments, perRestaurant, truncated };
}

export function buildReport(data) {
  const orderResults = Object.entries(SCOPE.orders).map(([id, expectedRestaurantId]) => {
    const order = data.orders.find((o) => String(o._id) === id) || null;
    const rid = String(order?.restaurantId ?? expectedRestaurantId);
    const ctx = data.perRestaurant[rid] || data.perRestaurant[expectedRestaurantId] || {};
    return analyzeMissingDueOrder({
      orderId: id, expectedRestaurantId, order,
      ledgers: data.orderLedgers.filter((l) => String(l.orderId) === id),
      payments: data.orderPayments.filter((p) => String(p.orderId) === id),
      restaurant: ctx.restaurant, restLedgers: ctx.restLedgers || [], restPayouts: ctx.restPayouts || [], restDelivered: ctx.restDelivered || [],
    });
  });
  const restaurants = SCOPE.restaurants.map((rid) => analyzeRelation({ ...data.perRestaurant[rid], orderResults }));
  const sums = restaurants.map((r) => r.expectedSum);
  const allKnown = sums.every((x) => x != null);
  const totalExpected = allKnown ? r2(sums.reduce((s, x) => s + x, 0)) : null;
  const liveNet = r2(restaurants.reduce((s, r) => s + r.diff, 0));
  const overall = {
    caveat: '89 430 = Osiyo +166 350, Volidam −82 020, ESKI DO‘STLAR +5 100 (oldingi audit). ESKI DO‘STLAR bu doirada QAYTA O‘QILMAGAN.',
    liveDiffsInScope: Object.fromEntries(restaurants.map((r) => [r.name || r.restaurantId, r.diff])),
    netInScope: liveNet,
    priorNetAllThree: PRIOR_AUDIT.net,
    missingDueExpectedTotal: totalExpected,
    equalsPriorNet: totalExpected != null && totalExpected === PRIOR_AUDIT.net,
    note: 'Tenglik faqat arifmetik fakt; sabab emas.',
  };
  return { orders: orderResults, restaurants, overall, truncated: data.truncated };
}

async function main() {
  if (argv.help) {
    process.stdout.write('FINANCE_AUDIT_URI=... node finance-audit-missing-due.mjs --db=<baza> [--out=fayl.json] [--json]\n');
    return EXIT.OK;
  }
  const uri = process.env.FINANCE_AUDIT_URI;
  if (!uri) die(EXIT.USAGE, 'FINANCE_AUDIT_URI berilmagan. FAQAT O‘QISH huquqli foydalanuvchi manzilini bering (ilova MONGO_URI si EMAS).');
  if (process.env.MONGO_URI && process.env.MONGO_URI === uri) die(EXIT.NOT_READ_ONLY, 'FINANCE_AUDIT_URI ilovaning MONGO_URI si bilan bir xil — bu o‘qish-yozish foydalanuvchisi.');
  for (const k of ['restaurants', 'orders']) {
    if (argv[k] !== undefined) die(EXIT.USAGE, `--${k} berilmaydi: tekshiruv doirasi (SCOPE) kod ichida qat'iy belgilangan`);
  }
  if (argv.out !== undefined) {
    if (argv.out === true || !String(argv.out).trim()) die(EXIT.USAGE, '--out=fayl.json ko‘rinishida bering');
    if (existsSync(argv.out)) die(EXIT.USAGE, `${argv.out} allaqachon bor — ustidan yozilmaydi. Boshqa nom bering.`);
  }

  const commandLog = {};
  const client = new MongoClient(uri, {
    monitorCommands: true, readPreference: 'secondaryPreferred', retryWrites: false,
    appName: 'lokmago-finance-missingdue-readonly', serverSelectionTimeoutMS: 15000, maxPoolSize: 2,
  });
  client.on('commandStarted', (ev) => {
    commandLog[ev.commandName] = (commandLog[ev.commandName] || 0) + 1;
    if (!ALLOWED_COMMANDS.has(ev.commandName)) {
      process.stderr.write(`\n⛔ Ruxsat etilmagan buyruq: "${ev.commandName}" — audit DARHOL to'xtatildi (hech narsa yozilmadi)\n`);
      process.exit(EXIT.FORBIDDEN_COMMAND);
    }
    if (ev.commandName === 'aggregate' && pipelineHasWriteStage(ev.command?.pipeline)) {
      process.stderr.write('\n⛔ aggregate ichida $out/$merge — audit DARHOL to\'xtatildi\n');
      process.exit(EXIT.FORBIDDEN_COMMAND);
    }
  });

  await client.connect();
  try {
    const dbName = client.options?.dbName && client.options.dbName !== 'test' ? client.options.dbName : (argv.db || null);
    if (!dbName) die(EXIT.USAGE, 'Baza nomi URI ichida bo‘lishi kerak yoki --db=<baza>');
    const db = client.db(dbName);
    const admin = client.db('admin');

    const status = await admin.command({ connectionStatus: 1, showPrivileges: true });
    const priv = analyzePrivileges(status);
    if (!priv.ok) {
      const why = !priv.users.length
        ? 'foydalanuvchi autentifikatsiya qilinmagan — huquqlarni isbotlab bo‘lmaydi'
        : `foydalanuvchida O‘QISHDAN BOShQA huquqlar bor: ${priv.nonRead.join(', ') || '(huquq ro‘yxati bo‘sh)'}`;
      die(EXIT.NOT_READ_ONLY, `Audit ishga tushmadi: ${why}.\n   Foydalanuvchi: ${priv.users.join(', ') || '—'} · rollar: ${priv.roles.join(', ') || '—'}`);
    }

    const T = Number(argv.maxTimeMS) > 0 ? Number(argv.maxTimeMS) : 120000;
    const hello = await admin.command({ hello: 1 });
    const report = buildReport(await collect(db, T));
    const out = {
      generatedAt: new Date().toISOString(),
      readOnly: { users: priv.users, roles: priv.roles, actions: priv.actions },
      target: { uri: redact(uri), db: dbName },
      topology: hello.msg === 'isdbgrid' ? 'sharded' : (hello.setName ? `replicaset:${hello.setName}` : 'standalone'),
      scope: SCOPE,
      ...report,
    };
    out.commandsSent = { ...commandLog };

    if (argv.out) writeFileSync(argv.out, `${JSON.stringify(out, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    if (argv.json) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    else {
      printText(out);
      if (argv.out) process.stdout.write(`\nJSON saqlandi: ${argv.out} (0600)\n`);
    }
    return EXIT.OK;
  } finally {
    await client.close().catch(() => {});
  }
}

function printText(out) {
  const p = (s = '') => process.stdout.write(`${s}\n`);
  p(`\nrestaurant_due YOZILMAGAN BUYURTMALAR — AUDIT (READ-ONLY) · ${out.generatedAt}`);
  p(`Baza: ${out.target.db} · ${out.topology} · foydalanuvchi: ${out.readOnly.users.join(', ')} (${out.readOnly.roles.join(', ')})`);
  if (out.truncated) p('⚠ Ba‘zi ro‘yxatlar limitga yetdi — to‘liq emas');

  for (const o of out.orders) {
    p(`\n══════ BUYURTMA ${o.orderId} ══════`);
    p('FAKT:'); o.facts.forEach((f) => p(`  • ${f}`));
    if (o.neighbors?.length) { p('  Atrofdagi jurnal yozuvlari (±10 daqiqa):'); o.neighbors.slice(0, 12).forEach((n) => p(`    ${n.at} (${n.gapSec}s) · ${n.type} · ${n.amount} · ${n.orderId || '—'}`)); }
    if (o.nearPayouts?.length) p(`  Yaqin payoutlar (±1 soat): ${JSON.stringify(o.nearPayouts)}`);
    p('TAXMIN (bazadagi izlar; TASDIQLANMAGAN):');
    for (const h of o.hypotheses) {
      p(`  ▸ ${h.id} [${h.status}] ${h.claim}`);
      p(`      kod: ${h.code}`);
      p(`      topilgan izlar: ${h.evidence.join(' | ') || '—'}`);
      p(`      tasdiqlash uchun kerak: ${h.evidenceNeeded.join(' | ')}`);
    }
    p('NOMA‘LUM:'); o.unknown.forEach((u) => p(`  • ${u}`));
    p(`XULOSA: ${o.conclusion}`);
  }

  for (const r of out.restaurants) {
    p(`\n══════ BALANS BILAN BOG‘LANISH · ${r.name} (${r.restaurantId}) ══════`);
    p('FAKT:'); r.facts.forEach((f) => p(`  • ${f}`));
    p('TAXMIN:'); (r.taxmin.length ? r.taxmin : ['—']).forEach((t) => p(`  • ${t}`));
    p('NOMA‘LUM:'); r.unknown.forEach((u) => p(`  • ${u}`));
  }
  p('\n══════ 89 430 SO‘MLIK UMUMIY FARQ BILAN BOG‘LANISH ══════');
  p(`FAKT: ${JSON.stringify(out.overall)}`);
  p(`\nYuborilgan buyruqlar: ${Object.entries(out.commandsSent).map(([k, v]) => `${k}×${v}`).join(', ')}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code)).catch((e) => {
    process.stderr.write(`\n✗ Audit xatosi: ${e?.message || e}\n`);
    process.exit(EXIT.ERROR);
  });
}
