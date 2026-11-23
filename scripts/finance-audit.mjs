/*
 * ═══════════════════════════════════════════════════════════════════════════
 * MOLIYAVIY AUDIT — FAQAT O'QIYDI (READ-ONLY)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   FINANCE_AUDIT_URI='mongodb+srv://<READONLY_USER>:<PAROL>@<cluster>/<db>' \
 *     node scripts/finance-audit.mjs [--out=audit.json] [--json] [--from=YYYY-MM-DD] [--to=YYYY-MM-DD]
 *
 * Bazaga HECH NARSA yozmaydi. Buni uchta MUSTAQIL qatlam kafolatlaydi — bittasi ishlamasa ham qolganlari to'xtatadi:
 *
 *  1) HUQUQ DARVOZASI (baza tomonida tekshiriladi). Ulangandan keyin `connectionStatus { showPrivileges: true }`
 *     bilan foydalanuvchining HAQIQIY huquqlari o'qiladi. Faqat o'qish huquqlari (READ_ACTIONS) bo'lmasa —
 *     insert/update/remove/createIndex/drop… bo'lsa yoki foydalanuvchi aniqlanmasa — skript BIRORTA kolleksiyaga
 *     murojaat qilmasdan to'xtaydi (chiqish kodi 4). Ya'ni hatto kodda xato bo'lsa ham baza yozuvni rad etadi.
 *
 *  2) BUYRUQ RUXSAT RO'YXATI (drayver tomonida). Har bir wire buyrug'i yuborilishidan oldin `commandStarted`
 *     hodisasida tekshiriladi: faqat ALLOWED_COMMANDS. `aggregate` da `$out`/`$merge` bo'lsa ham to'xtaydi.
 *     Ro'yxatdan tashqari buyruq — darhol process.exit(3).
 *
 *  3) KOD. Faqat `mongodb` drayveri (mongoose, model, autoIndex yo'q). `.env` O'QILMAYDI — production'ning
 *     o'qish-yozish huquqli MONGO_URI si tasodifan ishlatilmasin; manzil faqat FINANCE_AUDIT_URI dan.
 *     Yozish metodlari (insert, update, delete, replace, bulkWrite, drop, create, rename, findOneAnd…) umuman yo'q —
 *     tests/finance-audit-readonly.test.mjs buni statik tekshiradi.
 *
 * Yuk: o'qishlar `secondaryPreferred` (Atlas'da ikkilamchi tugundan), har operatsiya `maxTimeMS` bilan cheklangan.
 * Natija: `--out=fayl.json` — faqat LOKAL faylga, 0600 huquq bilan, mavjud faylni USTIDAN YOZMAYDI.
 *
 * Tekshiradi:
 *   1. bir buyurtmaga BIR NECHTA hisob-kitob (commission > 0 yoki birlamchi restaurant_due takrori) — F-02 izi;
 *   2. restoran balansi ≠ jurnaldan hisoblangan balans — F-01 (yo'qolgan yangilanish) izi;
 *   3. bir buyurtmada bir nechta payment_in — F-19;
 *   4. bir provayder tranzaksiyasiga bir nechta Payment / bir buyurtmaga bir nechta SUCCESS Payment — F-16;
 *   5. qaytarilgan summa > buyurtma summasi — F-10;
 *   6. musbat komissiyasiz manfiy komissiya — F-05 izi;
 *   7. yarim qolgan settlement (SETTLING) va PROCESSING payout'lar;
 *   8. takroriy postingKey.
 * Topilgan narsalar TUZATILMAYDI.
 */
import { MongoClient } from 'mongodb';
import { writeFileSync, existsSync } from 'node:fs';

const EXIT = { OK: 0, USAGE: 2, FORBIDDEN_COMMAND: 3, NOT_READ_ONLY: 4, ERROR: 1 };

/* ─── Ruxsat etilgan wire buyruqlari (faqat o'qish va ulanish xizmati) ─── */
export const ALLOWED_COMMANDS = new Set([
  'hello', 'ismaster', 'isMaster', 'ping', 'buildInfo', 'buildinfo',
  'saslStart', 'saslContinue', 'authenticate', 'getnonce',      // autentifikatsiya
  'connectionStatus',                                            // huquqlarni o'qish
  'find', 'aggregate', 'getMore', 'killCursors', 'endSessions',  // o'qish va kursor/sessiya tozalash
]);
/* ─── Faqat o'qish huquqlari (MongoDB privilege actions). Boshqa HAR QANDAY action → rad. ─── */
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

