import multer from 'multer';

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
