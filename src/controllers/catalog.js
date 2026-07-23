import { asyncHandler } from '../middleware/error.js';
import { Restaurant } from '../models/Restaurant.js';
import { Dish } from '../models/Dish.js';
import { Order } from '../models/Order.js';

// MongoDB ObjectId formatини tekshirish — noto'g'ri ID kelса server yiqilmasин,
// aniq 404 qaytarsin (masalan eski mock ID 'r1' kelганда).
const isValidId = (id) => typeof id === 'string' && /^[a-f\d]{24}$/i.test(id);

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

    // select: faqat karta uchun kerakli maydonlar (tarmoq trafigini kamaytiradi)
    const restaurants = await Restaurant.find(filter)
      .select('name cuisine category kind rating reviewCount deliveryMin deliveryMax deliveryFee discount isFresh tint icon images imageUrl createdAt pickupEnabled prepMinutes shopTypes')
      .sort({ createdAt: -1 })
      .limit(limit + 1)
      .lean();

    // Keyingi sahifa bormi?
    const hasMore = restaurants.length > limit;
    const items = hasMore ? restaurants.slice(0, limit) : restaurants;
    const nextCursor = hasMore ? items[items.length - 1].createdAt : null;

    res.json({ items, nextCursor, hasMore });
  }),

  // GET /api/restaurants/:id
  getOne: asyncHandler(async (req, res) => {
    if (!isValidId(req.params.id)) return res.status(404).json({ error: 'Restoran topilmadi' });
    const restaurant = await Restaurant.findById(req.params.id)
      .select('-ownerId -__v')
      .lean();
    if (!restaurant) return res.status(404).json({ error: 'Restoran topilmadi' });
    if (restaurant.isBlocked || !restaurant.isActive) {
      return res.status(404).json({ error: 'Restoran hozircha mavjud emas' });
    }
    res.json(restaurant);
  }),

  // GET /api/dishes/:id  — bitta taom (ulashilган havola ochilganda kerak)
  getDishById: asyncHandler(async (req, res) => {
    if (!isValidId(req.params.id)) return res.status(404).json({ error: 'Taom topilmadi' });
    const dish = await Dish.findById(req.params.id).lean();
    if (!dish) return res.status(404).json({ error: 'Taom topilmadi' });
    // Taom restorani bloklangan/nofaol bo'lsa ko'rsatmaymiz
    const restaurant = await Restaurant.findById(dish.restaurantId).select('isBlocked isActive name').lean();
    if (!restaurant || restaurant.isBlocked || !restaurant.isActive) {
      return res.status(404).json({ error: 'Taom mavjud emas' });
    }
    res.json({ ...dish, restaurantName: restaurant.name });
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
      .select('restaurantId name description section category prepMinutes price oldPrice weightGram calories ingredients optionGroups isHit isTrending isDiscounted tint icon images imageUrl isAvailable')
      .lean();
    res.json(dishes);
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
    const dishes = await Dish.find({ isTrending: true, isAvailable: true }).limit(10);
    res.json(dishes);
  }),

  // GET /api/dishes/discounted
  discounted: asyncHandler(async (_req, res) => {
    const dishes = await Dish.find({ isDiscounted: true, isAvailable: true }).limit(10);
    res.json(dishes);
  }),

  // GET /api/dishes/all?cursor=&limit=  — BARCHA restoranlarнинг taomlarи aralash
  // Bosh sahifада ko'rsatiladi (faqat faol, bloklanмаgan restoranlar).
  all: asyncHandler(async (req, res) => {
    // Faqat ko'rinadigan (faol, bloklanмаган, tasdiqlangan) restoranlar
    const visibleRestaurants = await Restaurant.find({
      isApproved: true, isActive: true, isBlocked: { $ne: true },
    }).select('_id name tint icon imageUrl').lean();

    const restMap = new Map(visibleRestaurants.map((r) => [String(r._id), r]));
    const restIds = visibleRestaurants.map((r) => r._id);

    const filter = { restaurantId: { $in: restIds }, isAvailable: true };
    if (req.query.cursor) filter.createdAt = { $lt: new Date(req.query.cursor) };
    const limit = Math.min(Number(req.query.limit) || 20, 50);

    const dishes = await Dish.find(filter)
      .select('name description section price oldPrice imageUrl images tint icon restaurantId isHit isDiscounted createdAt')
      .sort({ createdAt: -1 })
      .limit(limit + 1)
      .lean();

    const hasMore = dishes.length > limit;
    const items = (hasMore ? dishes.slice(0, limit) : dishes).map((d) => {
      const r = restMap.get(String(d.restaurantId));
      return { ...d, restaurantName: r?.name || '', restaurantTint: r?.tint, restaurantIcon: r?.icon };
    });
    const nextCursor = hasMore ? items[items.length - 1].createdAt : null;

    res.json({ items, nextCursor, hasMore });
  })
};
