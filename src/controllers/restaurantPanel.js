import { z } from 'zod';
import { cached, KEYS, TTL } from '../services/cache.js';
import { asyncHandler } from '../middleware/error.js';
import { Restaurant } from '../models/Restaurant.js';
import { Dish } from '../models/Dish.js';
import { Order } from '../models/Order.js';
import { Banner } from '../models/User.js';
import { getIO } from '../sockets/io.js';
import { changeOrderStatus, OrderFlowError } from '../services/orderFlow.js';

// Restoran token'idagi restaurantId'ni oladi (auth middleware qo'ygan)
function rid(req) {
  return req.restaurantId;
}

/**
 * Restoran ko'radigan moliyaviy tasvir.
 *
 * Faqat restoranga tegishli raqamlar: taom summasi, ushlangan
 * komissiya va qo'lga tegadigan summa. LokmaGo daromadi, shlyuz
 * residuali va mijoz xizmat haqining taqsimoti KO'RSATILMAYDI.
 *
 * Summalar so'mda (snapshot tiyinda saqlanadi).
 */
function restaurantFinanceView(f) {
  const som = (t) => Math.round(Number(t) || 0) / 100;
  return {
    model: f.model,
    currency: f.currency,
    foodSubtotal: som(f.foodSubtotal),
    discountAmount: som(f.discountAmount),
    restaurantCommissionPercent: f.restaurantCommissionPercent,
    restaurantCommissionAmount: som(f.restaurantCommissionAmount),
    restaurantPayout: som(f.restaurantPayout),
    deliveryFee: som(f.deliveryFee),
    totalCharged: som(f.totalCharged),
  };
}

/*
 * ═══ HAJM VA QO'SHIMCHA GURUHLARI — VALIDATSIYA ═══
 *
 * Restoran taom qo'shganda (yoki tahrirlaganda) hajm/razmer
 * yoki qo'shimcha guruhlarini kiritishi mumkin:
 *
 *   variant — "Porsiya hajmi": 33 sm — 61 500, 40 sm — 76 875.
 *             Narx taom narxini ALMASHTIRADI, bittasi tanlanadi.
 *   addon   — "Qo'shimcha": Pishloq +5 000. Narx QO'SHILADI.
 *
 * Qat'iy tekshiruv: bu ma'lumot to'g'ridan-to'g'ri narxga ta'sir
 * qiladi, noto'g'ri kiritilsa mijozdan noto'g'ri pul olinadi.
 */
const optionGroupsSchema = z.array(z.object({
  title: z.string().trim().min(1, 'Guruh nomi bo‘sh').max(60),
  kind: z.enum(['addon', 'variant']).default('addon'),
  required: z.boolean().optional(),
  multiple: z.boolean().optional(),
  options: z.array(z.object({
    name: z.string().trim().min(1, 'Variant nomi bo‘sh').max(60),
    price: z.number().min(0).max(100000000),
  })).min(1).max(20),
})).max(10)
  .refine(
    (groups) => groups.every((g) => g.kind !== 'variant' || g.options.length >= 2),
    { message: 'Hajm guruhida kamida 2 ta variant bo‘lishi kerak' },
  )
  .refine(
    (groups) => groups.filter((g) => g.kind === 'variant').length <= 1,
    { message: 'Bitta taomda faqat bitta hajm guruhi bo‘lishi mumkin' },
  )
  /*
   * Hajm guruhi har doim: bittasi tanlanadi va tanlash SHART.
   * Restoran buni noto'g'ri belgilasa ham server to'g'rilaydi.
   */
  .transform((groups) => groups.map((g) => (g.kind === 'variant'
    ? { ...g, required: true, multiple: false }
    : { ...g, required: Boolean(g.required), multiple: g.multiple !== false })));

