/*
 * ═══ scripts/finance-audit.mjs HAQIQATAN READ-ONLY EKANINING ISBOTI ═══   npm run test:finance-audit-readonly
 *
 * A) Statik: skript matnida yozish metodi / $out / $merge / .env / mongoose YO'Q.
 * B) Birlik: huquq tahlili (analyzePrivileges) va pipeline tekshiruvi ($lookup/$facet ichida ham).
 * C) Empirik (AUDIT_TEST_ROOT_URI berilsa — autentifikatsiyali REPLICA SET kerak):
 *    • read-only foydalanuvchi bilan audit → oplog'da `lokmago.*` uchun YANGI yozuv 0 ta, dbHash o'zgarmagan,
 *      faqat ruxsat etilgan buyruqlar yuborilgan, JSON fayl 0600 bilan saqlangan;
 *    • readWrite foydalanuvchi → kolleksiyalarga murojaatdan OLDIN rad (chiqish 4);
 *    • autentifikatsiyasiz → rad (4); FINANCE_AUDIT_URI === MONGO_URI → rad (4); --out mavjud fayl → rad (2);
 *    • skript ICHIGA yozuv kiritilsa (preload bilan insertOne) → buyruq ro'yxati to'xtatadi (3), hujjat yozilmaydi.
 *
 * Replica set'da HAR QANDAY yozuv (insert/update/delete, indeks, kolleksiya yaratish) oplog'ga tushadi —
 * oplog'ning o'zgarmagani bazaga hech narsa yozilmaganining eng kuchli isboti.
 */