/** Pipeline ichida (shu jumladan $lookup/$facet/$unionWith ichida ham) $out/$merge qidiradi. */
export function pipelineHasWriteStage(node) {
  if (Array.isArray(node)) return node.some(pipelineHasWriteStage);
  if (node && typeof node === 'object') {
    return Object.keys(node).some((k) => FORBIDDEN_STAGES.includes(k) || pipelineHasWriteStage(node[k]));
  }
  return false;
}

/** connectionStatus javobidan: faqat o'qish huquqlarimi? */
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

async function main() {
  if (argv.help) {
    process.stdout.write('FINANCE_AUDIT_URI=... node scripts/finance-audit.mjs [--out=fayl.json] [--json] [--from=YYYY-MM-DD] [--to=YYYY-MM-DD]\n');
    return EXIT.OK;
  }
  const uri = process.env.FINANCE_AUDIT_URI;
  if (!uri) die(EXIT.USAGE, 'FINANCE_AUDIT_URI berilmagan. FAQAT O‘QISH huquqli foydalanuvchi manzilini bering (ilova MONGO_URI si EMAS).');
  if (process.env.MONGO_URI && process.env.MONGO_URI === uri) {
    die(EXIT.NOT_READ_ONLY, 'FINANCE_AUDIT_URI ilovaning MONGO_URI si bilan bir xil — bu o‘qish-yozish foydalanuvchisi. Alohida read-only foydalanuvchi kerak.');
  }
  for (const k of ['from', 'to']) {
    if (argv[k] !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(argv[k]))) die(EXIT.USAGE, `--${k} formati YYYY-MM-DD bo‘lishi kerak`);
  }
  if (argv.out !== undefined) {
    if (argv.out === true || !String(argv.out).trim()) die(EXIT.USAGE, '--out=fayl.json ko‘rinishida bering');
    if (existsSync(argv.out)) die(EXIT.USAGE, `${argv.out} allaqachon bor — ustidan yozilmaydi. Boshqa nom bering.`);
  }

  const commandLog = {};
  const client = new MongoClient(uri, {
    monitorCommands: true,
    readPreference: 'secondaryPreferred',
    retryWrites: false,
    appName: 'lokmago-finance-audit-readonly',
    serverSelectionTimeoutMS: 15000,
    maxPoolSize: 2,
  });

  /* ─── QATLAM 2: har bir buyruq yuborilishidan oldin tekshiriladi ─── */
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
    if (!dbName) die(EXIT.USAGE, 'Baza nomi URI ichida bo‘lishi kerak (…mongodb.net/<baza>?…) yoki --db=<baza>');
    const db = client.db(dbName);
    const admin = client.db('admin');

    /* ─── QATLAM 1: HUQUQ DARVOZASI — kolleksiyalarga murojaatdan OLDIN ─── */
    const status = await admin.command({ connectionStatus: 1, showPrivileges: true });
    const priv = analyzePrivileges(status);
    if (!priv.ok) {
      const why = !priv.users.length
        ? 'foydalanuvchi autentifikatsiya qilinmagan — huquqlarni isbotlab bo‘lmaydi'
        : `foydalanuvchida O‘QISHDAN BOShQA huquqlar bor: ${priv.nonRead.join(', ') || '(huquq ro‘yxati bo‘sh)'}`;
      die(EXIT.NOT_READ_ONLY, `Audit ishga tushmadi: ${why}.\n   Foydalanuvchi: ${priv.users.join(', ') || '—'} · rollar: ${priv.roles.join(', ') || '—'}\n   Atlas'da faqat "Only read any database" (yoki read@${dbName}) rolli vaqtinchalik foydalanuvchi yarating.`);
    }

    const T = Number(argv.maxTimeMS) > 0 ? Number(argv.maxTimeMS) : 120000;
    const agg = (coll, pipeline) => {
      if (pipelineHasWriteStage(pipeline)) die(EXIT.FORBIDDEN_COMMAND, 'pipeline ichida $out/$merge');
      return db.collection(coll).aggregate(pipeline, { maxTimeMS: T, allowDiskUse: false }).toArray();
    };
    const find = (coll, filter, projection, limit = 500) => db.collection(coll)
      .find(filter, { projection, limit, maxTimeMS: T }).toArray();

    const range = {};
    if (argv.from) range.$gte = new Date(`${argv.from}T00:00:00+05:00`);
    if (argv.to) range.$lt = new Date(new Date(`${argv.to}T00:00:00+05:00`).getTime() + 86400000);
    const created = Object.keys(range).length ? { createdAt: range } : {};
    const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

    const hello = await admin.command({ hello: 1 });
    const out = {
      generatedAt: new Date().toISOString(),
      readOnly: { users: priv.users, roles: priv.roles, actions: priv.actions },
      target: { uri: redact(uri), db: dbName },
      topology: hello.msg === 'isdbgrid' ? 'sharded' : (hello.setName ? `replicaset:${hello.setName}` : 'standalone'),
      filter: { from: argv.from || null, to: argv.to || null, timezone: 'Asia/Tashkent' },
      sections: {},
    };
    const S = out.sections;

    S.duplicateSettlements = await agg('ledgers', [
      { $match: { ...created, type: 'commission', amount: { $gt: 0 }, orderId: { $ne: null } } },
      { $group: { _id: '$orderId', n: { $sum: 1 }, total: { $sum: '$amount' }, restaurantId: { $first: '$restaurantId' } } },
      { $match: { n: { $gt: 1 } } }, { $limit: 500 },
    ]);
    S.duplicatePrimaryDue = await agg('ledgers', [
      { $match: { ...created, type: 'restaurant_due', orderId: { $ne: null }, 'meta.note': { $not: /Qaytarish|qaytarish/ } } },
      { $group: { _id: '$orderId', n: { $sum: 1 }, total: { $sum: '$amount' }, restaurantId: { $first: '$restaurantId' } } },
      { $match: { n: { $gt: 1 } } }, { $limit: 500 },
    ]);

    // Balans kumulyativ — davr filtri qo'llanmaydi
    const ledgerBal = await agg('ledgers', [
      { $match: { restaurantId: { $ne: null }, type: { $in: ['restaurant_due', 'bonus_compensation', 'payout'] } } },
      { $group: { _id: '$restaurantId', s: { $sum: '$amount' } } },
    ]);
    const promoAdj = await agg('ledgers', [
      { $match: { restaurantId: { $ne: null }, type: 'adjustment', 'meta.note': /jalb qilish qarzi — delivery tushumidan/ } },
      { $group: { _id: '$restaurantId', s: { $sum: '$amount' } } },
    ]);
    const lb = new Map(ledgerBal.map((x) => [String(x._id), x.s]));
    const pa = new Map(promoAdj.map((x) => [String(x._id), x.s]));
    const rests = await find('restaurants', {}, { name: 1, balance: 1 }, 0);
    S.balanceDrift = rests.map((x) => {
      const expected = r2(r2(lb.get(String(x._id)) || 0) - r2(pa.get(String(x._id)) || 0));
      return { restaurantId: x._id, name: x.name, balance: r2(x.balance), ledgerDerived: expected, diff: r2((x.balance || 0) - expected) };
    }).filter((x) => Math.abs(x.diff) >= 0.01).sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

    S.duplicatePaymentIn = await agg('ledgers', [
      { $match: { ...created, type: 'payment_in', orderId: { $ne: null } } },
      { $group: { _id: '$orderId', n: { $sum: 1 }, total: { $sum: '$amount' } } }, { $match: { n: { $gt: 1 } } }, { $limit: 500 },
    ]);
    S.duplicateProviderTx = await agg('payments', [
      { $match: { ...created, providerTransactionId: { $nin: ['', null] } } },
      { $group: { _id: { provider: '$provider', tx: '$providerTransactionId' }, n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }, { $limit: 500 },
    ]);
    S.multipleSuccessPerOrder = await agg('payments', [
      { $match: { ...created, status: 'SUCCESS' } },
      { $group: { _id: '$orderId', n: { $sum: 1 }, amounts: { $push: '$amount' } } }, { $match: { n: { $gt: 1 } } }, { $limit: 500 },
    ]);
    S.overRefund = await agg('ledgers', [
      { $match: { ...created, type: 'refund', orderId: { $ne: null } } },
      { $group: { _id: '$orderId', refunded: { $sum: { $abs: '$amount' } } } },
      { $lookup: { from: 'orders', localField: '_id', foreignField: '_id', as: 'o', pipeline: [{ $project: { total: 1 } }] } },
      { $project: { refunded: 1, total: { $first: '$o.total' } } },
      { $match: { $expr: { $gt: ['$refunded', { $add: [{ $ifNull: ['$total', 0] }, 0.01] }] } } }, { $limit: 500 },
    ]);
    S.orphanNegativeCommission = await agg('ledgers', [
      { $match: { ...created, type: 'commission', orderId: { $ne: null } } },
      { $group: { _id: '$orderId', pos: { $sum: { $cond: [{ $gt: ['$amount', 0] }, '$amount', 0] } }, neg: { $sum: { $cond: [{ $lt: ['$amount', 0] }, '$amount', 0] } } } },
      { $match: { pos: 0, neg: { $lt: 0 } } }, { $limit: 500 },
    ]);
    S.stuckSettlements = await find('orders', { 'financeSettlement.state': 'SETTLING' }, { restaurantId: 1, financeSettlement: 1 });
    S.stuckPayouts = await find('payouts', { status: 'PROCESSING' }, { restaurantId: 1, amount: 1, createdAt: 1, 'snapshot.balanceClaimed': 1 });
    S.duplicatePostingKeys = await agg('ledgers', [
      { $match: { postingKey: { $type: 'string' } } }, { $group: { _id: '$postingKey', n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }, { $limit: 100 },
    ]);

    out.summary = Object.fromEntries(Object.entries(S).map(([k, v]) => [k, v.length]));
    out.balanceDriftTotal = r2(S.balanceDrift.reduce((s, x) => s + x.diff, 0));
    out.commandsSent = { ...commandLog };   // isbot: yuborilgan barcha buyruqlar (faqat ruxsat etilganlar)

    if (argv.out) {
      writeFileSync(argv.out, `${JSON.stringify(out, null, 2)}\n`, { flag: 'wx', mode: 0o600 });   // lokal fayl; mavjud bo'lsa — xato
    }
    if (argv.json) {
      process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    } else {
      printText(out);
      if (argv.out) process.stdout.write(`\nJSON saqlandi: ${argv.out} (0600)\n`);
    }
    return EXIT.OK;
  } finally {
    await client.close().catch(() => {});
  }
}

