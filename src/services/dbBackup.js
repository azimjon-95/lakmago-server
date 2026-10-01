import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import mongoose from 'mongoose';
import { config } from '../config/index.js';
import { BackupRun } from '../models/BackupRun.js';
import { tgCall, tgUpload } from './telegramApi.js';
import { zoneDate, addDaysYmd } from './restaurantTime.js';

/*
 * ═══════════════════════════════════════════════════════════
 * BUTUN BAZANING KUNLIK JSON ZAXIRASI → TELEGRAM HISOBOT GURUHI
 * ═══════════════════════════════════════════════════════════
 *
 * Har kuni O'zbekiston vaqti bilan 23:59 da:
 *   1) BARCHA collection'lardan 100% to'liq nusxa (kunlik o'zgarish EMAS),
 *      bo'limlarga ajratilgan YAGONA JSON faylga jamlanadi;
 *   2) fayl BACKUP_GROUP_CHAT_ID guruhiga yuboriladi;
 *   3) yangi fayl MUVAFFAQIYATLI kelgach, 1 daqiqadan keyin eski zaxira
 *      fayl guruhdan o'chiriladi (spam va Telegram limitlari uchun).
 *
 * MUHIM SHART: yangi fayl kelmasa yoki xato bo'lsa — eski fayl O'CHIRILMAYDI.
 * Buni ikki qatlam ta'minlaydi: o'chirish jadvali FAQAT muvaffaqiyatli
 * yuborishdan keyin qo'yiladi, va o'chirish paytida yana bir bor "yangiroq
 * yuborilgan zaxira bormi" tekshiriladi.
 *
 * ─── FAYL TUZILISHI ───
 *   {
 *     "meta":        { app, createdAt, timezone, ymd, database, format },
 *     "collections": { "users": [ {...}, ... ], "orders": [ ... ], ... },
 *     "summary":     { "collections": { "users": 123, ... }, "totalDocuments": N }
 *   }
 * Hujjatlar MongoDB Extended JSON (relaxed): ObjectId → {"$oid":…},
 * sana → {"$date":…} — turlar yo'qolmaydi. Tiklash:
 *   const { EJSON } = mongoose.mongo.BSON;
 *   const data = EJSON.parse(fs.readFileSync(file, 'utf8'));
 *   await db.collection('users').insertMany(data.collections.users);
 *
 * ─── ISHONCHLILIK ───
 *  • Oqim bilan yoziladi (collection → kursor → disk): butun baza xotiraga
 *    yuklanmaydi.
 *  • Bir kun — bir zaxira (BackupRun.ymd UNIQUE): server qayta ishga tushsa
 *    yoki ikki nusxa ishlasa ham ikki marta yuborilmaydi.
 *  • Xato bo'lsa qayta uriniladi (2, 10, 30 daqiqadan keyin), oxirgisi ham
 *    yiqilsa — guruhga ogohlantirish (eski fayl saqlanadi).
 *  • Server 23:59 da o'chiq bo'lsa — keyingi kuni 00:00–01:00 orasida
 *    o'tkazib yuborilgan zaxira olinadi (catch-up).
 *  • Telegram bot fayl chegarasi 50 MB: JSON undan katta bo'lsa .json.gz
 *    (gzip) yuboriladi; shunda ham sig'masa — xato + ogohlantirish.
 *
 * ─── XAVFSIZLIK (o'qing!) ───
 * Zaxira BUTUN bazani o'z ichiga oladi: mijozlar telefon/manzillari, parol
 * xeshlari, shifrlangan rekvizitlar, PIN xeshlari, sessiya ma'lumotlari.
 * Telegram guruhiga tushgach uni guruh a'zolari VA Telegram serverlari
 * ko'radi. Guruh YOPIQ bo'lsin, faqat ishonchli shaxslar a'zo bo'lsin.
 */

const TZ = 'Asia/Tashkent';
const BACKUP_MINUTE = 23 * 60 + 59;                    // 23:59
const CATCHUP_UNTIL_MINUTE = 60;                        // 00:00–01:00
// Telegram 50 MB — 1 MB zaxira. BACKUP_FILE_LIMIT_BYTES — FAQAT testlar uchun (o'z Bot API serveri bo'lsa ham shu bilan oshiriladi)
const FILE_LIMIT = Number(process.env.BACKUP_FILE_LIMIT_BYTES) || 49 * 1024 * 1024;
const DELETE_DELAY_MS = 60_000;                         // yangi fayl kelgach 1 daqiqa
const LEASE_MS = 25 * 60_000;                           // "running" qotib qolsa
const RETRY_DELAYS_MS = [2 * 60_000, 10 * 60_000, 30 * 60_000]; // 4 urinish jami
const MAX_DELETE_ATTEMPTS = 5;

