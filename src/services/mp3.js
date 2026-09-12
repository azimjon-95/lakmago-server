/*
 * ═══════════════════════════════════════════════════════════
 * MP3 — TEG TOZALASH, DAVOMIYLIK, TAKRORLASH
 * ═══════════════════════════════════════════════════════════
 *
 * Signal ovozini N marta ketma-ket chaladigan BITTA fayl kerak.
 * Uni ffmpeg bilan qilish mumkin edi, lekin ishlab chiqarish
 * obrazi `node:22-alpine` — unda ffmpeg YO'Q va uni qo'shish
 * obrazni ~100 MB ga shishiradi. MP3 esa mustaqil kadrlardan
 * (frame) iborat: teglarni olib tashlab, kadrlarni ketma-ket
 * ulash yetarli — barcha pleyerlar buni muammosiz chaladi.
 *
 * Nozik jihatlar (shu sababli "shunchaki Buffer.concat" emas):
 *   • ID3v2 teg fayl BOSHIDA — nusxalarda u audio o'rtasida
 *     qolib, ba'zi pleyerlarda shitirlash beradi;
 *   • ID3v1 teg — oxirgi 128 bayt ("TAG");
 *   • Xing/Info kadri — VBR ma'lumoti. U birinchi nusxada
 *     qoladi (davomiylik to'g'ri ko'rinsin), nusxalarda
 *     olib tashlanadi, aks holda pleyer uni yangi faylning
 *     boshi deb o'ylab, davomiylikni noto'g'ri ko'rsatadi.
 *
 * Fayl buzuq yoki MP3 emas bo'lsa — xato TASHLANADI, chaqiruvchi
 * tomon uni ushlab, signalsiz davom etadi (buyurtma oqimi
 * hech qachon to'xtamaydi).
 */

const BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const SAMPLE_RATES = {
  3: [44100, 48000, 32000],   // MPEG-1
  2: [22050, 24000, 16000],   // MPEG-2
  0: [11025, 12000, 8000],    // MPEG-2.5
};

/** ID3v2 (bosh) va ID3v1 (oxir) teglarini kesib tashlaydi. */
function stripTags(buf) {
  let start = 0;
  let end = buf.length;

  // ID3v2: "ID3" + versiya(2) + bayroq(1) + hajm(4, syncsafe)
  while (end - start >= 10 && buf[start] === 0x49 && buf[start + 1] === 0x44 && buf[start + 2] === 0x33) {
    const size = ((buf[start + 6] & 0x7f) << 21)
      | ((buf[start + 7] & 0x7f) << 14)
      | ((buf[start + 8] & 0x7f) << 7)
      | (buf[start + 9] & 0x7f);
    const footer = (buf[start + 5] & 0x10) ? 10 : 0;   // ID3v2.4 footer
    const next = start + 10 + size + footer;
    if (next <= start || next > end) break;            // buzuq teg — to'xtaymiz
    start = next;
  }

  // ID3v1: oxirgi 128 bayt "TAG" bilan boshlanadi
  if (end - start >= 128 && buf.toString('latin1', end - 128, end - 125) === 'TAG') {
    end -= 128;
  }

  return buf.subarray(start, end);
}

/** Kadr sarlavhasini o'qish. Yaroqsiz bo'lsa null. */
function frameHeader(buf, i) {
  if (i + 4 > buf.length) return null;
  if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) return null;

  const versionBits = (buf[i + 1] >> 3) & 0x03;        // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
  const layerBits = (buf[i + 1] >> 1) & 0x03;          // 1 = Layer III
  if (versionBits === 1 || layerBits === 0) return null;

  const bitrateIdx = (buf[i + 2] >> 4) & 0x0f;
  const rateIdx = (buf[i + 2] >> 2) & 0x03;
  if (bitrateIdx === 0 || bitrateIdx === 15 || rateIdx === 3) return null;

  const sampleRate = SAMPLE_RATES[versionBits]?.[rateIdx];
  if (!sampleRate) return null;

  const isV1 = versionBits === 3;
  const kbps = (isV1 ? BITRATES_V1_L3 : BITRATES_V2_L3)[bitrateIdx];
  if (!kbps) return null;

  const padding = (buf[i + 2] >> 1) & 0x01;
  // Layer III: MPEG-1 da 1152, MPEG-2/2.5 da 576 namuna
  const samples = isV1 ? 1152 : 576;
  const length = Math.floor((samples / 8) * kbps * 1000 / sampleRate) + padding;
  if (length < 4) return null;

  return { length, samples, sampleRate, isV1 };
}

/** Kadr Xing/Info (VBR ma'lumoti) — tovushsiz xizmat kadri. */
function isXingFrame(buf, offset, header) {
  const channelMode = (buf[offset + 3] >> 6) & 0x03;
  const mono = channelMode === 3;
  // Yon ma'lumot (side info) hajmi versiya va kanalga bog'liq
  const sideInfo = header.isV1 ? (mono ? 17 : 32) : (mono ? 9 : 17);
  const at = offset + 4 + sideInfo;
  if (at + 4 > buf.length) return false;
  const tag = buf.toString('latin1', at, at + 4);
  return tag === 'Xing' || tag === 'Info';
}

/**
 * MP3 ni kadrlarga ajratadi.
 * @returns {{ audio: Buffer, body: Buffer, durationMs: number }}
 *   audio — Xing'siz sof audio (nusxalar uchun)
 *   body  — teglarsiz, lekin Xing bilan (birinchi nusxa uchun)
 */
export function parseMp3(buffer) {
  const body = stripTags(buffer);

  let i = 0;
  let firstFrame = -1;
  // Birinchi yaroqli kadrni qidiramiz (oldida axlat bo'lishi mumkin)
  while (i < body.length - 4) {
    const h = frameHeader(body, i);
    // Ikkinchi kadr ham joyida bo'lsa — bu haqiqiy audio boshlanishi
    if (h && (i + h.length >= body.length - 4 || frameHeader(body, i + h.length))) {
      firstFrame = i;
      break;
    }
    i += 1;
  }
  if (firstFrame < 0) throw new Error('MP3 kadrlari topilmadi (fayl buzuq yoki MP3 emas)');

  let offset = firstFrame;
  let audioStart = firstFrame;
  let durationMs = 0;
  let frames = 0;

  while (offset < body.length - 4) {
    const h = frameHeader(body, offset);
    if (!h) break;                                     // oxiridagi axlat — to'xtaymiz
    if (frames === 0 && isXingFrame(body, offset, h)) {
      // Xizmat kadri: davomiylikka qo'shilmaydi, nusxalarga tushmaydi
      audioStart = offset + h.length;
    } else {
      durationMs += (h.samples / h.sampleRate) * 1000;
      frames += 1;
    }
    offset += h.length;
  }

  if (!frames) throw new Error('MP3 da audio kadrlar yo‘q');

  return {
    body: body.subarray(firstFrame, offset),
    audio: body.subarray(audioStart, offset),
    durationMs: Math.round(durationMs),
  };
}

/**
 * Signalni `times` marta ketma-ket chaladigan bitta MP3 quradi.
 * @returns {{ buffer: Buffer, durationSec: number }}
 */
export function repeatMp3(buffer, times = 3) {
  const count = Math.max(1, Math.min(Number(times) || 1, 10));
  const { body, audio, durationMs } = parseMp3(buffer);

  const parts = [body];
  for (let i = 1; i < count; i += 1) parts.push(audio);

  return {
    buffer: Buffer.concat(parts),
    durationSec: Math.max(1, Math.round((durationMs * count) / 1000)),
  };
}
