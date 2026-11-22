/*
 * ═══════════════════════════════════════════════════════════════════════════
 * MOLIYAVIY AUDIT — CHUQURLASHTIRILGAN TEKSHIRUV (FAQAT O'QIYDI, READ-ONLY)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   FINANCE_AUDIT_URI='mongodb+srv://<READONLY_USER>:<PAROL>@<cluster>/' \
 *     node finance-audit-drilldown.mjs --db=test [--out=drilldown.json] [--json]
 *
 * Faqat QATʼIY BELGILANGAN 3 ta restoran va 4 ta buyurtmani tekshiradi (SCOPE — kod ichida, parametr bilan
 * o'zgartirilmaydi). Boshqa restoran/buyurtma yozuvlari so'ralmaydi.
 *
 * Bazaga HECH NARSA yozmaydi. finance-audit.mjs dagi UCHTA MUSTAQIL himoya qatlami aynan saqlangan:
 *  1) HUQUQ DARVOZASI — kolleksiyalarga murojaatdan OLDIN `connectionStatus {showPrivileges:true}`; faqat o'qish
 *     huquqlari bo'lmasa (yoki foydalanuvchi aniqlanmasa) — chiqish kodi 4, hech narsa o'qilmaydi.
 *  2) BUYRUQ RUXSAT RO'YXATI — har bir wire buyrug'i yuborilishidan oldin (`commandStarted`); ro'yxatdan tashqari
 *     buyruq yoki `aggregate` ichida `$out`/`$merge` → darhol process.exit(3).
 *  3) KOD — faqat `mongodb` drayveri, yozish metodlari yo'q, `.env` o'qilmaydi, mongoose yo'q.
 * Qo'shimcha: nol tuzatish (balans/jurnalga hech narsa yozilmaydi), mijozning shaxsiy ma'lumotlari (telefon,
 * manzil, ism, userId) so'ralmaydi (projection oq ro'yxat), natija faqat lokal faylga (0600, ustidan yozmaydi).
 *
 * HISOBOT UCHTA ALOHIDA TOIFADA beriladi:
 *   FAKT    — bazadan o'qilgan yoki kodning o'zidan kelib chiqadigan aniq narsa;
 *   TAXMIN  — bazadagi izlar bilan QO'LLAB-QUVVATLANGAN, lekin TASDIQLANMAGAN sabab (qanday dalil kerakligi bilan);
 *   NOMA'LUM — mavjud ma'lumotdan aniqlab bo'lmaydigan narsa.
 *
 * Balansga ta'sir qoidalari production (`main`, billing.js) kodiga asoslangan — qarang BALANCE_RULES.
 */
import { MongoClient, ObjectId } from 'mongodb';
import { writeFileSync, existsSync } from 'node:fs';

const EXIT = { OK: 0, USAGE: 2, FORBIDDEN_COMMAND: 3, NOT_READ_ONLY: 4, ERROR: 1 };

/* ─── Tekshiruv doirasi: FAQAT shular (audit natijasidan olingan) ─── */
export const SCOPE = Object.freeze({
  restaurants: Object.freeze([
    '6ab76b5a8be3984b83624122',   // Osiyo kafe — balans jurnaldan KO'P (+166 350)
    '6a9fc10fa6ae8a984c7552b9',   // Volidam Osiyo — balans jurnaldan KAM (−82 020)
    '6af5b0e45ae9fa1dc1263324',   // ESKI DO'STLAR, BALIQXONASI — balans jurnaldan KO'P (+5 100)
  ]),
  orders: Object.freeze([
    '6b031b73e0bba6b3303ba9a7',   // musbatsiz manfiy komissiya −6 060
    '6adb6df6f27ee9a6a2f128f5',   // −4 800
    '6afd3be8f11f6dda213a1319',   // −4 686
    '6abb4f1e1c83a9a2d49cdf0e',   // −2 800
  ]),
});

/* ─── Ruxsat etilgan wire buyruqlari (finance-audit.mjs bilan bir xil; testda tenglik tekshiriladi) ─── */
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
 * TAHLIL MANTIG'I (sof funksiyalar — bazaga murojaat qilmaydi, alohida test qilinadi)
 * ═══════════════════════════════════════════════════════════════════════════ */
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const sId = (v) => (v == null ? null : String(v));
const ts = (d) => (d ? new Date(d).getTime() : null);
const iso = (d) => (d ? new Date(d).toISOString() : null);
const tiyinToSom = (t) => (Number(t) || 0) / 100;
const PROMO_NOTE = /jalb qilish qarzi — delivery tushumidan/;
const INSUFFICIENT = /Balansda yetarli emas/;
const REFUND_NOTE = /Qaytarish|qaytarish|Qisman qaytarish/;

/** Race oynasi (ms): shu vaqt ichida ikki balans yozuvi — "yo'qolgan yangilanish" ehtimoli. */
export const RACE_WINDOW_MS = 3000;
/** Promo-qarz chegirmasi va uning FAILED payout'i orasidagi eng katta vaqt (ms). */
export const PAYOUT_LINK_MS = 120000;

export const isPromoSettlementAdj = (l) => l.type === 'adjustment' && PROMO_NOTE.test(l.meta?.note || '');

/**
 * Jurnal yozuvi Restaurant.balance ga QANDAY ta'sir qilgan — production (`main`) kodi bo'yicha.
 * Manba (main:src/services/billing.js):
 *   settleOrder     — restaurant_due (karta: +ulush, naqd: −komissiya) va bonus_compensation (+) bilan BIR VAQTDA balans o'zgaradi
 *   recordRefund    — qaytarish restaurant_due (teskari) yozuvi bilan birga `$inc balance`
 *   recordPayout    — balans `$inc: { balance: -(payoutAmount + deducted) }`; jurnalga payout (−payoutAmount) va,
 *                     promo qarz chegirilsa, adjustment (+deducted, "…delivery tushumidan") yoziladi
 *   boshqa turlar   — balansga tegmaydi (commission, refund, payment_in, qo'lda adjustment, courier_*)
 */
