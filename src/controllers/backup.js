import { asyncHandler } from '../middleware/error.js';
import { getBackupStatus, runBackupNow } from '../services/dbBackup.js';

/*
 * Baza zaxirasi — admin panel uchun (faqat 'admin').
 *   GET  /admin/backup/status — yoqilganmi, so'nggi zaxira, so'nggi urinishlar va xato sabablari
 *   POST /admin/backup/run    — hozir zaxira olib guruhga yuborish (kunlik jadvalni buzmaydi)
 * Maxfiy ma'lumot (bot tokeni, to'liq guruh ID) javobda YO'Q.
 */
export const backupController = {
  status: asyncHandler(async (_req, res) => {
    res.set('Cache-Control', 'no-store').json(await getBackupStatus());
  }),

  run: asyncHandler(async (_req, res) => {
    try {
      const r = await runBackupNow();
      // attempt() xato tashlamaydi: { ok:false, error } qaytaradi — mijozga AYNAN sabab ko'rsatiladi
      if (!r.ok) return res.status(502).json({ ok: false, error: r.error || 'Zaxira yuborilmadi' });
      return res.json({ ok: true, ymd: r.ymd, documents: r.documents });
    } catch (e) {
      return res.status(400).json({ ok: false, error: e.message });
    }
  }),
};
