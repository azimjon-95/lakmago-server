import { asyncHandler } from '../middleware/error.js';
import { cached, KEYS, TTL } from '../services/cache.js';
import { Restaurant } from '../models/Restaurant.js';
import { Dish } from '../models/Dish.js';
import { Order } from '../models/Order.js';
import { isRestaurantOpen } from '../services/restaurantTime.js';

// MongoDB ObjectId formatини tekshirish — noto'g'ri ID kelса server yiqilmasин,
// aniq 404 qaytarsin (masalan eski mock ID 'r1' kelганда).
const isValidId = (id) => typeof id === 'string' && /^[a-f\d]{24}$/i.test(id);


/**
 * Bir necha restoran uchun narx koeffitsientlarini bir marta oladi.
 *
 * Har taomga alohida so'rov yubormaslik uchun: 50 ta taom bo'lsa
 * ham shartnomalar va ustamalar ikkita so'rovda olinadi.
 */
async function pricingMap(restaurantIds) {
  const { CommissionAgreement } = await import('../models/CommissionAgreement.js');
  const now = new Date();

  const [restaurants, agreements] = await Promise.all([
    Restaurant.find({ _id: { $in: restaurantIds } })
      .select('deliveryMarkupPercent').lean(),
    CommissionAgreement.find({
      restaurantId: { $in: restaurantIds },
      status: 'ACTIVE',
      effectiveFrom: { $lte: now },
      $or: [{ effectiveTo: null }, { effectiveTo: { $gt: now } }],
    }).lean(),
  ]);

  const markup = new Map(restaurants.map((r) =>
    [String(r._id), Number(r.deliveryMarkupPercent) || 0]));
  const fee = new Map(agreements.map((a) =>
    [String(a.restaurantId), Number(a.customerFeePercent) || 0]));

  const map = new Map();
  restaurantIds.forEach((id) => {
    const key = String(id);
    map.set(key, {
      deliveryMarkupPercent: markup.get(key) || 0,
      customerFeePercent: fee.get(key) || 0,
    });
  });
  return map;
}

/**
 * Ro'yxatdagi taomlarga mijoz narxini qo'yadi.
 *
 * MUHIM: narx hisobi yiqilsa ham menyu KO'RINISHI kerak —
 * mijoz taomlarni umuman ko'rmay qolgandan ko'ra baza narxni
 * ko'rgani yaxshiroq. Shuning uchun xato ushlanadi.
 */
async function withCustomerPrices(dishes) {
  if (!Array.isArray(dishes) || dishes.length === 0) return dishes || [];
  try {
    const { applyPricing } = await import('../services/customerPricing.js');
    const ids = [...new Set(dishes.map((d) => String(d.restaurantId)).filter(Boolean))];
    if (ids.length === 0) return dishes;

    const ctxMap = await pricingMap(ids);
    const zero = { deliveryMarkupPercent: 0, customerFeePercent: 0 };
    return dishes.map((d) => applyPricing(d, ctxMap.get(String(d.restaurantId)) || zero));
  } catch (err) {
    console.error('[pricing] narx qo\'llanmadi, baza narx ko\'rsatiladi:', err.message);
    return dishes;
  }
}

