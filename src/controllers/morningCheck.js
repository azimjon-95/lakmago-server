import { asyncHandler } from '../middleware/error.js';
import { Restaurant } from '../models/Restaurant.js';
import { getPanelMorningStatus, panelMarkAllOk, listMorningChecks, getTodayYmd } from '../services/morningChecklist.js';

/*
 * Ertalabki ochilish tekshiruvi — panel va admin endpointlari (yangi fayl: mavjud
 * restaurantPanelController ga tegilmagan). Mantiq: services/morningChecklist.js.
 */

const SELECT = 'name openTime closeTime timezone workingDays isActive isBlocked isApproved';

async function myRestaurant(req, res) {
  const r = await Restaurant.findById(req.restaurantId).select(SELECT).lean();
  if (!r) { res.status(404).json({ error: 'Restoran topilmadi' }); return null; }
  return r;
}

export const morningCheckController = {
  // GET /api/panel/morning-check → { status: 'pending'|'checked_all_ok'|'checked_with_stop'|null, reminderCount, firstSentAt, date }
  // status null — hozir tekshiruv kerak emas (dam olish kuni, ochilishdan oldin yoki yopilgach): banner ko'rinmaydi
  panelGet: asyncHandler(async (req, res) => {
    const restaurant = await myRestaurant(req, res);
    if (!restaurant) return;
    res.json(await getPanelMorningStatus(restaurant));
  }),

  // POST /api/panel/morning-check/all-ok → { ok: true } (qayta bosilsa ham xato yo'q: already: true)
  panelAllOk: asyncHandler(async (req, res) => {
    const restaurant = await myRestaurant(req, res);
    if (!restaurant) return;
    res.json(await panelMarkAllOk(restaurant, req.userId));
  }),

  // GET /api/admin/morning-checks?date=YYYY-MM-DD → jadval (sana berilmasa — bugun, Toshkent)
  adminList: asyncHandler(async (req, res) => {
    const date = String(req.query.date || '');
    const ymd = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : getTodayYmd({}, Date.now());
    const rows = await listMorningChecks(ymd);
    const counts = rows.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});
    res.json({ date: ymd, counts, rows });
  }),
};
