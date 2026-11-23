/*
 * ═══ scripts/finance-audit-missing-due.mjs HAQIQATAN READ-ONLY EKANINING ISBOTI + TAHLIL MANTIG'I ═══
 *   npm run test:finance-missing-due        (C bo'limi uchun AUDIT_TEST_ROOT_URI kerak: autentifikatsiyali replica set)
 *
 * A) Statik — yozish metodi/dotenv/mongoose yo'q; SCOPE qat'iy (2 restoran, 3 buyurtma); shaxsiy maydonlar projection'da yo'q.
 * B) Birlik — himoya funksiyalari, settleOrder summasi (expectedSettlement), sabab taxminlari, balans bilan bog'lanish.
 * C) Empirik — read-only foydalanuvchi bilan: oplog'da yangi yozuv 0, dbHash o'zgarmagan; readWrite/root/autentifikatsiyasiz → rad;
 *    skript ichiga insert / $out kiritilsa → buyruq ro'yxati to'xtatadi; SCOPE'dan tashqari ma'lumot va PII natijaga tushmaydi.
 */
import { readFileSync, existsSync, statSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/finance-audit-missing-due.mjs', import.meta.url));
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
  const collMethods = [...new Set([...code.matchAll(/db\.collection\([^)]*\)\s*\.(\w+)/g)].map((x) => x[1]))];
  ok(collMethods.every((x) => x === 'find'), `kolleksiya metodlari faqat find: ${collMethods.join(', ')}`);
  const projBlock = src.slice(src.indexOf('const PROJ = {'), src.indexOf('const LIMIT'));
  const pii = ['userId', 'phone', 'address', 'addressNote', 'addressLat', 'addressLng', 'items', 'deviceSessionId', 'cancelReason', 'comment', 'snapshot.card', 'snapshot.bank', 'metadata', 'waiterName', 'courierName', 'courierId'];
  const piiHits = pii.filter((k) => new RegExp(`(^|[\\s{,'"])${k.replace('.', '\\.')}['"]?\\s*:`, 'm').test(projBlock) || projBlock.includes(`'${k}'`));
  ok(piiHits.length === 0, 'projection oq ro‘yxatida shaxsiy/maxfiy maydonlar yo‘q', piiHits.join(','));
  const eq = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
  ok(eq(m.ALLOWED_COMMANDS, base.ALLOWED_COMMANDS), 'ALLOWED_COMMANDS finance-audit.mjs bilan bir xil');
  ok(eq(m.READ_ACTIONS, base.READ_ACTIONS), 'READ_ACTIONS finance-audit.mjs bilan bir xil');
  for (const c of ['insert', 'update', 'delete', 'findAndModify', 'createIndexes', 'create', 'drop', 'dropDatabase', 'renameCollection', 'applyOps', 'bulkWrite', 'collMod']) {
    if (m.ALLOWED_COMMANDS.has(c)) ok(false, `ruxsat ro‘yxatida yozuv buyrug‘i: ${c}`);
  }
  ok(true, 'ruxsat etilgan buyruqlarda yozuv buyrug‘i yo‘q');

  ok(m.SCOPE.restaurants.length === 2 && Object.keys(m.SCOPE.orders).length === 3, 'SCOPE: aynan 2 restoran va 3 buyurtma');
  ok(Object.isFrozen(m.SCOPE) && Object.isFrozen(m.SCOPE.restaurants) && Object.isFrozen(m.SCOPE.orders), 'SCOPE o‘zgartirib bo‘lmaydi (frozen)');
  ok(JSON.stringify(m.SCOPE.restaurants) === JSON.stringify(['6ab76b5a8be3984b83624122', '6a9fc10fa6ae8a984c7552b9']), 'SCOPE restoranlari: Osiyo kafe, Volidam Osiyo');
  ok(JSON.stringify(m.SCOPE.orders) === JSON.stringify({
    '6accaad699f996bdedf9a8f6': '6ab76b5a8be3984b83624122',
    '6af6c7f0debad38f7c96a004': '6ab76b5a8be3984b83624122',
    '6af8557b58b6a44f3d4ab09c': '6a9fc10fa6ae8a984c7552b9',
  }), 'SCOPE buyurtmalari: Osiyo kafe 2 ta, Volidam Osiyo 1 ta');
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
  ok(!m.analyzePrivileges(st(['find', 'anyAction'])).ok, 'anyAction (root) — rad');
  ok(!m.analyzePrivileges(st(['find'], [])).ok, 'autentifikatsiyasiz — rad');
  ok(!m.analyzePrivileges(st([])).ok, 'huquq ro‘yxati bo‘sh — rad');
}

