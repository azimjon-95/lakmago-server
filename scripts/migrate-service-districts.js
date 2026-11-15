/**
 * Eski restoranlarga katalog hududini (serviceDistrictId, serviceAreaDistrictIds) koordinatadan to'ldirish.
 * KURYER TUMANI (`district`) GA TEGMAYDI.
 *
 *   node scripts/migrate-service-districts.js                    # DRY-RUN (standart): faqat hisobot, bazaga yozmaydi
 *   node scripts/migrate-service-districts.js --apply            # yozadi (avval backups/ ga zaxira oladi)
 *   node scripts/migrate-service-districts.js --apply --batch=50 --limit=200
 *   node scripts/migrate-service-districts.js --rollback=backups/service-districts-<vaqt>.json
 *
 * Talab: DISTRICT_BOUNDARIES_ENABLED=true (aks holda resolver o'chiq — skript to'xtaydi).
 * Koordinatasi yo'q / qamrovdan tashqari / chegarada noaniq restoranlar — "ko'rib chiqish" ro'yxatiga chiqadi,
 * ularga tuman YOZILMAYDI (hech qachon "pop" deb taxmin qilinmaydi). Admin qo'lda override qiladi (sabab bilan).
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import mongoose from 'mongoose';
import { config } from '../src/config/index.js';
import { Restaurant } from '../src/models/Restaurant.js';
import { loadBoundaries } from '../src/services/districtResolver.js';
import { computeServiceDistrict, toMongoUpdate, districtFeatureOn } from '../src/services/restaurantDistrict.js';
import { districtLabel } from '../src/constants/districts.js';

const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=') || null;
const APPLY = process.argv.includes('--apply');
const ROLLBACK = arg('rollback');
const BATCH = Math.min(Math.max(Number(arg('batch')) || 100, 1), 500);
const LIMIT = Number(arg('limit')) || 0;
const FIELDS = 'name lat lng isActive isApproved district serviceDistrictId serviceAreaDistrictIds districtBoundaryVersion districtResolvedAt districtResolveReason serviceDistrictOverride';

async function rollback(file) {
  const rows = JSON.parse(readFileSync(file, 'utf8')).rows;
  let n = 0;
  for (const r of rows) {
    const set = {}; const unset = {};
    for (const k of ['serviceDistrictId', 'serviceAreaDistrictIds', 'districtBoundaryVersion', 'districtResolvedAt', 'districtResolveReason']) {
      if (r.before[k] === undefined) unset[k] = 1; else set[k] = r.before[k];
    }
    await Restaurant.updateOne({ _id: r._id }, { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) });
    n += 1;
  }
  console.log(`Orqaga qaytarildi: ${n} ta restoran (${file}). districtAudit tarixiga tegilmadi.`);
}

async function main() {
  await mongoose.connect(config.mongoUri);
  if (ROLLBACK) { await rollback(ROLLBACK); await mongoose.disconnect(); return; }
  loadBoundaries();
  if (!districtFeatureOn()) {
    console.error('Resolver o‘chiq: DISTRICT_BOUNDARIES_ENABLED=true va chegara fayli kerak.');
    await mongoose.disconnect(); process.exit(2);
  }
  const total = await Restaurant.countDocuments({});
  const report = { mode: APPLY ? 'APPLY' : 'DRY-RUN', total, scanned: 0, willChange: 0, unchanged: 0, byDistrict: {}, review: [], courierDistrictMismatch: [] };
  const backup = [];
  let lastId = null;
  while (true) {
    const q = lastId ? { _id: { $gt: lastId } } : {};
    const batch = await Restaurant.find(q).select(FIELDS).sort({ _id: 1 }).limit(BATCH).lean();
    if (!batch.length) break;
    for (const r of batch) {
      if (LIMIT && report.scanned >= LIMIT) break;
      report.scanned += 1;
      const res = computeServiceDistrict(r, { by: 'migration', action: 'migrate' });
      const id = res.set.serviceDistrictId;
      if (id) report.byDistrict[id] = (report.byDistrict[id] || 0) + 1;
      else report.review.push({ _id: String(r._id), name: r.name, reason: res.set.districtResolveReason, live: !!(r.isActive && r.isApproved) });
      // Ma'lumot uchun: kuryer tumani bilan farq (kuryer tumani O'ZGARTIRILMAYDI)
      if (id && r.district && r.district !== id) report.courierDistrictMismatch.push({ _id: String(r._id), name: r.name, courierDistrict: r.district, serviceDistrictId: id });
      if (!res.changed) { report.unchanged += 1; continue; }
      report.willChange += 1;
      if (APPLY) {
        backup.push({ _id: String(r._id), before: {
          serviceDistrictId: r.serviceDistrictId, serviceAreaDistrictIds: r.serviceAreaDistrictIds, districtBoundaryVersion: r.districtBoundaryVersion,
          districtResolvedAt: r.districtResolvedAt, districtResolveReason: r.districtResolveReason,
        } });
      }
    }
    lastId = batch[batch.length - 1]._id;
    if (LIMIT && report.scanned >= LIMIT) break;
  }

  if (APPLY && backup.length) {
    mkdirSync('backups', { recursive: true });
    const file = `backups/service-districts-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    writeFileSync(file, JSON.stringify({ createdAt: new Date(), rows: backup }, null, 2));
    console.log(`Zaxira: ${file} (orqaga qaytarish: --rollback=${file})`);
    let done = 0;
    for (const b of backup) {
      const r = await Restaurant.findById(b._id).select(FIELDS).lean();
      const u = toMongoUpdate(computeServiceDistrict(r, { by: 'migration', action: 'migrate' }));
      if (u) await Restaurant.updateOne({ _id: b._id }, u);
      done += 1;
      if (done % BATCH === 0) console.log(`  … ${done}/${backup.length}`);
    }
  }

  console.log(`\n${report.mode}: ${report.scanned}/${report.total} restoran ko'rildi · o'zgaradi: ${report.willChange} · o'zgarmaydi: ${report.unchanged}`);
  console.log('Tumanlar bo\'yicha:', Object.entries(report.byDistrict).map(([k, v]) => `${districtLabel(k)}: ${v}`).join(', ') || '—');
  console.log(`\nKO'RIB CHIQISH KERAK (tuman yozilmaydi): ${report.review.length}`);
  for (const r of report.review) console.log(`  • ${r.name} (${r._id}) — ${r.reason}${r.live ? ' — HOZIR FAOL' : ''}`);
  if (report.courierDistrictMismatch.length) {
    console.log(`\nMa'lumot: kuryer tumani koordinatadan farq qiladi (kuryer tumani o'zgartirilmaydi): ${report.courierDistrictMismatch.length}`);
    for (const r of report.courierDistrictMismatch.slice(0, 30)) console.log(`  • ${r.name}: kuryer=${r.courierDistrict}, koordinata=${r.serviceDistrictId}`);
  }
  if (!APPLY) console.log('\nBu DRY-RUN edi — bazaga hech narsa yozilmadi. Yozish uchun: --apply');
  await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
