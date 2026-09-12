import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BotSignalLog } from '../models/BotSignalLog.js';
import { BotAsset } from '../models/BotAsset.js';
import { repeatMp3 } from './mp3.js';
import { isRestaurantBotEnabled, tgCall, tgUpload } from './restaurantBotApi.js';

/*
 * ═══════════════════════════════════════════════════════════
 * OVOZLI SIGNAL — YANGI BUYURTMA VA BRON
 * ═══════════════════════════════════════════════════════════
 *
 * Buyurtma/bron kartasidan keyin xodimga ovozli xabar keladi.
 * Ichida signal KETMA-KET 3 MARTA chalinadi (bitta faylga
 * ulangan — mp3.js), tugagach o'zi to'xtaydi.
 *
 * ─── FAYLLAR ───
 *   sounds/order.mp3        — yangi BUYURTMA
 *   sounds/reservation.mp3  — yangi BRON
 * Papkani SOUNDS_DIR bilan o'zgartirish mumkin. Fayl bo'lmasa
 * yoki buzuq bo'lsa — signal o'tkazib yuboriladi, buyurtma
 * oqimi HECH QACHON to'xtamaydi (faqat logga bir marta yoziladi).
 *
 * ─── TAKRORLANMASLIK ───
 * Har (buyurtma, xodim) juftligi bazada "band qilinadi"
 * (BotSignalLog, unique indeks). Shu sababli signal qayta
 * ketmaydi: server restart bo'lsa ham, notifyNewOrder ikkinchi
 * marta chaqirilsa ham (masalan karta to'lovi tasdiqlangach),
 * bir nechta server nusxasi bo'lsa ham.
 *
 * ─── NEGA "VOICE" ───
 * Ovozli xabar (sendVoice) iOS va Android'da bir tegishda
 * chaladi va Telegram ketma-ket ovozli xabarlarni avtomatik
 * davom ettiradi. Premium foydalanuvchi ovozli xabarlarni
 * taqiqlab qo'ygan bo'lsa — avtomatik musiqa (sendAudio)
 * ko'rinishida yuboriladi.
 *
 * MUHIM VA HALOL CHEKLOV: Telegram'da HECH BIR bot chatdagi
 * ovozni O'ZI chaldira olmaydi — bu platforma cheklovi. Telefon
 * jiringlashi Telegram'ning bildirishnoma ovozi orqali bo'ladi.
 * Shuning uchun signal xabari bildirishnoma bilan yuboriladi:
 * xodim ovozni eshitadi va bir tegishda signalni to'liq chaladi.
 * Eng baland ogohlantirish uchun: Telegram → shu bot chati →
 * Bildirishnomalar → ohangni tanlash (iOS va Android'da bor).
 */

const REPEATS = 3;

const SOUNDS = {
  order: 'order.mp3',
  reservation: 'reservation.mp3',
};

const CAPTION = {
  order: '🔔 Yangi buyurtma signali',
  reservation: '🔔 Yangi bron signali',
};

const here = path.dirname(fileURLToPath(import.meta.url));
const SOUNDS_DIR = process.env.SOUNDS_DIR
  ? path.resolve(process.env.SOUNDS_DIR)
  : path.resolve(here, '../../sounds');

/*
 * Xotira keshi: fayl bir marta o'qilib, bir marta 3x ga ulanadi.
 * Qiymat — Promise: bir vaqtda kelgan ikki buyurtma faylni ikki
 * marta o'qimasin (ikkalasi ham bitta tayyorlashni kutadi).
 */
const prepared = new Map();      // kind → Promise<{ buffer, durationSec, hash } | null>
const warned = new Set();        // bir xil ogohlantirish log'ni to'ldirmasin

function warnOnce(key, message) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

/**
 * Signal faylini o'qib, 3 marta takrorlangan nusxasini tayyorlaydi.
 * Natija xotirada keshlanadi. Fayl yo'q/buzuq bo'lsa — null.
 */
function prepare(kind) {
  if (!prepared.has(kind)) prepared.set(kind, readAndRepeat(kind));
  return prepared.get(kind);
}