const T0 = Date.UTC(2026, 10, 20, 10, 0, 0);
let idc = 0;
const id = () => `65${String(++idc).padStart(22, '0')}`;
const fin = (commissionSom, shareSom) => ({ model: 'v2', lokmaGrossCommission: commissionSom * 100, restaurantPayout: shareSom * 100 });
const L = (type, amount, offsetMs, extra = {}) => ({ _id: id(), type, amount, createdAt: new Date(T0 + offsetMs), ...extra });
const ORD = (over = {}) => ({ _id: 'o-x', restaurantId: 'r1', status: 'delivered', paymentMethod: 'click', isPaid: true, total: 100000, subtotal: 90000, deliveryFee: 10000, fulfillment: 'delivery', createdAt: new Date(T0), deliveredAt: new Date(T0 + 600000), updatedAt: new Date(T0 + 600000), finance: fin(9000, 83175), ...over });

console.log('\n[B2] expectedSettlement — settleOrder (main) yozgan bo‘lardi');
{
  const e = m.expectedSettlement;
  let r = e(ORD());
  ok(r.known && r.dueAmount === 83175 && r.balanceEffect === 83175 && !r.isCash, 'karta: restaurant_due = +restoran ulushi');
  r = e(ORD({ paymentMethod: 'cash' }));
  ok(r.known && r.isCash && r.dueAmount === -9000, 'naqd: restaurant_due = −komissiya');
  r = e(ORD({ paymentMethod: 'cash', courierParty: 'lokma' }));
  ok(r.known && !r.isCash && r.dueAmount === 83175, 'naqd + LokmaGo kuryeri: karta kabi (+ulush)');
  r = e(ORD({ paymentMethod: 'cash', finance: fin(0, 90000) }));
  ok(r.dueAmount === 0, 'naqd, komissiya 0: restaurant_due = 0');
  r = e(ORD({ bonusItems: [{ quantity: 2, reimburse: 1500 }] }));
  ok(r.bonusCompensation === 3000 && r.balanceEffect === 83175 + 3000, 'sovg‘a-bonus qoplash balansga qo‘shiladi');
  r = e(ORD({ finance: undefined }));
  ok(r.known === false && /legacy|snapshot/.test(r.reason), 'snapshot yo‘q (legacy): summa hisoblanmaydi');
}

console.log('\n[B3] peerStats / deliveredClusters');
{
  const D = (idv, over = {}) => ({ _id: idv, status: 'delivered', paymentMethod: 'click', deliveredAt: new Date(T0 + 1000), ...over });
  const delivered = [D('a'), D('b'), D('c', { paymentMethod: 'cash' }), D('d', { deliveredAt: new Date(T0 + 2000), deliveryCheck: { confirmed: true } })];
  const due = new Set(['a', 'c']);
  const s = m.peerStats(delivered, due);
  ok(s.paymentMethod.click.withDue === 1 && s.paymentMethod.click.withoutDue === 2 && s.paymentMethod.cash.withDue === 1, 'belgi bo‘yicha "due bor/yo‘q" soni');
  ok(s.yakunlash['avtomatik-ish izi'].withoutDue === 1, 'avtomatik ish izi aniqlandi (confirmed=true, confirmedBy/At yo‘q)');
  const cl = m.deliveredClusters(delivered, due);
  ok(cl.length === 1 && cl[0].count === 3 && cl[0].orders.filter((x) => !x.hasDue).length === 1, 'bir xil millisekund guruhi: 3 ta, ulardan due yo‘q 1 ta');
}

