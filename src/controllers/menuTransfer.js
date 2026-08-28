import { z } from 'zod';
import { asyncHandler } from '../middleware/error.js';
import { MenuTransfer } from '../models/MenuTransfer.js';
import { Dish } from '../models/Dish.js';
import { Restaurant } from '../models/Restaurant.js';
import { getIO } from '../sockets/io.js';

const rid = (req) => req.restaurantId;

// Bir vaqtda nechta taom nusxalanadi — katta menyu serverni bloklamasin
const BATCH_SIZE = 25;

/**
 * Taomni nusxalash uchun tayyorlaydi.
 *
 * Ko'chiriladi: kategoriya, nom, tavsif, rasm, narx,
 *               variantlar (optionGroups), ozuqaviy ma'lumot
 * Ko'chirilmaydi: mavjudlik holati, stop, hit/trending
 *                 belgilari — ular har filialga xos
 */
function prepareCopy(dish, toRestaurantId) {
  return {
    restaurantId: toRestaurantId,
    name: dish.name,
    description: dish.description || '',
    category: dish.category,
    section: dish.section || dish.category,
    price: dish.price,
    oldPrice: dish.oldPrice,
    imageUrl: dish.imageUrl || '',
    images: dish.images || [],
    tint: dish.tint,
    icon: dish.icon,
    optionGroups: dish.optionGroups || [],
    ingredients: dish.ingredients || [],
    weight: dish.weight || '',
    volume: dish.volume || '',
    calories: dish.calories,
    protein: dish.protein,
    fat: dish.fat,
    carbs: dish.carbs,
    prepMinutes: dish.prepMinutes ?? 15,
    catalogProductId: dish.catalogProductId || null,

    // Yangi filialda faol, stop emas
    isAvailable: true,
    isHit: false,
    isTrending: false,
    isDiscounted: false,
  };
}

/**
 * Taomlarni ko'chiradi. Takrorlanmaydi — bir xil nom va
 * hajmdagi taom bo'lsa o'tkazib yuboriladi.
 *
 * Bosqichma-bosqich ishlaydi: katta menyu bo'lsa ham server
 * qotib qolmaydi.
 */
async function copyDishes(transfer) {
  const dishes = await Dish.find({ _id: { $in: transfer.dishIds } }).lean();

  // Qabul qiluvchida nima borligini bir marta olamiz
  const existing = await Dish.find({ restaurantId: transfer.toRestaurantId })
    .select('name volume')
    .lean();

  const key = (n, v) => `${String(n).trim().toLowerCase()}|${String(v || '').trim().toLowerCase()}`;
  const existingKeys = new Set(existing.map((d) => key(d.name, d.volume)));

  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < dishes.length; i += BATCH_SIZE) {
    const batch = dishes.slice(i, i + BATCH_SIZE);
    const toInsert = [];

    for (const d of batch) {
      const k = key(d.name, d.volume);
      if (existingKeys.has(k)) {
        skipped++;
        continue;
      }
      existingKeys.add(k); // shu partiya ichida ham takrorlanmasin
      toInsert.push(prepareCopy(d, transfer.toRestaurantId));
    }

    if (toInsert.length) {
      try {
        const res = await Dish.insertMany(toInsert, { ordered: false });
        created += res.length;
      } catch (e) {
        // ordered: false — qismi o'tadi, qolgani xato beradi
        created += e.insertedDocs?.length || 0;
        failed += toInsert.length - (e.insertedDocs?.length || 0);
      }
    }
  }

  return { created, skipped, failed };
}

