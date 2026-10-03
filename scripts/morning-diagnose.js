/**
 * Ertalabki tekshiruv diagnostikasi — "nega bu restoranga xabar ketmadi?".
 * FAQAT O'QIYDI: bazaga hech narsa yozmaydi, Telegram'ga hech narsa yubormaydi.
 *
 *   node scripts/morning-diagnose.js                  # faol restoranlar: holat va sabab
 *   node scripts/morning-diagnose.js --name=ziynat    # nom bo'yicha
 *   node scripts/morning-diagnose.js --all            # nofaol/bloklanganlarni ham
 *   node scripts/morning-diagnose.js --json
 *
 * Mantiq: src/services/morningChecklist.js (explainMorning, diagnoseMorning)
 */
import mongoose from 'mongoose';
import { config } from '../src/config/index.js';
import { diagnoseMorning } from '../src/services/morningChecklist.js';

const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1] || null;
const ICON = { blocked: '⛔', waiting: '⏳', 'in-window': '🟢', missed: '⚠️ ', sent: '📨', answered: '✅' };
const LABEL = { blocked: 'TO‘SIQ', waiting: 'kutmoqda', 'in-window': 'hozir ketadi', missed: 'O‘TIB KETGAN', sent: 'yuborilgan', answered: 'javob berilgan' };

async function main() {
  await mongoose.connect(config.mongoUri);
  const res = await diagnoseMorning({ name: arg('name'), all: process.argv.includes('--all') });
  if (process.argv.includes('--json')) { console.log(JSON.stringify(res, null, 2)); await mongoose.disconnect(); return; }

  console.log(`\nVaqt: ${res.now}   Bot token: ${res.botEnabled ? '✅ bor' : '❌ YO‘Q (RESTAURANT_BOT_TOKEN)'}   Restoranlar: ${res.rows.length}\n`);
  const count = {};
  for (const r of res.rows) {
    count[r.state] = (count[r.state] || 0) + 1;
    console.log(`${ICON[r.state] || ' '} ${r.name}  [${r.openTime}–${r.closeTime}, xodim: ${r.staff}, sana: ${r.date}]  → ${LABEL[r.state]}`);
    if (r.detail) console.log(`     ${r.detail}`);
    for (const b of r.blockers) console.log(`     ✗ ${b.code}: ${b.text}`);
  }
  console.log(`\nJami: ${Object.entries(count).map(([k, v]) => `${LABEL[k]}=${v}`).join(', ')}`);
  const codes = {};
  for (const r of res.rows) for (const b of r.blockers) codes[b.code] = (codes[b.code] || 0) + 1;
  if (Object.keys(codes).length) console.log(`To‘siqlar: ${Object.entries(codes).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
