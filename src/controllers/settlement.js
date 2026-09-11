import { asyncHandler } from '../middleware/error.js';
import {
  getDailySettlementAllRestaurants,
  recordPayout,
} from '../services/billing.js';

/*
 * ═══════════════════════════════════════════════════════════
 * KUNLIK HISOB-KITOB (settlement) — MOLIYA MODULI
 * ═══════════════════════════════════════════════════════════
 *
 * TARIX (nima uchun bu fayl QAYTA YOZILDI):
 *
 * Bu kontroller ILGARI `Payment` degan ALOHIDA kolleksiyadan
 * o'qirdi — u yerda Click/Paynet ni ajratib, `providerFee`,
 * `restaurantAmount` kabi aniq maydonlar bilan saqlash g'oyasi
 * to'g'ri edi. LEKIN: butun kod bazasida `Payment.create(...)`
 * degan qator BITTA HAM YO'Q EDI — hech kim bu modelni
 * to'ldirmasdi. Natijada bu sahifa HAR DOIM bo'sh natija
 * qaytarardi, garchi UI (BillingPage.jsx) to'liq ishlagan
 * ko'rinsa ham.
 *
 * Bundan tashqari, `confirm` amali `amount` ni FRONTEND'dan
 * kelgan qiymatga ishonib, hech qanday tekshiruvsiz yozardi —
 * bu aynan "backend qayta hisoblasin, frontendga ishonma"
 * qoidasining buzilishi edi.
 *
 * ENDI: ikkalasi ham `services/billing.js` dagi — restoranga
 * pul kelishi bilan ISHLAYOTGAN, real ma'lumot yozadigan —
 * `Ledger` manbasidan ishlaydi. `confirm` esa xuddi
 * `/admin/billing/payout` ishlatadigan `recordPayout()` ning
 * O'ZINI chaqiradi — ya'ni endi ikkita mustaqil to'lov yo'li
 * emas, BITTA canonical yo'l bor.
 */

export const settlementController = {
  // GET /admin/settlement/daily?date=2026-08-17
  daily: asyncHandler(async (req, res) => {
    const data = await getDailySettlementAllRestaurants(req.query.date);
    res.json(data);
  }),

  /**
   * POST /admin/settlement/confirm
   * { restaurantId, amount, bankReference?, note?, idempotencyKey }
   *
   * Admin BANK ORQALI PULNI HAQIQATDA YUBORGANDAN KEYIN shu
   * yerni bosadi — tizim hech qanday pulni o'zi YUBORMAYDI,
   * faqat "yuborildi" deb QAYD ETADI.
   */
  confirm: asyncHandler(async (req, res) => {
    const { restaurantId, amount, bankReference, note, idempotencyKey } = req.body || {};

    if (!restaurantId || typeof restaurantId !== 'string' || restaurantId.length !== 24) {
      return res.status(400).json({ error: 'restaurantId noto‘g‘ri' });
    }
    if (typeof amount !== 'number' || amount <= 0) {
      return res.status(400).json({ error: 'amount musbat son bo‘lishi kerak' });
    }
    if (!idempotencyKey || typeof idempotencyKey !== 'string' || idempotencyKey.length < 8) {
      return res.status(400).json({ error: 'idempotencyKey majburiy' });
    }

    try {
      const fullNote = [note, bankReference && `Bank hujjat: ${bankReference}`]
        .filter(Boolean).join(' — ');
      const result = await recordPayout(restaurantId, amount, req.userId, fullNote, idempotencyKey);
      res.status(201).json(result);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  }),
};