import { readFileSync, existsSync, statSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/finance-audit.mjs', import.meta.url));
let fails = 0; let passes = 0;
const ok = (c, m, extra = '') => { console.log(c ? '  ✓' : '  ✗ FAIL:', m, c ? '' : extra); if (c) passes++; else fails++; };

/* ── A) Statik ── */
console.log('\n[A] Statik tahlil: skript matni');
{
  const src = readFileSync(SCRIPT, 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\/[^'\n]*$/gm, '');
  const forbidden = [
    /\.insert(One|Many)?\s*\(/, /\.update(One|Many)?\s*\(/, /\.delete(One|Many)?\s*\(/, /\.replaceOne\s*\(/, /\.bulkWrite\s*\(/,
    /\.findOneAnd(Update|Replace|Delete)\s*\(/, /\.drop(Database|Index|Indexes)?\s*\(/, /\.create(Index|Indexes|Collection|SearchIndex)\s*\(/,
    /\.rename\s*\(/, /\.save\s*\(/, /\bmapReduce\b/, /\$eval\b/, /\bwatch\s*\(/,
    /\bimport\s+['"]dotenv/, /\bfrom\s+['"]mongoose['"]/, /process\.env\.MONGO_URI\s*\|\|/,
  ];
  const hits = forbidden.filter((re) => re.test(code)).map(String);
  ok(hits.length === 0, 'yozish metodi, dotenv, mongoose, MONGO_URI fallback yo‘q', hits.join(' '));
  const stageHits = (code.match(/['"]\$(out|merge)['"]/g) || []);
  ok(stageHits.length === 2 && /FORBIDDEN_STAGES = \['\$out', '\$merge'\]/.test(code), '$out/$merge faqat TAQIQ ro‘yxatida uchraydi');
  const cmdCalls = [...code.matchAll(/\.command\(\s*\{\s*(\w+)/g)].map((m) => m[1]);
  ok(cmdCalls.every((c) => ['connectionStatus', 'hello'].includes(c)), `.command() faqat connectionStatus/hello: ${cmdCalls.join(', ')}`);
  ok(/flag: 'wx', mode: 0o600/.test(code), 'natija fayli: ustidan yozmaydi (wx), 0600');
}

/* ── B) Birlik ── */
console.log('\n[B] Himoya funksiyalari');
{
  const m = await import(SCRIPT);
  ok(m.pipelineHasWriteStage([{ $match: {} }, { $out: 'x' }]), '$out ushlanadi');
  ok(m.pipelineHasWriteStage([{ $lookup: { from: 'o', pipeline: [{ $merge: { into: 'y' } }], as: 'z' } }]), '$lookup ichidagi $merge ushlanadi');
  ok(m.pipelineHasWriteStage([{ $facet: { a: [{ $out: 'q' }] } }]), '$facet ichidagi $out ushlanadi');
  ok(!m.pipelineHasWriteStage([{ $match: { note: '$out' } }, { $group: { _id: '$x' } }]), 'oddiy qiymatdagi "$out" matni — xato signal emas');
  const st = (actions, users = [{ user: 'u', db: 'admin' }]) => ({ authInfo: { authenticatedUsers: users, authenticatedUserRoles: [], authenticatedUserPrivileges: [{ resource: {}, actions }] } });
  ok(m.analyzePrivileges(st(['find', 'listCollections', 'dbHash'])).ok, 'faqat o‘qish huquqlari — ruxsat');
  ok(!m.analyzePrivileges(st(['find', 'insert'])).ok, 'insert bor — rad');
  ok(!m.analyzePrivileges(st(['find', 'createIndex'])).ok, 'createIndex bor — rad');
  ok(!m.analyzePrivileges(st(['find', 'anyAction'])).ok, 'anyAction (root) — rad');
  ok(!m.analyzePrivileges(st(['find'], [])).ok, 'autentifikatsiyasiz — rad');
  ok(!m.analyzePrivileges(st([])).ok, 'huquq ro‘yxati bo‘sh — rad');
  for (const c of ['insert', 'update', 'delete', 'findAndModify', 'createIndexes', 'create', 'drop', 'dropDatabase', 'renameCollection', 'applyOps', 'bulkWrite', 'collMod']) {
    if (m.ALLOWED_COMMANDS.has(c)) { ok(false, `ruxsat ro‘yxatida yozuv buyrug‘i: ${c}`); }
  }
  ok(true, 'ruxsat etilgan buyruqlar ro‘yxatida yozuv buyrug‘i yo‘q');
}

/* ── C) Empirik ── */
const ROOT = process.env.AUDIT_TEST_ROOT_URI;   // masalan mongodb://root:rootpw@127.0.0.1:27020/admin?directConnection=true
if (!ROOT) {
  console.log('\n[C] O‘TKAZIB YUBORILDI — AUDIT_TEST_ROOT_URI berilmagan (autentifikatsiyali replica set kerak)');
} else {
  const { MongoClient } = await import('mongodb');
  const host = ROOT.replace(/^mongodb:\/\/[^@]+@/, '').replace(/\/.*$/, '');
  const uri = (u, p, authDb, db = 'lokmago') => `mongodb://${u}:${p}@${host}/${db}?authSource=${authDb}&directConnection=true`;
  const root = new MongoClient(ROOT); await root.connect();
  const oplog = root.db('local').collection('oplog.rs');
  const snap = async () => ({
    opCount: await oplog.countDocuments({ ns: { $regex: '^lokmago\\.' } }),
    lastTs: (await oplog.find({}).sort({ $natural: -1 }).limit(1).toArray())[0]?.ts,
    hash: (await root.db('lokmago').command({ dbHash: 1 })).md5,
    colls: (await root.db('lokmago').listCollections().toArray()).map((c) => c.name).sort().join(','),
  });
  const dir = mkdtempSync(join(tmpdir(), 'audit-'));
  const run = (env, args = [], extraNode = []) => spawnSync(process.execPath, [...extraNode, SCRIPT, ...args], {
    env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', cwd: dir, timeout: 180000,
  });
  const nsWritesSince = async (ts) => (ts ? oplog.countDocuments({ ts: { $gt: ts }, ns: { $regex: '^lokmago\\.' } }) : -1);

  console.log('\n[C1] read-only (readAnyDatabase) foydalanuvchi bilan to‘liq audit');
  {
    const before = await snap();
    const out = join(dir, 'audit-ro.json');
    const r = run({ FINANCE_AUDIT_URI: uri('auditro', 'ropw', 'admin') }, [`--out=${out}`]);
    const after = await snap();
    ok(r.status === 0, `chiqish kodi 0 (${r.status})`, r.stderr.slice(0, 300));
    ok(await nsWritesSince(before.lastTs) === 0, 'oplog: lokmago.* uchun yangi yozuv 0 ta');
    ok(after.opCount === before.opCount, `oplog lokmago.* soni o‘zgarmadi (${before.opCount})`);
    ok(after.hash === before.hash, `dbHash o‘zgarmadi (${before.hash})`);
    ok(after.colls === before.colls, 'kolleksiyalar ro‘yxati o‘zgarmadi (yangi kolleksiya/indeks yo‘q)');
    ok(existsSync(out) && (statSync(out).mode & 0o777) === 0o600, 'JSON fayl saqlandi, huquq 0600');
    const j = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : {};
    const { ALLOWED_COMMANDS } = await import(SCRIPT);
    const sent = Object.keys(j.commandsSent || {});
    ok(sent.length > 0 && sent.every((c) => ALLOWED_COMMANDS.has(c)), `yuborilgan buyruqlar faqat ruxsat etilganlar: ${sent.join(', ')}`);
    ok(j.summary?.duplicateSettlements === 1 && j.summary?.balanceDrift >= 1 && j.summary?.overRefund === 1
      && j.summary?.multipleSuccessPerOrder === 1 && j.summary?.stuckPayouts === 1, `ataylab qo‘yilgan buzilishlar topildi: ${JSON.stringify(j.summary)}`);
    ok(String(j.topology).startsWith('replicaset:'), `topologiya: ${j.topology}`);
    ok(!/ropw/.test(readFileSync(out, 'utf8')) && !/ropw/.test(r.stdout), 'parol natijada yo‘q (URI yashirilgan)');
  }

  console.log('\n[C2] read@lokmago foydalanuvchisi (bitta bazaga o‘qish)');
  {
    const before = await snap();
    const r = run({ FINANCE_AUDIT_URI: uri('dbro', 'ropw', 'lokmago') }, ['--json']);
    ok(r.status === 0, `chiqish kodi 0 (${r.status})`, r.stderr.slice(0, 300));
    ok(await nsWritesSince(before.lastTs) === 0 && (await snap()).hash === before.hash, 'oplog va dbHash o‘zgarmadi');
  }

  console.log('\n[C3] readWrite foydalanuvchi — RAD');
  {
    const before = await snap();
    const r = run({ FINANCE_AUDIT_URI: uri('apprw', 'rwpw', 'lokmago') }, [`--out=${join(dir, 'rw.json')}`]);
    ok(r.status === 4, `chiqish kodi 4 (${r.status})`);
    ok(/O‘QISHDAN BOShQA huquqlar bor/.test(r.stderr) && /insert|update|remove/.test(r.stderr), 'sabab: yozish huquqlari ko‘rsatildi');
    ok(!existsSync(join(dir, 'rw.json')), 'natija fayli yaratilmadi');
    ok(await nsWritesSince(before.lastTs) === 0 && (await snap()).hash === before.hash, 'oplog va dbHash o‘zgarmadi');
  }

  console.log('\n[C4] root (anyAction) — RAD');
  {
    const r = run({ FINANCE_AUDIT_URI: ROOT.replace('/admin?', '/lokmago?authSource=admin&') });
    ok(r.status === 4, `chiqish kodi 4 (${r.status})`);
  }

  console.log('\n[C5] autentifikatsiyasiz / noto‘g‘ri sozlama — RAD');
  {
    let r = run({ FINANCE_AUDIT_URI: `mongodb://${host}/lokmago?directConnection=true` });
    ok(r.status === 4, `autentifikatsiyasiz → 4 (${r.status})`);
    r = run({});
    ok(r.status === 2, `FINANCE_AUDIT_URI yo‘q → 2 (${r.status})`);
    const same = uri('auditro', 'ropw', 'admin');
    r = run({ FINANCE_AUDIT_URI: same, MONGO_URI: same });
    ok(r.status === 4, `FINANCE_AUDIT_URI = MONGO_URI → 4 (${r.status})`);
    const exist = join(dir, 'bor.json'); writeFileSync(exist, 'ESKI');
    r = run({ FINANCE_AUDIT_URI: same }, [`--out=${exist}`]);
    ok(r.status === 2 && readFileSync(exist, 'utf8') === 'ESKI', `--out mavjud fayl → 2, fayl o‘zgarmadi (${r.status})`);
    r = run({ FINANCE_AUDIT_URI: same }, ['--from=2026/01/01']);
    ok(r.status === 2, `noto‘g‘ri sana → 2 (${r.status})`);
  }

  console.log('\n[C6] Skript ICHIGA yozuv kiritilsa ham (preload: ulangach insertOne) — buyruq ro‘yxati to‘xtatadi');
  {
    const before = await snap();
    const pre = join(dir, 'inject.mjs');
    const { createRequire } = await import('node:module');
    const { pathToFileURL } = await import('node:url');
    // Skript ishlatadigan AYNAN o'sha mongodb moduli (bir xil nusxa — prototipni o'zgartirish skriptga ta'sir qiladi)
    const mongoUrl = pathToFileURL(createRequire(SCRIPT).resolve('mongodb')).href;
    writeFileSync(pre, `
      import { MongoClient } from '${mongoUrl}';
      const orig = MongoClient.prototype.connect;
      MongoClient.prototype.connect = async function (...a) {
        const r = await orig.apply(this, a);
        await this.db('lokmago').collection('injected').insertOne({ x: 1 }).catch(() => {});
        return r;
      };`);
    // readWrite foydalanuvchi bilan — ya'ni baza yozuvga RUXSAT berardi; faqat skriptning buyruq qo'riqchisi to'xtatadi
    const r = run({ FINANCE_AUDIT_URI: uri('apprw', 'rwpw', 'lokmago') }, [], ['--import', pre]);
    ok(r.status === 3, `chiqish kodi 3 — ruxsat etilmagan buyruq (${r.status})`, r.stderr.slice(0, 300));
    ok(/Ruxsat etilmagan buyruq: "insert"/.test(r.stderr), 'sabab: "insert"');
    const n = await root.db('lokmago').collection('injected').countDocuments();
    ok(n === 0, `"injected" kolleksiyasida hujjat yo‘q (${n})`);
    ok(await nsWritesSince(before.lastTs) === 0 && (await snap()).hash === before.hash, 'oplog va dbHash o‘zgarmadi');
  }

  await root.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${fails ? `✗ ${fails} ta XATO` : '✓ HAMMASI O‘TDI'} (${passes} tekshiruv)`);
process.exit(fails ? 1 : 0);