console.log('\n[B4] analyzeMissingDueOrder — sabab taxminlari');
{
  const rest = { _id: 'r1', name: 'T', balance: 0 };
  const peerDue = L('restaurant_due', 1000, 0, { orderId: 'peer', restaurantId: 'r1' });
  const peerOrder = (over = {}) => ({ _id: 'peer', status: 'delivered', paymentMethod: 'click', deliveredAt: new Date(T0 + 13 * 3600000), finance: { model: 'v2' }, ...over });
  const H = (r, hid) => r.hypotheses.find((h) => h.id === hid);

  // S1: avtomatik ish izi + bir xil ms klaster, hech qanday jurnal yo'q
  let r = m.analyzeMissingDueOrder({
    orderId: 'o-x', expectedRestaurantId: 'r1', restaurant: rest,
    order: ORD({ deliveredAt: new Date(T0 + 13 * 3600000), deliveryCheck: { confirmed: true } }),
    ledgers: [], payments: [{ status: 'SUCCESS', provider: 'click', amount: 10000000 }],
    restLedgers: [peerDue], restPayouts: [], restDelivered: [ORD({ _id: 'o-x', deliveredAt: new Date(T0 + 13 * 3600000), deliveryCheck: { confirmed: true } }), peerOrder()],
  });
  ok(H(r, 'M-A').evidence.length === 3 && /izlar bor/.test(H(r, 'M-A').status), 'S1: M-A — 3 ta iz (confirmed izi, ≥12 soat, bir xil ms)');
  ok(H(r, 'M-B').evidence.length === 0 && H(r, 'M-D').evidence.length === 0, 'S1: M-B va M-D izi yo‘q');
  ok(/M-A/.test(r.conclusion) && /TASDIQLANMADI/.test(r.conclusion), 'S1: xulosa — "aniq sabab TASDIQLANMADI", izlar: M-A');
  ok(r.numbers.expected.balanceEffect === 83175 && r.numbers.hasDue === false, 'S1: yozilishi kerak bo‘lgan ta‘sir 83175, due yo‘q');
  ok(r.sameMillisecondCluster?.count === 2, 'S1: bir xil millisekund klasteri topildi');
  ok(r.unknown.some((u) => /xato bazada saqlanmaydi/.test(u)), 'S1: NOMA‘LUM — xato bazada saqlanmaydi');

  // S2: odatiy yo'l, komissiya yozilgan, due yo'q
  r = m.analyzeMissingDueOrder({
    orderId: 'o-x', expectedRestaurantId: 'r1', restaurant: rest, order: ORD({ deliveryCheck: { confirmed: true, confirmedBy: 'customer', confirmedAt: new Date(T0 + 1) } }),
    ledgers: [L('commission', 9000, 600100, { orderId: 'o-x', restaurantId: 'r1' })], payments: [], restLedgers: [peerDue], restPayouts: [], restDelivered: [],
  });
  ok(H(r, 'M-D').evidence.length === 1 && H(r, 'M-B').evidence.length === 2 && H(r, 'M-A').evidence.length === 0, 'S2: M-D (commission bor, due yo‘q) va M-B izlari; M-A yo‘q');

  // S3: LokmaGo kuryeri
  r = m.analyzeMissingDueOrder({
    orderId: 'o-x', expectedRestaurantId: 'r1', restaurant: rest, order: ORD({ courierParty: 'lokma', lokmaCourier: { claimedAt: new Date(T0 + 1), settledAt: new Date(T0 + 2) } }),
    ledgers: [], payments: [], restLedgers: [], restPayouts: [], restDelivered: [],
  });
  ok(H(r, 'M-C').evidence.length === 3 && H(r, 'M-B').evidence.length === 0, 'S3: M-C — 3 ta iz (kuryer yo‘li)');

  // S4: due boshqa restoranga yozilgan
  r = m.analyzeMissingDueOrder({
    orderId: 'o-x', expectedRestaurantId: 'r1', restaurant: rest, order: ORD(),
    ledgers: [L('restaurant_due', 83175, 600100, { orderId: 'o-x', restaurantId: 'OTHER' })], payments: [], restLedgers: [], restPayouts: [], restDelivered: [],
  });
  ok(H(r, 'M-E').evidence.length === 1, 'S4: M-E — due boshqa restoran nomiga yozilgan');

  // S5: legacy
  r = m.analyzeMissingDueOrder({ orderId: 'o-x', expectedRestaurantId: 'r1', restaurant: rest, order: ORD({ finance: undefined }), ledgers: [], payments: [], restLedgers: [], restPayouts: [], restDelivered: [] });
  ok(H(r, 'M-G').evidence.length === 1 && r.numbers.expected.known === false && r.unknown.some((u) => /Legacy/.test(u)), 'S5: legacy — M-G, summa NOMA‘LUM');

  // S6: dine-in / demo
  r = m.analyzeMissingDueOrder({ orderId: 'o-x', expectedRestaurantId: 'r1', restaurant: rest, order: ORD({ fulfillment: 'dinein', orderSource: 'qr', isDemo: true }), ledgers: [], payments: [], restLedgers: [], restPayouts: [], restDelivered: [] });
  ok(H(r, 'M-F').evidence.length === 3, 'S6: M-F — dine-in, QR, demo izlari');

  // Hech qanday iz yo'q → xulosa "izlar yo'q"
  r = m.analyzeMissingDueOrder({ orderId: 'o-x', expectedRestaurantId: 'r1', restaurant: rest, order: ORD({ courierParty: 'restaurant' }), ledgers: [], payments: [], restLedgers: [], restPayouts: [], restDelivered: [] });
  ok(r.hypotheses.every((h) => h.evidenceNeeded.length > 0), 'har bir taxmin uchun tasdiqlash dalili ko‘rsatilgan');
  ok(!/\bSABAB: /.test(r.conclusion) && /TASDIQLANMADI/.test(r.conclusion), 'xulosa hech qachon taxminni fakt deb ko‘rsatmaydi');

  r = m.analyzeMissingDueOrder({ orderId: 'zz', order: null });
  ok(/TOPILMADI/.test(r.facts[0]), 'buyurtma hujjati topilmasa — FAKT');
  ok(!JSON.stringify(m.analyzeMissingDueOrder({ orderId: 'o-x', expectedRestaurantId: 'r1', restaurant: rest, order: ORD({ phone: '+998', address: 'X', userId: 'U' }), ledgers: [], payments: [], restLedgers: [], restPayouts: [], restDelivered: [] })).match(/\+998|"address"|userId/), 'natijada shaxsiy maydonlar yo‘q');
}

