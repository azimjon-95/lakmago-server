import { Schema, model } from 'mongoose';

/*
 * ═══ LOKMAGO SOVG'A-BONUSI ═══
 * Buyurtma summasi shartdan oshsa, mijozga buyurtma taomlariga QO'SHIB sovg'a beriladi
 * (masalan 100 000 so'mdan 1 l Coca-Cola). Sovg'ani restoran BEPUL beradi, uning puli esa
 * LokmaGo tomonidan restoranga qoplanadi (`reimburse` — bitta dona uchun, so'm).
 *
 * Bu BonusRule (restoranning balans-bonusi) dan BOSHQA narsa: u mijoz balansiga pul tushiradi,
 * bu esa jismoniy sovg'a bo'lib, buyurtma bilan birga yuboriladi va LokmaGo hisobidan qoplanadi.
 *
 * Hisob: har bir qoida buyurtmaga `bonusItems` ko'rinishida MUZLATILADI (keyin qoida o'zgarsa ham
 * eski buyurtma o'zgarmaydi); restoranga to'lov — buyurtma yetkazilgach (billing.settleOrder).
 */
export const GIFT_KINDS = ['restaurant', 'choyxona', 'cafe', 'fastfood', 'club', 'shop'];
export const FOOD_KINDS = ['restaurant', 'choyxona', 'cafe', 'fastfood', 'club'];

const giftBonusSchema = new Schema(
  {
    /** Admin uchun ichki nom ("Kola bonusi — 100 ming") */
    name: { type: String, required: true, maxlength: 80 },

    // ── Sovg'a ──
    itemName: { type: String, required: true, maxlength: 60 },     // "1 l Coca-Cola"
    imageUrl: { type: String, default: '', maxlength: 500 },
    quantity: { type: Number, default: 1, min: 1, max: 5 },        // buyurtma boshiga nechta
    /** LokmaGo restoranga to'laydigan summa — BITTA dona uchun (so'm) */
    reimburse: { type: Number, default: 0, min: 0, max: 2_000_000 },

    // ── Shart ──
    minAmount: { type: Number, default: 100_000, min: 0, max: 1_000_000_000 },
    /** Yuqori chegara (0 = yo'q): masalan "faqat 300 000 gacha" */
    maxAmount: { type: Number, default: 0, min: 0, max: 1_000_000_000 },
    /**
     * Qaysi summa hisobga olinadi:
     *   menu — taomlar narxi (aksiya/olib ketish chegirmasidan OLDIN) — mijoz savatda aniq ko'radi;
     *   paid — chegirmalardan KEYIN to'lanadigan taomlar summasi.
     */
    basis: { type: String, enum: ['menu', 'paid'], default: 'menu' },

    active: { type: Boolean, default: false, index: true },

    // ── Kimlarga / qayerda ──
    scope: { type: String, enum: ['all', 'include', 'exclude'], default: 'all' },
    restaurantIds: [{ type: Schema.Types.ObjectId, ref: 'Restaurant' }],
    kinds: { type: [{ type: String, enum: GIFT_KINDS }], default: () => [...FOOD_KINDS] },
    fulfillments: { type: [{ type: String, enum: ['delivery', 'pickup'] }], default: () => ['delivery', 'pickup'] },
    /** Bo'sh = hamma to'lov turi */
    paymentMethods: { type: [{ type: String, enum: ['cash', 'click', 'payme', 'paynet', 'uzum'] }], default: [] },

    // ── Qachon ──
    startsAt: { type: Date, default: null },
    endsAt: { type: Date, default: null },
    /** Haftaning kunlari (0=yakshanba … 6=shanba, Toshkent vaqti). Bo'sh = har kuni */
    weekdays: { type: [Number], default: [] },
    /** Kun ichidagi vaqt oynasi (Toshkent soati). Ikkalasi ham null = kun bo'yi. from > to — tun oshib ketadi */
    hourFrom: { type: Number, default: null, min: 0, max: 23 },
    hourTo: { type: Number, default: null, min: 1, max: 24 },

    // ── Chegaralar (0 = cheksiz) ──
    perCustomerPerDay: { type: Number, default: 0, min: 0 },
    perCustomerTotal: { type: Number, default: 0, min: 0 },
    dailyLimit: { type: Number, default: 0, min: 0 },
    totalLimit: { type: Number, default: 0, min: 0 },
    /** Umumiy qoplash byudjeti (so'm): shuncha sarflangach qoida o'zi to'xtaydi */
    budget: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);
giftBonusSchema.index({ active: 1, createdAt: 1 });

export const GiftBonus = model('GiftBonus', giftBonusSchema);
