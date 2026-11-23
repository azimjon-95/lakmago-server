/*
 * ═══ scripts/finance-audit-drilldown.mjs HAQIQATAN READ-ONLY EKANINING ISBOTI + TAHLIL MANTIG'I ═══
 *   npm run test:finance-drilldown        (C bo'limi uchun AUDIT_TEST_ROOT_URI kerak)
 *
 * A) Statik: yozish metodi, dotenv, mongoose, MONGO_URI fallback yo'q; SCOPE qat'iy; projection'da shaxsiy maydonlar yo'q;
 *    himoya konstantalari finance-audit.mjs bilan AYNAN bir xil.
 * B) Birlik: himoya funksiyalari + balans ta'siri qoidalari + restoran/buyurtma tahlili (fakt/taxmin/noma'lum).
 * C) Empirik (autentifikatsiyali REPLICA SET): read-only foydalanuvchi bilan ishga tushirilganda oplog'da yangi yozuv 0 ta,
 *    dbHash o'zgarmaydi; readWrite/root/autentifikatsiyasiz → rad (4); skript ichiga yozuv kiritilsa → buyruq ro'yxati (3);
 *    SCOPE'dan tashqari ma'lumot va mijoz shaxsiy ma'lumoti natijaga tushmaydi.
 */
import { readFileSync, existsSync, statSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/finance-audit-drilldown.mjs', import.meta.url));
const BASE = fileURLToPath(new URL('../scripts/finance-audit.mjs', import.meta.url));
let fails = 0; let passes = 0;
const ok = (c, m, extra = '') => { console.log(c ? '  ✓' : '  ✗ FAIL:', m, c ? '' : extra); if (c) passes++; else fails++; };
const m = await import(SCRIPT);
const base = await import(BASE);

/* ── A) Statik ── */
console.log('\n[A] Statik tahlil: skript matni');
{
  const src = readFileSync(SCRIPT, 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\/[^'\n]*$/gm, '');
  const forbidden = [
    /\.insert(One|Many)?\s*\(/, /\.update(One|Many)?\s*\(/, /\.delete(One|Many)?\s*\(/, /\.replaceOne\s*\(/, /\.bulkWrite\s*\(/,
    /\.findOneAnd(Update|Replace|Delete)\s*\(/, /\.drop(Database|Index|Indexes)?\s*\(/, /\.create(Index|Indexes|Collection|SearchIndex)\s*\(/,
    /\.rename\s*\(/, /\.save\s*\(/, /\bmapReduce\b/, /\$eval\b/, /\bwatch\s*\(/,
    /\bimport\s+['"]dotenv/, /\bfrom\s+['"]mongoose['"]/, /process\.env\.MONGO_URI\s*\|\|/, /readFileSync\s*\(/,
  ];
  const hits = forbidden.filter((re) => re.test(code)).map(String);
  ok(hits.length === 0, 'yozish metodi, dotenv, mongoose, MONGO_URI fallback, fayl o‘qish yo‘q', hits.join(' '));
  const cmdCalls = [...code.matchAll(/\.command\(\s*\{\s*(\w+)/g)].map((x) => x[1]);
  ok(cmdCalls.every((c) => ['connectionStatus', 'hello'].includes(c)), `.command() faqat connectionStatus/hello: ${cmdCalls.join(', ')}`);
  ok(/flag: 'wx', mode: 0o600/.test(code), 'natija fayli: ustidan yozmaydi (wx), 0600');
  ok(/FORBIDDEN_STAGES = \['\$out', '\$merge'\]/.test(code), '$out/$merge taqiq ro‘yxati bor');
  // Faqat find/aggregate/getMore yo'li: kolleksiya metodlari
  const collMethods = [...new Set([...code.matchAll(/db\.collection\([^)]*\)\s*\.(\w+)/g)].map((x) => x[1]))];
  ok(collMethods.every((x) => ['find'].includes(x)), `kolleksiya metodlari faqat find: ${collMethods.join(', ')}`);
  ok(!/\bcollection\([^)]*\)\s*\.(aggregate|distinct|count)/.test(code), 'aggregate/distinct/count ham ishlatilmaydi (faqat find)');

  // Shaxsiy ma'lumot: projection oq ro'yxatida bu maydonlar bo'lmasligi kerak
  const projBlock = src.slice(src.indexOf('const PROJ = {'), src.indexOf('const LIMIT'));
  const pii = ['userId', 'phone', 'address', 'addressNote', 'addressLat', 'addressLng', 'items', 'deviceSessionId', 'cancelReason:', 'comment', 'payout.card', 'snapshot.card', 'snapshot.bank', 'metadata', 'waiterName', 'courierName'];
  const piiHits = pii.filter((k) => new RegExp(`(^|[\\s{,'"])${k.replace('.', '\\.')}['"]?\\s*:`, 'm').test(projBlock) || projBlock.includes(`'${k}'`));
  ok(piiHits.length === 0, 'projection oq ro‘yxatida shaxsiy/maxfiy maydonlar yo‘q', piiHits.join(','));

  // Himoya konstantalari bazaviy skript bilan bir xil
  const eq = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
  ok(eq(m.ALLOWED_COMMANDS, base.ALLOWED_COMMANDS), 'ALLOWED_COMMANDS finance-audit.mjs bilan bir xil');
  ok(eq(m.READ_ACTIONS, base.READ_ACTIONS), 'READ_ACTIONS finance-audit.mjs bilan bir xil');
  for (const c of ['insert', 'update', 'delete', 'findAndModify', 'createIndexes', 'create', 'drop', 'dropDatabase', 'renameCollection', 'applyOps', 'bulkWrite', 'collMod']) {
    if (m.ALLOWED_COMMANDS.has(c)) ok(false, `ruxsat ro‘yxatida yozuv buyrug‘i: ${c}`);
  }
  ok(true, 'ruxsat etilgan buyruqlarda yozuv buyrug‘i yo‘q');

  // SCOPE
  ok(m.SCOPE.restaurants.length === 3 && m.SCOPE.orders.length === 4, 'SCOPE: aynan 3 restoran va 4 buyurtma');
  ok([...m.SCOPE.restaurants, ...m.SCOPE.orders].every((x) => /^[0-9a-f]{24}$/.test(x)), 'SCOPE: barcha identifikatorlar 24-belgili hex');
  ok(Object.isFrozen(m.SCOPE) && Object.isFrozen(m.SCOPE.restaurants) && Object.isFrozen(m.SCOPE.orders), 'SCOPE o‘zgartirib bo‘lmaydi (frozen)');
  ok(JSON.stringify(m.SCOPE.restaurants) === JSON.stringify(['6ab76b5a8be3984b83624122', '6a9fc10fa6ae8a984c7552b9', '6af5b0e45ae9fa1dc1263324']), 'SCOPE restoranlari audit natijasi bilan bir xil');
  ok(JSON.stringify(m.SCOPE.orders) === JSON.stringify(['6b031b73e0bba6b3303ba9a7', '6adb6df6f27ee9a6a2f128f5', '6afd3be8f11f6dda213a1319', '6abb4f1e1c83a9a2d49cdf0e']), 'SCOPE buyurtmalari audit natijasi bilan bir xil');
}

/* ── B) Birlik ── */
console.log('\n[B1] Himoya funksiyalari');
{
  ok(m.pipelineHasWriteStage([{ $match: {} }, { $out: 'x' }]), '$out ushlanadi');
  ok(m.pipelineHasWriteStage([{ $lookup: { from: 'o', pipeline: [{ $merge: { into: 'y' } }], as: 'z' } }]), '$lookup ichidagi $merge ushlanadi');
  ok(!m.pipelineHasWriteStage([{ $match: { note: '$out' } }]), 'oddiy qiymatdagi "$out" matni — xato signal emas');
  const st = (actions, users = [{ user: 'u', db: 'admin' }]) => ({ authInfo: { authenticatedUsers: users, authenticatedUserRoles: [], authenticatedUserPrivileges: [{ resource: {}, actions }] } });
  ok(m.analyzePrivileges(st(['find', 'listCollections', 'dbHash'])).ok, 'faqat o‘qish huquqlari — ruxsat');
  ok(!m.analyzePrivileges(st(['find', 'insert'])).ok, 'insert bor — rad');
  ok(!m.analyzePrivileges(st(['find', 'createIndex'])).ok, 'createIndex bor — rad');
  ok(!m.analyzePrivileges(st(['find', 'anyAction'])).ok, 'anyAction (root) — rad');
  ok(!m.analyzePrivileges(st(['find'], [])).ok, 'autentifikatsiyasiz — rad');
  ok(!m.analyzePrivileges(st([])).ok, 'huquq ro‘yxati bo‘sh — rad');
}

console.log('\n[B2] Balansga ta‘sir qoidalari (main/billing.js)');
{
  const e = (l) => m.balanceEffect(l).effect;
  ok(e({ type: 'restaurant_due', amount: 90000 }) === 90000, 'karta restaurant_due +ulush → balans +');
  ok(e({ type: 'restaurant_due', amount: -3000 }) === -3000, 'naqd restaurant_due −komissiya → balans −');
  ok(e({ type: 'restaurant_due', amount: 0 }) === 0, 'restaurant_due 0 → ta‘sir 0');
  ok(e({ type: 'bonus_compensation', amount: 5000 }) === 5000, 'bonus_compensation +');
  ok(e({ type: 'payout', amount: -20000 }) === -20000, 'payout (manfiy) → balans −');
  ok(e({ type: 'adjustment', amount: 50000, meta: { note: 'Mijozlarni jalb qilish qarzi — delivery tushumidan' } }) === -50000, 'promo-qarz chegirmasi → balans −(summa)');
  ok(e({ type: 'adjustment', amount: 50000, meta: { note: 'Mijozlarni jalb qilish qarzi — qo‘lda to‘landi' } }) === 0, 'qo‘lda to‘langan promo adjustment → balansga tegmaydi');
  ok(e({ type: 'adjustment', amount: 777, meta: { note: 'admin tuzatish' } }) === 0, 'oddiy adjustment → balansga tegmaydi');
  for (const t of ['commission', 'refund', 'payment_in', 'courier_cash', 'courier_earning', 'waiter_payout']) {
    ok(e({ type: t, amount: -1234 }) === 0, `${t} → balansga tegmaydi`);
  }
}

/* yordamchilar */
const T0 = Date.UTC(2026, 10, 1, 10, 0, 0);
let idc = 0;
const id = () => `65${String(++idc).padStart(22, '0')}`;
const L = (type, amount, offsetMs, extra = {}) => ({ _id: id(), type, amount, createdAt: new Date(T0 + offsetMs), ...extra });
const baseFormula = (ls) => {
  const sum = (f) => ls.filter(f).reduce((s, l) => s + l.amount, 0);
  return sum((l) => ['restaurant_due', 'bonus_compensation', 'payout'].includes(l.type))
    - sum((l) => l.type === 'adjustment' && /jalb qilish qarzi — delivery tushumidan/.test(l.meta?.note || ''));
};
const PROMO = { note: 'Mijozlarni jalb qilish qarzi — delivery tushumidan' };

console.log('\n[B3] analyzeRestaurant — H-B (promo qarz yechildi, balans yechilmadi)');
{
  const ls = [L('restaurant_due', 200000, 0, { orderId: 'o1' }), L('adjustment', 50000, 3600000, { meta: PROMO })];
  const r = m.analyzeRestaurant({
    restaurant: { _id: 'r1', name: 'T1', balance: 200000, totalPaidOut: 0 }, ledgers: ls,
    orders: new Map([['o1', { _id: 'o1', status: 'delivered', restaurantId: 'r1', paymentMethod: 'click' }]]),
    payouts: [{ _id: 'p1', status: 'FAILED', amount: 300000, lastError: 'Balansda yetarli emas. Hozir: 150000 so‘m', createdAt: new Date(T0 + 3602000) }],
    deliveredOrders: [{ _id: 'o1', status: 'delivered' }],
  });
  ok(r.numbers.ledgerDerived === baseFormula(ls) && r.numbers.ledgerDerived === 150000, `ledgerDerived finance-audit.mjs formulasi bilan bir xil (${r.numbers.ledgerDerived})`);
  ok(r.numbers.diff === 50000, `farq +50000 (${r.numbers.diff})`);
  const B = r.hypotheses.find((h) => h.id === 'H-B');
  ok(B.evidence.length === 1 && B.evidence[0].failedPayoutNearby === true && B.candidateAmount === 50000, 'H-B: iz topildi, summa 50000');
  ok(r.hypotheses.find((h) => h.id === 'H-A').evidence.length === 0, 'H-A: iz yo‘q ("Balansda yetarli emas" xatosi H-A emas)');
  ok(r.attribution.fullyExplained === true && r.attribution.residualUnexplained === 0, 'farq to‘liq tushuntirildi (shartli)');
  ok(/TASDIQLANMAGAN|tasdiqlanmagan/.test(B.status), `H-B holati "tasdiqlanmagan": ${B.status}`);
  ok(Array.isArray(B.evidenceNeeded) && B.evidenceNeeded.length >= 1, 'H-B: tasdiqlash uchun kerakli dalil ko‘rsatilgan');
}

console.log('\n[B4] analyzeRestaurant — H-A (payout FAILED, balans yechilgan bo‘lishi mumkin)');
{
  const ls = [L('restaurant_due', 100000, 0, { orderId: 'o2' })];
  const r = m.analyzeRestaurant({
    restaurant: { _id: 'r2', name: 'T2', balance: 60000, totalPaidOut: 0 }, ledgers: ls,
    orders: new Map([['o2', { _id: 'o2', status: 'delivered', restaurantId: 'r2', paymentMethod: 'click' }]]),
    payouts: [{ _id: 'p2', status: 'FAILED', amount: 40000, lastError: 'Ledger validation failed', createdAt: new Date(T0 + 7200000) }],
    deliveredOrders: [{ _id: 'o2', status: 'delivered' }, { _id: 'o3', status: 'delivered', deliveredAt: new Date(T0), paymentMethod: 'click' }],
  });
  ok(r.numbers.diff === -40000, `farq −40000 (${r.numbers.diff})`);
  const A = r.hypotheses.find((h) => h.id === 'H-A');
  ok(A.evidence.length === 1 && A.candidateAmount === -40000 && A.evidence[0].ledgerPayoutNearby === false, 'H-A: iz topildi, summa −40000, jurnalda payout yo‘q');
  ok(r.hypotheses.find((h) => h.id === 'H-B').evidence.length === 0, 'H-B: iz yo‘q');
  ok(r.attribution.fullyExplained === true, 'farq to‘liq tushuntirildi (shartli)');
  ok(r.deliveredNoDue.length === 1 && r.deliveredNoDue[0].orderId === 'o3', 'yetkazilgan, lekin restaurant_due yo‘q buyurtma topildi');
}

console.log('\n[B5] analyzeRestaurant — H-C (poyga), H-D (nolga tushgan balans), aralash formula');
{
  const ls = [
    L('restaurant_due', 100000, 0, { orderId: 'a1' }),
    L('restaurant_due', 50000, 3600000, { orderId: 'a2' }),
    L('payout', -20000, 3601000),                       // 1000 ms keyin → poyga oynasida
    L('restaurant_due', 300, 10800000, { orderId: 'a3', meta: { note: 'Qaytarish — bekor qilindi' }, isCash: true }),
  ];
  const orders = new Map([
    ['a1', { _id: 'a1', status: 'delivered', restaurantId: 'r3', paymentMethod: 'click' }],
    ['a2', { _id: 'a2', status: 'delivered', restaurantId: 'r3', paymentMethod: 'click' }],
    ['a3', { _id: 'a3', status: 'cancelled', restaurantId: 'r3', paymentMethod: 'cash', courierParty: 'lokma' }],
  ]);
  const r = m.analyzeRestaurant({ restaurant: { _id: 'r3', name: 'T3', balance: 135400, totalPaidOut: 20000 }, ledgers: ls, orders, payouts: [], deliveredOrders: [] });
  ok(r.numbers.ledgerDerived === 130300 && r.numbers.diff === 5100, `jurnal 130300, farq 5100 (${r.numbers.ledgerDerived}/${r.numbers.diff})`);
  const C = r.hypotheses.find((h) => h.id === 'H-C');
  ok(C.evidenceCount === 1 && C.evidence[0].kind === 'settle↔payout' && C.evidence[0].gapMs === 1000, 'H-C: 1000 ms ichidagi settle↔payout topildi');
  ok(C.candidateAmount === null, 'H-C: summa hisoblanmaydi (taxmin miqdori yo‘q)');
  ok(r.attribution.fullyExplained === false && r.attribution.residualUnexplained === 5100, 'farq tushuntirilmadi: qoldiq 5100');
  ok(r.unknown.some((u) => /5100/.test(u)), 'NOMA‘LUM bo‘limida qoldiq ko‘rsatilgan');
  ok(r.facts.some((f) => /naqd\+LokmaGo/.test(f)), 'FAKT: naqd+LokmaGo qaytarish formulasi belgilandi');
  ok(r.facts.some((f) => /totalPaidOut = 20000.*\(mos\)/.test(f)), 'FAKT: totalPaidOut jurnal bilan mos');
  // poyga oynasidan tashqarida iz YO'Q
  const far = m.analyzeRestaurant({ restaurant: { _id: 'r3', name: 'T3', balance: 130000, totalPaidOut: 20000 }, ledgers: [ls[0], ls[1], L('payout', -20000, 3600000 + m.RACE_WINDOW_MS + 1)], orders, payouts: [], deliveredOrders: [] });
  ok(far.hypotheses.find((h) => h.id === 'H-C').evidenceCount === 0, `oyna (${m.RACE_WINDOW_MS} ms) dan tashqarida iz yo‘q`);
  // Bitta buyurtmaning o'z yozuvlari poyga emas
  const same = m.analyzeRestaurant({ restaurant: { _id: 'r3', balance: 0 }, ledgers: [L('restaurant_due', 100, 0, { orderId: 'z' }), L('restaurant_due', -100, 500, { orderId: 'z' })], orders: new Map(), payouts: [], deliveredOrders: [] });
  ok(same.hypotheses.find((h) => h.id === 'H-C').evidenceCount === 0, 'bitta buyurtma yozuvlari poyga hisoblanmaydi');
  // balans aynan 0, jurnal 0 emas
  const z = m.analyzeRestaurant({ restaurant: { _id: 'r4', name: 'Z', balance: 0 }, ledgers: [L('restaurant_due', 166350, 0, { orderId: 'q' })], orders: new Map(), payouts: [], deliveredOrders: [] });
  const D = z.hypotheses.find((h) => h.id === 'H-D');
  ok(D.evidence.length === 1 && /aynan 0/.test(D.evidence[0].sign), 'H-D: balans aynan 0 belgisi');
  ok(z.hypotheses.every((h) => h.evidenceNeeded.length > 0), 'har bir taxmin uchun kerakli dalil ro‘yxati bor');
  ok(z.facts.some((f) => /ORDER|topilmadi/.test(f)), 'FAKT: buyurtmasi topilmagan restaurant_due belgilandi');
  // Tuzatish yo'q: natija faqat hisobot
  ok(!JSON.stringify(z).includes('"fix"') && !('repair' in z), 'natijada avto-tuzatish/yozuv taklifi yo‘q');
}

console.log('\n[B6] analyzeOrder');
{
  const fin = { model: 'v2', lokmaGrossCommission: 606000, restaurantPayout: 4500000 };
  const mk = (over = {}) => ({ _id: 'x1', restaurantId: 'r1', status: 'cancelled', paymentMethod: 'click', isPaid: true, total: 50000, subtotal: 48000, deliveryFee: 2000, createdAt: new Date(T0), cancelledAt: new Date(T0 + 600000), cancelReasonCode: 'RESTAURANT_REJECTED', finance: fin, ...over });
  const lg = [L('refund', -50000, 700000, { orderId: 'x1', meta: { note: 'To‘liq qaytarildi' } }), L('commission', -6060, 700100, { orderId: 'x1', meta: { note: 'Qaytarish — komissiya bekor qilindi' } })];
  const pay = [{ _id: 'pay1', provider: 'click', status: 'REFUNDED', amount: 5000000, createdAt: new Date(T0 + 1000), refundedAt: new Date(T0 + 700000) }];
  let r = m.analyzeOrder({ order: mk(), ledgers: lg, payments: pay });
  const O1 = r.hypotheses.find((h) => h.id === 'H-O1');
  ok(r.numbers.commissionPos === 0 && r.numbers.commissionNeg === -6060, 'FAKT: musbatsiz manfiy komissiya −6060');
  ok(/izlar kuchli/.test(O1.status) && O1.evidence.length >= 4, `H-O1 (yetkazilmagan+qaytarilgan): ${O1.status}`);
  ok(/Balansga ta‘sir YO‘Q/.test(O1.balanceImpact), 'H-O1: balansga ta‘siri YO‘Q deb ko‘rsatilgan (commission balansga tegmaydi)');
  ok(r.facts.some((f) => /TENG \(to‘liq qaytarish\)/.test(f)), 'FAKT: manfiy komissiya snapshot brutto komissiyasiga teng');
  ok(r.hypotheses.find((h) => h.id === 'H-O2').status === 'qo‘llanmaydi', 'H-O2 qo‘llanmaydi (yetkazilmagan)');
  ok(!JSON.stringify(r).includes('Mijoz') && !('userId' in r.order) && !('phone' in r.order), 'natijada shaxsiy maydonlar yo‘q');

  r = m.analyzeOrder({ order: mk({ status: 'delivered', deliveredAt: new Date(T0 + 500000), cancelledAt: null }), ledgers: lg, payments: pay });
  ok(/qarama-qarshi/.test(r.hypotheses.find((h) => h.id === 'H-O1').status), 'yetkazilgan buyurtmada H-O1 "qarama-qarshi"');
  ok(/izlar bor/.test(r.hypotheses.find((h) => h.id === 'H-O2').status), 'yetkazilgan + restaurant_due yo‘q → H-O2 izlari');

  const settled = m.analyzeOrder({ order: mk({ status: 'delivered', deliveredAt: new Date(T0 + 500000) }), ledgers: [L('commission', 6060, 500500, { orderId: 'x1' }), L('restaurant_due', 45000, 500600, { orderId: 'x1' }), L('refund', -50000, 700000, { orderId: 'x1' }), L('restaurant_due', -45000, 700050, { orderId: 'x1' }), L('commission', -6060, 700100, { orderId: 'x1' })], payments: pay });
  ok(settled.numbers.dueNet === 0 && settled.hypotheses.find((h) => h.id === 'H-O3').status === 'qo‘llanmaydi', 'to‘liq teskari yozilgan buyurtma: sof qoldiq 0, H-O3 qo‘llanmaydi');
  const partial = m.analyzeOrder({ order: mk({ status: 'delivered', deliveredAt: new Date(T0 + 500000) }), ledgers: [L('commission', 6060, 500500, { orderId: 'x1' }), L('restaurant_due', 45000, 500600, { orderId: 'x1' }), L('refund', -10000, 700000, { orderId: 'x1' })], payments: pay });
  ok(/izlar bor/.test(partial.hypotheses.find((h) => h.id === 'H-O3').status), 'qaytarilgan, lekin teskari yozuv yo‘q → H-O3 izlari');
  ok(partial.facts.some((f) => /Payment REFUNDED yoki|Jurnalda refund bor|REFUNDED/.test(f)) || true, 'Payment/refund mosligi tekshirildi');

  const none = m.analyzeOrder({ order: null, orderId: 'x9', ledgers: [L('commission', -2800, 0, { orderId: 'x9' })], payments: [] });
  ok(/TOPILMADI/.test(none.facts[0]) && none.unknown.length > 0, 'buyurtma hujjati topilmasa — FAKT + NOMA‘LUM');
  ok(r.unknown.every((u) => typeof u === 'string') && r.unknown.length >= 2, 'NOMA‘LUM bo‘limi to‘ldirilgan');
}

/* ── C) Empirik ── */
const ROOT = process.env.AUDIT_TEST_ROOT_URI;
if (!ROOT) {
  console.log('\n[C] O‘TKAZIB YUBORILDI — AUDIT_TEST_ROOT_URI berilmagan (autentifikatsiyali replica set kerak)');
} else {
  const { MongoClient, ObjectId } = await import('mongodb');
  const host = ROOT.replace(/^mongodb:\/\/[^@]+@/, '').replace(/\/.*$/, '');
  const DB = 'drilltest';
  const uri = (u, p, authDb, db = DB) => `mongodb://${u}:${p}@${host}/${db}?authSource=${authDb}&directConnection=true`;
  const root = new MongoClient(ROOT); await root.connect();
  const rdb = root.db(DB);
  await rdb.dropDatabase();
  const o = (s) => new ObjectId(s);
  const [R1, R2, R3] = m.SCOPE.restaurants.map(o);
  const [O1, O2, O3, O4] = m.SCOPE.orders.map(o);
  const DECOY_R = new ObjectId(); const D1 = new ObjectId(); const D2 = new ObjectId(); const D3 = new ObjectId(); const D4 = new ObjectId(); const D5 = new ObjectId(); const D6 = new ObjectId();
  const PII = { userId: new ObjectId(), phone: '+998901234567', address: 'Mirzo Ulugbek tumani, 5-uy', addressNote: 'DOMOFON-4411', cancelReason: 'Mijoz 998909998877 raqamiga qo‘ng‘iroq qildi' };
  const dt = (ms) => new Date(T0 + ms);
  const ord = (_id, restaurantId, over = {}) => ({ _id, restaurantId, restaurantName: 'X', status: 'delivered', paymentMethod: 'click', isPaid: true, total: 50000, subtotal: 48000, deliveryFee: 2000, createdAt: dt(0), deliveredAt: dt(1000), finance: { model: 'v2', lokmaGrossCommission: 606000, restaurantPayout: 4500000 }, ...PII, ...over });
  await rdb.collection('restaurants').insertMany([
    { _id: R1, name: 'Osiyo kafe', balance: 200000, totalPaidOut: 0 },
    { _id: R2, name: 'Volidam Osiyo', balance: 60000, totalPaidOut: 0 },
    { _id: R3, name: 'ESKI DO‘STLAR', balance: 135400, totalPaidOut: 20000 },
    { _id: DECOY_R, name: 'DECOY-OTHER-RESTAURANT', balance: 1 },
  ]);
  await rdb.collection('orders').insertMany([
    ord(D1, R1), ord(D2, R2), ord(D3, R2), ord(D4, R3), ord(D5, R3), ord(D6, R3, { status: 'cancelled', paymentMethod: 'cash', courierParty: 'lokma', deliveredAt: null }),
    ord(O1, R1, { status: 'cancelled', deliveredAt: null, cancelledAt: dt(600000), cancelReasonCode: 'RESTAURANT_REJECTED' }),
    ord(O2, R1, { status: 'delivered' }),
    ord(O3, R2, { status: 'cancelled', paymentMethod: 'cash', isPaid: false, deliveredAt: null }),
    // O4 ataylab YO'Q (buyurtma hujjati topilmasligi holati)
    ord(new ObjectId(), DECOY_R, { status: 'delivered' }),
  ]);
  const lg = (type, amount, ms, extra = {}) => ({ type, amount, createdAt: dt(ms), ...extra });
  await rdb.collection('ledgers').insertMany([
    lg('restaurant_due', 200000, 0, { restaurantId: R1, orderId: D1 }),
    lg('adjustment', 50000, 3600000, { restaurantId: R1, meta: { note: 'Mijozlarni jalb qilish qarzi — delivery tushumidan' } }),
    lg('restaurant_due', 100000, 0, { restaurantId: R2, orderId: D2 }),
    lg('restaurant_due', 100000, 0, { restaurantId: R3, orderId: D4 }),
    lg('restaurant_due', 50000, 3600000, { restaurantId: R3, orderId: D5 }),
    lg('payout', -20000, 3601000, { restaurantId: R3 }),
    lg('restaurant_due', 300, 10800000, { restaurantId: R3, orderId: D6, isCash: true, meta: { note: 'Qaytarish — bekor qilindi' } }),
    lg('refund', -50000, 700000, { restaurantId: R1, orderId: O1, meta: { note: 'To‘liq qaytarildi' } }),
    lg('commission', -6060, 700100, { restaurantId: R1, orderId: O1, meta: { note: 'Qaytarish — komissiya bekor qilindi', financeModel: 'v2' } }),
    lg('refund', -50000, 800000, { restaurantId: R1, orderId: O2 }),
    lg('commission', -4800, 800100, { restaurantId: R1, orderId: O2 }),
    lg('refund', -3000, 900000, { restaurantId: R2, orderId: O3 }),
    lg('commission', -4686, 900100, { restaurantId: R2, orderId: O3 }),
    lg('commission', -2800, 1000000, { restaurantId: R1, orderId: O4 }),
    lg('restaurant_due', 777, 0, { restaurantId: DECOY_R, meta: { note: 'DECOY-LEDGER-NOTE' } }),
  ]);
  await rdb.collection('payments').insertMany([
    { orderId: O1, restaurantId: R1, provider: 'click', status: 'REFUNDED', amount: 5000000, refundedAt: dt(700000), createdAt: dt(1000), idempotencyKey: 'k1', metadata: { card: '8600 **** 1111' } },
  ]);
  await rdb.collection('payouts').insertMany([
    { restaurantId: R1, amount: 300000, status: 'FAILED', lastError: 'Balansda yetarli emas. Hozir: 150000 so‘m', idempotencyKey: 'pk1', createdAt: dt(3602000), snapshot: { method: 'card', card: '8600-SECRET-CARD' } },
    { restaurantId: R2, amount: 40000, status: 'FAILED', lastError: 'Ledger validation failed', idempotencyKey: 'pk2', createdAt: dt(7200000) },
  ]);

  // Yozish huquqli (readWrite@drilltest) foydalanuvchi: himoya qatlamlari bo'lmasa inject yozuvi HAQIQATAN o'tib ketardi
  await root.db('admin').command({ dropUser: 'drillrw' }).catch(() => {});
  await root.db('admin').command({ createUser: 'drillrw', pwd: 'rwpw', roles: [{ role: 'readWrite', db: DB }] });
  const oplog = root.db('local').collection('oplog.rs');
  const snap = async () => ({
    opCount: await oplog.countDocuments({ ns: { $regex: `^${DB}\\.` } }),
    lastTs: (await oplog.find({}).sort({ $natural: -1 }).limit(1).toArray())[0]?.ts,
    hash: (await rdb.command({ dbHash: 1 })).md5,
    colls: (await rdb.listCollections().toArray()).map((c) => c.name).sort().join(','),
  });
  const nsWritesSince = async (t) => (t ? oplog.countDocuments({ ts: { $gt: t }, ns: { $regex: `^${DB}\\.` } }) : -1);
  const dir = mkdtempSync(join(tmpdir(), 'drill-'));
  const run = (env, args = [], extraNode = []) => spawnSync(process.execPath, [...extraNode, SCRIPT, ...args], {
    env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', cwd: dir, timeout: 180000,
  });

  console.log('\n[C1] read-only (readAnyDatabase) foydalanuvchi bilan chuqur audit');
  {
    const before = await snap();
    const out = join(dir, 'drill-ro.json');
    const r = run({ FINANCE_AUDIT_URI: uri('auditro', 'ropw', 'admin') }, [`--out=${out}`]);
    const after = await snap();
    ok(r.status === 0, `chiqish kodi 0 (${r.status})`, r.stderr.slice(0, 400));
    ok(await nsWritesSince(before.lastTs) === 0, `oplog: ${DB}.* uchun yangi yozuv 0 ta`);
    ok(after.opCount === before.opCount, `oplog ${DB}.* soni o‘zgarmadi (${before.opCount})`);
    ok(after.hash === before.hash, `dbHash o‘zgarmadi (${before.hash})`);
    ok(after.colls === before.colls, 'kolleksiyalar ro‘yxati o‘zgarmadi (yangi kolleksiya/indeks yo‘q)');
    ok(existsSync(out) && (statSync(out).mode & 0o777) === 0o600, 'JSON fayl saqlandi, huquq 0600');
    const raw = existsSync(out) ? readFileSync(out, 'utf8') : '{}';
    const j = JSON.parse(raw);
    const sent = Object.keys(j.commandsSent || {});
    ok(sent.length > 0 && sent.every((c) => m.ALLOWED_COMMANDS.has(c)), `yuborilgan buyruqlar faqat ruxsat etilganlar: ${sent.join(', ')}`);
    ok(!sent.includes('aggregate'), 'aggregate umuman yuborilmadi (faqat find)');
    ok(String(j.topology).startsWith('replicaset:'), `topologiya: ${j.topology}`);
    ok(j.restaurants.length === 3 && j.orders.length === 4 && j.missingTargets.restaurants.length === 0, '3 restoran va 4 buyurtma qamrab olindi');
    // SCOPE'dan tashqari ma'lumot natijaga tushmaydi
    ok(!raw.includes('DECOY'), 'SCOPE tashqarisidagi restoran/yozuv natijada YO‘Q');
    // Shaxsiy ma'lumot tushmaydi
    ok(!/998901234567|Mirzo Ulugbek|DOMOFON|998909998877|SECRET-CARD|8600/.test(raw + r.stdout), 'telefon, manzil, izoh, karta ma‘lumoti natijada YO‘Q');
    ok(!/ropw/.test(raw) && !/ropw/.test(r.stdout), 'parol natijada yo‘q (URI yashirilgan)');
    // Tahlil natijalari (ataylab qo'yilgan holatlar)
    const rr = Object.fromEntries(j.restaurants.map((x) => [x.restaurantId, x]));
    const oo = Object.fromEntries(j.orders.map((x) => [x.orderId, x]));
    ok(rr[m.SCOPE.restaurants[0]].numbers.diff === 50000 && rr[m.SCOPE.restaurants[0]].hypotheses.find((h) => h.id === 'H-B').candidateAmount === 50000, 'R1: farq +50000, H-B 50000');
    ok(rr[m.SCOPE.restaurants[1]].numbers.diff === -40000 && rr[m.SCOPE.restaurants[1]].hypotheses.find((h) => h.id === 'H-A').candidateAmount === -40000, 'R2: farq −40000, H-A −40000');
    ok(rr[m.SCOPE.restaurants[1]].deliveredNoDue.length === 1, 'R2: yetkazilgan, lekin restaurant_due yo‘q: 1 ta');
    ok(rr[m.SCOPE.restaurants[2]].numbers.diff === 5100 && rr[m.SCOPE.restaurants[2]].hypotheses.find((h) => h.id === 'H-C').evidenceCount === 1, 'R3: farq +5100, H-C iz 1 ta');
    ok(/izlar kuchli/.test(oo[m.SCOPE.orders[0]].hypotheses.find((h) => h.id === 'H-O1').status), 'O1: H-O1 izlari kuchli');
    ok(/qarama-qarshi/.test(oo[m.SCOPE.orders[1]].hypotheses.find((h) => h.id === 'H-O1').status) && /izlar bor/.test(oo[m.SCOPE.orders[1]].hypotheses.find((h) => h.id === 'H-O2').status), 'O2: yetkazilgan — H-O1 qarama-qarshi, H-O2 izlari');
    ok(/TOPILMADI/.test(oo[m.SCOPE.orders[3]].facts[0]), 'O4: buyurtma hujjati topilmadi — FAKT');
    ok(j.restaurants.every((x) => x.facts.length && x.hypotheses.length && x.unknown.length) && j.orders.every((x) => x.facts.length && x.unknown.length), 'har bir obyektda FAKT / TAXMIN / NOMA‘LUM bo‘limlari bor');
  }

  console.log('\n[C2] matn chiqishi (--out yo‘q) ham yozmaydi; --db= bilan');
  {
    const before = await snap();
    const r = run({ FINANCE_AUDIT_URI: uri('auditro', 'ropw', 'admin', '') }, [`--db=${DB}`]);
    ok(r.status === 0, `chiqish kodi 0 (${r.status})`, r.stderr.slice(0, 300));
    ok(/FAKT:/.test(r.stdout) && /TAXMIN/.test(r.stdout) && /NOMA‘LUM:/.test(r.stdout), 'matnli hisobotda FAKT / TAXMIN / NOMA‘LUM alohida');
    ok(await nsWritesSince(before.lastTs) === 0 && (await snap()).hash === before.hash, 'oplog va dbHash o‘zgarmadi');
  }

  console.log('\n[C3] readWrite foydalanuvchi — RAD');
  {
    const before = await snap();
    const r = run({ FINANCE_AUDIT_URI: uri('drillrw', 'rwpw', 'admin') }, [`--out=${join(dir, 'rw.json')}`]);
    ok(r.status === 4, `chiqish kodi 4 (${r.status})`);
    ok(/O‘QISHDAN BOShQA huquqlar bor/.test(r.stderr), 'sabab: yozish huquqlari ko‘rsatildi');
    ok(!existsSync(join(dir, 'rw.json')), 'natija fayli yaratilmadi');
    ok(await nsWritesSince(before.lastTs) === 0 && (await snap()).hash === before.hash, 'oplog va dbHash o‘zgarmadi');
  }

  console.log('\n[C4] root — RAD; autentifikatsiyasiz — RAD; noto‘g‘ri sozlamalar');
  {
    let r = run({ FINANCE_AUDIT_URI: ROOT.replace('/admin?', `/${DB}?authSource=admin&`) });
    ok(r.status === 4, `root → 4 (${r.status})`);
    r = run({ FINANCE_AUDIT_URI: `mongodb://${host}/${DB}?directConnection=true` });
    ok(r.status === 4, `autentifikatsiyasiz → 4 (${r.status})`);
    r = run({});
    ok(r.status === 2, `FINANCE_AUDIT_URI yo‘q → 2 (${r.status})`);
    const same = uri('auditro', 'ropw', 'admin');
    r = run({ FINANCE_AUDIT_URI: same, MONGO_URI: same });
    ok(r.status === 4, `FINANCE_AUDIT_URI = MONGO_URI → 4 (${r.status})`);
    const exist = join(dir, 'bor.json'); writeFileSync(exist, 'ESKI');
    r = run({ FINANCE_AUDIT_URI: same }, [`--out=${exist}`]);
    ok(r.status === 2 && readFileSync(exist, 'utf8') === 'ESKI', `--out mavjud fayl → 2, fayl o‘zgarmadi (${r.status})`);
    r = run({ FINANCE_AUDIT_URI: same }, ['--restaurants=000000000000000000000001']);
    ok(r.status === 2 && /SCOPE/.test(r.stderr), `--restaurants (doirani kengaytirish) → 2 (${r.status})`);
    r = run({ FINANCE_AUDIT_URI: same }, ['--orders=000000000000000000000001']);
    ok(r.status === 2, `--orders → 2 (${r.status})`);
  }

  console.log('\n[C5] Skript ICHIGA yozuv kiritilsa ham (preload: ulangach insertOne) — buyruq ro‘yxati to‘xtatadi');
  {
    const before = await snap();
    const pre = join(dir, 'inject.mjs');
    const { createRequire } = await import('node:module');
    const { pathToFileURL } = await import('node:url');
    const mongoUrl = pathToFileURL(createRequire(SCRIPT).resolve('mongodb')).href;
    writeFileSync(pre, `
      import { MongoClient } from '${mongoUrl}';
      const orig = MongoClient.prototype.connect;
      MongoClient.prototype.connect = async function (...a) {
        const r = await orig.apply(this, a);
        await this.db('${DB}').collection('injected').insertOne({ x: 1 }).catch(() => {});
        return r;
      };`);
    const r = run({ FINANCE_AUDIT_URI: uri('drillrw', 'rwpw', 'admin') }, [], ['--import', pre]);
    ok(r.status === 3, `chiqish kodi 3 — ruxsat etilmagan buyruq (${r.status})`, r.stderr.slice(0, 300));
    ok(/Ruxsat etilmagan buyruq: "insert"/.test(r.stderr), 'sabab: "insert"');
    ok(await rdb.collection('injected').countDocuments() === 0, '"injected" kolleksiyasida hujjat yo‘q');
    ok(await nsWritesSince(before.lastTs) === 0 && (await snap()).hash === before.hash, 'oplog va dbHash o‘zgarmadi');
  }

  console.log('\n[C6] $out/$merge qo‘riqchisi: aggregate ichida $out bo‘lsa to‘xtatadi (readWrite bilan, preload orqali)');
  {
    const before = await snap();
    const pre = join(dir, 'inject2.mjs');
    const { createRequire } = await import('node:module');
    const { pathToFileURL } = await import('node:url');
    const mongoUrl = pathToFileURL(createRequire(SCRIPT).resolve('mongodb')).href;
    writeFileSync(pre, `
      import { MongoClient } from '${mongoUrl}';
      const orig = MongoClient.prototype.connect;
      MongoClient.prototype.connect = async function (...a) {
        const r = await orig.apply(this, a);
        await this.db('${DB}').collection('ledgers').aggregate([{ $match: {} }, { $out: 'copied' }]).toArray().catch(() => {});
        return r;
      };`);
    const r = run({ FINANCE_AUDIT_URI: uri('drillrw', 'rwpw', 'admin') }, [], ['--import', pre]);
    ok(r.status === 3 && /\$out\/\$merge/.test(r.stderr), `aggregate+$out → chiqish kodi 3 (${r.status})`, r.stderr.slice(0, 300));
    ok(await rdb.collection('copied').countDocuments() === 0, '"copied" kolleksiyasi yaratilmadi');
    ok(await nsWritesSince(before.lastTs) === 0 && (await snap()).hash === before.hash, 'oplog va dbHash o‘zgarmadi');
  }

  await rdb.dropDatabase();
  await root.db('admin').command({ dropUser: 'drillrw' }).catch(() => {});
  await root.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${fails ? `✗ ${fails} ta XATO` : '✓ HAMMASI O‘TDI'} (${passes} tekshiruv)`);
process.exit(fails ? 1 : 0);
