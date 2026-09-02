import { handlePaynetRpc } from '../services/paynetUws.js';

/*
 * POST /api/payments/paynet/uws
 *
 * Bitta endpoint — barcha JSON-RPC metodlar shu yerga keladi
 * (`method` maydoni orqali ajratiladi). Auth (paynetBasicAuth)
 * va IP whitelist (paynetIpWhitelist) route darajasida,
 * routes/index.js da ulanadi — bu yerga yetib kelgan so'rov
 * ALLAQACHON tekshirilgan.
 *
 * asyncHandler ISHLATILMAYDI ATAYLAB: handlePaynetRpc() hech
 * qachon throw qilmaydi (o'zi barcha xatolarni JSON-RPC error
 * shakliga o'raydi) — bu SLA (500ms) uchun muhim, chunki
 * markaziy xato-ishlov beruvchi middleware'ga o'tish qo'shimcha
 * vaqt yeydi.
 */
export async function paynetUwsController(req, res) {
  const response = await handlePaynetRpc(req.body);
  res.json(response);
}