export const restaurantController = {
  // GET /api/restaurants?category=milliy&cursor=<createdAt>&limit=20
  // Cursor-based pagination — katta ro'yxatlar tez yuklanadi
  list: asyncHandler(async (req, res) => {
    const filter = { isApproved: true, isActive: true, isBlocked: { $ne: true } };
    if (req.query.category && req.query.category !== 'all') {
      filter.category = req.query.category;
    }
    // Cursor: oldingi sahifaning oxirgi createdAt qiymati
    if (req.query.cursor) {
      filter.createdAt = { $lt: new Date(req.query.cursor) };
    }
    const limit = Math.min(Number(req.query.limit) || 20, 50);

    /*
     * KESHLASH — DIQQAT BILAN.
     *
     * FAQAT baza so'rovi natijasi keshlanadi. `isOpen` maydoni
     * kesh ichiga KIRMAYDI va har so'rovda qaytadan hisoblanadi
     * (pastda) — chunki u VAQTGA bog'liq: 2 daqiqalik kesh ham
     * restoran yopilgandan keyin uni "ochiq" ko'rsatib qo'yardi.
     * Bu yaqinda tuzatilgan vaqt-mintaqasi xatosini qaytarib
     * keltirgan bo'lardi.
     *
     * Kesh kaliti so'rov parametrlaridan tuziladi — turli
     * kategoriya/sahifa alohida keshlanadi.
     */
    const cacheKey = KEYS.catalogList(
      `${req.query.category || 'all'}:${req.query.cursor || '0'}:${limit}`,
    );

    const restaurants = await cached(cacheKey, TTL.catalog, () => Restaurant.find(filter)
      .select('name cuisine category kind rating reviewCount deliveryMin deliveryMax deliveryFee freeDeliveryThreshold minOrderAmount discount isFresh tint icon images imageUrl createdAt pickupEnabled deliveryEnabled pickupDiscountPercent prepMinutes shopTypes openTime closeTime timezone workingDays')
      .sort({ createdAt: -1 })
      .limit(limit + 1)
      .lean());

    // Keyingi sahifa bormi?
    const hasMore = restaurants.length > limit;
    const items = (hasMore ? restaurants.slice(0, limit) : restaurants)
      // isOpen — DOIM Toshkent (yoki restoranning o'z) vaqt
      // mintaqasidan hisoblanadi, mijoz qurilmasi qaysi davlatda
      // bo'lishidan qat'i nazar bir xil natija. Mijoz o'zi
      // qayta hisoblamasin — bitta haqiqat manbai shu yerda.
      .map((r) => ({ ...r, isOpen: isRestaurantOpen(r) }));
    const nextCursor = hasMore ? items[items.length - 1].createdAt : null;

    res.json({ items, nextCursor, hasMore });
  }),

  // GET /api/restaurants/:id
  getOne: asyncHandler(async (req, res) => {
    if (!isValidId(req.params.id)) return res.status(404).json({ error: 'Restoran topilmadi' });

    /*
     * XAVFSIZLIK: "oq ro'yxat" (faqat kerakli maydonlar),
     * "qora ro'yxat" EMAS.
     *
     * ILGARI: .select('-ownerId -__v') — "hammasini qaytar,
     * faqat shu ikkitasini yashir". Bu XAVFLI naqsh: modelda
     * XOHLAGAN vaqt yangi maxfiy maydon qo'shilsa (masalan
     * bank hisob raqami), u AVTOMATIK ravishda mijozga oshkor
     * bo'lib qolardi — hech kim buni sezmasdan.
     *
     * Tekshirsam, bu ANIQ SODIR BO'LGAN edi: model'da
     * `balance` (LokmaGo-restoran hisob-kitob balansi),
     * `commissionPercent`/`commissionMode` (shartnoma
     * komissiyasi — biznes siri), `totalPaidOut`,
     * `totalOrders`, `contractNumber`/`contractDate`
     * (shartnoma ma'lumotlari), `deliveryMarkupPercent`
     * (yetkazishga qo'shilgan ICHKI ustama foizi) va
     * `phone` (shaxsiy telefon) — BARCHASI istalgan kishiga
     * GET /restaurants/:id orqali ko'rinib turardi.
     *
     * Endi faqat mijozga KERAKLI, XAVFSIZ maydonlar sanab
     * chiqiladi. Yangi maxfiy maydon qo'shilsa — bu ro'yxatda
     * bo'lmagani uchun AVTOMATIK yashirin qoladi, aksincha emas.
     */
    const restaurant = await Restaurant.findById(req.params.id)
      .select([
        'name', 'cuisine', 'category', 'kind',
        'rating', 'reviewCount',
        'deliveryMin', 'deliveryMax', 'deliveryFee', 'freeDeliveryThreshold',
        'tint', 'icon', 'imageUrl', 'images', 'discount',
        'address', 'lat', 'lng', 'landmark',
        'openTime', 'closeTime', 'timezone', 'workingDays',
        'legalName', 'legalAddress', 'inn',
        'minOrderAmount',
        'delivery',
        'serviceFeePercent', 'serviceFeeMin', 'serviceFeeMax',
        'pickupEnabled', 'pickupDiscountPercent',
        'deliveryEnabled',
        'prepMinutes',
        'shopTypes',
        'reservationEnabled', 'reservationNote',
        'isFresh', 'isBlocked', 'isActive',   // status filtri uchun quyida kerak
        'createdAt',
      ].join(' '))
      .lean();
    if (!restaurant) return res.status(404).json({ error: 'Restoran topilmadi' });
    if (restaurant.isBlocked || !restaurant.isActive) {
      return res.status(404).json({ error: 'Restoran hozircha mavjud emas' });
    }
    // isBlocked/isActive faqat yuqoridagi tekshiruv uchun kerak edi —
    // javobda mijozga chiqarilmaydi (texnik holat, ma'nosi yo'q)
    delete restaurant.isBlocked;
    delete restaurant.isActive;

    // isOpen — DOIM Toshkent (yoki restoranning o'z) vaqt
    // mintaqasidan hisoblanadi, mijoz qurilmasi qaysi davlatda
    // bo'lishidan qat'i nazar bir xil natija.
    restaurant.isOpen = isRestaurantOpen(restaurant);

    // Mijozlar sharhlari — baholangan buyurtmalardan yig'iladi.
    // Xato bo'lsa restoran baribir ochiladi, faqat sharhlar
    // bo'sh qoladi. Avval bu yerda xato butun so'rovni qulatardi.
    restaurant.reviews = [];

    try {
      const rated = await Order.find({
        restaurantId: restaurant._id,
        rating: { $gte: 1 },
      })
        .select('rating comment ratedAt userId')
        .populate('userId', 'firstName photoUrl')
        .sort({ ratedAt: -1 })
        .limit(30)
        .lean();

      const MONTHS = [
        'yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun',
        'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr',
      ];
      const fmtDate = (d) => {
        if (!d) return '';
        const date = new Date(d);
        if (Number.isNaN(date.getTime())) return '';
        return `${date.getDate()}-${MONTHS[date.getMonth()]}`;
      };

      restaurant.reviews = rated.map((r) => ({
        id: String(r._id),
        rating: Number(r.rating) || 0,
        comment: r.comment || '',
        name: r.userId?.firstName || 'Mijoz',
        photoUrl: r.userId?.photoUrl || '',
        date: fmtDate(r.ratedAt),
      }));
    } catch (e) {
      console.error('[catalog] sharhlar yuklanmadi:', e.message);
    }

    res.json(restaurant);
  }),

  // GET /api/dishes/:id  — bitta taom (ulashilган havola ochilganda kerak)
  getDishById: asyncHandler(async (req, res) => {
    if (!isValidId(req.params.id)) return res.status(404).json({ error: 'Taom topilmadi' });
    const dish = await Dish.findById(req.params.id).lean();
    if (!dish) return res.status(404).json({ error: 'Taom topilmadi' });
    // Taom restorani bloklangan/nofaol bo'lsa ko'rsatmaymiz
    // (deliveryMarkupPercent BU YERDA ishlatilmaydi — narx
    // withCustomerPrices() ichida alohida hisoblanadi; keraksiz
    // maxfiy maydonni so'ramaslik uchun select'dan olib tashlandi)
    const restaurant = await Restaurant.findById(dish.restaurantId)
      .select('isBlocked isActive name').lean();
    if (!restaurant || restaurant.isBlocked || !restaurant.isActive) {
      return res.status(404).json({ error: 'Taom mavjud emas' });
    }
    const [priced] = await withCustomerPrices([dish]);
    res.json({ ...priced, restaurantName: restaurant.name });
  }),

  // GET /api/restaurants/:id/dishes
  getDishes: asyncHandler(async (req, res) => {
    if (!isValidId(req.params.id)) return res.json([]);
    const restaurant = await Restaurant.findById(req.params.id).select('isBlocked isActive').lean();
    if (!restaurant || restaurant.isBlocked || !restaurant.isActive) {
      return res.json([]);
    }
    const dishes = await Dish.find({
      restaurantId: req.params.id,
      isAvailable: true
    })
      .select('restaurantId name description section category prepMinutes price oldPrice weight weightGram volume drinkType calories protein fat carbs ingredients optionGroups isHit isTrending isDiscounted tint icon images imageUrl isAvailable')
      .lean();

    // Mijozga yetkazish narxi ko'rsatiladi: baza + ustama + xizmat haqi.
    // Zal menyusi alohida endpointda (dineInPricing) va u tegilmaydi.
    res.json(await withCustomerPrices(dishes));
  }),

  // GET /api/restaurants/:id/orders  (restoran paneli uchun)
  getOrders: asyncHandler(async (req, res) => {
    const orders = await Order.find({ restaurantId: req.params.id }).
    sort({ createdAt: -1 }).
    limit(50);
    res.json(orders);
  })
};