function printText(out) {
  const p = (s) => process.stdout.write(`${s}\n`);
  p(`\nMOLIYAVIY AUDIT (READ-ONLY) · ${out.generatedAt}`);
  p(`Baza: ${out.target.db} · ${out.topology} · foydalanuvchi: ${out.readOnly.users.join(', ')} (${out.readOnly.roles.join(', ')})`);
  if (out.filter.from || out.filter.to) p(`Davr: ${out.filter.from || '…'} — ${out.filter.to || '…'} (Toshkent vaqti)`);
  const labels = {
    duplicateSettlements: 'Bir buyurtmada bir nechta komissiya (takroriy hisob-kitob)',
    duplicatePrimaryDue: 'Bir buyurtmada bir nechta birlamchi restaurant_due',
    balanceDrift: 'Restoran balansi ≠ jurnal (yo‘qolgan yangilanish)',
    duplicatePaymentIn: 'Bir buyurtmada bir nechta payment_in',
    duplicateProviderTx: 'Bir provayder tranzaksiyasiga bir nechta Payment',
    multipleSuccessPerOrder: 'Bir buyurtmaga bir nechta SUCCESS Payment',
    overRefund: 'Qaytarilgan > buyurtma summasi',
    orphanNegativeCommission: 'Musbatsiz manfiy komissiya',
    stuckSettlements: 'Yarim qolgan settlement (SETTLING)',
    stuckPayouts: 'PROCESSING holatidagi payout',
    duplicatePostingKeys: 'Takroriy postingKey',
  };
  for (const [k, label] of Object.entries(labels)) {
    const v = out.sections[k];
    p(`\n${v.length ? '⚠' : '✓'} ${label}: ${v.length}`);
    v.slice(0, 10).forEach((x) => p(`    ${JSON.stringify(x)}`));
    if (v.length > 10) p(`    … yana ${v.length - 10} ta (--out bilan to‘liq)`);
  }
  if (out.sections.balanceDrift.length) p(`\nBalans farqi jami: ${out.balanceDriftTotal} so‘m (musbat — balans jurnaldan KO‘P: ortiqcha to‘lash xavfi)`);
  p(`\nYuborilgan buyruqlar: ${Object.entries(out.commandsSent).map(([k, v]) => `${k}×${v}`).join(', ')}`);
}

// To'g'ridan-to'g'ri ishga tushirilganda (test import qilganda — yo'q)
if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code)).catch((e) => {
    process.stderr.write(`\n✗ Audit xatosi: ${e?.message || e}\n`);
    process.exit(EXIT.ERROR);
  });
}
