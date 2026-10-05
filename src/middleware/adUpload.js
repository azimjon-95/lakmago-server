import multer from 'multer';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';

/*
 * REKLAMA VIDEOSI YUKLASH (multipart/form-data, maydon nomi: `video`)
 *
 * XOTIRADA (memoryStorage): fayl diskka ham, MongoDB'ga ham yozilmaydi —
 * so'rov tugagach xotiradan o'zi tozalanadi, Telegram'ga esa shu yerdan
 * uzatiladi (services/telegramGroup.js sendCustomBroadcast).
 *
 * 50 MB — Telegram Bot API `sendVideo` chegarasi (o'z Bot API serveri
 * bo'lsa TELEGRAM_API_BASE bilan kengaytiriladi, bu yerda ham oshirish kerak).
 * JSON so'rovlarga (rasm/matn reklama) TA'SIR QILMAYDI: multer multipart
 * bo'lmagan so'rovni o'zgartirmasdan o'tkazadi.
 */
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_VIDEO_BYTES, files: 1, fields: 12, fieldSize: 64 * 1024 },
});

export function adAttachment(req, res, next) {
  // Bo'laklab yuklangan video (JSON so'rovda uploadId) — pastdagi attachChunked
  if (!req.is('multipart/form-data') && req.body && typeof req.body.uploadId === 'string' && req.body.uploadId) {
    attachChunked(req, res)
      .then((err) => (err ? res.status(err.status).json({ error: err.error, code: err.code }) : next()))
      .catch(next);
    return;
  }
  upload.single('video')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'Video 50 MB dan oshmasligi kerak', code: 'VIDEO_TOO_LARGE' });
    }
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: 'Fayl yuklashda xato', code: err.code });
    }
    return next(err);
  });
}

/** Faylning HAQIQIY turi (mime soxta bo'lishi mumkin): mp4/mov — `ftyp`, webm/mkv — EBML. */
export function looksLikeVideo(buf) {
  if (!buf || buf.length < 12) return false;
  if (buf.slice(4, 8).toString('latin1') === 'ftyp') return true;
  return buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3;
}

export const ALLOWED_VIDEO_MIME = ['video/mp4', 'video/quicktime', 'video/webm'];

/* ═══════════════════════════════════════════════════════════════════
 * BO'LAKLAB YUKLASH (chunked upload) — 2026-10
 * ═══════════════════════════════════════════════════════════════════
 *
 * MUAMMO: admin paneldan 8.9 MB video yuborilganda ulanish ~11% da
 * (≈1 MB) uzilardi. Bu nginx'ning standart `client_max_body_size 1m`
 * chegarasi: undan katta so'rovni nginx o'rtada uzadi, brauzer esa
 * sababsiz "tarmoq xatosi" ko'radi. Mobil internetda bitta katta
 * so'rovning uzilishi ham hammasini boshidan boshlatardi.
 *
 * YECHIM: fayl brauzerda 512 KB lik bo'laklarga bo'linadi va har biri
 * alohida kichik so'rov bilan yuboriladi (nginx chegarasidan ancha
 * kichik). Bo'lak uzilsa — FAQAT o'sha bo'lak qayta yuboriladi.
 * Hammasi kelgach reklama so'rovi oddiy JSON bo'lib `uploadId` bilan
 * keladi; `adAttachment` faylni bo'laklardan yig'ib `req.file` qiladi —
 * kontrollerlar (broadcast / broadcastAll) O'ZGARMAYDI.
 *
 * Bo'laklar vaqtincha diskda (os.tmpdir) turadi — MongoDB'ga yozilmaydi.
 * Reklama muvaffaqiyatli ketgach o'chiriladi; xato bo'lsa qayta urinish
 * uchun qoladi va 2 soatdan keyin avtomatik tozalanadi.
 * Eski multipart yo'li ham ishlayveradi (orqaga moslik).
 */

export const CHUNK_BYTES = 512 * 1024;
const UPLOAD_ROOT = path.join(os.tmpdir(), 'lokma-ad-uploads');
const UPLOAD_TTL_MS = 2 * 60 * 60 * 1000;
const ID_RE = /^[a-f0-9]{32}$/;

const dirOf = (id) => path.join(UPLOAD_ROOT, id);
const partOf = (id, i) => path.join(dirOf(id), `${i}.part`);

