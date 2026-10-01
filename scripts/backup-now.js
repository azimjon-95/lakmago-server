/**
 * Bazaning JSON zaxirasini QO'LDA olish (tekshirish / favqulodda holat).
 *
 *   node scripts/backup-now.js                 # to'liq zaxira → hisobot guruhiga (BACKUP_GROUP_CHAT_ID)
 *   node scripts/backup-now.js --file zaxira.json   # faqat diskka, Telegram'siz (tekshirish uchun)
 *
 * Guruhga yuborilsa, undan OLDINGI zaxiralar odatdagidek 1 daqiqadan keyin
 * o'chiriladi — buning uchun server ishlab turishi kerak (o'chirishni u bajaradi).
 */
import mongoose from 'mongoose';
import { config } from '../src/config/index.js';
import { exportDatabaseToFile, runBackupNow } from '../src/services/dbBackup.js';
import { zoneDate } from '../src/services/restaurantTime.js';

const fileArg = process.argv.indexOf('--file');

async function main() {
  await mongoose.connect(config.mongoUri);
  if (fileArg !== -1) {
    const out = process.argv[fileArg + 1] || 'lokmago-backup.json';
    const r = await exportDatabaseToFile(out, { ymd: zoneDate('Asia/Tashkent', new Date()).ymd });
    console.log(`✓ ${out}: ${Object.keys(r.collections).length} collection, ${r.documents} hujjat, ${(r.bytes / 1024 / 1024).toFixed(1)} MB`);
  } else {
    const r = await runBackupNow();
    console.log(r.ok ? `✓ Yuborildi (${r.ymd}): ${r.documents} hujjat, xabar ${r.messageId}` : `✗ Xato: ${r.error}`);
    if (!r.ok) process.exitCode = 1;
  }
  await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
