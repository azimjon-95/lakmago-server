import { asyncHandler } from '../middleware/error.js';
import { Restaurant } from '../models/Restaurant.js';
import { User } from '../models/User.js';
import { Order } from '../models/Order.js';

export const adminController = {
  // GET /api/admin/stats — umumiy analitika
  stats: asyncHandler(async (_req, res) => {
    const [restaurants, pendingRestaurants, users, orders] = await Promise.all([
    Restaurant.countDocuments(),
    Restaurant.countDocuments({ isApproved: false }),
    User.countDocuments(),
    Order.countDocuments()]
    );

    const revenueAgg = await Order.aggregate([
    { $match: { status: 'delivered' } },
    { $group: { _id: null, total: { $sum: '$total' } } }]
    );
    const totalRevenue = revenueAgg[0]?.total ?? 0;
    // Platforma komissiyasi (masalan 12%)
    const commission = Math.round(totalRevenue * 0.12);

    res.json({ restaurants, pendingRestaurants, users, orders, totalRevenue, commission });
  }),

  // GET /api/admin/restaurants?status=pending
  restaurants: asyncHandler(async (req, res) => {
    const filter = {};
    if (req.query.status === 'pending') filter.isApproved = false;
    if (req.query.status === 'approved') filter.isApproved = true;
    const list = await Restaurant.find(filter).sort({ createdAt: -1 });
    res.json(list);
  }),

  // PATCH /api/admin/restaurants/:id/approve  { approved }
  approveRestaurant: asyncHandler(async (req, res) => {
    const { approved } = req.body;
    const restaurant = await Restaurant.findByIdAndUpdate(
      req.params.id,
      { isApproved: approved },
      { new: true }
    );
    if (!restaurant) return res.status(404).json({ error: 'Restoran topilmadi' });
    res.json(restaurant);
  }),

  // GET /api/admin/users
  users: asyncHandler(async (_req, res) => {
    const users = await User.find().sort({ createdAt: -1 }).limit(100);
    res.json(users);
  })
};
