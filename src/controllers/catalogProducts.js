import { barcodeTakenInStore, cleanBarcode, BARCODE_RE } from '../services/barcode.js';
import { z } from 'zod';
import { asyncHandler } from '../middleware/error.js';
import { CatalogProduct } from '../models/CatalogProduct.js';
import { Dish } from '../models/Dish.js';
import { Restaurant } from '../models/Restaurant.js';
import { CATALOG_CATEGORY_VALUES, DRINKS_CATEGORY, RESTAURANT_VISIBLE_CATEGORIES } from '../constants/catalogCategories.js';
import { isStore } from '../services/storeRules.js';
import { MARKET_CATEGORIES, MARKET_CATEGORY_VALUES, MARKET_UNIT_VALUES, marketSuggestion } from '../constants/marketCategories.js';

// Qidiruv matni regex'ga xavfsiz (maxsus belgilar ekranlanadi, uzunlik cheklangan)
const safeRx = (q) => String(q).trim().slice(0, 60).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
  /*
   * ILGARI faqat 'ichimliklar' 'salqin' ga xaritalanardi. Natijada
   * mineral suv yoki Coca-Cola menyuga qo'shilsa, mijoz ilovasida
   * "Do'kon mahsuloti" bo'lib chiqardi — ichimlik kategoriyasida
   * ko'rinmasdi. Endi barcha ichimlik kategoriyalari 'salqin' ga
   * tushadi.
   */
  return RESTAURANT_VISIBLE_CATEGORIES.includes(catalogCategory)
    ? 'salqin'
    : 'magazin_oziq';
}

export const catalogProductController = {
  // ===== ADMIN =====

  // GET /api/admin/catalog — admin har doim BARCHA 70 kategoriyani ko'radi
  list: asyncHandler(async (req, res) => {
    const filter = {};
    if (req.query.category) filter.category = req.query.category;
    if (req.query.q && String(req.query.q).trim()) {
      const rx = safeRx(req.query.q);
      filter.$or = [
        { name: { $regex: rx, $options: 'i' } },
        { brand: { $regex: rx, $options: 'i' } },
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
    // Do'kon qoidasi umumiy (services/storeRules.js): Magazin YOKI oziq-ovqat/meva-sabzavot do'koni
    const restaurant = await Restaurant.findById(req.restaurantId).select('kind category').lean();
    const isShop = isStore(restaurant);

    const filter = { isActive: true };
    if (isShop) {
      // Do'kon barcha kategoriyalarni ko'radi
      if (req.query.category) filter.category = req.query.category;
    } else {
      /*
       * Muassasa (restoran/kafe/choyxona) — faqat ichimliklar.
       *
       * ILGARI bu yerda `filter.category = DRINKS_CATEGORY` edi,
       * ya'ni FAQAT 'ichimliklar' kategoriyasi. Lekin katalogda
       * ichimliklar aniqroq bo'lingan: mineral_suv,
       * gazli_ichimliklar, sharbatlar, choy... Admin CHORTOQ ni
       * mineral suv deb kiritsa, restoran uni umuman ko'rmasdi va
       * panel "Katalog hali to'ldirilmagan" deb yozardi.
       *
       * Endi barcha ichimlik kategoriyalari ko'rinadi. Restoran
       * xohlasa ular orasidan bittasini tanlab ham filtrlashi
       * mumkin — lekin faqat RUXSAT ETILGAN ro'yxat ichidan,
       * aks holda so'rov orqali oziq-ovqat kategoriyalarini
       * ochib olish mumkin bo'lardi.
       */
      const requested = req.query.category;
      filter.category = RESTAURANT_VISIBLE_CATEGORIES.includes(requested)
        ? requested
        : { $in: RESTAURANT_VISIBLE_CATEGORIES };
    }
    if (req.query.q && String(req.query.q).trim()) {
      const rx = safeRx(req.query.q);
      filter.$or = [
        { name: { $regex: rx, $options: 'i' } },
        { brand: { $regex: rx, $options: 'i' } },
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
      // Do'kon uchun: Market kategoriyasi va birlik taklifi (qo'shish oynasida oldindan tanlanadi)
      ...(isShop ? { market: marketSuggestion(p.category) } : {}),
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

    /*
     * DO'KON: mahsulot Market maydonlari bilan yaratiladi — kategoriya,
     * birlik, qadoq hajmi, brend, shtrix-kod. Do'kon egasi oynada
     * o'zgartirganini olamiz, aks holda katalogdan taklif.
     * Restoran yo'li (pastda) O'ZGARMAGAN.
     */
    const restaurant = await Restaurant.findById(req.restaurantId).select('kind category').lean();
    if (isStore(restaurant)) {
      const sug = marketSuggestion(product.category);
      const marketCategory = MARKET_CATEGORY_VALUES.includes(req.body.marketCategory) ? req.body.marketCategory : sug.marketCategory;
      const unit = MARKET_UNIT_VALUES.includes(req.body.unit) ? req.body.unit : sug.unit;
      const str = (v, max, def = '') => (typeof v === 'string' ? v.trim().slice(0, max) : def);
      const oldPrice = Number(req.body.oldPrice);
      if (oldPrice && oldPrice <= price) {
        return res.status(400).json({ error: 'Eski narx hozirgi narxdan katta bo‘lishi kerak' });
      }
      const barcode = cleanBarcode(req.body.barcode);
      if (barcode && !BARCODE_RE.test(barcode)) return res.status(400).json({ error: 'Shtrix-kod noto‘g‘ri (4–32 belgi: harf, raqam, -)' });
      if (await barcodeTakenInStore(req.restaurantId, barcode)) {
        return res.status(409).json({ error: 'Bu shtrix-kod shu do‘konda boshqa mahsulotda bor', code: 'BARCODE_TAKEN' });
      }
      const label = MARKET_CATEGORIES.find((c) => c.value === marketCategory);
      const dish = await Dish.create({
        restaurantId: req.restaurantId,
        catalogProductId: product._id,
        name: str(req.body.name, 120) || product.name,
        description: product.description,
        category: 'boshqa',              // restoran taom filtrlariga aralashmasin
        section: label?.label || 'Mahsulotlar',
        icon: label?.icon || 'ti-shopping-cart',
        marketCategory,
        unit,
        packSize: str(req.body.packSize, 40, product.volume || ''),
        barcode,
        volume: product.volume,
        imageUrl: product.imageUrl,
        images: product.imageUrl ? [product.imageUrl] : [],
        price,
        oldPrice: oldPrice > price ? oldPrice : undefined,
        calories: product.calories,
        protein: product.protein,
        fat: product.fat,
        carbs: product.carbs,
        prepMinutes: 5,
        isAvailable: true,
      });
      await CatalogProduct.findByIdAndUpdate(product._id, { $inc: { usageCount: 1 } });
      return res.status(201).json(dish);
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
