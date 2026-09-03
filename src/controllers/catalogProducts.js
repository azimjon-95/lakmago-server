import { z } from 'zod';
import { asyncHandler } from '../middleware/error.js';
import { CatalogProduct } from '../models/CatalogProduct.js';
import { Dish } from '../models/Dish.js';
import { Restaurant } from '../models/Restaurant.js';
import { CATALOG_CATEGORY_VALUES, DRINKS_CATEGORY } from '../constants/catalogCategories.js';

const productSchema = z.object({
  name: z.string().min(2).max(120),
  description: z.string().max(500).optional().default(''),
  category: z.enum(CATALOG_CATEGORY_VALUES),
  volume: z.string().max(30).optional().default(''),
  imageUrl: z.string().url().or(z.literal('')).optional().default(''),
  isActive: z.boolean().optional(),
  // Eski mijozlar (yoki eski frontend keshi) hali ham shu maydonlarni
  // yuborishi mumkin — qabul qilamiz, lekin talab qilmaymiz. Yangi
  // admin formasi bularni umuman yubormaydi (narx/brend/kaloriya
  // endi katalog darajasida kerak emas — restoran/do'kon o'z narxini
  // qo'yadi).
  brand: z.string().max(60).optional(),
  suggestedPrice: z.number().min(0).max(10000000).optional(),
  calories: z.number().min(0).optional(),
  protein: z.number().min(0).optional(),
  fat: z.number().min(0).optional(),
  carbs: z.number().min(0).optional(),
});

/*
 * CatalogProduct.category (70 ta, do'kon assortimenti) bilan
 * Dish.category (mijoz ilovasidagi qidiruv/filtr kategoriyasi,
 * ATAYLAB kichik — Dish.js dagi izohga qarang) ORASIDA to'g'ridan
 * to'g'ri moslik yo'q. Shuning uchun katalogdan menyuga
 * qo'shilganda mos kichik kategoriyaga xaritalanadi:
 *   - "ichimliklar"  -> "salqin"       (mijoz ilovasida "Ichimlik")
 *   - qolgan 69 tasi -> "magazin_oziq" (mijoz ilovasida "Do'kon mahsuloti")
 * Aks holda mijoz bosh sahifasidagi kategoriya filtri 70 tagacha
 * shishib ketardi.
 */
function toDishCategory(catalogCategory) {
  return catalogCategory === DRINKS_CATEGORY ? 'salqin' : 'magazin_oziq';
}

