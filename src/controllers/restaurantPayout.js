import { z } from 'zod';
import { asyncHandler } from '../middleware/error.js';
import { Restaurant } from '../models/Restaurant.js';
import { RestaurantPayoutAudit } from '../models/RestaurantPayoutAudit.js';
import { RestaurantPayoutSecret } from '../models/RestaurantPayoutSecret.js';
import { User } from '../models/User.js';
import { encryptSecret, decryptSecret } from '../lib/secrets.js';

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
function toSafeView(restaurant, fullNumberSaved = false) {
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
      hasFullNumber: Boolean(fullNumberSaved),
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
        // Faqat TO'LIQ raqam qabul qilinadi (o'zgartirishda). Oxirgi 4
    // xona Restaurant'da (ro'yxatlar uchun), to'liq raqam esa
    // SHIFRLANGAN holda ALOHIDA kolleksiyada (RestaurantPayoutSecret)
    // — buxgalter o'tkazma qilishi uchun kerak
    cardNumber: z.string().regex(/^\d{16}$/, '16 xonali raqam kerak').optional(),
    holderName: z.string().max(150).optional(),
    bankName: z.string().max(100).optional(),
  }).optional(),

  status: z.enum(['unverified', 'verified', 'blocked']).optional(),
});

/** Audit uchun ism (auth token'da faqat id bor). */
async function actorName(req) {
  if (req.staffName || req.adminName) return req.staffName || req.adminName;
  if (!req.userId) return '';
  const u = await User.findById(req.userId).select('firstName lastName login').lean().catch(() => null);
  return u ? ([u.firstName, u.lastName].filter(Boolean).join(' ') || u.login || '') : '';
}

export const restaurantPayoutController = {
  // GET /api/admin/restaurants/:id/payout
  get: asyncHandler(async (req, res) => {
    const restaurant = await Restaurant.findById(req.params.id).select('name payout').lean();
    if (!restaurant) return res.status(404).json({ error: 'Restoran topilmadi' });
    const hasSecret = await RestaurantPayoutSecret.exists({ restaurantId: restaurant._id });
    res.json({ restaurantId: restaurant._id, name: restaurant.name, ...toSafeView(restaurant, Boolean(hasSecret)) });
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
    let secretToSave = '';

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
      if (d.card.cardNumber) {
        restaurant.payout.card.cardLast4 = d.card.cardNumber.slice(-4);
        // To'liq raqam — shifrlangan, alohida kolleksiyada
        secretToSave = encryptSecret(d.card.cardNumber);
      }
      if (d.card.holderName !== undefined) restaurant.payout.card.holderName = d.card.holderName;
      if (d.card.bankName !== undefined) restaurant.payout.card.bankName = d.card.bankName;
      auditEntries.push({
        field: 'card',
        oldValue: oldCard,
        // TO'LIQ karta raqami audit tarixida ham hech qachon
        // saqlanmaydi — faqat oxirgi 4 xona (maskalangan)
        newValue: { holderName: d.card.holderName, bankName: d.card.bankName, cardMasked: maskCard(restaurant.payout.card.cardLast4) },
      });
    }

    if (d.status !== undefined && d.status !== restaurant.payout?.status) {
      auditEntries.push({ field: 'status', oldValue: before.status || 'unverified', newValue: d.status });
      restaurant.payout.status = d.status;
    }

    if (auditEntries.length === 0) {
      const has = await RestaurantPayoutSecret.exists({ restaurantId: restaurant._id });
      return res.json({ restaurantId: restaurant._id, ...toSafeView(restaurant, Boolean(has)), noChanges: true });
    }

    restaurant.payout.updatedAt = new Date();
    restaurant.payout.updatedBy = req.userId || null;
    await restaurant.save();
    if (secretToSave) {
      await RestaurantPayoutSecret.findOneAndUpdate(
        { restaurantId: restaurant._id },
        { cardNumberEnc: secretToSave, updatedBy: req.userId || null },
        { upsert: true, setDefaultsOnInsert: true },
      );
    }
    const actor = await actorName(req);

    // Audit — HAR BIR o'zgargan maydon uchun alohida yozuv.
    // Yozuvlar o'chirilmaydi (TZ 27-band).
    await RestaurantPayoutAudit.insertMany(
      auditEntries.map((e) => ({
        restaurantId: restaurant._id,
        changedBy: req.userId || null,
        changedByName: actor,
        field: e.field,
        oldValue: e.oldValue,
        newValue: e.newValue,
        ip: req.ip || '',
      })),
    );

    const hasSecretNow = await RestaurantPayoutSecret.exists({ restaurantId: restaurant._id });
    res.json({ restaurantId: restaurant._id, ...toSafeView(restaurant, Boolean(hasSecretNow)) });
  }),

  /*
   * GET /api/admin/restaurants/:id/payout/reveal
   *
   * TO'LIQ rekvizit — buxgalter "To'lash" oynasida pulni QAYERGA
   * o'tkazishni ko'radi. Faqat 'billing' ruxsati (route'da).
   *
   * Bu maxfiy ma'lumot, shuning uchun:
   *   • HAR bir ko'rish audit jurnaliga yoziladi (kim, qachon, IP) —
   *     "kim rekvizitni ko'rdi" degan savolga javob bor;
   *   • javob keshlanmaydi (Cache-Control: no-store);
   *   • ro'yxat/tahrir endpointlari maskalangan holda qoladi —
   *     to'liq qiymat FAQAT shu yerda chiqadi.
   */
  reveal: asyncHandler(async (req, res) => {
    const restaurant = await Restaurant.findById(req.params.id).select('name payout').lean();
    if (!restaurant) return res.status(404).json({ error: 'Restoran topilmadi' });

    const p = restaurant.payout || {};
    const secret = await RestaurantPayoutSecret.findOne({ restaurantId: restaurant._id }).lean();

    let cardNumber = '';
    let cardError = '';
    if (secret?.cardNumberEnc) {
      try {
        cardNumber = decryptSecret(secret.cardNumberEnc);
      } catch {
        // Kalit almashtirilgan yoki qiymat buzilgan — jim qolmaymiz
        cardError = 'Karta raqamini o‘qib bo‘lmadi — qayta kiriting';
      }
    }

    await RestaurantPayoutAudit.create({
      restaurantId: restaurant._id,
      changedBy: req.userId || null,
      changedByName: await actorName(req),
      field: 'reveal',
      oldValue: null,
      newValue: { method: p.method || null },
      ip: req.ip || '',
    });

    res.set('Cache-Control', 'no-store');
    res.json({
      restaurantId: restaurant._id,
      name: restaurant.name,
      method: p.method || null,
      status: p.status || 'unverified',
      bank: {
        accountNumber: p.bank?.accountNumber || '',
        bankName: p.bank?.bankName || '',
        mfo: p.bank?.mfo || '',
        inn: p.bank?.inn || '',
        holderName: p.bank?.holderName || '',
      },
      card: {
        number: cardNumber,
        last4: p.card?.cardLast4 || '',
        holderName: p.card?.holderName || '',
        bankName: p.card?.bankName || '',
        // Faqat oxirgi 4 xona bor (eski yozuv) — to'liq raqam kiritilmagan
        needsFullNumber: Boolean(p.card?.cardLast4) && !cardNumber,
        error: cardError,
      },
    });
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
