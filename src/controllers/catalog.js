import { asyncHandler } from '../middleware/error.js';
import { Restaurant } from '../models/Restaurant.js';
import { Dish } from '../models/Dish.js';
import { Order } from '../models/Order.js';

export const restaurantController = {
  // GET /api/restaurants?category=milliy
  list: asyncHandler(async (req, res) => {
    // Mijozga faqat faol (ochiq) muassasalar ko'rinadi
    const filter = { isApproved: true, isActive: true };
    if (req.query.category && req.query.category !== 'all') {
      filter.category = req.query.category;
    }
    const restaurants = await Restaurant.find(filter).sort({ rating: -1 });
    res.json(restaurants);
  }),

  // GET /api/restaurants/:id
  getOne: asyncHandler(async (req, res) => {
    const restaurant = await Restaurant.findById(req.params.id);
    if (!restaurant) return res.status(404).json({ error: 'Restoran topilmadi' });
    res.json(restaurant);
  }),

  // GET /api/restaurants/:id/dishes
  getDishes: asyncHandler(async (req, res) => {
    const dishes = await Dish.find({
      restaurantId: req.params.id,
      isAvailable: true
    });
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