export const menuTransferController = {
  // GET /api/panel/restaurants/search?q=
  // Qabul qiluvchi filialni qidirish
  searchRestaurants: asyncHandler(async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json([]);

    const list = await Restaurant.find({
      _id: { $ne: rid(req) },          // o'zini ko'rsatmaymiz
      isActive: true,
      isBlocked: { $ne: true },
      name: { $regex: q, $options: 'i' },
    })
      .select('name address imageUrl category')
      .limit(10)
      .lean();

    res.json(list);
  }),

  // POST /api/panel/menu-transfers
  create: asyncHandler(async (req, res) => {
    const schema = z.object({
      toRestaurantId: z.string().length(24),
      mode: z.enum(['all', 'selected']).default('selected'),
      dishIds: z.array(z.string().length(24)).optional().default([]),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Ma‘lumot noto‘g‘ri' });
    }

    const { toRestaurantId, mode } = parsed.data;

    if (String(toRestaurantId) === String(rid(req))) {
      return res.status(400).json({ error: 'O‘ziga ko‘chirib bo‘lmaydi' });
    }

    const target = await Restaurant.findById(toRestaurantId).select('name isActive isBlocked');
    if (!target || !target.isActive || target.isBlocked) {
      return res.status(404).json({ error: 'Filial topilmadi yoki faol emas' });
    }

    // Ko'chiriladigan taomlarni aniqlaymiz
    let dishIds;
    if (mode === 'all') {
      const all = await Dish.find({ restaurantId: rid(req) }).select('_id').lean();
      dishIds = all.map((d) => d._id);
    } else {
      // Faqat o'z taomlari — boshqa restoran taomini yubora olmaydi
      const own = await Dish.find({
        _id: { $in: parsed.data.dishIds },
        restaurantId: rid(req),
      }).select('_id').lean();
      dishIds = own.map((d) => d._id);
    }

    if (dishIds.length === 0) {
      return res.status(400).json({ error: 'Taom tanlanmagan' });
    }

    // Shu filialga kutilayotgan so'rov bormi
    const pending = await MenuTransfer.findOne({
      fromRestaurantId: rid(req),
      toRestaurantId,
      status: 'pending',
    });
    if (pending) {
      return res.status(400).json({
        error: 'Bu filialga yuborilgan so‘rov hali javobsiz',
      });
    }

    const me = await Restaurant.findById(rid(req)).select('name').lean();

    const transfer = await MenuTransfer.create({
      fromRestaurantId: rid(req),
      fromRestaurantName: me?.name || '',
      toRestaurantId,
      toRestaurantName: target.name,
      dishIds,
      mode,
    });

    // Qabul qiluvchiga darhol xabar
    getIO()?.to(`restaurant:${toRestaurantId}`).emit('transfer:new', {
      id: String(transfer._id),
      from: me?.name || '',
      count: dishIds.length,
    });

    res.status(201).json(transfer);
  }),

  // GET /api/panel/menu-transfers?box=in|out
  list: asyncHandler(async (req, res) => {
    const box = req.query.box === 'out' ? 'out' : 'in';
    const filter = box === 'out'
      ? { fromRestaurantId: rid(req) }
      : { toRestaurantId: rid(req) };

    const items = await MenuTransfer.find(filter)
      .select('-dishIds')            // ro'yxatda ID lar kerak emas
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    res.json(items);
  }),

  // GET /api/panel/menu-transfers/:id — tafsilot (taomlar bilan)
  detail: asyncHandler(async (req, res) => {
    const transfer = await MenuTransfer.findOne({
      _id: req.params.id,
      $or: [{ fromRestaurantId: rid(req) }, { toRestaurantId: rid(req) }],
    }).lean();

    if (!transfer) return res.status(404).json({ error: 'So‘rov topilmadi' });

    const dishes = await Dish.find({ _id: { $in: transfer.dishIds } })
      .select('name price category imageUrl volume')
      .lean();

    res.json({ ...transfer, dishes });
  }),

  // PATCH /api/panel/menu-transfers/:id/respond  { action, reason }
  respond: asyncHandler(async (req, res) => {
    const action = req.body.action;
    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'Noto‘g‘ri amal' });
    }

    // Faqat QABUL QILUVCHI javob bera oladi
    const transfer = await MenuTransfer.findOne({
      _id: req.params.id,
      toRestaurantId: rid(req),
    });

    if (!transfer) return res.status(404).json({ error: 'So‘rov topilmadi' });
    if (transfer.status !== 'pending') {
      return res.status(400).json({ error: 'So‘rovga allaqachon javob berilgan' });
    }

    if (action === 'reject') {
      transfer.status = 'rejected';
      transfer.rejectReason = String(req.body.reason || '').slice(0, 200);
      transfer.processedAt = new Date();
      await transfer.save();

      getIO()?.to(`restaurant:${transfer.fromRestaurantId}`).emit('transfer:update', {
        id: String(transfer._id), status: 'rejected',
      });
      return res.json(transfer);
    }

    // ===== TASDIQLASH =====
    // Holatni darhol belgilaymiz — ikki marta bosilmasin
    transfer.status = 'processing';
    await transfer.save();

    // Javobni kutmasdan qaytaramiz, nusxalash fonda ketadi
    res.json({ ...transfer.toObject(), message: 'Ko‘chirilmoqda...' });

    // Fon jarayoni
    (async () => {
      try {
        const result = await copyDishes(transfer);
        transfer.status = 'approved';
        transfer.result = result;
        transfer.processedAt = new Date();
        await transfer.save();

        const io = getIO();
        const payload = {
          id: String(transfer._id),
          status: 'approved',
          result,
        };
        io?.to(`restaurant:${transfer.fromRestaurantId}`).emit('transfer:update', payload);
        io?.to(`restaurant:${transfer.toRestaurantId}`).emit('transfer:update', payload);
        io?.emit('dish:update', { restaurantId: String(transfer.toRestaurantId) });
      } catch (e) {
        console.error('[transfer] nusxalash xatosi:', e.message);
        transfer.status = 'failed';
        transfer.result = { created: 0, skipped: 0, failed: 0, error: e.message };
        await transfer.save();

        getIO()?.to(`restaurant:${transfer.toRestaurantId}`).emit('transfer:update', {
          id: String(transfer._id), status: 'failed',
        });
      }
    })();
  }),

  // GET /api/panel/menu-transfers/pending/count — badge uchun
  pendingCount: asyncHandler(async (req, res) => {
    const count = await MenuTransfer.countDocuments({
      toRestaurantId: rid(req),
      status: 'pending',
    });
    res.json({ count });
  }),
};
