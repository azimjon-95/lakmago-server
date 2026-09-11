import { z } from 'zod';
import { asyncHandler } from '../middleware/error.js';
import { Restaurant } from '../models/Restaurant.js';
import { RestaurantPayoutAudit } from '../models/RestaurantPayoutAudit.js';

/*
 * ═══════════════════════════════════════════════════════════
 * RESTORAN TO'LOV REKVIZITI (Moliya moduli)
 * ═══════════════════════════════════════════════════════════
 *
 * "Buxgalter pulni qayerga jo'natadi" — bank hisobimi, kartami.
 * Faqat 'billing' sahifasiga ruxsati bor xodim (buxgalter)
 * ko'radi va o'zgartiradi — restoranni umumiy tahrirlash
 * huquqidan ATAYLAB ajratilgan, chunki bu maxfiy moliyaviy
 * ma'lumot (TZ 2-band: "faqat kerakli admin/buxgalter ko'ra
 * olishi").
 */

function maskCard(last4) {
  return last4 ? `8600 **** **** ${last4}` : '';
}

function maskAccount(accountNumber) {
  if (!accountNumber) return '';
  const s = String(accountNumber);
  return s.length <= 4 ? s : `${'*'.repeat(Math.max(0, s.length - 4))}${s.slice(-4)}`;
}

/** Panelga chiqariladigan, maskalangan ko'rinish. */
function toSafeView(restaurant) {
  const p = restaurant.payout || {};
  return {
    method: p.method || null,
    status: p.status || 'unverified',
    bank: {
      accountNumber: maskAccount(p.bank?.accountNumber),
      bankName: p.bank?.bankName || '',
      mfo: p.bank?.mfo || '',
      inn: p.bank?.inn || '',
      holderName: p.bank?.holderName || '',
      hasAccountNumber: Boolean(p.bank?.accountNumber),
    },
    card: {
      cardMasked: maskCard(p.card?.cardLast4),
      holderName: p.card?.holderName || '',
      bankName: p.card?.bankName || '',
      hasCard: Boolean(p.card?.cardLast4),
    },
    updatedAt: p.updatedAt || null,
  };
}

const updateSchema = z.object({
  method: z.enum(['bank', 'card']).optional(),

  bank: z.object({
    // To'liq holda YOZISHDA qabul qilinadi — o'zgartirilmasa
    // yuborilmaydi, eski qiymat saqlanadi
    accountNumber: z.string().max(40).optional(),
    bankName: z.string().max(100).optional(),
    mfo: z.string().max(20).optional(),
    inn: z.string().max(20).optional(),
    holderName: z.string().max(150).optional(),
  }).optional(),

  card: z.object({
    // Faqat TO'LIQ raqam qabul qilinadi (o'zgartirishda) — shu
    // zahoti oxirgi 4 xonaga qisqartiriladi, to'liq holda
    // HECH QACHON saqlanmaydi
    cardNumber: z.string().regex(/^\d{16}$/, '16 xonali raqam kerak').optional(),
    holderName: z.string().max(150).optional(),
    bankName: z.string().max(100).optional(),
  }).optional(),

  status: z.enum(['unverified', 'verified', 'blocked']).optional(),
});

export const restaurantPayoutController = {
  // GET /api/admin/restaurants/:id/payout
  get: asyncHandler(async (req, res) => {
    const restaurant = await Restaurant.findById(req.params.id).select('name payout').lean();
    if (!restaurant) return res.status(404).json({ error: 'Restoran topilmadi' });
    res.json({ restaurantId: restaurant._id, name: restaurant.name, ...toSafeView(restaurant) });
  }),

  // PATCH /api/admin/restaurants/:id/payout
  update: asyncHandler(async (req, res) => {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Noto‘g‘ri ma‘lumot', details: parsed.error.flatten() });
    }

    const restaurant = await Restaurant.findById(req.params.id);
    if (!restaurant) return res.status(404).json({ error: 'Restoran topilmadi' });

    const before = JSON.parse(JSON.stringify(restaurant.payout || {}));
    const d = parsed.data;
    const auditEntries = [];

    if (d.method !== undefined && d.method !== restaurant.payout?.method) {
      auditEntries.push({ field: 'method', oldValue: before.method || null, newValue: d.method });
      restaurant.payout.method = d.method;
    }

    if (d.bank) {
      const oldBank = { ...before.bank, accountNumber: maskAccount(before.bank?.accountNumber) };
      // Har bir maydon ALOHIDA yangilanadi — faqat kelgan
      // qiymatlar o'zgaradi, yuborilmagan maydonlar eskicha qoladi
      if (d.bank.accountNumber !== undefined) restaurant.payout.bank.accountNumber = d.bank.accountNumber;
      if (d.bank.bankName !== undefined) restaurant.payout.bank.bankName = d.bank.bankName;
      if (d.bank.mfo !== undefined) restaurant.payout.bank.mfo = d.bank.mfo;
      if (d.bank.inn !== undefined) restaurant.payout.bank.inn = d.bank.inn;
      if (d.bank.holderName !== undefined) restaurant.payout.bank.holderName = d.bank.holderName;
      auditEntries.push({
        field: 'bank',
        oldValue: oldBank,
        // Audit tarixida ham TO'LIQ hisob raqami saqlanmaydi —
        // faqat maskalangan holda
        newValue: { ...d.bank, accountNumber: maskAccount(d.bank.accountNumber) },
      });
    }

    if (d.card) {
      const oldCard = { ...before.card, cardNumber: maskCard(before.card?.cardLast4) };
      if (d.card.cardNumber) restaurant.payout.card.cardLast4 = d.card.cardNumber.slice(-4);
      if (d.card.holderName !== undefined) restaurant.payout.card.holderName = d.card.holderName;
      if (d.card.bankName !== undefined) restaurant.payout.card.bankName = d.card.bankName;
      auditEntries.push({
        field: 'card',
        oldValue: oldCard,
        // TO'LIQ karta raqami audit tarixida ham hech qachon
        // saqlanmaydi — faqat oxirgi 4 xona
        newValue: { holderName: d.card.holderName, bankName: d.card.bankName, cardMasked: maskCard(restaurant.payout.card.cardLast4) },
      });
    }

    if (d.status !== undefined && d.status !== restaurant.payout?.status) {
      auditEntries.push({ field: 'status', oldValue: before.status || 'unverified', newValue: d.status });
      restaurant.payout.status = d.status;
    }

    if (auditEntries.length === 0) {
      return res.json({ restaurantId: restaurant._id, ...toSafeView(restaurant), noChanges: true });
    }

    restaurant.payout.updatedAt = new Date();
    restaurant.payout.updatedBy = req.userId || null;
    await restaurant.save();

    // Audit — HAR BIR o'zgargan maydon uchun alohida yozuv.
    // Yozuvlar o'chirilmaydi (TZ 27-band).
    await RestaurantPayoutAudit.insertMany(
      auditEntries.map((e) => ({
        restaurantId: restaurant._id,
        changedBy: req.userId || null,
        changedByName: req.staffName || req.adminName || '',
        field: e.field,
        oldValue: e.oldValue,
        newValue: e.newValue,
        ip: req.ip || '',
      })),
    );

    res.json({ restaurantId: restaurant._id, ...toSafeView(restaurant) });
  }),

  // GET /api/admin/restaurants/:id/payout/audit
  audit: asyncHandler(async (req, res) => {
    const items = await RestaurantPayoutAudit.find({ restaurantId: req.params.id })
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();
    res.json(items);
  }),
};
