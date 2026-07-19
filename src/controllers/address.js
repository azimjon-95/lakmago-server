import { z } from 'zod';
import { asyncHandler } from '../middleware/error.js';
import { User } from '../models/User.js';

const addressSchema = z.object({
  title: z.string().min(1).default('Manzil'),
  address: z.string().min(1),
  street: z.string().optional().default(''),
  city: z.string().optional().default(''),
  entrance: z.string().optional().default(''),
  floor: z.string().optional().default(''),
  flat: z.string().optional().default(''),
  note: z.string().optional().default(''),
  labelId: z.string().optional().default('other'),
  lat: z.number().optional(),
  lng: z.number().optional(),
});

export const addressController = {
  // GET /api/addresses — mening manzillarim
  list: asyncHandler(async (req, res) => {
    const user = await User.findById(req.userId).select('addresses defaultAddressId').lean();
    if (!user) return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });
    res.json({
      addresses: user.addresses || [],
      defaultAddressId: user.defaultAddressId || null,
    });
  }),

  // POST /api/addresses — yangi manzil qo'shish
  create: asyncHandler(async (req, res) => {
    const parsed = addressSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Manzil ma\u2018lumoti noto\u2018g\u2018ri', details: parsed.error.issues });
    }
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });

    user.addresses.push(parsed.data);
    // Yangi qo'shilgan manzil darhol tanlanadi
    const added = user.addresses[user.addresses.length - 1];
    user.defaultAddressId = added._id;
    await user.save();

    res.status(201).json({
      addresses: user.addresses,
      defaultAddressId: user.defaultAddressId,
    });
  }),

  // PATCH /api/addresses/:id — tahrirlash
  update: asyncHandler(async (req, res) => {
    const parsed = addressSchema.partial().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Ma\u2018lumot noto\u2018g\u2018ri' });

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });

    const addr = user.addresses.id(req.params.id);
    if (!addr) return res.status(404).json({ error: 'Manzil topilmadi' });

    Object.assign(addr, parsed.data);
    await user.save();
    res.json({ addresses: user.addresses, defaultAddressId: user.defaultAddressId });
  }),

  // DELETE /api/addresses/:id
  remove: asyncHandler(async (req, res) => {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });

    const addr = user.addresses.id(req.params.id);
    if (!addr) return res.status(404).json({ error: 'Manzil topilmadi' });

    addr.deleteOne();
    // Tanlangan manzil o'chirilsa — birinchisiga o'tamiz
    if (String(user.defaultAddressId) === String(req.params.id)) {
      user.defaultAddressId = user.addresses[0]?._id || null;
    }
    await user.save();
    res.json({ addresses: user.addresses, defaultAddressId: user.defaultAddressId });
  }),

  // PATCH /api/addresses/:id/default — asosiy qilib belgilash
  setDefault: asyncHandler(async (req, res) => {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });

    const addr = user.addresses.id(req.params.id);
    if (!addr) return res.status(404).json({ error: 'Manzil topilmadi' });

    user.defaultAddressId = addr._id;
    await user.save();
    res.json({ defaultAddressId: user.defaultAddressId });
  }),
};