export const dishManageController = {
  // PATCH /api/dishes/:id  (mavjudlik/narx yangilash)
  update: asyncHandler(async (req, res) => {
    const allowed = ['isAvailable', 'price', 'oldPrice', 'name', 'description'];
    const update = {};
    for (const key of allowed) {
      if (key in req.body) update[key] = req.body[key];
    }
    const dish = await Dish.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!dish) return res.status(404).json({ error: 'Taom topilmadi' });
    res.json(dish);
  }),

  // POST /api/restaurants/:id/dishes  (yangi taom)
  create: asyncHandler(async (req, res) => {
    const dish = await Dish.create({ ...req.body, restaurantId: req.params.id });
    res.status(201).json(dish);
  })
};

export const dishController = {
  // GET /api/dishes/trending
  trending: asyncHandler(async (_req, res) => {
    // Faqat ko'rinadigan restoranlar taomlari
    const visible = await Restaurant.find({
      isApproved: true, isActive: true, isBlocked: { $ne: true },
    }).select('_id name tint icon openTime closeTime').lean();
    const restMap = new Map(visible.map((r) => [String(r._id), r]));

    const dishes = await Dish.find({
      isTrending: true,
      isAvailable: true,
      restaurantId: { $in: visible.map((r) => r._id) },
    }).limit(20).lean();

    const priced = await withCustomerPrices(dishes);
    res.json(priced.map((d) => {
      const r = restMap.get(String(d.restaurantId));
      return {
        ...d,
        restaurantName: r?.name || '',
        restaurantOpenTime: r?.openTime || '',
        restaurantCloseTime: r?.closeTime || '',
      };
    }));
  }),

  // GET /api/dishes/discounted
  discounted: asyncHandler(async (_req, res) => {
    // Faqat ko'rinadigan restoranlar taomlari
    const visible = await Restaurant.find({
      isApproved: true, isActive: true, isBlocked: { $ne: true },
    }).select('_id name tint icon openTime closeTime').lean();
    const restMap = new Map(visible.map((r) => [String(r._id), r]));

    const dishes = await Dish.find({
      isDiscounted: true,
      isAvailable: true,
      restaurantId: { $in: visible.map((r) => r._id) },
    }).limit(20).lean();

    const priced = await withCustomerPrices(dishes);
    res.json(priced.map((d) => {
      const r = restMap.get(String(d.restaurantId));
      return {
        ...d,
        restaurantName: r?.name || '',
        restaurantOpenTime: r?.openTime || '',
        restaurantCloseTime: r?.closeTime || '',
      };
    }));
  }),

  // GET /api/dishes/all?cursor=&limit=  — BARCHA restoranlarнинг taomlarи aralash
  // Bosh sahifада ko'rsatiladi (faqat faol, bloklanмаgan restoranlar).
  all: asyncHandler(async (req, res) => {
    // Faqat ko'rinadigan (faol, bloklanмаган, tasdiqlangan) restoranlar
    const visibleRestaurants = await Restaurant.find({
      isApproved: true, isActive: true, isBlocked: { $ne: true },
    }).select('_id name tint icon imageUrl deliveryMin deliveryMax deliveryFee freeDeliveryThreshold minOrderAmount prepMinutes openTime closeTime').lean();

    const restMap = new Map(visibleRestaurants.map((r) => [String(r._id), r]));
    const restIds = visibleRestaurants.map((r) => r._id);

    const filter = { restaurantId: { $in: restIds }, isAvailable: true };
    if (req.query.cursor) filter.createdAt = { $lt: new Date(req.query.cursor) };
    const limit = Math.min(Number(req.query.limit) || 20, 50);

    const dishes = await Dish.find(filter)
      .select('name description section category price oldPrice imageUrl images tint icon restaurantId isHit isDiscounted createdAt weight weightGram calories protein fat carbs prepMinutes ingredients optionGroups')
      .sort({ createdAt: -1 })
      .limit(limit + 1)
      .lean();

    const hasMore = dishes.length > limit;
    const pricedAll = await withCustomerPrices(hasMore ? dishes.slice(0, limit) : dishes);
    const items = pricedAll.map((d) => {
      const r = restMap.get(String(d.restaurantId));
      return {
        ...d,
        restaurantName: r?.name || '',
        restaurantTint: r?.tint,
        restaurantIcon: r?.icon,
        // Savatda yetkazish hisobi uchun kerak
        restaurantDeliveryMin: r?.deliveryMin ?? 25,
        restaurantDeliveryMax: r?.deliveryMax ?? 40,
        restaurantDeliveryFee: r?.deliveryFee ?? 0,
        restaurantFreeDeliveryThreshold: r?.freeDeliveryThreshold ?? 0,
        restaurantMinOrderAmount: r?.minOrderAmount ?? 0,
        restaurantPrepMinutes: r?.prepMinutes ?? 20,
        // Ish vaqti — yopiq restoran taomlari ro'yxatdan chiqadi
        restaurantOpenTime: r?.openTime || '',
        restaurantCloseTime: r?.closeTime || '',
      };
    });
    const nextCursor = hasMore ? items[items.length - 1].createdAt : null;

    res.json({ items, nextCursor, hasMore });
  })
};