export function balanceEffect(l) {
  const amt = Number(l.amount) || 0;
  switch (l.type) {
    case 'restaurant_due':
      return { effect: amt, rule: 'settleOrder/recordRefund: restaurant_due balansga aynan shu summada qo‘shiladi' };
    case 'bonus_compensation':
      return { effect: amt, rule: 'settleOrder: sovg‘a-bonus qoplash balansga qo‘shiladi' };
    case 'payout':
      return { effect: amt, rule: 'recordPayout: balansdan to‘langan summa (manfiy) ayriladi' };
    case 'adjustment':
      return isPromoSettlementAdj(l)
        ? { effect: -amt, rule: 'recordPayout → deductFromSettlement: promo qarz balansdan ushlanadi (jurnalda musbat adjustment)' }
        : { effect: 0, rule: 'main kodida bu adjustment balansga TEGMAYDI' };
    default:
      return { effect: 0, rule: `main kodida "${l.type}" balansga tegmaydi` };
  }
}

const sumBy = (rows, f) => r2(rows.reduce((s, x) => s + (Number(f(x)) || 0), 0));

/**
 * Bitta restoran tahlili.
 * @param d { restaurant, ledgers[], orders: Map|Object(orderId→order), payouts[], promoBillings[], deliveredOrders[], truncated }
 */