export const restaurantPanelController = {
  // GET /api/panel/me — restoranning o'z profili
  profile: asyncHandler(async (req, res) => {
    // Shartnoma va moliya ma'lumotlari restoranga BERILMAYDI —
    // komissiya foizi, balans, to'langan summa faqat adminda.
    const restaurant = await Restaurant.findById(rid(req))
      .select('-ownerId -__v -commissionPercent -commissionMode -balance -totalPaidOut -contractNumber -contractDate');

    if (!restaurant) return res.status(404).json({ error: 'Restoran topilmadi' });
    res.json(restaurant);
  }),

  // PATCH /api/panel/me/active  { isActive } — butun restoranni ochish/yopish
  toggleActive: asyncHandler(async (req, res) => {
    const { isActive } = req.body;
    const restaurant = await Restaurant.findByIdAndUpdate(
      rid(req),
      { isActive: Boolean(isActive) },
      { new: true },
    );
    if (!restaurant) return res.status(404).json({ error: 'Restoran topilmadi' });
    res.json(restaurant);
  }),

  // GET /api/panel/dishes — o'z taomlari (barchasi, STOPdagilar ham)
  dishes: asyncHandler(async (req, res) => {
    const id = String(rid(req));
    /*
     * KESHDAN o'qiladi (login paytida allaqachon to'ldirilgan —
     * services/restaurantWarmup.js). Menyu eng ko'p ochiladigan
     * sahifa, shuning uchun eng katta foyda shu yerda.
     *
     * Kesh yangilanishi haqida tashvishlanmasa bo'ladi: Dish
     * modeliga ulangan plagin har qanday o'zgarishda (qo'shish,
     * tahrirlash, o'chirish, stop-list) keshni AVTOMATIK
     * tozalaydi (models/cacheInvalidation.js).
     */
    const dishes = await cached(
      KEYS.restaurantDishes(id),
      TTL.dishes,
      () => Dish.find({ restaurantId: id }).sort({ section: 1, name: 1 }).lean(),
    );
    res.json(dishes);
  }),

  // POST /api/panel/dishes — yangi taom qo'shish
  createDish: asyncHandler(async (req, res) => {
    const schema = z.object({
      section: z.string().min(1),
      name: z.string().min(1),
      description: z.string().optional().default(''),
      price: z.number().nonnegative(),
      oldPrice: z.number().optional(),
      // Tayyorlanish vaqti va kategoriya
      prepMinutes: z.number().int().min(1).max(240).optional(),
      // Qo'shimcha ma'lumot — barchasi ixtiyoriy
      weight: z.string().optional(),
      volume: z.string().max(30).optional(),
      drinkType: z.string().max(40).optional(),
      priceMode: z.enum(['sync', 'custom']).optional(),
      dineInPrice: z.number().min(0).nullable().optional(),
      calories: z.number().optional(),
      protein: z.number().optional(),
      fat: z.number().optional(),
      carbs: z.number().optional(),
      category: z.string().optional(),
      icon: z.string().optional(),
      tint: z.string().optional(),
      calories: z.number().optional(),
      weightGram: z.number().optional(),
      imageUrl: z.string().optional(),
      images: z.array(z.string()).optional(),
      // Hajm/razmer va qo'shimchalar (ixtiyoriy)
      optionGroups: optionGroupsSchema.optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Ma‘lumot noto‘g‘ri', details: parsed.error.issues });
    }
    const dish = await Dish.create({ ...parsed.data, restaurantId: rid(req) });

    // Yuborilgan, lekin saqlanmagan maydonlarni aniqlaymiz.
    // Mongoose strict rejimda modelda yo'q maydonni jim tashlaydi —
    // bu jimgina ma'lumot yo'qolishiga olib keladi.
    const dropped = Object.keys(parsed.data).filter(
      (k) => parsed.data[k] !== undefined && dish[k] === undefined,
    );
    if (dropped.length) {
      console.warn(
        `[dish] Saqlanmagan maydonlar: ${dropped.join(', ')}\n` +
        '  Sabab: server eski kod bilan ishlayapti.\n' +
        '  Yechim: git pull && pm2 restart lakmago-server',
      );
    }
    // Real-time: admin nazorat panelida darhol ko'rinadi
    getIO()?.to('admin').emit('dish:update', { restaurantId: String(rid(req)) });
    res.status(201).json(dish);
  }),

  // PATCH /api/panel/dishes/:id — taomni tahrirlash (narx, nom, STOP)
  updateDish: asyncHandler(async (req, res) => {
    const allowed = ['name', 'description', 'price', 'oldPrice', 'section', 'category', 'prepMinutes', 'icon', 'tint', 'isAvailable', 'isHit', 'isTrending', 'isDiscounted', 'calories', 'weight', 'weightGram', 'protein', 'fat', 'carbs', 'volume', 'drinkType', 'priceMode', 'dineInPrice', 'imageUrl', 'images'];
    const update = {};
    for (const k of allowed) if (k in req.body) update[k] = req.body[k];

    /*
     * Guruhlar boshqa maydonlardan farqli — ular narxga ta'sir
     * qiladi, shuning uchun xomligicha EMAS, validatsiyadan
     * o'tkazilib saqlanadi.
     */
    if ('optionGroups' in req.body) {
      const groups = optionGroupsSchema.safeParse(req.body.optionGroups || []);
      if (!groups.success) {
        return res.status(400).json({
          error: groups.error.issues[0]?.message || 'Hajm/qo‘shimcha noto‘g‘ri',
          details: groups.error.issues,
        });
      }
      update.optionGroups = groups.data;
    }

    // Faqat o'z taomini o'zgartira olsin
    const dish = await Dish.findOneAndUpdate(
      { _id: req.params.id, restaurantId: rid(req) },
      update,
      { new: true },
    );
    if (!dish) return res.status(404).json({ error: 'Taom topilmadi' });

    // Panel va mijozlar ilovasi darhol yangilanadi
    const count = await Dish.countDocuments({
      restaurantId: rid(req),
      isAvailable: false,
    });
    const io = getIO();
    io?.to(`restaurant:${rid(req)}`).emit('dish:stop', {
      dishId: String(dish._id),
      isAvailable: dish.isAvailable,
      stoppedCount: count,
    });
    io?.emit('dish:update', { restaurantId: String(rid(req)) });

    res.json({ ...dish.toObject(), stoppedCount: count });
  }),

  // PATCH /api/panel/dishes/:id/stop  { stop: true|false }
  // Taomni STOPga tushirish yoki qaytarish (isAvailable teskarisi)
  // GET /api/panel/dishes/stopped — stop'dagi taomlar
  // Menyu sahifasidan alohida: faqat kerakli maydonlar,
  // ortiqcha ma'lumot yuborilmaydi.
  stoppedDishes: asyncHandler(async (req, res) => {
    const dishes = await Dish.find({
      restaurantId: rid(req),
      isAvailable: false,
    })
      .select('name imageUrl images price oldPrice category section volume updatedAt')
      .sort({ updatedAt: -1 })
      .lean();

    res.json(dishes);
  }),

  // GET /api/panel/dishes/stopped/count — faqat son (badge uchun)
  stoppedCount: asyncHandler(async (req, res) => {
    const count = await Dish.countDocuments({
      restaurantId: rid(req),
      isAvailable: false,
    });
    res.json({ count });
  }),

  toggleStop: asyncHandler(async (req, res) => {
    const { stop } = req.body;
    const dish = await Dish.findOneAndUpdate(
      { _id: req.params.id, restaurantId: rid(req) },
      { isAvailable: !stop },
      { new: true },
    );
    if (!dish) return res.status(404).json({ error: 'Taom topilmadi' });
    res.json(dish);
  }),

  // DELETE /api/panel/dishes/:id
  deleteDish: asyncHandler(async (req, res) => {
    const dish = await Dish.findOneAndDelete({ _id: req.params.id, restaurantId: rid(req) });
    if (!dish) return res.status(404).json({ error: 'Taom topilmadi' });
    res.json({ ok: true });
  }),

  // GET /api/panel/orders?status= — o'z buyurtmalari (live)
  orders: asyncHandler(async (req, res) => {
    const filter = {
      restaurantId: rid(req),
      // To'lov kutilayotgan buyurtmalar restoranga KO'RINMAYDI —
      // pul kelgach avtomatik 'pending' bo'ladi va chiqadi
      status: { $ne: 'awaiting_payment' },

      /*
       * ZAL BUYURTMALARI BU YERGA TUSHMAYDI.
       *
       * Bu endpoint "Buyurtmalar" sahifasini to'ldiradi — u
       * mijoz ilovasidan kelgan YETKAZIB BERISH va OLIB KETISH
       * buyurtmalari uchun. Zal (dine-in) buyurtmalari esa
       * "Zal buyurtmalari" sahifasida, boshqa oqim bilan
       * yuritiladi: ular stolga bog'langan, kuryer kerak emas,
       * manzil ham yo'q.
       *
       * Ilgari bu filtr YO'Q edi va zal buyurtmasi yetkazib
       * berish ro'yxatida "YETKAZIB BERISH · Manzil
       * ko'rsatilmagan" bo'lib chiqardi — restoran uni kuryerga
       * bermoqchi bo'lib chalkashardi.
       */
      fulfillment: { $ne: 'dinein' },
    };
    if (req.query.status && req.query.status !== 'all') filter.status = req.query.status;

    // Mijoz ma'lumotlari bilan — restoran bog'lana olishi uchun
    /*
     * Moliyaviy snapshot ichida LokmaGo ICHKI ko'rsatkichlari bor
     * (netto daromad, shlyuz residual). Restoran ularni ko'rmasligi
     * kerak — unga faqat O'Z hisobi ko'rsatiladi (pastda
     * `restaurantFinanceView` bilan qisqartiriladi).
     */
    const orders = await Order.find(filter)
      .populate('userId', 'firstName lastName username telegramId phone photoUrl')
      .sort({ createdAt: -1 })
      .limit(80)
      .lean();

    for (const o of orders) {
      if (o.finance) o.finance = restaurantFinanceView(o.finance);
    }

    // Mijozni qulay ko'rinishga keltiramiz
    const items = orders.map((o) => {
      const u = o.userId || {};
      return {
        ...o,
        userId: u._id ? String(u._id) : null,
        customer: {
          name: [u.firstName, u.lastName].filter(Boolean).join(' ') || 'Mijoz',
          username: u.username || '',
          telegramId: u.telegramId || '',
          phone: o.phone || u.phone || '',
          photoUrl: u.photoUrl || '',
        },
      };
    });

    res.json(items);
  }),

  // PATCH /api/panel/orders/:id/status  { status }
  /*
   * Restoran oqimi: pending -> accepted -> preparing -> ready -> delivering
   *
   * MANTIQ BU YERDA EMAS. U services/orderFlow.js ga ko'chirildi,
   * chunki AYNAN shu mantiq Telegram botga ham kerak (TZ 23-band:
   * "Telegram uchun parallel order logic yaratish taqiqlanadi").
   *
   * Bu kontroller endi faqat HTTP qatlami: so'rovni o'qiydi,
   * service'ni chaqiradi, xatoni HTTP kodiga aylantiradi.
   */
  updateOrderStatus: asyncHandler(async (req, res) => {
    try {
      const { order } = await changeOrderStatus({
        orderId: req.params.id,
        restaurantId: rid(req),
        status: req.body.status,
      });
      return res.json(order);
    } catch (e) {
      if (e instanceof OrderFlowError) {
        // NOT_FOUND -> 404, qolgani -> 400 (mijoz xatosi)
        const code = e.code === 'NOT_FOUND' ? 404 : 400;
        return res.status(code).json({ error: e.message });
      }
      throw e;
    }
  }),

  // ===== RESTORAN BANNERI =====
  // PATCH /api/panel/orders/:id/paid — naqd to'lov qabul qilindi
  markPaid: asyncHandler(async (req, res) => {
    const order = await Order.findOneAndUpdate(
      { _id: req.params.id, restaurantId: rid(req) },
      { isPaid: req.body.paid !== false, paidAt: new Date() },
      { new: true },
    );
    if (!order) return res.status(404).json({ error: 'Buyurtma topilmadi' });

    // Naqd to'lov jurnalga tushadi.
    // Komissiya esa buyurtma yetkazilganda hisoblanadi (settleOrder).
    if (order.isPaid) {
      const { recordPayment } = await import('../services/billing.js');
      await recordPayment(order, 'cash').catch(() => {});
    }

    getIO()?.to('admin').emit('order:update', order);
    res.json(order);
  }),

  // PATCH /api/panel/me — restoran o'z ma'lumotlarini tahrirlaydi
  //
  // XAVFSIZLIK: shartnomaga tegishli maydonlar (komissiya, balans,
  // to'langan summa) va tizim maydonlari (isApproved, isBlocked,
  // ownerId) BU YERDA O'ZGARTIRILMAYDI. Ular faqat adminda.
  updateProfile: asyncHandler(async (req, res) => {
    const schema = z.object({
      // Asosiy
      name: z.string().min(2).max(80).optional(),
      cuisine: z.string().max(80).optional(),
      description: z.string().max(500).optional(),
      phone: z.string().max(30).optional(),
      imageUrl: z.string().url().or(z.literal('')).optional(),

      // Joylashuv
      address: z.string().max(200).optional(),
      landmark: z.string().max(200).optional(),
      lat: z.number().min(-90).max(90).nullable().optional(),
      lng: z.number().min(-180).max(180).nullable().optional(),

      // Ish vaqti
      timezone: z.string().max(50).optional(),
      workingDays: z.array(z.enum(['mon','tue','wed','thu','fri','sat','sun'])).optional(),
      /*
       * Yetkazish: faqat RADIUS qoldi. Yetkazish turi va
       * masofaga qarab bosqichli narx (freeKm, basePrice,
       * extraKmPrice, maxPrice) olib tashlandi — endi bitta
       * narx (`deliveryFee`) va bepul chegara ishlatiladi.
       */
      delivery: z.object({
        maxDistanceKm: z.number().min(0).max(200).optional(),
        // Narx rejimi: qat'iy narx yoki kilometr bo'yicha
        pricingMode: z.enum(['flat', 'perKm']).optional(),
        freeKm: z.number().min(0).max(200).optional(),
        perKm: z.number().min(0).max(1000000).optional(),
      }).optional(),
      openTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      closeTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),

      // Yetkazish shartlari
      deliveryMin: z.number().int().min(0).max(300).optional(),
      deliveryMax: z.number().int().min(0).max(300).optional(),
      deliveryFee: z.number().min(0).max(500000).optional(),
      freeDeliveryThreshold: z.number().min(0).max(10000000).optional(),
      minOrderAmount: z.number().min(0).max(10000000).optional(),

      // Yetkazish xizmati umuman bormi
      deliveryEnabled: z.boolean().optional(),

      // Naqd pul qabul qilinadimi (o'chirilsa faqat karta)
      cashEnabled: z.boolean().optional(),

      // Olib ketish
      pickupEnabled: z.boolean().optional(),
      pickupDiscountPercent: z.number().min(0).max(50).optional(),
      // Yetkazish ustamasi — zal narxiga nisbatan
      deliveryMarkupPercent: z.number().min(0).max(100).optional(),
      prepMinutes: z.number().int().min(1).max(240).optional(),

      // Stol bron qilish
      reservationEnabled: z.boolean().optional(),
      reservationNote: z.string().max(300).optional(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Ma‘lumot noto‘g‘ri',
        details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }

    const data = { ...parsed.data };

    // Yetkazish vaqti mantiqiy bo'lsin
    if (data.deliveryMin != null && data.deliveryMax != null
        && data.deliveryMin > data.deliveryMax) {
      return res.status(400).json({
        error: 'Eng kam yetkazish vaqti eng ko‘pdan katta bo‘lmasligi kerak',
      });
    }

    // Rasm o'zgarsa images ham yangilanadi
    if (data.imageUrl) data.images = [data.imageUrl];

    const restaurant = await Restaurant.findByIdAndUpdate(
      rid(req), data, { new: true, runValidators: true },
    ).select('-ownerId -__v -balance -totalPaidOut -commissionPercent -commissionMode');

    if (!restaurant) return res.status(404).json({ error: 'Restoran topilmadi' });

    // Mijozlar ilovasida yangilansin
    getIO()?.emit('restaurant:update', { _id: String(restaurant._id) });

    res.json(restaurant);
  }),

  // GET /api/panel/banner — muassasa rasmi
  // Banner alohida saqlanmaydi: muassasa yozuvidagi rasm — banner.
  getBanner: asyncHandler(async (req, res) => {
    const r = await Restaurant.findById(rid(req)).select('imageUrl').lean();
    res.json(r?.imageUrl ? { imageUrl: r.imageUrl } : null);
  }),

  // PUT /api/panel/banner — rasmni almashtirish
  setBanner: asyncHandler(async (req, res) => {
    const schema = z.object({ imageUrl: z.string().min(1) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Banner rasmi majburiy' });

    const { imageUrl } = parsed.data;
    const restaurant = await Restaurant.findByIdAndUpdate(
      rid(req),
      { imageUrl, images: [imageUrl] },
      { new: true },
    ).select('imageUrl').lean();

    // Real-time: mijoz ilovasi va admin panel darhol yangilanadi
    const io = getIO();
    io?.to('admin').emit('restaurant:update', { _id: String(rid(req)) });

    res.json({ imageUrl: restaurant?.imageUrl || '' });
  }),

  // DELETE /api/panel/banner — rasmni olib tashlash
  deleteBanner: asyncHandler(async (req, res) => {
    await Restaurant.findByIdAndUpdate(rid(req), { imageUrl: '', images: [] });
    getIO()?.to('admin').emit('restaurant:update', { _id: String(rid(req)) });
    res.json({ ok: true });
  }),

};