console.log('\n[B5] analyzeRelation + buildReport — balans farqi bilan bog‘lanish');
{
  // Osiyo kafe: jurnal 1000, balans 167350, yozilmagan 2 buyurtma × 83175 → farq = yig'indi
  const osiyoLedgers = [L('restaurant_due', 1000, 0, { orderId: 'p1', restaurantId: m.SCOPE.restaurants[0] })];
  const volLedgers = [L('restaurant_due', 50000, 0, { orderId: 'p2', restaurantId: m.SCOPE.restaurants[1] })];
  const [rO, rV] = m.SCOPE.restaurants;
  const [m1, m2, m3] = Object.keys(m.SCOPE.orders);
  const data = {
    orders: [
      { ...ORD({ restaurantId: rO }), _id: m1 }, { ...ORD({ restaurantId: rO }), _id: m2 },
      { ...ORD({ restaurantId: rV, paymentMethod: 'cash', finance: fin(3000, 87000) }), _id: m3 },
    ],
    orderLedgers: [], orderPayments: [], truncated: false,
    perRestaurant: {
      [rO]: { restaurant: { _id: rO, name: 'Osiyo kafe', balance: 167350 }, restLedgers: osiyoLedgers, restPayouts: [], restDelivered: [] },
      [rV]: { restaurant: { _id: rV, name: 'Volidam Osiyo', balance: 50000 }, restLedgers: volLedgers, restPayouts: [], restDelivered: [] },
    },
  };
  const rep = m.buildReport(data);
  const o = rep.restaurants.find((x) => x.restaurantId === rO);
  const v = rep.restaurants.find((x) => x.restaurantId === rV);
  ok(o.diff === 166350 && o.expectedSum === 166350 && o.facts.some((f) => /ARIFMETIK TENGLIK/.test(f)), 'Osiyo: farq 166350 = yozilmagan yozuvlar yig‘indisi (arifmetik tenglik)');
  ok(o.facts.some((f) => /farq 0 bo‘lardi/.test(f)), 'Osiyo: "agar yozilganida farq 0 bo‘lardi"');
  ok(o.taxmin.some((t) => /tasodif/.test(t)), 'Osiyo: tenglik TAXMIN sifatida, tasodif ehtimoli bilan');
  ok(o.priorDiff === 166350, 'Osiyo: oldingi audit farqi solishtirildi (o‘zgarmagan)');
  ok(v.diff === 0 && v.expectedSum === -3000 && v.facts.some((f) => /TENG EMAS/.test(f)), 'Volidam: farq 0, yozilmagan −3000 → TENG EMAS');
  ok(rep.overall.missingDueExpectedTotal === 166350 - 3000 && rep.overall.equalsPriorNet === false, 'umumiy: yozilmagan yig‘indi 163350 ≠ 89430 (arifmetik fakt)');
  ok(/QAYTA O‘QILMAGAN/.test(rep.overall.caveat), 'umumiy: ESKI DO‘STLAR qayta o‘qilmagani ochiq aytilgan');
  // legacy bo'lsa summa noma'lum
  data.orders[2] = { ...ORD({ restaurantId: rV, finance: undefined }), _id: m3 };
  const rep2 = m.buildReport(data);
  ok(rep2.restaurants.find((x) => x.restaurantId === rV).expectedSum === null && rep2.overall.missingDueExpectedTotal === null, 'legacy buyurtma bo‘lsa yig‘indi null (taxmin raqam sifatida berilmaydi)');
}