async function readMeta(id) {
  if (!ID_RE.test(String(id || ''))) return null;
  try {
    return JSON.parse(await fsp.readFile(path.join(dirOf(id), 'meta.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** Eskirgan (2 soatdan oshgan) yuklashlarni tozalash — yangi yuklash boshlanganda. */
async function sweepOld() {
  let names = [];
  try { names = await fsp.readdir(UPLOAD_ROOT); } catch { return; }
  const now = Date.now();
  await Promise.all(names.filter((n) => ID_RE.test(n)).map(async (n) => {
    try {
      const st = await fsp.stat(dirOf(n));
      if (now - st.mtimeMs > UPLOAD_TTL_MS) await fsp.rm(dirOf(n), { recursive: true, force: true });
    } catch { /* boshqa jarayon o'chirgan */ }
  }));
}

export async function removeUpload(id) {
  if (!ID_RE.test(String(id || ''))) return;
  await fsp.rm(dirOf(id), { recursive: true, force: true }).catch(() => {});
}

/** Bo'lak tanasi — xom bayt, nginx 1 MB chegarasidan kichik. */
export const adChunkBody = express.raw({ type: () => true, limit: CHUNK_BYTES + 1024 });

export const adUploadController = {
  /*
   * POST /api/admin/ad-uploads  { fileName, mimeType, size }
   * → { uploadId, chunkSize, totalChunks }
   */
  async init(req, res, next) {
    try {
      const mimeType = String(req.body?.mimeType || '');
      const size = Number(req.body?.size);
      const fileName = String(req.body?.fileName || 'video').slice(0, 200);
      if (!ALLOWED_VIDEO_MIME.includes(mimeType)) {
        return res.status(415).json({ error: 'Faqat video fayl (MP4, MOV, WEBM) yuklang', code: 'UNSUPPORTED_VIDEO' });
      }
      if (!Number.isInteger(size) || size <= 0) return res.status(400).json({ error: 'Fayl hajmi noto‘g‘ri' });
      if (size > MAX_VIDEO_BYTES) {
        return res.status(413).json({ error: 'Video 50 MB dan oshmasligi kerak', code: 'VIDEO_TOO_LARGE' });
      }

      sweepOld().catch(() => {});
      const uploadId = crypto.randomBytes(16).toString('hex');
      const totalChunks = Math.ceil(size / CHUNK_BYTES);
      await fsp.mkdir(dirOf(uploadId), { recursive: true });
      await fsp.writeFile(path.join(dirOf(uploadId), 'meta.json'), JSON.stringify({
        owner: String(req.userId), mimeType, size, fileName, chunkSize: CHUNK_BYTES, totalChunks, createdAt: Date.now(),
      }));
      res.status(201).json({ uploadId, chunkSize: CHUNK_BYTES, totalChunks });
    } catch (e) { next(e); }
  },

  /*
   * PUT /api/admin/ad-uploads/:uploadId/chunks/:index  (xom bayt)
   * Takror yuborilsa — ustiga yoziladi (idempotent): qayta urinish xavfsiz.
   */
  async chunk(req, res, next) {
    try {
      const { uploadId } = req.params;
      const index = Number(req.params.index);
      const meta = await readMeta(uploadId);
      if (!meta || meta.owner !== String(req.userId)) {
        return res.status(404).json({ error: 'Yuklash topilmadi yoki muddati o‘tgan. Qaytadan yuboring.', code: 'UPLOAD_NOT_FOUND' });
      }
      if (!Number.isInteger(index) || index < 0 || index >= meta.totalChunks) {
        return res.status(400).json({ error: 'Bo‘lak raqami noto‘g‘ri' });
      }
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const expected = index === meta.totalChunks - 1
        ? meta.size - meta.chunkSize * (meta.totalChunks - 1)
        : meta.chunkSize;
      if (body.length !== expected) {
        return res.status(400).json({ error: 'Bo‘lak to‘liq kelmadi — qayta yuboriladi', code: 'CHUNK_SIZE' });
      }
      // Avval vaqtinchalik nomga, keyin almashtirish — yarim yozilgan bo'lak qolmaydi
      const tmp = `${partOf(uploadId, index)}.${process.pid}.${Date.now()}.tmp`;
      await fsp.writeFile(tmp, body);
      await fsp.rename(tmp, partOf(uploadId, index));
      res.json({ ok: true, index });
    } catch (e) { next(e); }
  },
};

/**
 * `uploadId` bo'yicha bo'laklarni yig'ib `req.file` (multer bilan bir xil shakl).
 * @returns {Promise<{error?:string,status?:number,code?:string}|null>}
 */
async function attachChunked(req, res) {
  const uploadId = String(req.body.uploadId);
  const meta = await readMeta(uploadId);
  if (!meta || meta.owner !== String(req.userId)) {
    return { status: 404, error: 'Video topilmadi yoki muddati o‘tgan. Qaytadan yuboring.', code: 'UPLOAD_NOT_FOUND' };
  }
  const parts = [];
  for (let i = 0; i < meta.totalChunks; i += 1) {
    try {
      parts.push(await fsp.readFile(partOf(uploadId, i)));
    } catch {
      return { status: 409, error: 'Video to‘liq yuklanmagan. Qayta yuboring.', code: 'UPLOAD_INCOMPLETE' };
    }
  }
  const buffer = Buffer.concat(parts);
  if (buffer.length !== meta.size) {
    return { status: 409, error: 'Video to‘liq yuklanmagan. Qayta yuboring.', code: 'UPLOAD_INCOMPLETE' };
  }
  req.file = { buffer, mimetype: meta.mimeType, originalname: meta.fileName, size: buffer.length };
  delete req.body.uploadId;
  // Muvaffaqiyatli ketsa — bo'laklar o'chiriladi; xato bo'lsa qayta urinish uchun qoladi
  res.on('finish', () => { if (res.statusCode < 400) removeUpload(uploadId); });
  return null;
}
