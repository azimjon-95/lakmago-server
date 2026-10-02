/**
 * Komissiya auditi — har restoran o'z kelishuvi foizida hisoblanayotganini tekshiradi.
 * FAQAT O'QIYDI: bazaga hech narsa yozmaydi.
 *
 *   node scripts/audit-commission.js                    # hammasi
 *   node scripts/audit-commission.js --since=2026-08-01  # shu sanadan keyingi buyurtmalar
 *   node scripts/audit-commission.js --json              # mashina o'qiydigan natija
 *
 * Mantiq: src/services/commissionAudit.js
 */
import mongoose from 'mongoose';
import { config } from '../src/config/index.js';
import { auditCommission, formatAudit } from '../src/services/commissionAudit.js';

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] || null;

async function main() {
  await mongoose.connect(config.mongoUri);
  const result = await auditCommission({ since: arg('since') });
  console.log(process.argv.includes('--json') ? JSON.stringify(result, null, 2) : formatAudit(result));
  await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