export const isBackupEnabled = () => Boolean(config.telegramBotToken && config.backupGroupChatId);

const tmpName = (ymd) => path.join(os.tmpdir(), `lokmago-backup-${ymd.replace(/[^\w-]/g, '_')}-${process.pid}.json`);
const mb = (b) => `${(b / 1024 / 1024).toFixed(b >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
const fmtDate = (ymd) => ymd.slice(0, 10).split('-').reverse().join('.');

/**
 * Butun bazani BITTA JSON faylga oqim bilan yozadi.
 * @returns {{ collections: Record<string,number>, documents: number, bytes: number }}
 */
export async function exportDatabaseToFile(filePath, { ymd, now = new Date() } = {}) {
  const { EJSON } = mongoose.mongo.BSON;
  const db = mongoose.connection.db;
  const all = await db.listCollections().toArray();
  const names = all
    .filter((c) => c.type !== 'view' && !c.name.startsWith('system.'))
    .map((c) => c.name)
    .sort();

  const ws = fs.createWriteStream(filePath, { encoding: 'utf8' });
  let streamError = null;
  ws.on('error', (e) => { streamError = e; });
  const write = async (chunk) => {
    if (streamError) throw streamError;
    if (!ws.write(chunk)) await once(ws, 'drain');
  };

  const meta = {
    app: 'lokmago',
    kind: 'full-database-backup',
    createdAt: now.toISOString(),
    timezone: TZ,
    ymd,
    database: db.databaseName,
    format: 'MongoDB Extended JSON (relaxed) — tiklash: mongoose.mongo.BSON.EJSON.parse()',
  };

  const counts = {};
  let documents = 0;
  await write(`{"meta":${JSON.stringify(meta)},"collections":{`);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    await write(`${i ? ',' : ''}${JSON.stringify(name)}:[`);
    let n = 0;
    const cursor = db.collection(name).find({}, { batchSize: 500 });
    for await (const doc of cursor) {
      await write(`${n ? ',' : ''}${EJSON.stringify(doc, { relaxed: true })}`);
      n++;
    }
    await write(']');
    counts[name] = n;
    documents += n;
  }
  await write(`},"summary":${JSON.stringify({ collections: counts, totalDocuments: documents })}}`);

  ws.end();
  await once(ws, 'finish');
  if (streamError) throw streamError;
  return { collections: counts, documents, bytes: fs.statSync(filePath).size };
}

async function toBlob(p) {
  return typeof fs.openAsBlob === 'function' ? fs.openAsBlob(p) : new Blob([await fs.promises.readFile(p)]);
}

class BackupTooLarge extends Error {
  constructor(bytes) { super(`Zaxira hajmi Telegram chegarasidan (50 MB) katta: ${mb(bytes)} (siqilgandan keyin ham)`); this.name = 'BackupTooLarge'; }
}

/** Faylni hisobot guruhiga yuboradi (kerak bo'lsa gzip). */
async function sendFile(jsonPath, { ymd, exp, durationMs }) {
  let sendPath = jsonPath;
  let gz = false;
  if (exp.bytes > FILE_LIMIT) {
    sendPath = `${jsonPath}.gz`;
    await pipeline(fs.createReadStream(jsonPath), zlib.createGzip({ level: 9 }), fs.createWriteStream(sendPath));
    gz = true;
  }
  const size = fs.statSync(sendPath).size;
  if (size > FILE_LIMIT) { fs.rmSync(sendPath, { force: true }); throw new BackupTooLarge(size); }

  const fileName = `lokmago-backup-${ymd.slice(0, 10)}${ymd.length > 10 ? `-${ymd.slice(11).replace(/[^\w]/g, '')}` : ''}.json${gz ? '.gz' : ''}`;
  const caption = `🗄 <b>Baza zaxirasi</b> · ${fmtDate(ymd)}\n`
    + `📦 ${Object.keys(exp.collections).length} collection · ${exp.documents.toLocaleString('ru-RU')} hujjat · ${mb(size)}${gz ? ' (gzip)' : ''}\n`
    + `⏱ ${(durationMs / 1000).toFixed(1)} s`;
  const msg = await tgUpload(
    'sendDocument',
    { chat_id: config.backupGroupChatId, caption, parse_mode: 'HTML', disable_notification: true },
    { field: 'document', blob: await toBlob(sendPath), filename: fileName },
  );
  return { messageId: msg.message_id, fileName, gz, sentBytes: size };
}

/** Bitta urinish: eksport → yuborish → holatni yozish. Xato tashlamaydi (holat BackupRun'da). */
async function attempt(run, now) {
  const started = Date.now();
  const file = tmpName(run.ymd);
  try {
    const exp = await exportDatabaseToFile(file, { ymd: run.ymd, now });
    const durationMs = Date.now() - started;
    const sent = await sendFile(file, { ymd: run.ymd, exp, durationMs });

    const sentAt = new Date(now.getTime());
    await BackupRun.updateOne({ _id: run._id }, {
      status: 'sent', error: '', nextAttemptAt: null, lockedUntil: null,
      chatId: String(config.backupGroupChatId), messageId: sent.messageId, fileName: sent.fileName, gzip: sent.gz,
      bytes: exp.bytes, sentBytes: sent.sentBytes, collections: Object.keys(exp.collections).length,
      documents: exp.documents, durationMs, sentAt,
    });

    /*
     * Eski zaxiralarni O'CHIRISH jadvali — FAQAT shu yerda, yangi fayl
     * muvaffaqiyatli kelgandan keyin. (Xato bo'lsa bu qator umuman
     * bajarilmaydi: eski fayl guruhda qoladi.)
     */
    await BackupRun.updateMany(
      { status: 'sent', deletedAt: null, _id: { $ne: run._id }, ymd: { $lt: run.ymd } },
      { $set: { deleteAt: new Date(sentAt.getTime() + DELETE_DELAY_MS) } },
    );
    return { ok: true, messageId: sent.messageId, documents: exp.documents };
  } catch (e) {
    const finalTry = run.attempts > RETRY_DELAYS_MS.length;
    await BackupRun.updateOne({ _id: run._id }, {
      status: 'failed',
      error: String(e.message || e).slice(0, 500),
      lockedUntil: null,
      nextAttemptAt: finalTry || e.name === 'BackupTooLarge' ? null : new Date(now.getTime() + RETRY_DELAYS_MS[run.attempts - 1]),
    });
    console.error(`[backup] ${run.ymd} urinish ${run.attempts} xato:`, e.message);
    if (finalTry || e.name === 'BackupTooLarge') await alertFailure(run.ymd, e.message);
    return { ok: false, error: e.message };
  } finally {
    fs.rmSync(file, { force: true });
    fs.rmSync(`${file}.gz`, { force: true });
  }
}

/** Guruhga ogohlantirish (eski fayl saqlanadi). Best-effort. */
async function alertFailure(ymd, reason) {
  try {
    await tgCall('sendMessage', {
      chat_id: config.backupGroupChatId,
      parse_mode: 'HTML',
      text: `⚠️ <b>Baza zaxirasi olinmadi</b> · ${fmtDate(ymd)}\nSabab: ${String(reason).replace(/</g, '&lt;').slice(0, 300)}\n\n<i>Oldingi zaxira fayli guruhdan O‘CHIRILMADI.</i>`,
    });
  } catch (e) {
    console.error('[backup] ogohlantirish yuborilmadi:', e.message);
  }
}

/** Kunni band qilish: birinchi bo'lgan yozuvni yaratadi; boshqasi allaqachon band qilgan bo'lsa null. */
async function claim(ymd, trigger, now) {
  try {
    return await BackupRun.create({
      ymd, trigger, status: 'running', attempts: 1, startedAt: now, lockedUntil: new Date(now.getTime() + LEASE_MS),
    });
  } catch (e) {
    if (e?.code === 11000) return null;
    throw e;
  }
}

/** Qayta urinish/qotib qolgan yozuvni atomik band qilish. */
async function reclaim(filter, now) {
  return BackupRun.findOneAndUpdate(
    filter,
    { $set: { status: 'running', lockedUntil: new Date(now.getTime() + LEASE_MS) }, $inc: { attempts: 1 } },
    { new: true },
  );
}

async function processDeletions(now) {
  const due = await BackupRun.find({ status: 'sent', deletedAt: null, deleteAt: { $ne: null, $lte: now } }).limit(20);
  let deleted = 0;
  for (const run of due) {
    // Ikkinchi himoya: yangiroq yuborilgan zaxira bo'lmasa ESKINI TEGMAYMIZ
    const newer = await BackupRun.exists({ status: 'sent', ymd: { $gt: run.ymd } });
    if (!newer) {
      await BackupRun.updateOne({ _id: run._id }, { deleteAt: null });
      continue;
    }
    try {
      await tgCall('deleteMessage', { chat_id: run.chatId, message_id: run.messageId });
      await BackupRun.updateOne({ _id: run._id }, { deletedAt: now, deleteError: '' });
      deleted++;
    } catch (e) {
      // Xabar allaqachon yo'q / 48 soatdan eski (bot o'chira olmaydi) — qayta urinishning foydasi yo'q
      const gone = /message to delete not found|message can't be deleted|MESSAGE_ID_INVALID/i.test(e.message);
      const attempts = run.deleteAttempts + 1;
      if (gone || attempts >= MAX_DELETE_ATTEMPTS) {
        await BackupRun.updateOne({ _id: run._id }, { deletedAt: now, deleteAttempts: attempts, deleteError: e.message.slice(0, 200) });
        if (!gone) console.error(`[backup] eski faylni o‘chirib bo‘lmadi (${run.ymd}):`, e.message);
      } else {
        await BackupRun.updateOne({ _id: run._id }, { deleteAttempts: attempts, deleteError: e.message.slice(0, 200), deleteAt: new Date(now.getTime() + 5 * 60_000) });
      }
    }
  }
  return deleted;
}

let ticking = false;

/**
 * Har 15 soniyada chaqiriladi. Vaqt (`now`) tashqaridan beriladi — testlarda
 * soatlab kutilmaydi.
 * @returns {{ started: string[], retried: string[], deleted: number }}
 */
export async function backupTick(now = new Date()) {
  const out = { started: [], retried: [], deleted: 0 };
  if (!isBackupEnabled() || ticking) return out;
  ticking = true;
  try {
    const { ymd, minutes } = zoneDate(TZ, now);

    // 1) Kunlik: 23:59
    if (minutes === BACKUP_MINUTE) {
      const run = await claim(ymd, 'schedule', now);
      if (run) { out.started.push(ymd); await attempt(run, now); }
    }

    // 2) Catch-up: kecha zaxira olinmagan (server 23:59 da o'chiq edi) — 00:00–01:00 orasida
    if (minutes < CATCHUP_UNTIL_MINUTE) {
      const yesterday = addDaysYmd(ymd, -1);
      const run = await claim(yesterday, 'catchup', now);
      if (run) { out.started.push(yesterday); await attempt(run, now); }
    }

    // 3) Qayta urinishlar va qotib qolgan ("running", lease tugagan) yozuvlar
    const retryable = await BackupRun.find({
      $or: [
        { status: 'failed', nextAttemptAt: { $ne: null, $lte: now } },
        { status: 'running', lockedUntil: { $lt: now } },
      ],
    }).limit(3);
    for (const r of retryable) {
      const run = await reclaim(
        { _id: r._id, status: r.status, ...(r.status === 'failed' ? { nextAttemptAt: r.nextAttemptAt } : { lockedUntil: r.lockedUntil }) },
        now,
      );
      if (run) { out.retried.push(run.ymd); await attempt(run, now); }
    }

    // 4) Eski fayllarni o'chirish (yangisi kelgandan 1 daqiqa keyin)
    out.deleted = await processDeletions(now);
  } finally {
    ticking = false;
  }
  return out;
}

/**
 * Qo'lda zaxira (skript/tekshiruv). Kunlik zaxirani BUZMAYDI: alohida kalit
 * ('YYYY-MM-DD+manual-HHMMSS'). Muvaffaqiyatli bo'lsa undan OLDINGI zaxiralar
 * odatdagidek 1 daqiqadan keyin o'chiriladi.
 */
export async function runBackupNow(now = new Date()) {
  if (!isBackupEnabled()) throw new Error('BACKUP_GROUP_CHAT_ID yoki TELEGRAM_BOT_TOKEN sozlanmagan');
  const { ymd } = zoneDate(TZ, now);
  const hms = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .format(now).replace(/:/g, '');
  const run = await claim(`${ymd}+manual-${hms}`, 'manual', now);
  if (!run) throw new Error('Bu soniyada zaxira allaqachon boshlangan');
  return { ymd: run.ymd, ...(await attempt(run, now)) };
}

/** Rejalashtiruvchi (index.js). BACKUP_GROUP_CHAT_ID bo'sh bo'lsa ishga tushmaydi. */
export function startBackupScheduler() {
  if (!isBackupEnabled()) return null;
  const run = () => backupTick().catch((e) => console.error('[backup] tick:', e.message));
  setTimeout(run, 20_000).unref?.();
  const t = setInterval(run, 15_000);
  t.unref?.();
  console.log(`✓ Kunlik baza zaxirasi: har kuni 23:59 (Toshkent) → guruh ${config.backupGroupChatId}`);
  return t;
}