/* ── C) Empirik ── */
const ROOT = process.env.AUDIT_TEST_ROOT_URI;
if (!ROOT) {
  console.log('\n[C] O‘TKAZIB YUBORILDI — AUDIT_TEST_ROOT_URI berilmagan (autentifikatsiyali replica set kerak)');
} else {
  const { MongoClient, ObjectId } = await import('mongodb');
  const host = ROOT.replace(/^mongodb:\/\/[^@]+@/, '').replace(/\/.*$/, '');
  const DB = 'missingdue_test';
  const uri = (u, p, authDb, db = DB) => `mongodb://${u}:${p}@${host}/${db}?authSource=${authDb}&directConnection=true`;
  const root = new MongoClient(ROOT); await root.connect();
  const rdb = root.db(DB);
  await rdb.dropDatabase();
  const o = (s) => new ObjectId(s);
  const [R1, R2] = m.SCOPE.restaurants.map(o);
  const [M1, M2, M3] = Object.keys(m.SCOPE.orders).map(o);
  const DECOY_R = new ObjectId(); const P1 = new ObjectId(); const P2 = new ObjectId();
  const PII = { userId: new ObjectId(), phone: '+998901234567', address: 'Mirzo Ulugbek tumani, 5-uy', addressNote: 'DOMOFON-4411', cancelReason: 'Mijoz 998909998877 raqamiga qo‘ng‘iroq qildi' };
  const dt = (ms) => new Date(T0 + ms);
  const ord = (_id, restaurantId, over = {}) => ({ _id, restaurantId, restaurantName: 'X', status: 'delivered', paymentMethod: 'click', isPaid: true, total: 99900, subtotal: 90000, deliveryFee: 9900, fulfillment: 'delivery', createdAt: dt(0), deliveredAt: dt(13 * 3600000), finance: fin(9000, 83175), ...PII, ...over });
  await rdb.collection('restaurants').insertMany([
    { _id: R1, name: 'Osiyo kafe', balance: 167350 }, { _id: R2, name: 'Volidam Osiyo', balance: 50000 }, { _id: DECOY_R, name: 'DECOY-OTHER-RESTAURANT', balance: 1 },
  ]);
  await rdb.collection('orders').insertMany([
    ord(P1, R1), ord(P2, R2),
    ord(M1, R1, { deliveryCheck: { confirmed: true } }),                                                                       // avtomatik ish izi, P1 bilan bir xil ms
    ord(M2, R1, { deliveredAt: dt(5 * 3600000), deliveryCheck: { confirmed: true, confirmedBy: 'customer', confirmedAt: dt(5 * 3600000) } }),
    ord(M3, R2, { paymentMethod: 'cash', finance: fin(3000, 87000), deliveredAt: dt(2 * 3600000) }),
    ord(new ObjectId(), DECOY_R),
  ]);
  const lg = (type, amount, ms, extra = {}) => ({ type, amount, createdAt: dt(ms), ...extra });
  await rdb.collection('ledgers').insertMany([
    lg('restaurant_due', 1000, 13 * 3600000 + 500, { restaurantId: R1, orderId: P1 }),
    lg('restaurant_due', 50000, 13 * 3600000 + 500, { restaurantId: R2, orderId: P2 }),
    lg('payment_in', 99900, 1000, { restaurantId: R1, orderId: M1 }),
    lg('payment_in', 99900, 1000, { restaurantId: R1, orderId: M2 }),
    lg('commission', 9000, 5 * 3600000 + 100, { restaurantId: R1, orderId: M2 }),
    lg('restaurant_due', 777, 0, { restaurantId: DECOY_R, meta: { note: 'DECOY-LEDGER-NOTE' } }),
  ]);
  await rdb.collection('payments').insertMany([
    { orderId: M1, restaurantId: R1, provider: 'click', status: 'SUCCESS', amount: 9990000, createdAt: dt(500), idempotencyKey: 'k1', metadata: { card: '8600 **** 1111' } },
  ]);
  await rdb.collection('payouts').insertMany([{ restaurantId: R1, amount: 1, status: 'SUCCESS', idempotencyKey: 'pk1', createdAt: dt(0), snapshot: { card: '8600-SECRET-CARD' } }]);

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
  const dir = mkdtempSync(join(tmpdir(), 'missingdue-'));
  const run = (env, args = [], extraNode = []) => spawnSync(process.execPath, [...extraNode, SCRIPT, ...args], {
    env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', cwd: dir, timeout: 180000,
  });

  console.log('\n[C1] read-only (readAnyDatabase) foydalanuvchi bilan audit');
  {
    const before = await snap();
    const out = join(dir, 'md-ro.json');
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
    ok(j.orders.length === 3 && j.restaurants.length === 2, '3 buyurtma va 2 restoran qamrab olindi');
    ok(!raw.includes('DECOY'), 'SCOPE tashqarisidagi restoran/yozuv natijada YO‘Q');
    ok(!/998901234567|Mirzo Ulugbek|DOMOFON|998909998877|SECRET-CARD|8600/.test(raw + r.stdout), 'telefon, manzil, izoh, karta ma‘lumoti natijada YO‘Q');
    ok(!/ropw/.test(raw) && !/ropw/.test(r.stdout), 'parol natijada yo‘q (URI yashirilgan)');
    const oo = Object.fromEntries(j.orders.map((x) => [x.orderId, x]));
    const H = (id2, hid) => oo[id2].hypotheses.find((h) => h.id === hid);
    ok(H(m1(), 'M-A').evidence.length === 3, 'M1: M-A — 3 ta iz (avtomatik ish, ≥12 soat, bir xil ms klaster)');
    ok(H(m2(), 'M-D').evidence.length === 1 && H(m2(), 'M-A').evidence.length === 0, 'M2: M-D (commission bor, due yo‘q); M-A yo‘q');
    ok(oo[m1()].numbers.expected.balanceEffect === 83175 && oo[m3()].numbers.expected.balanceEffect === -3000, 'kutilgan ta‘sir: M1 +83175, M3 (naqd) −3000');
    const rel = Object.fromEntries(j.restaurants.map((x) => [x.restaurantId, x]));
    ok(rel[m.SCOPE.restaurants[0]].diff === 166350 && rel[m.SCOPE.restaurants[0]].expectedSum === 166350, 'Osiyo: farq 166350 = yozilmagan yig‘indi 166350');
    ok(j.overall.equalsPriorNet === false && j.overall.missingDueExpectedTotal === 163350, 'umumiy: 163350 ≠ 89430');
    ok(j.orders.every((x) => x.facts.length && x.hypotheses.length && x.unknown.length && /TASDIQLANMADI/.test(x.conclusion)), 'har bir buyurtmada FAKT / TAXMIN / NOMA‘LUM / xulosa bor');
  }
  function m1() { return Object.keys(m.SCOPE.orders)[0]; }
  function m2() { return Object.keys(m.SCOPE.orders)[1]; }
  function m3() { return Object.keys(m.SCOPE.orders)[2]; }

  console.log('\n[C2] matn chiqishi (--out yo‘q) va --db=');
  {
    const before = await snap();
    const r = run({ FINANCE_AUDIT_URI: uri('auditro', 'ropw', 'admin', '') }, [`--db=${DB}`]);
    ok(r.status === 0, `chiqish kodi 0 (${r.status})`, r.stderr.slice(0, 300));
    ok(/FAKT:/.test(r.stdout) && /TAXMIN/.test(r.stdout) && /NOMA‘LUM:/.test(r.stdout) && /XULOSA:/.test(r.stdout), 'matnli hisobotda FAKT / TAXMIN / NOMA‘LUM / XULOSA');
    ok(/89 430|BILAN BOG‘LANISH/.test(r.stdout), 'balans farqi bilan bog‘lanish bo‘limi bor');
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

  console.log('\n[C4] root, autentifikatsiyasiz, noto‘g‘ri sozlamalar — RAD');
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
    r = run({ FINANCE_AUDIT_URI: same }, ['--orders=000000000000000000000001']);
    ok(r.status === 2 && /SCOPE/.test(r.stderr), `--orders (doirani kengaytirish) → 2 (${r.status})`);
    r = run({ FINANCE_AUDIT_URI: same }, ['--restaurants=000000000000000000000001']);
    ok(r.status === 2, `--restaurants → 2 (${r.status})`);
  }

  const injectTest = async (title, body, expectMsg, check) => {
    console.log(`\n${title}`);
    const before = await snap();
    const pre = join(dir, `inject-${Math.random().toString(36).slice(2)}.mjs`);
    const { createRequire } = await import('node:module');
    const { pathToFileURL } = await import('node:url');
    const mongoUrl = pathToFileURL(createRequire(SCRIPT).resolve('mongodb')).href;
    writeFileSync(pre, `
      import { MongoClient } from '${mongoUrl}';
      const orig = MongoClient.prototype.connect;
      MongoClient.prototype.connect = async function (...a) {
        const r = await orig.apply(this, a);
        ${body}
        return r;
      };`);
    const r = run({ FINANCE_AUDIT_URI: uri('drillrw', 'rwpw', 'admin') }, [], ['--import', pre]);
    ok(r.status === 3, `chiqish kodi 3 — ruxsat etilmagan buyruq (${r.status})`, r.stderr.slice(0, 300));
    ok(expectMsg.test(r.stderr), `sabab: ${expectMsg}`);
    ok(await check(), 'yozuv bazaga TUSHMADI');
    ok(await nsWritesSince(before.lastTs) === 0 && (await snap()).hash === before.hash, 'oplog va dbHash o‘zgarmadi');
  };
  await injectTest('[C5] Skript ICHIGA insertOne kiritilsa (yozish huquqli foydalanuvchi bilan) — buyruq ro‘yxati to‘xtatadi',
    `await this.db('${DB}').collection('injected').insertOne({ x: 1 }).catch(() => {});`, /Ruxsat etilmagan buyruq: "insert"/,
    async () => (await rdb.collection('injected').countDocuments()) === 0);
  await injectTest('[C6] aggregate ichida $out — qo‘riqchi to‘xtatadi',
    `await this.db('${DB}').collection('ledgers').aggregate([{ $match: {} }, { $out: 'copied' }]).toArray().catch(() => {});`, /\$out\/\$merge/,
    async () => (await rdb.collection('copied').countDocuments()) === 0);
  await injectTest('[C7] updateOne (balansni o‘zgartirishga urinish) — qo‘riqchi to‘xtatadi, balans o‘zgarmaydi',
    `await this.db('${DB}').collection('restaurants').updateOne({}, { $set: { balance: 999999 } }).catch(() => {});`, /Ruxsat etilmagan buyruq: "update"/,
    async () => (await rdb.collection('restaurants').findOne({ _id: R1 })).balance === 167350);

  await rdb.dropDatabase();
  await root.db('admin').command({ dropUser: 'drillrw' }).catch(() => {});
  await root.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${fails ? `✗ ${fails} ta XATO` : '✓ HAMMASI O‘TDI'} (${passes} tekshiruv)`);
process.exit(fails ? 1 : 0);