async function readAndRepeat(kind) {
  const file = path.join(SOUNDS_DIR, SOUNDS[kind]);
  let result = null;
  try {
    const raw = await fs.readFile(file);
    const { buffer, durationSec } = repeatMp3(raw, REPEATS);
    result = {
      buffer,
      durationSec,
      hash: crypto.createHash('sha1').update(raw).digest('hex'),
    };
    console.log(`[signal] ${kind}: ${SOUNDS[kind]} tayyor — ${REPEATS}× (${durationSec}s)`);
  } catch (e) {
    warnOnce(
      `file:${kind}`,
      e.code === 'ENOENT'
        ? `[signal] ${file} topilmadi — "${kind}" uchun ovozli signal yuborilmaydi`
        : `[signal] ${file} o‘qilmadi: ${e.message}`,
    );
  }

  return result;
}

/*
 * file_id keshi ikki qavatli:
 *   1) xotira — eng tez, va baza yozuvi muvaffaqiyatsiz bo'lsa ham
 *      shu jarayon faylni qayta yuklamaydi;
 *   2) baza — restartdan keyin ham saqlanadi, barcha nusxalar uchun umumiy.
 * Ikkalasi ham hash bilan tekshiriladi: ovoz fayli almashtirilsa
 * kesh o'zi bekor bo'ladi.
 */
const memFileId = new Map();     // kind → { hash, fileId }

async function cachedFileId(kind, hash) {
  const mem = memFileId.get(kind);
  if (mem && mem.hash === hash) return mem.fileId;

  const doc = await BotAsset.findOne({ key: `signal:${kind}` }).lean().catch(() => null);
  if (doc && doc.hash === hash) {
    memFileId.set(kind, { hash, fileId: doc.fileId });
    return doc.fileId;
  }
  return null;
}

async function rememberFileId(kind, hash, fileId) {
  if (!fileId) return;
  memFileId.set(kind, { hash, fileId });
  await BotAsset.updateOne(
    { key: `signal:${kind}` },
    { $set: { fileId, hash, updatedAt: new Date() } },
    { upsert: true },
  ).catch(() => {});
}

/** Eskirgan file_id — keshdan chiqariladi, keyingi yuborish yuklaydi. */
function forgetFileId(kind) {
  memFileId.delete(kind);
  return BotAsset.deleteOne({ key: `signal:${kind}` }).catch(() => {});
}

/*
 * Yuklash NAVBATI.
 *
 * Xodimlarga signal parallel yuboriladi. Kesh hali bo'sh bo'lsa
 * (birinchi buyurtma yoki ovoz almashtirilgan), hammasi bir
 * vaqtda "file_id yo'q" deb ko'rib, faylni BARAVARIGA yuklab
 * yuborardi — 5 xodimda 5 ta ortiqcha yuklash.
 *
 * Endi birinchi yuborish yuklaydi, qolganlari uning natijasini
 * (file_id) kutadi va tayyor identifikator bilan ketadi.
 */
const inFlight = new Map();      // kind → Promise<string|null>

/** Ovozli xabar yuborishga urinish; muvaffaqiyatsiz bo'lsa null. */
async function deliver({ chatId, kind, signal, fileId }) {
  const base = {
    chat_id: chatId,
    duration: signal.durationSec,
    caption: CAPTION[kind],
    // Bildirishnoma ATAYLAB yoqilgan — telefon jiringlashi shundan
    disable_notification: false,
  };

  /*
   * 1) Keshdagi file_id bilan (tez yo'l).
   * file_id eskirgan bo'lsa Telegram xato beradi — pastda
   * qayta yuklanadi va kesh yangilanadi.
   */
  if (fileId) {
    const res = await tgCall('sendVoice', { ...base, voice: fileId });
    if (res?.ok) return res;
    const res2 = await tgCall('sendAudio', { ...base, audio: fileId, title: CAPTION[kind] });
    if (res2?.ok) return res2;
    // Ikkalasi ham rad etdi — file_id eskirgan, keshni tozalaymiz
    await forgetFileId(kind);
  }

  /* 2) Yuklash: ovozli xabar sifatida. */
  const file = {
    field: 'voice',
    filename: SOUNDS[kind],
    buffer: signal.buffer,
    contentType: 'audio/mpeg',
  };
  const up = await tgUpload('sendVoice', base, file);
  if (up?.ok) {
    await rememberFileId(kind, signal.hash, up.result?.voice?.file_id);
    return up;
  }

  /*
   * 3) Zaxira: ba'zi foydalanuvchilar (Telegram Premium sozlamasi)
   * ovozli xabarlarni taqiqlab qo'yadi — o'shanda oddiy audio.
   */
  const up2 = await tgUpload('sendAudio', { ...base, title: CAPTION[kind] }, { ...file, field: 'audio' });
  if (up2?.ok) {
    await rememberFileId(kind, signal.hash, up2.result?.audio?.file_id);
    return up2;
  }

  return null;
}

