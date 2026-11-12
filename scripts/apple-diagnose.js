/**
 * Sign in with Apple diagnostikasi — "nega Apple orqali kirib bo'lmayapti?".
 * Sukut bo'yicha FAQAT O'QIYDI: bazaga hech narsa yozmaydi.
 *
 *   node scripts/apple-diagnose.js                       # tekshiruv
 *   node scripts/apple-diagnose.js --fix-telegram-index  # telegramId indeksi sparse bo'lmasa — sparse qilib qayta yaratadi
 *
 * Tekshiradi: env (APPLE_SIGNIN_ENABLED, APPLE_CLIENT_IDS), Apple kalitlariga (JWKS) serverdan ulanish, server soati
 * (Apple tokeni iat bilan solishtiriladi), users.telegramId indeksi (unique, lekin sparse EMAS bo'lsa — Telegram ID'siz
 * ikkinchi foydalanuvchini yaratib bo'lmaydi), so'nggi challenge'lar va Apple identity'lar.
 */
import mongoose from 'mongoose';
import { config } from '../src/config/index.js';
import { getAppleConfig } from '../src/config/apple.js';

const ok = (m) => console.log(`  ✅ ${m}`);
const bad = (m) => console.log(`  ❌ ${m}`);
const warn = (m) => console.log(`  ⚠️  ${m}`);
const FIX = process.argv.includes('--fix-telegram-index');

async function main() {
  const cfg = getAppleConfig();
  console.log('\n1) Sozlamalar (env)');
  cfg.enabled ? ok('APPLE_SIGNIN_ENABLED=true') : bad('APPLE_SIGNIN_ENABLED true emas — tugma ko\'rinmaydi, endpointlar 404');
  console.log(`     APPLE_CLIENT_IDS = ${JSON.stringify(cfg.clientIds)}  (iOS ilova Bundle ID'si bilan BIR XIL bo'lishi shart: uz.lokmago.app)`);
  if (!cfg.clientIds.includes('uz.lokmago.app')) warn('ro\'yxatda uz.lokmago.app yo\'q — token audience mos kelmaydi (AUDIENCE_MISMATCH)');

  console.log('\n2) Apple kalitlari (JWKS) va server soati');
  try {
    const t0 = Date.now();
    const res = await fetch(cfg.jwksUrl, { signal: AbortSignal.timeout(8000) });
    const j = await res.json();
    const kids = (j.keys || []).map((k) => k.kid);
    res.ok && kids.length ? ok(`${cfg.jwksUrl} — ${kids.length} ta kalit (${Date.now() - t0} ms)`) : bad(`JWKS javobi g'alati: HTTP ${res.status}`);
    const appleDate = Date.parse(res.headers.get('date') || '');
    if (appleDate) {
      const skew = Math.round((Date.now() - appleDate) / 1000);
      Math.abs(skew) <= 60 ? ok(`server soati to'g'ri (Apple bilan farq ${skew} s)`) : bad(`server soati Apple'dan ${skew} s farq qiladi — tokenlar "eskirgan" deb rad etiladi (TOKEN_EXPIRED). NTP ni yoqing`);
    }
  } catch (e) { bad(`serverdan ${cfg.jwksUrl} ga ulanib bo'lmadi: ${e.message} — APPLE_KEYS_UNAVAILABLE (tarmoq/firewall)`); }

  console.log('\n3) Baza: users.telegramId indeksi');
  await mongoose.connect(config.mongoUri);
  const users = mongoose.connection.db.collection('users');
  const idx = (await users.indexes().catch(() => [])).find((i) => i.key && Object.keys(i.key).length === 1 && i.key.telegramId);   // kolleksiya yo'q bo'lsa — []
  const noTg = await users.countDocuments({ $or: [{ telegramId: { $exists: false } }, { telegramId: null }] });
  console.log(`     Telegram ID'siz foydalanuvchilar: ${noTg}`);
  let broken = false;
  if (!idx) warn('telegramId indeksi topilmadi');
  else if (idx.unique && !idx.sparse && !idx.partialFilterExpression) {
    broken = true;
    bad(`"${idx.name}" — unique, lekin SPARSE EMAS. Telegram ID'siz faqat BITTA foydalanuvchi bo'lishi mumkin → Apple bilan yangi hisob yaratib bo'lmaydi (USER_CREATE_DUPLICATE)`);
    console.log('     Sabab: loyihaning birinchi versiyasida telegramId required+unique edi; keyin sxema sparse qilingan, lekin MongoDB eski indeksni o\'zi o\'zgartirmaydi.');
  } else ok(`"${idx.name}" — unique=${Boolean(idx.unique)}, sparse=${Boolean(idx.sparse)} (to'g'ri)`);

  if (broken && FIX) {
    const dup = await users.aggregate([{ $match: { telegramId: { $type: 'string' } } }, { $group: { _id: '$telegramId', n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }, { $limit: 5 }]).toArray();
    if (dup.length) { bad(`telegramId takrorlari bor (${dup.map((d) => d._id).join(', ')}) — avval ularni hal qiling; indeks O'ZGARTIRILMADI`); }
    else {
      await users.dropIndex(idx.name);
      await users.createIndex({ telegramId: 1 }, { unique: true, sparse: true, name: idx.name });
      // Natijani TEKSHIRAMIZ (faqat "yaratildi" deb ishonmaymiz)
      const after = (await users.indexes()).find((i) => i.name === idx.name);
      if (after?.unique && after?.sparse) ok(`"${idx.name}" qayta yaratildi va tekshirildi: unique + sparse. Endi Apple bilan kirib ko'ring`);
      else bad(`"${idx.name}" qayta yaratildi, lekin baza sparse'ni saqlamadi (unique=${Boolean(after?.unique)}, sparse=${Boolean(after?.sparse)}). Bu MongoDB emas (masalan FerretDB)?`);
    }
  } else if (broken) console.log('     Tuzatish: node scripts/apple-diagnose.js --fix-telegram-index');

  console.log('\n4) So\'nggi Apple urinishlari (24 soat)');
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const ch = mongoose.connection.db.collection('appleauthchallenges');
  const total = await ch.countDocuments({ createdAt: { $gte: since } }).catch(() => 0);
  const used = await ch.countDocuments({ createdAt: { $gte: since }, usedAt: { $ne: null } }).catch(() => 0);
  const ids = await mongoose.connection.db.collection('authidentities').countDocuments({ provider: 'apple' }).catch(() => 0);
  console.log(`     challenge: ${total} ta (ishlatilgan: ${used}); Apple identity'lar jami: ${ids}`);
  if (total && !used) warn('challenge olingan, lekin kirish so\'rovi serverga yetmagan yoki boshqa sababda ishlatilmagan');
  if (used && !ids) warn('challenge ishlatilgan, lekin birorta Apple hisob yaratilmagan — server logida "[apple-auth] login:" qatorini qarang');

  console.log('\nServer logi: "[apple-auth]" qatorlarida har bir rad etishning aniq kodi va sababi yozilgan.\n');
  await mongoose.disconnect();
}

main().catch(async (e) => { console.error(e); await mongoose.disconnect().catch(() => {}); process.exit(1); });