export const catalogProductController = {
  // ===== ADMIN =====

  // GET /api/admin/catalog — admin har doim BARCHA 70 kategoriyani ko'radi
  list: asyncHandler(async (req, res) => {
    const filter = {};
    if (req.query.category) filter.category = req.query.category;
    if (req.query.q) {
      filter.$or = [
        { name: { $regex: req.query.q, $options: 'i' } },
        { brand: { $regex: req.query.q, $options: 'i' } },
      ];
    }

    const items = await CatalogProduct.find(filter)
      .sort({ category: 1, name: 1 })
      .limit(500)
      .lean();

    res.json(items);
  }),

  // POST /api/admin/catalog
  create: asyncHandler(async (req, res) => {
    const parsed = productSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Ma‘lumot noto‘g‘ri',
        details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }

    // Bir xil nom va hajm takrorlanmasin
    const exists = await CatalogProduct.findOne({
      name: parsed.data.name.trim(),
      volume: parsed.data.volume || '',
    });
    if (exists) {
      return res.status(400).json({ error: 'Bu mahsulot allaqachon bor' });
    }

    const product = await CatalogProduct.create(parsed.data);
    res.status(201).json(product);
  }),

  // PATCH /api/admin/catalog/:id
  update: asyncHandler(async (req, res) => {
    const parsed = productSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Ma‘lumot noto‘g‘ri' });
    }

    const product = await CatalogProduct.findByIdAndUpdate(
      req.params.id, parsed.data, { new: true, runValidators: true },
    );
    if (!product) return res.status(404).json({ error: 'Mahsulot topilmadi' });

    res.json(product);
  }),

  // DELETE /api/admin/catalog/:id
  remove: asyncHandler(async (req, res) => {
    const used = await Dish.countDocuments({ catalogProductId: req.params.id });
    if (used > 0) {
      // Ishlatilayotgan bo'lsa o'chirmaymiz — nofaol qilamiz
      await CatalogProduct.findByIdAndUpdate(req.params.id, { isActive: false });
      return res.json({
        deactivated: true,
        message: `${used} ta restoranda ishlatilmoqda — nofaol qilindi`,
      });
    }

    const product = await CatalogProduct.findByIdAndDelete(req.params.id);
    if (!product) return res.status(404).json({ error: 'Mahsulot topilmadi' });
    res.json({ deleted: true });
  }),

  // ===== RESTORAN / DO'KON =====

  // GET /api/panel/catalog — tanlash uchun ro'yxat
  //
  // Muassasa turiga qarab qat'iy cheklov: restoran/kafe/oshxona/
  // choyxona/fastfood/klub FAQAT "ichimliklar" ko'radi — mijoz
  // (frontend) so'ragan category filtri bu holatda E'TIBORGA
  // OLINMAYDI, chunki bu biznes qoidasi. Faqat do'kon (kind === 'shop')
  // barcha 70 kategoriyani ko'radi va filtrlashi mumkin.
  forRestaurant: asyncHandler(async (req, res) => {
    const restaurant = await Restaurant.findById(req.restaurantId).select('kind').lean();
    const isShop = restaurant?.kind === 'shop';

    const filter = { isActive: true };
    if (isShop) {
      if (req.query.category) filter.category = req.query.category;
    } else {
      filter.category = DRINKS_CATEGORY;
    }
    if (req.query.q) {
      filter.$or = [
        { name: { $regex: req.query.q, $options: 'i' } },
        { brand: { $regex: req.query.q, $options: 'i' } },
      ];
    }

    const items = await CatalogProduct.find(filter)
      .sort({ usageCount: -1, name: 1 })
      .limit(300)
      .lean();

    // Restoranda allaqachon bormi — belgilab beramiz
    const added = await Dish.find({
      restaurantId: req.restaurantId,
      catalogProductId: { $ne: null },
    }).select('catalogProductId').lean();

    const addedIds = new Set(added.map((d) => String(d.catalogProductId)));

    res.json(items.map((p) => ({
      ...p,
      alreadyAdded: addedIds.has(String(p._id)),
    })));
  }),

  // POST /api/panel/catalog/:id/add — katalogdan menyuga qo'shish
  addToMenu: asyncHandler(async (req, res) => {
    const price = Number(req.body.price);
    if (!Number.isFinite(price) || price <= 0) {
      return res.status(400).json({ error: 'Narx kiriting' });
    }

    const product = await CatalogProduct.findById(req.params.id);
    if (!product || !product.isActive) {
      return res.status(404).json({ error: 'Mahsulot topilmadi' });
    }

    // Takroriy qo'shishdan himoya
    const exists = await Dish.findOne({
      restaurantId: req.restaurantId,
      catalogProductId: product._id,
    });
    if (exists) {
      return res.status(400).json({ error: 'Bu mahsulot menyuda bor' });
    }

    const dish = await Dish.create({
      restaurantId: req.restaurantId,
      catalogProductId: product._id,
      name: product.name,
      description: product.description,
      category: toDishCategory(product.category),
      section: product.category,
      volume: product.volume,
      imageUrl: product.imageUrl,
      images: product.imageUrl ? [product.imageUrl] : [],
      price,
      oldPrice: Number(req.body.oldPrice) || undefined,
      calories: product.calories,
      protein: product.protein,
      fat: product.fat,
      carbs: product.carbs,
      prepMinutes: 1, // ichimlik/do'kon mahsuloti — tayyorlash kerak emas
      isAvailable: true,
    });

    // Mashhurlik hisobi
    await CatalogProduct.findByIdAndUpdate(product._id, { $inc: { usageCount: 1 } });

    res.status(201).json(dish);
  }),
};