/**
 * Signalni xodimlarga yuboradi — HAR BIRIGA BIR MARTA.
 *
 * @param {'order'|'reservation'} kind
 * @param {string} refId   buyurtma yoki bron _id si
 * @param {Array}  staff   [{ telegramUserId }]
 */
export async function sendSignal(kind, refId, staff) {
  if (!isRestaurantBotEnabled() || !SOUNDS[kind] || !refId) return;
  const chats = (staff || []).map((s) => String(s.telegramUserId)).filter(Boolean);
  if (!chats.length) return;

  const signal = await prepare(kind);
  if (!signal) return;                       // fayl yo'q — jim o'tamiz

  /*
   * ATOMIK BAND QILISH: yozuv yaratilsa — signalni shu jarayon
   * yuboradi. Dublikat (11000) bo'lsa, demak allaqachon
   * yuborilgan (yoki boshqa nusxa hozir yubormoqda).
   */
  const claim = async (chatId) => {
    try {
      await BotSignalLog.create({ refId: String(refId), kind, telegramUserId: chatId });
      return true;
    } catch (e) {
      if (e?.code !== 11000) console.error('[signal] band qilish xatosi:', e.message);
      return false;
    }
  };

  /*
   * Yuborilmadi (tarmoq, bot bloklangan ...) — bandlikni BEKOR
   * QILAMIZ, shunda keyingi urinishda signal yetib borishi
   * mumkin. Muvaffaqiyatli yozuv esa qoladi va takrorlanmaydi.
   */
  const release = (chatId) => BotSignalLog
    .deleteOne({ refId: String(refId), kind, telegramUserId: chatId })
    .catch(() => {});

  const sendTo = async (chatId, fileId) => {
    if (!await claim(chatId)) return null;
    const res = await deliver({ chatId, kind, signal, fileId });
    if (!res) {
      await release(chatId);
      return null;
    }
    return res;
  };

  let fileId = await cachedFileId(kind, signal.hash);

  /*
   * Kesh bo'sh: birinchi xodimga yuborish faylni yuklaydi va
   * file_id ni keshga yozadi. Boshqa buyurtma shu payt kelsa,
   * u ham shu yagona yuklashni kutadi (inFlight).
   */
  if (!fileId) {
    if (inFlight.has(kind)) {
      fileId = await inFlight.get(kind);
    } else {
      /*
       * Birinchi MUVAFFAQIYATLI yuborish faylni yuklaydi va keshni
       * to'ldiradi. Ro'yxat boshidagi xodim signalni allaqachon
       * olgan bo'lishi mumkin (masalan yangi xodim keyin qo'shilgan,
       * yoki ovoz almashtirilgan) — o'shanda hech narsa yuklanmaydi,
       * shuning uchun keshni to'ldirmaguncha KETMA-KET davom etamiz.
       * Aks holda qolgan xodimlarning HAR BIRI faylni qaytadan
       * yuklardi (5 xodimda ~0.5 MB ortiqcha trafik).
       */
      const task = (async () => {
        while (chats.length) {
          const chatId = chats.shift();
          await sendTo(chatId, null);
          const ready = await cachedFileId(kind, signal.hash);
          if (ready) return ready;
        }
        return null;
      })();
      inFlight.set(kind, task);
      try {
        fileId = await task;
      } finally {
        inFlight.delete(kind);
      }
    }
  }

  await Promise.all(chats.map((chatId) => sendTo(chatId, fileId)));
}

/**
 * Server ishga tushganda fayllarni oldindan tekshirish:
 * bor-yo'qligi darhol logda ko'rinadi va birinchi buyurtma
 * kechikmaydi (fayl allaqachon tayyor).
 */
export async function warmUpSignals() {
  if (!isRestaurantBotEnabled()) return;
  const results = await Promise.all(Object.keys(SOUNDS).map(prepare));
  if (results.every((r) => !r)) {
    console.warn(`[signal] Ovoz fayllari topilmadi: ${SOUNDS_DIR} (order.mp3, reservation.mp3)`);
  }
}
