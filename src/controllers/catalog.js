import { asyncHandler } from '../middleware/error.js';
import { Restaurant } from '../models/Restaurant.js';
import { Dish } from '../models/Dish.js';
import { Order } from '../models/Order.js';

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
      .select('name cuisine category kind rating reviewCount deliveryMin deliveryMax deliveryFee discount isFresh tint icon images createdAt')
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
    const restaurant = await Restaurant.findById(req.params.id)
      .select('-ownerId -__v')
      .lean();
    if (!restaurant) return res.status(404).json({ error: 'Restoran topilmadi' });
    if (restaurant.isBlocked || !restaurant.isActive) {
      return res.status(404).json({ error: 'Restoran hozircha mavjud emas' });
    }
    res.json(restaurant);
  }),

  // GET /api/restaurants/:id/dishes
  getDishes: asyncHandler(async (req, res) => {
    const restaurant = await Restaurant.findById(req.params.id).select('isBlocked isActive').lean();
    if (!restaurant || restaurant.isBlocked || !restaurant.isActive) {
      return res.json([]);
    }
    const dishes = await Dish.find({
      restaurantId: req.params.id,
      isAvailable: true
    })
      .select('name description section price oldPrice weightGram calories ingredients optionGroups isHit isTrending isDiscounted tint icon images isAvailable')
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
  })
};