export function analyzeRestaurant(d) {
  const restaurant = d.restaurant;
  const ledgers = [...(d.ledgers || [])].sort((a, b) => ts(a.createdAt) - ts(b.createdAt) || String(a._id).localeCompare(String(b._id)));
  const orders = d.orders instanceof Map ? d.orders : new Map(Object.entries(d.orders || {}));
  const payouts = d.payouts || [];
  const deliveredOrders = d.deliveredOrders || [];
  const rid = sId(restaurant?._id);

  const fact = [];
  const hypotheses = [];
  const unknown = [];

  /* ── FAKT: jurnal bo'yicha balans va yurish ── */
  let running = 0;
  const timeline = ledgers.map((l) => {
    const e = balanceEffect(l);
    running = r2(running + e.effect);
    const o = l.orderId ? orders.get(String(l.orderId)) : null;
    return {
      at: iso(l.createdAt), ledgerId: sId(l._id), type: l.type, amount: r2(l.amount), orderId: sId(l.orderId),
      provider: l.provider || null, isCash: l.isCash === true,
      balanceEffect: e.effect, runningExpectedBalance: running,
      note: l.meta?.note || null, financeModel: l.meta?.financeModel || null,
      orderStatus: o?.status ?? (l.orderId ? 'ORDER_NOT_FOUND' : null),
      orderPayment: o ? `${o.paymentMethod || '?'}${o.courierParty ? `/${o.courierParty}` : ''}` : null,
    };
  });
  const ledgerDerived = running;
  const balance = r2(restaurant?.balance);
  const diff = r2(balance - ledgerDerived);

  const byType = {};
  for (const l of ledgers) {
    const k = l.type;
    byType[k] = byType[k] || { count: 0, sum: 0 };
    byType[k].count += 1;
    byType[k].sum = r2(byType[k].sum + (Number(l.amount) || 0));
  }

  fact.push(`Restaurant.balance = ${balance}; jurnaldan hisoblangan (main qoidalari bo‘yicha) = ${ledgerDerived}; farq (balans − jurnal) = ${diff}`);
  if (d.truncated) fact.push('DIQQAT: jurnal yozuvlari limitga yetdi — yurish to‘liq emas bo‘lishi mumkin');

  const payoutLedgerSum = r2(-sumBy(ledgers.filter((l) => l.type === 'payout'), (l) => l.amount));
  const totalPaidOut = r2(restaurant?.totalPaidOut);
  fact.push(`Restaurant.totalPaidOut = ${totalPaidOut}; jurnaldagi payout yig‘indisi = ${payoutLedgerSum}${totalPaidOut === payoutLedgerSum ? ' (mos)' : ` (farq ${r2(totalPaidOut - payoutLedgerSum)})`}`);

  const promoAdjs = ledgers.filter(isPromoSettlementAdj);
  const payoutSuccess = payouts.filter((p) => p.status === 'SUCCESS');
  const payoutFailed = payouts.filter((p) => p.status === 'FAILED');
  fact.push(`Payout hujjatlari: jami ${payouts.length}, SUCCESS ${payoutSuccess.length}, FAILED ${payoutFailed.length}, boshqa ${payouts.length - payoutSuccess.length - payoutFailed.length}`);
  fact.push(`Promo-qarz chegirmasi (adjustment "…delivery tushumidan"): ${promoAdjs.length} ta, jami ${sumBy(promoAdjs, (l) => l.amount)}`);

  /* ── Yozuv ↔ buyurtma bog'lanish tekshiruvlari (FAKT) ── */
  const dueEntries = ledgers.filter((l) => l.type === 'restaurant_due' && l.orderId);
  const misattributed = dueEntries.filter((l) => {
    const o = orders.get(String(l.orderId));
    return o && sId(o.restaurantId) !== rid;
  });
  const orphanOrder = dueEntries.filter((l) => !orders.get(String(l.orderId)));
  if (misattributed.length) fact.push(`${misattributed.length} ta restaurant_due yozuvi boshqa restoran buyurtmasiga bog‘langan: ${misattributed.slice(0, 5).map((l) => sId(l._id)).join(', ')}`);
  if (orphanOrder.length) fact.push(`${orphanOrder.length} ta restaurant_due yozuvi uchun buyurtma topilmadi (o‘chirilgan yoki boshqa baza)`);

  const dueNotDelivered = dueEntries.filter((l) => {
    const o = orders.get(String(l.orderId));
    return o && o.status !== 'delivered' && !REFUND_NOTE.test(l.meta?.note || '') && (Number(l.amount) || 0) !== 0
      && !ledgers.some((x) => x.type === 'refund' && String(x.orderId) === String(l.orderId));
  });
  if (dueNotDelivered.length) fact.push(`${dueNotDelivered.length} ta restaurant_due "yetkazilmagan" va qaytarilmagan buyurtmaga yozilgan`);

  // Qaytarish teskari yozuvi: settle `isCash` ni courierParty bilan hisoblaydi, recordRefund esa yo'q (main)
  const mixedFormula = dueEntries.filter((l) => {
    const o = orders.get(String(l.orderId));
    return o && REFUND_NOTE.test(l.meta?.note || '') && o.paymentMethod === 'cash' && o.courierParty === 'lokma';
  });
  if (mixedFormula.length) fact.push(`${mixedFormula.length} ta qaytarish teskari yozuvi naqd+LokmaGo kuryeri buyurtmasiga tegishli — settle (karta kabi) va refund (naqd kabi) formulalari bir xil emas (main kodi); jurnal va balans bir-biriga MOS, lekin summaning o‘zi noto‘g‘ri bo‘lishi mumkin`);

  // Yetkazilgan, lekin restaurant_due yo'q buyurtmalar
  const dueOrderIds = new Set(dueEntries.map((l) => String(l.orderId)));
  const deliveredNoDue = deliveredOrders.filter((o) => !dueOrderIds.has(String(o._id)));
  fact.push(`Yetkazilgan buyurtmalar: ${deliveredOrders.length}; ulardan restaurant_due yozuvi YO‘Q: ${deliveredNoDue.length}${deliveredNoDue.length ? ` (summa balansga/jurnalga kirmagan: ${deliveredNoDue.slice(0, 8).map((o) => sId(o._id)).join(', ')}${deliveredNoDue.length > 8 ? '…' : ''})` : ''}`);

  /* ── TAXMIN A: payout FAILED, lekin balans ALLAQACHON yechilgan bo'lishi mumkin ── */
  const failedOther = payoutFailed.filter((p) => !INSUFFICIENT.test(p.lastError || ''));
  const failedInsufficient = payoutFailed.filter((p) => INSUFFICIENT.test(p.lastError || ''));
  const hasLedgerPayoutNear = (p) => ledgers.some((l) => l.type === 'payout'
    && Math.abs(ts(l.createdAt) - ts(p.createdAt)) <= PAYOUT_LINK_MS);
  const A = {
    id: 'H-A',
    claim: 'Payout balansdan yechilgandan KEYIN xato bilan FAILED bo‘lgan: balans kamaygan, jurnalda payout yozuvi yo‘q → balans jurnaldan KAM',
    code: 'main:recordPayout — findOneAndUpdate($inc balance) → keyin Ledger.create; ikkinchisi xato bersa catch Payout.status=FAILED qiladi, balans qaytarilmaydi',
    direction: 'balans − jurnal < 0',
    evidence: failedOther.map((p) => ({
      payoutId: sId(p._id), amount: p.amount, status: p.status, lastError: p.lastError || '', at: iso(p.createdAt),
      ledgerPayoutNearby: hasLedgerPayoutNear(p),
    })),
    evidenceNeeded: [
      'Atlas oplog / backup: shu payout vaqtida restaurants.balance qiymati kamayganmi (yechish bo‘ldimi)',
      'Ilova logi (pm2 logs): Ledger.create xatosi va vaqti',
    ],
    candidateAmount: r2(-sumBy(failedOther, (p) => p.amount)),
  };
  A.status = A.evidence.length ? 'izlar bor (tasdiqlanmagan)' : 'izlar topilmadi';
  hypotheses.push(A);

  /* ── TAXMIN B: promo-qarz yechildi, lekin balans yechilmadi (yetarli emas) ── */
  const orphanPromo = promoAdjs.filter((a) => {
    const nearLedgerPayout = ledgers.some((l) => l.type === 'payout' && Math.abs(ts(l.createdAt) - ts(a.createdAt)) <= PAYOUT_LINK_MS);
    const nearSuccess = payoutSuccess.some((p) => Math.abs(ts(p.createdAt) - ts(a.createdAt)) <= PAYOUT_LINK_MS);
    return !nearLedgerPayout && !nearSuccess;
  });
  const B = {
    id: 'H-B',
    claim: 'Promo-qarz "to‘langan" deb belgilandi va jurnalga adjustment yozildi, keyin balans yechilmay payout FAILED ("Balansda yetarli emas") → balans jurnaldan KO‘P',
    code: 'main:recordPayout — deductFromSettlement (adjustment yoziladi, PromoBilling=paid) balans tekshiruvidan OLDIN; tekshiruv o‘tmasa qaytarilmaydi',
    direction: 'balans − jurnal > 0',
    evidence: orphanPromo.map((a) => ({
      ledgerId: sId(a._id), amount: r2(a.amount), at: iso(a.createdAt),
      failedPayoutNearby: failedInsufficient.some((p) => Math.abs(ts(p.createdAt) - ts(a.createdAt)) <= PAYOUT_LINK_MS),
    })),
    evidenceNeeded: [
      'PromoBilling: shu adjustment ledgerId bilan paid bo‘lgan davrlar (paidVia=settlement)',
      'Payout (FAILED, "Balansda yetarli emas") vaqti adjustment bilan mosligi',
    ],
    candidateAmount: sumBy(orphanPromo, (a) => a.amount),
  };
  B.status = B.evidence.length ? 'izlar bor (tasdiqlanmagan)' : 'izlar topilmadi';
  hypotheses.push(B);

  /* ── TAXMIN C: settleOrder `restaurant.save()` yo'qolgan yangilanishi (poyga) ── */
  const eff = timeline.filter((t) => t.balanceEffect !== 0);
  const raceHits = [];
  for (let i = 0; i < eff.length; i += 1) {
    for (let j = i + 1; j < eff.length && ts(eff[j].at) - ts(eff[i].at) <= RACE_WINDOW_MS; j += 1) {
      const a = eff[i]; const b = eff[j];
      const settleLike = (t) => t.type === 'restaurant_due' || t.type === 'bonus_compensation';
      const payoutLike = (t) => t.type === 'payout' || (t.type === 'adjustment');
      if (a.orderId && a.orderId === b.orderId) continue;   // bitta buyurtmaning o'z yozuvlari poyga emas
      if ((settleLike(a) && payoutLike(b)) || (payoutLike(a) && settleLike(b)) || (settleLike(a) && settleLike(b) && a.orderId !== b.orderId)) {
        raceHits.push({ a: { ledgerId: a.ledgerId, type: a.type, amount: a.amount, at: a.at }, b: { ledgerId: b.ledgerId, type: b.type, amount: b.amount, at: b.at }, gapMs: ts(b.at) - ts(a.at), kind: settleLike(a) && settleLike(b) ? 'settle↔settle' : 'settle↔payout' });
      }
    }
  }
  const C = {
    id: 'H-C',
    claim: `settleOrder balansni o‘qib, keyin save() bilan ABSOLUT qiymat yozadi: ${RACE_WINDOW_MS} ms ichidagi boshqa balans o‘zgarishi (boshqa yetkazish yoki payout) yo‘qolishi mumkin`,
    code: 'main:settleOrder — Restaurant.findById → restaurant.balance = … → restaurant.save chaqiruvi (atomik $inc emas)',
    direction: 'yo‘qolgan yozuvning ishorasiga qarab: payout yo‘qolsa balans KO‘P, ijobiy ulush yo‘qolsa KAM',
    evidence: raceHits.slice(0, 20),
    evidenceCount: raceHits.length,
    evidenceNeeded: [
      'Atlas oplog/backup: shu soniyalarda restaurants.balance ketma-ketligi (qaysi yozuv ustidan yozilgan)',
      'Ilova logi: bir vaqtdagi ikki so‘rov (deliver + payout)',
    ],
    candidateAmount: null,
  };
  C.status = raceHits.length ? 'izlar bor (tasdiqlanmagan)' : 'izlar topilmadi';
  hypotheses.push(C);

  /* ── TAXMIN D: balans jurnaldan tashqari o'zgargan (qo'lda / skript) ── */
  const D = {
    id: 'H-D',
    claim: 'Restaurant.balance jurnalsiz o‘zgargan (qo‘lda DB tahriri, migratsiya yoki boshqa skript)',
    code: 'main kodida bunday yo‘l topilmadi (balans faqat billing.js da o‘zgaradi) — lekin bazaga to‘g‘ridan-to‘g‘ri yozuvni kod bilan inkor qilib bo‘lmaydi',
    direction: 'har ikki yo‘nalish',
    evidence: [
      ...(balance === 0 && ledgerDerived !== 0 ? [{ sign: 'balans aynan 0, jurnal esa 0 emas — qo‘lda nollash belgisi bo‘lishi mumkin' }] : []),
      ...(restaurant?.balanceUpdatedBy ? [{ sign: `balanceUpdatedBy=${restaurant.balanceUpdatedBy}` }] : []),
    ],
    evidenceNeeded: [
      'Atlas Database Auditing / oplog / backup solishtirish: restaurants.balance qachon va qaysi mijozdan yozilgan',
      'Jamoadan so‘rash: balans qo‘lda o‘zgartirilganmi',
    ],
    candidateAmount: null,
  };
  D.status = D.evidence.length ? 'belgi bor (tasdiqlanmagan)' : 'bevosita belgi yo‘q; bazadan isbotlab/inkor qilib bo‘lmaydi';
  hypotheses.push(D);

  /* ── Tushuntirilgan va qolgan farq (faqat TAXMIN ASOSIDA, shartli) ── */
  const explainedIfBothHold = r2((B.candidateAmount || 0) + (A.candidateAmount || 0));
  const residual = r2(diff - explainedIfBothHold);
  const attribution = {
    caveat: 'TAXMIN. H-A va H-B tasdiqlansagina o‘rinli. H-C va H-D miqdori hisoblanmaydi.',
    diff,
    ifHAandHBHold: explainedIfBothHold,
    residualUnexplained: residual,
    fullyExplained: Math.abs(residual) < 0.01 && Math.abs(diff) >= 0.01,
  };

  unknown.push('Restaurant.balance tarixi (qachon, qaysi qiymatdan qaysi qiymatga o‘zgargani) — bazada saqlanmaydi; faqat Atlas oplog/backup/audit log orqali aniqlanadi');
  unknown.push('Payout.amount birligi: modelda "tiyin" deyilgan, kodda so‘m kabi yoziladi — summalar solishtirilganda birlik farqi hisobga olinmagan');
  if (Math.abs(residual) >= 0.01 && Math.abs(diff) >= 0.01) unknown.push(`Farqning ${residual} so‘mi jurnal izlari bilan tushuntirilmadi`);

  return {
    restaurantId: rid, name: restaurant?.name ?? null,
    facts: fact, ledgerByType: byType,
    numbers: { balance, ledgerDerived, diff, totalPaidOut, payoutLedgerSum },
    timeline,
    deliveredNoDue: deliveredNoDue.map((o) => ({ orderId: sId(o._id), deliveredAt: iso(o.deliveredAt), paymentMethod: o.paymentMethod || null, courierParty: o.courierParty || null, financeModel: o.finance?.model || null, total: o.total })),
    hypotheses, attribution, unknown,
  };
}

