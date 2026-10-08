import { asyncHandler } from '../middleware/error.js';
import { User } from '../models/User.js';
import { weddingFetch } from './weddingProxy.js';

/*
 * ═══ LOKMA FOYDALANUVCHISI — TO'YXONA BRONLARI ═══
 * To'yxona serveri mijozni alohida saqlamaydi: bron telefon raqami bilan
 * yoziladi. Bu yerda tizimga kirgan foydalanuvchining O'Z telefoni (bazadan,
 * token bo'yicha) to'yxona serveriga yuboriladi — boshqa odamning telefonini
 * so'rab bo'lmaydi.
 *   GET  /api/weddings/my-bookings
 *   POST /api/weddings/my-bookings/:id/cancel
 */
async function myPhone(req) {
  const u = await User.findById(req.userId).select('phone').lean().catch(() => null);
  const phone = String(u?.phone || '').replace(/[^\d+]/g, '');
  return phone.replace(/\D/g, '').length >= 9 ? phone : '';
}

export const weddingUserController = {
  myBookings: asyncHandler(async (req, res) => {
    const phone = await myPhone(req);
    if (!phone) return res.json({ bookings: [], needsPhone: true });
    const { status, data } = await weddingFetch(`/api/internal/my-bookings?phone=${encodeURIComponent(phone)}`);
    if (status !== 200) return res.status(status === 404 ? 502 : status).json({ error: data?.error || 'To‘yxonalar serveri xatosi' });
    res.json({ bookings: Array.isArray(data) ? data : [], needsPhone: false });
  }),

  cancel: asyncHandler(async (req, res) => {
    const id = String(req.params.id || '');
    if (!/^[a-f0-9]{24}$/i.test(id)) return res.status(404).json({ error: 'Bron topilmadi' });
    const phone = await myPhone(req);
    if (!phone) return res.status(400).json({ error: 'Telefon raqamingizni profilda kiriting' });
    const { status, data } = await weddingFetch(`/api/internal/my-bookings/${id}/cancel`, { method: 'POST', body: { phone } });
    res.status(status).json(data);
  }),
};