/** Bitta buyurtma tahlili. d = { order, ledgers[], payments[] } */
export function analyzeOrder(d) {
  const order = d.order;
  const ledgers = [...(d.ledgers || [])].sort((a, b) => ts(a.createdAt) - ts(b.createdAt));
  const payments = d.payments || [];
  const fact = [];
  const hypotheses = [];
  const unknown = [];
  const oid = sId(order?._id) || sId(d.orderId);

  if (!order) {
    return {
      orderId: oid, facts: ['Buyurtma hujjati TOPILMADI (o‘chirilgan yoki boshqa baza)'], hypotheses: [], unknown: ['Buyurtma holati va summasi'],
      ledgerByType: {}, timeline: [],
    };
  }

  const fin = order.finance?.model === 'v2' ? order.finance : null;
  const of = (type) => ledgers.filter((l) => l.type === type);
  const commission = of('commission');
  const commissionPos = r2(sumBy(commission.filter((l) => l.amount > 0), (l) => l.amount));
  const commissionNeg = r2(sumBy(commission.filter((l) => l.amount < 0), (l) => l.amount));
  const due = of('restaurant_due');
  const dueNet = sumBy(due, (l) => l.amount);
  const refunds = of('refund');
  const refundTotal = r2(-sumBy(refunds, (l) => l.amount));
  const firstDue = due[0] ? ts(due[0].createdAt) : null;
  const firstRefund = refunds[0] ? ts(refunds[0].createdAt) : null;

  const events = [];
  const ev = (at, kind, text) => events.push({ at: iso(at), kind, text });
  ev(order.createdAt, 'order', 'Buyurtma yaratildi');
  if (order.paidAt) ev(order.paidAt, 'order', 'To‘langan deb belgilandi (paidAt)');
  if (order.acceptedAt) ev(order.acceptedAt, 'order', 'Restoran qabul qildi');
  if (order.deliveringAt) ev(order.deliveringAt, 'order', 'Yo‘lga chiqdi');
  if (order.deliveredAt) ev(order.deliveredAt, 'order', 'Yetkazildi (deliveredAt)');
  if (order.cancelledAt) ev(order.cancelledAt, 'order', `Bekor qilindi (kod: ${order.cancelReasonCode || '—'})`);
  for (const p of payments) {
    ev(p.createdAt, 'payment', `Payment ${p.status} · ${p.provider} · summa ${p.amount} tiyin`);
    if (p.refundedAt) ev(p.refundedAt, 'payment', 'Payment qaytarildi (refundedAt)');
  }
  for (const l of ledgers) ev(l.createdAt, 'ledger', `${l.type} ${r2(l.amount)}${l.meta?.note ? ` — ${l.meta.note}` : ''}`);
  events.sort((a, b) => new Date(a.at) - new Date(b.at));

  fact.push(`Holat: ${order.status}; to‘lov usuli: ${order.paymentMethod}${order.courierParty ? `/${order.courierParty}` : ''}; isPaid=${order.isPaid === true}; jami ${order.total}, taom ${order.subtotal}, yetkazish ${order.deliveryFee}`);
  fact.push(`Moliya snapshot: ${fin ? 'v2' : (order.finance?.model || 'YO‘Q (legacy)')}${order.financeSettlement ? `; financeSettlement=${JSON.stringify(order.financeSettlement)}` : ''}`);
  fact.push(`Jurnal: komissiya musbat ${commissionPos}, manfiy ${commissionNeg}; restaurant_due ${due.length} ta (sof ${r2(dueNet)}); qaytarish ${refunds.length} ta (jami ${refundTotal})`);
  if (payments.length) fact.push(`Payment: ${payments.map((p) => `${p.status}/${p.provider}/${p.amount}t`).join(', ')}`);
  else fact.push('Payment hujjati yo‘q (naqd yoki to‘lov yozuvi yaratilmagan)');

  if (fin) {
    const expCommission = tiyinToSom(fin.lokmaGrossCommission);
    const expPayout = tiyinToSom(fin.restaurantPayout);
    fact.push(`Snapshot kutgan: LokmaGo brutto komissiya ${expCommission}, restoran ulushi ${expPayout}`);
    if (commissionPos > 0 && Math.abs(commissionPos - expCommission) > 0.01) fact.push(`FARQ: yozilgan komissiya ${commissionPos} ≠ snapshot ${expCommission}`);
    if (commissionNeg < 0 && refunds.length) {
      const full = Math.abs(commissionNeg) - expCommission;
      fact.push(`Manfiy komissiya ${commissionNeg} snapshot brutto komissiyasiga ${Math.abs(full) < 0.01 ? 'TENG (to‘liq qaytarish)' : `teng emas (farq ${r2(full)} — qisman qaytarish yoki boshqa hisob)`}`);
    }
  }

  // Payment ↔ refund ledger mos kelishi
  const payRefunded = payments.some((p) => p.status === 'REFUNDED');
  if (refunds.length && payments.length && !payRefunded) fact.push('Jurnalda refund bor, lekin hech bir Payment REFUNDED emas');
  if (!refunds.length && payRefunded) fact.push('Payment REFUNDED, lekin jurnalda refund yozuvi YO‘Q');

  const orphanNeg = commissionPos === 0 && commissionNeg < 0;
  const settled = due.length > 0;

  /* ── TAXMIN O1: yetkazilmagan (settle bo'lmagan) buyurtma qaytarilganda komissiya shartsiz teskari yoziladi ── */
  const O1 = {
    id: 'H-O1',
    claim: 'Buyurtma settle bo‘lmasdan (yetkazilishdan oldin) bekor qilinib qaytarilgan; recordRefund komissiya teskari yozuvini "settle bo‘lganmi" tekshirmasdan yozadi → musbat komissiyasiz manfiy yozuv',
    code: 'main:recordRefund — `if (settled) {restaurant_due teskari}` bloki ichida, lekin `if (refund.lokmaGrossCommission > 0) Ledger.create(commission −…)` shartsiz',
    balanceImpact: 'Balansga ta‘sir YO‘Q (commission yozuvi balansga tegmaydi). Ta‘sir: hisobotlarda komissiya yig‘indisi (type bo‘yicha) haqiqatdan kam ko‘rinadi.',
    evidence: [],
    evidenceNeeded: [
      'order.status = cancelled va deliveredAt yo‘qligi (shu hujjatda tekshirildi)',
      'Ilova logida shu buyurtma uchun settleOrder chaqirilmaganligi / xatosi',
    ],
  };
  if (orphanNeg) {
    if (!settled) O1.evidence.push('restaurant_due yozuvi yo‘q — settle hech qachon bo‘lmagan');
    if (order.status === 'cancelled') O1.evidence.push('order.status = cancelled');
    if (!order.deliveredAt) O1.evidence.push('deliveredAt yo‘q — yetkazilmagan');
    if (firstRefund && (firstDue === null || firstRefund < firstDue)) O1.evidence.push('refund yozuvi birinchi (yoki settle umuman yo‘q)');
    if (refunds.length) O1.evidence.push(`refund yozuvi ${refunds.length} ta, jami ${refundTotal}`);
    if (fin) O1.evidence.push('order.finance v2 — recordRefund v2 yo‘li ishlagan (komissiya teskari yozuvi faqat v2 da yoziladi)');
  }
  const deliveredNoSettle = order.status === 'delivered';
  O1.status = !orphanNeg ? 'qo‘llanmaydi (musbatsiz manfiy komissiya yo‘q)'
    : deliveredNoSettle ? 'qarama-qarshi: buyurtma YETKAZILGAN — qarang H-O2'
      : (O1.evidence.length >= 3 && !settled ? 'izlar kuchli (kod yo‘li bilan mos, tasdiqlanmagan)' : 'izlar zaif/qarama-qarshi');
  hypotheses.push(O1);

  /* ── TAXMIN O2: yetkazilgan, lekin settle bo'lmagan ── */
  const O2 = {
    id: 'H-O2',
    claim: 'Buyurtma yetkazilgan, lekin settleOrder ishlamagan yoki xato bilan to‘xtagan → restoran ulushi jurnalga/balansga kirmagan',
    code: 'main:settleOrder — xatolar yutiladi (.catch(console.error)), restoran topilmasa null qaytaradi',
    balanceImpact: 'Restoran ulushi hisoblanmagan (balans ham, jurnal ham kamroq)',
    evidence: [],
    evidenceNeeded: ['pm2 logs: "[billing]" xatolari buyurtma yetkazilgan vaqtda', 'order.deliveredAt bilan ledger yo‘qligi'],
  };
  if (order.status === 'delivered' && !settled) O2.evidence.push('status=delivered, lekin restaurant_due yo‘q');
  if (order.status === 'delivered' && refunds.length) O2.evidence.push('yetkazilgan buyurtma ustidan refund yozilgan');
  O2.status = O2.evidence.length ? 'izlar bor (tasdiqlanmagan)' : 'qo‘llanmaydi';
  hypotheses.push(O2);

  /* ── TAXMIN O3: qaytarishdan keyin restoran qarzi to'liq bekor bo'lmagan ── */
  const O3 = {
    id: 'H-O3',
    claim: 'Qaytarishdan keyin restaurant_due sof qoldig‘i 0 emas (teskari yozuv yo‘q, qisman yoki noto‘g‘ri formula)',
    code: 'main:recordRefund — teskari yozuv `settled` bo‘lsa yoziladi; isCash = paymentMethod==="cash" (courierParty hisobga olinmaydi)',
    balanceImpact: 'Qoldiq restoran balansida qoladi',
    evidence: [],
    evidenceNeeded: ['Order.finance snapshot bilan teskari yozuv summasini solishtirish'],
  };
  if (settled && refunds.length && Math.abs(dueNet) > 0.01) O3.evidence.push(`sof restaurant_due qoldig‘i ${r2(dueNet)}`);
  if (order.paymentMethod === 'cash' && order.courierParty === 'lokma' && refunds.length && settled) O3.evidence.push('naqd + LokmaGo kuryeri: settle karta kabi, refund naqd kabi hisoblaydi');
  O3.status = O3.evidence.length ? 'izlar bor (tasdiqlanmagan)' : 'qo‘llanmaydi';
  hypotheses.push(O3);

  unknown.push('Buyurtmani KIM va NIMA UCHUN bekor qilgani (matnli sabab ataylab o‘qilmaydi — shaxsiy ma‘lumot bo‘lishi mumkin; faqat cancelReasonCode)');
  unknown.push('Ilova logi (settleOrder chaqirilgani/xatosi) bazada saqlanmaydi — pm2 loglari kerak');

  const byType = {};
  for (const l of ledgers) {
    byType[l.type] = byType[l.type] || { count: 0, sum: 0 };
    byType[l.type].count += 1;
    byType[l.type].sum = r2(byType[l.type].sum + (Number(l.amount) || 0));
  }

  return {
    orderId: oid, restaurantId: sId(order.restaurantId), facts: fact, hypotheses, unknown, ledgerByType: byType,
    numbers: { commissionPos, commissionNeg, dueNet: r2(dueNet), refundTotal },
    timeline: events,
    order: {
      status: order.status, paymentMethod: order.paymentMethod, courierParty: order.courierParty || null, isPaid: order.isPaid === true,
      total: order.total, subtotal: order.subtotal, deliveryFee: order.deliveryFee, fulfillment: order.fulfillment || null,
      createdAt: iso(order.createdAt), deliveredAt: iso(order.deliveredAt), cancelledAt: iso(order.cancelledAt), cancelReasonCode: order.cancelReasonCode || null,
      financeModel: order.finance?.model || null, finance: order.finance || null, financeSettlement: order.financeSettlement || null,
    },
    payments: payments.map((p) => ({
      paymentId: sId(p._id), provider: p.provider, status: p.status, amountTiyin: p.amount, providerFee: p.providerFee,
      payoutStatus: p.payoutStatus, refundReason: p.refundReason || null, refundedAt: iso(p.refundedAt), createdAt: iso(p.createdAt),
    })),
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
 * O'QISH (find/aggregate) — barcha so'rovlar SCOPE bilan cheklangan, projection oq ro'yxat
 * ═══════════════════════════════════════════════════════════════════════════ */
const PROJ = {
  restaurant: { name: 1, balance: 1, totalPaidOut: 1, totalOrders: 1, commissionPercent: 1, isDemo: 1 },
  ledger: {
    type: 1, amount: 1, orderId: 1, restaurantId: 1, provider: 1, isCash: 1, createdAt: 1, postingKey: 1,
    'meta.note': 1, 'meta.financeModel': 1, 'meta.orderTotal': 1, 'meta.commissionPercent': 1, 'meta.commissionMode': 1,
    'meta.refundedFoodBaseTiyin': 1, 'meta.remainingFoodBaseTiyin': 1, 'meta.deliveryRefunded': 1, 'meta.promoDebtDeducted': 1,
  },
  order: {
    restaurantId: 1, status: 1, paymentMethod: 1, courierParty: 1, isPaid: 1, paidAt: 1, total: 1, subtotal: 1, deliveryFee: 1,
    fulfillment: 1, isDemo: 1, finance: 1, financeSettlement: 1, financeRefund: 1, createdAt: 1, acceptedAt: 1, deliveringAt: 1,
    deliveredAt: 1, cancelledAt: 1, cancelReasonCode: 1,
  },
  orderLite: { restaurantId: 1, status: 1, paymentMethod: 1, courierParty: 1, total: 1, deliveredAt: 1, 'finance.model': 1, isDemo: 1 },
  payment: {
    orderId: 1, restaurantId: 1, provider: 1, status: 1, amount: 1, providerFee: 1, payoutStatus: 1, refundReason: 1, refundedAt: 1, createdAt: 1,
  },
  payout: {
    restaurantId: 1, amount: 1, status: 1, lastError: 1, attempts: 1, createdAt: 1, sentAt: 1, confirmedAt: 1, 'snapshot.promoDebtDeducted': 1,
  },
  promo: { restaurantId: 1, amount: 1, status: 1, paidVia: 1, paidAt: 1, paidAmount: 1, ledgerId: 1, periodStart: 1, service: 1 },
};
const LIMIT = 5000;

async function collect(db, T) {
  const oid = (s) => new ObjectId(s);
  const RIDS = SCOPE.restaurants.map(oid);
  const OIDS = SCOPE.orders.map(oid);
  const find = async (coll, filter, projection, sort = null) => {
    let c = db.collection(coll).find(filter, { projection, limit: LIMIT, maxTimeMS: T });
    if (sort) c = c.sort(sort);
    const rows = await c.toArray();
    return { rows, truncated: rows.length >= LIMIT };
  };

  const restaurants = (await find('restaurants', { _id: { $in: RIDS } }, PROJ.restaurant)).rows;
  const perRestaurant = [];
  for (const rid of RIDS) {
    const restaurant = restaurants.find((r) => String(r._id) === String(rid)) || null;
    const L = await find('ledgers', { restaurantId: rid }, PROJ.ledger, { createdAt: 1 });
    const orderIds = [...new Set(L.rows.map((l) => l.orderId).filter(Boolean).map(String))].map(oid);
    const orders = new Map();
    for (let i = 0; i < orderIds.length; i += 500) {
      const part = (await find('orders', { _id: { $in: orderIds.slice(i, i + 500) } }, PROJ.orderLite)).rows;
      for (const o of part) orders.set(String(o._id), o);
    }
    const payouts = (await find('payouts', { restaurantId: rid }, PROJ.payout)).rows;
    const promoBillings = (await find('promobillings', { restaurantId: rid }, PROJ.promo)).rows;
    const delivered = await find('orders', { restaurantId: rid, status: 'delivered' }, PROJ.orderLite);
    perRestaurant.push({ restaurant, ledgers: L.rows, orders, payouts, promoBillings, deliveredOrders: delivered.rows, truncated: L.truncated || delivered.truncated });
  }

  const ordersDocs = (await find('orders', { _id: { $in: OIDS } }, PROJ.order)).rows;
  const orderLedgers = (await find('ledgers', { orderId: { $in: OIDS } }, PROJ.ledger, { createdAt: 1 })).rows;
  const orderPayments = (await find('payments', { orderId: { $in: OIDS } }, PROJ.payment)).rows;
  const perOrder = OIDS.map((id) => ({
    orderId: String(id),
    order: ordersDocs.find((o) => String(o._id) === String(id)) || null,
    ledgers: orderLedgers.filter((l) => String(l.orderId) === String(id)),
    payments: orderPayments.filter((p) => String(p.orderId) === String(id)),
  }));
  return { perRestaurant, perOrder, missing: { restaurants: RIDS.filter((r) => !restaurants.some((x) => String(x._id) === String(r))).map(String) } };
}

async function main() {
  if (argv.help) {
    process.stdout.write('FINANCE_AUDIT_URI=... node finance-audit-drilldown.mjs --db=<baza> [--out=fayl.json] [--json]\n');
    return EXIT.OK;
  }
  const uri = process.env.FINANCE_AUDIT_URI;
  if (!uri) die(EXIT.USAGE, 'FINANCE_AUDIT_URI berilmagan. FAQAT O‘QISH huquqli foydalanuvchi manzilini bering (ilova MONGO_URI si EMAS).');
  if (process.env.MONGO_URI && process.env.MONGO_URI === uri) {
    die(EXIT.NOT_READ_ONLY, 'FINANCE_AUDIT_URI ilovaning MONGO_URI si bilan bir xil — bu o‘qish-yozish foydalanuvchisi.');
  }
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
    appName: 'lokmago-finance-drilldown-readonly', serverSelectionTimeoutMS: 15000, maxPoolSize: 2,
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
    const data = await collect(db, T);

    const out = {
      generatedAt: new Date().toISOString(),
      readOnly: { users: priv.users, roles: priv.roles, actions: priv.actions },
      target: { uri: redact(uri), db: dbName },
      topology: hello.msg === 'isdbgrid' ? 'sharded' : (hello.setName ? `replicaset:${hello.setName}` : 'standalone'),
      scope: SCOPE,
      missingTargets: data.missing,
      restaurants: data.perRestaurant.map(analyzeRestaurant),
      orders: data.perOrder.map(analyzeOrder),
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
  p(`\nCHUQURLASHTIRILGAN AUDIT (READ-ONLY) · ${out.generatedAt}`);
  p(`Baza: ${out.target.db} · ${out.topology} · foydalanuvchi: ${out.readOnly.users.join(', ')} (${out.readOnly.roles.join(', ')})`);
  if (out.missingTargets.restaurants.length) p(`⚠ Topilmagan restoranlar: ${out.missingTargets.restaurants.join(', ')}`);

  for (const r of out.restaurants) {
    p(`\n══════ RESTORAN ${r.name} (${r.restaurantId}) ══════`);
    p('FAKT:'); r.facts.forEach((f) => p(`  • ${f}`));
    p(`  • Jurnal turlari: ${Object.entries(r.ledgerByType).map(([k, v]) => `${k}×${v.count}=${v.sum}`).join(', ')}`);
    p('TAXMIN (bazadagi izlar; TASDIQLANMAGAN):');
    for (const h of r.hypotheses) {
      p(`  ▸ ${h.id} [${h.status}] ${h.claim}`);
      p(`      kod: ${h.code}`);
      p(`      yo‘nalish: ${h.direction}${h.candidateAmount != null ? ` · mumkin bo‘lgan summa: ${h.candidateAmount}` : ''}`);
      const n = h.evidenceCount ?? h.evidence.length;
      p(`      topilgan izlar: ${n}`);
      h.evidence.slice(0, 5).forEach((e) => p(`        - ${JSON.stringify(e)}`));
      p(`      tasdiqlash uchun kerak: ${h.evidenceNeeded.join(' | ')}`);
    }
    p(`  ▸ Farqni taqsimlash (shartli): ${JSON.stringify(r.attribution)}`);
    p('NOMA‘LUM:'); r.unknown.forEach((u) => p(`  • ${u}`));
    const tail = r.timeline.filter((t) => t.balanceEffect !== 0).slice(-8);
    p('  Oxirgi balansga ta‘sir qilgan yozuvlar (vaqt · tur · summa · ta‘sir · kutilgan balans):');
    tail.forEach((t) => p(`    ${t.at} · ${t.type} · ${t.amount} · ${t.balanceEffect} · ${t.runningExpectedBalance}${t.orderStatus ? ` · buyurtma:${t.orderStatus}` : ''}`));
  }

  for (const o of out.orders) {
    p(`\n══════ BUYURTMA ${o.orderId} ══════`);
    p('FAKT:'); o.facts.forEach((f) => p(`  • ${f}`));
    p('  Tarix:'); (o.timeline || []).forEach((e) => p(`    ${e.at} · ${e.kind} · ${e.text}`));
    p('TAXMIN (bazadagi izlar; TASDIQLANMAGAN):');
    for (const h of o.hypotheses) {
      p(`  ▸ ${h.id} [${h.status}] ${h.claim}`);
      p(`      kod: ${h.code}`);
      p(`      balansga ta‘siri: ${h.balanceImpact}`);
      p(`      topilgan izlar: ${h.evidence.join(' | ') || '—'}`);
      p(`      tasdiqlash uchun kerak: ${h.evidenceNeeded.join(' | ')}`);
    }
    p('NOMA‘LUM:'); o.unknown.forEach((u) => p(`  • ${u}`));
  }
  p(`\nYuborilgan buyruqlar: ${Object.entries(out.commandsSent).map(([k, v]) => `${k}×${v}`).join(', ')}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code)).catch((e) => {
    process.stderr.write(`\n✗ Audit xatosi: ${e?.message || e}\n`);
    process.exit(EXIT.ERROR);
  });
}
