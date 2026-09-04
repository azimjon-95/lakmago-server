import { z } from 'zod';
import { asyncHandler } from '../middleware/error.js';
import {
  signToken, verifyTelegramInitData, verifyTelegramLoginWidget,
  signAccessToken, generateRefreshToken, hashRefreshToken, refreshTokenExpiry,
} from '../middleware/auth.js';
import { Banner } from '../models/User.js';
import { Restaurant } from '../models/Restaurant.js';
import { Dish } from '../models/Dish.js';
import { calcDeliveryFee, calcServiceFee, checkMinOrder } from '../services/orderPricing.js';
import { isRestaurantOpen as isOpenTz } from '../services/restaurantTime.js';
import { quoteDelivery } from '../services/deliveryEngine.js';
import { applyPromotion, markPromotionUsed } from '../services/promotions.js';
import { User } from '../models/User.js';
import { AuthIdentity } from '../models/AuthIdentity.js';
import { Session } from '../models/Session.js';
import { Order } from '../models/Order.js';
import { getIO } from '../sockets/io.js';
import { notify } from '../services/notifications.js';
import { notifyUser } from '../services/telegram.js';
import { parseReferralCode, attachReferral, rewardReferralIfSubscribed, checkChannelSubscription, buildReferralLink } from '../services/referral.js';

export const bannerController = {
  // GET /api/banners — mijozга ko'rinadigan bannerlar
  list: asyncHandler(async (_req, res) => {
    // Faqat platforma bannerlari — restoran bannerlari o'z sahifasida ko'rinadi
    const banners = await Banner.find({ active: true, kind: 'platform' }).sort({ order: 1 }).lean();

    // Restoran bannerlari orasidan bloklangan/nofaol muassasalarникini olib tashlaymiz
    const restaurantBanners = banners.filter((b) => b.kind === 'restaurant' && b.restaurantId);
    const validRestIds = new Set();
    if (restaurantBanners.length) {
      const rests = await Restaurant.find({
        _id: { $in: restaurantBanners.map((b) => b.restaurantId) },
        isBlocked: { $ne: true },
        isActive: true,
      }).select('_id').lean();
      rests.forEach((r) => validRestIds.add(String(r._id)));
    }

    const visible = banners.filter((b) => {
      if (b.kind !== 'restaurant') return true; // platforma bannerlari doim ko'rinadi
      return validRestIds.has(String(b.restaurantId));
    });
    res.json(visible);
  }),
};











/*
 * Telegram orqali autentifikatsiyani YAKUNLAYDI — User topish/
 * yaratish, BLOCKED tekshiruvi, AuthIdentity bog'lash, referal,
 * Session + tokenlar. Mini App (initData) va Login Widget (browser)
 * IKKALASI HAM shu funksiyaga kelib qo'shiladi — faqat DASTLABKI
 * VALIDATSIYA farqli (tepada authController.telegram va
 * authController.telegramWeb'ga qarang).
 *
 * tgUser maydonlari: id (majburiy), first_name, last_name,
 * username, language_code (FAQAT Mini App'da bor), is_premium
 * (FAQAT Mini App'da bor), photo_url.
 *
 * MUHIM: language_code/is_premium kabi FAQAT Mini App orqali
 * keladigan maydonlar undefined bo'lsa, profileFields'ga UMUMAN
 * QO'SHILMAYDI — aks holda foydalanuvchi avval Mini App'da
 * o'rnatgan qiymat (masalan languageCode:'uz'), keyin Login
 * Widget orqali kirganda undefined bilan ustidan yozilib
 * o'chib qolardi (Object.assign undefined'ni ham qo'llaydi).
 */
async function completeTelegramAuth(tgUser, { platform, deviceId, startParam } = {}) {
  const telegramId = String(tgUser.id);
  const profileFields = { lastLoginAt: new Date() };
  if (tgUser.first_name !== undefined) profileFields.firstName = tgUser.first_name;
  if (tgUser.last_name !== undefined) profileFields.lastName = tgUser.last_name;
  if (tgUser.username !== undefined) profileFields.username = tgUser.username;
  if (tgUser.language_code !== undefined) profileFields.languageCode = tgUser.language_code;
  if (tgUser.is_premium !== undefined) profileFields.isPremium = Boolean(tgUser.is_premium);
  if (tgUser.photo_url !== undefined) profileFields.photoUrl = tgUser.photo_url;

  let user = await User.findOne({ telegramId });
  let isNewUser = false;
  if (!user) {
    isNewUser = true;
    user = await User.create({ telegramId, ...profileFields });

    const refCode = parseReferralCode(startParam);
    if (refCode) {
      try { await attachReferral(user, refCode); } catch { /* jim */ }
    }
  } else {
    Object.assign(user, profileFields);
    await user.save();
  }

  if (user.status === 'BLOCKED') {
    const err = new Error('Akkauntingiz bloklangan');
    err.status = 403;
    throw err;
  }

  await AuthIdentity.findOneAndUpdate(
    { provider: 'telegram', providerUserId: telegramId },
    { $setOnInsert: { userId: user._id, provider: 'telegram', providerUserId: telegramId } },
    { upsert: true, setDefaultsOnInsert: true },
  );

  if (user.referredBy && !user.referralRewarded) {
    try { await rewardReferralIfSubscribed(user); } catch { /* jim */ }
  }

  const token = signToken(String(user._id), user.role ?? 'customer');
  const accessToken = signAccessToken(String(user._id), user.role ?? 'customer');

  const refreshToken = generateRefreshToken();
  await Session.create({
    userId: user._id,
    refreshTokenHash: hashRefreshToken(refreshToken),
    deviceId: deviceId || '',
    platform: ['telegram', 'web', 'android', 'ios'].includes(platform) ? platform : 'telegram',
    expiresAt: refreshTokenExpiry(),
  });

  return { token, accessToken, refreshToken, user, isNewUser };
}

export const authController = {
  // POST /api/auth/telegram — Telegram Mini App (initData)
  // Body: { initData, platform?, deviceId? }
  telegram: asyncHandler(async (req, res) => {
    const { initData } = req.body;
    if (!initData) return res.status(400).json({ error: 'initData yo‘q' });

    const data = verifyTelegramInitData(initData);
    if (!data) return res.status(401).json({ error: 'Telegram tekshiruvi muvaffaqiyatsiz' });

    const tgUser = JSON.parse(data.user ?? '{}');
    if (!tgUser.id) return res.status(400).json({ error: 'Telegram user ma’lumoti topilmadi' });

    let result;
    try {
      result = await completeTelegramAuth(tgUser, {
        platform: req.body.platform,
        deviceId: req.body.deviceId,
        startParam: req.body.startParam || req.body.start_param,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      throw e;
    }

    res.json(result);
  }),

  // POST /api/auth/telegram-web — browser orqali kirish (Telegram
  // Login Widget). Mini App emas — https://lokma.uz da "Telegram
  // orqali kirish" tugmasi bosilganda Telegram bergan ma'lumot.
  // Body: Login Widget obyektining o'zi + { platform?, deviceId? }
  telegramWeb: asyncHandler(async (req, res) => {
    const { platform, deviceId, ...widgetData } = req.body;
    if (!widgetData.id || !widgetData.hash) {
      return res.status(400).json({ error: 'Telegram widget ma’lumoti to‘liq emas' });
    }

    const data = verifyTelegramLoginWidget(widgetData);
    if (!data) return res.status(401).json({ error: 'Telegram tekshiruvi muvaffaqiyatsiz' });

    let result;
    try {
      result = await completeTelegramAuth(data, { platform: platform || 'web', deviceId });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      throw e;
    }

    res.json(result);
  }),

  // POST /api/auth/refresh
  // Body: { refreshToken }
  // Eski Session revoke qilinadi, yangisi yaratiladi (rotatsiya) —
  // o'g'irlangan eski refresh token qayta ishlatilsa rad etiladi.
  refresh: asyncHandler(async (req, res) => {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ error: 'refreshToken yo‘q' });

    const tokenHash = hashRefreshToken(refreshToken);
    const session = await Session.findOne({ refreshTokenHash: tokenHash });

    if (!session || session.revokedAt || session.expiresAt < new Date()) {
      return res.status(401).json({ error: 'Sessiya yaroqsiz — qayta kiring' });
    }

    const user = await User.findById(session.userId);
    if (!user || user.status === 'BLOCKED') {
      session.revokedAt = new Date();
      await session.save();
      return res.status(403).json({ error: 'Akkauntingiz bloklangan' });
    }

    // Rotatsiya: eski sessiya bekor qilinadi, yangisi yaratiladi
    session.revokedAt = new Date();
    await session.save();

    const newRefreshToken = generateRefreshToken();
    await Session.create({
      userId: user._id,
      refreshTokenHash: hashRefreshToken(newRefreshToken),
      deviceId: session.deviceId,
      platform: session.platform,
      expiresAt: refreshTokenExpiry(),
    });

    const accessToken = signAccessToken(String(user._id), user.role ?? 'customer');
    res.json({ accessToken, refreshToken: newRefreshToken });
  }),

  // POST /api/auth/logout
  // Body: { refreshToken }
  logout: asyncHandler(async (req, res) => {
    const { refreshToken } = req.body;
    if (refreshToken) {
      await Session.updateOne(
        { refreshTokenHash: hashRefreshToken(refreshToken), revokedAt: null },
        { revokedAt: new Date() },
      );
    }
    res.json({ ok: true });
  }),
};

// MongoDB ObjectId formatи (24 belgili hex)
const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, 'ID formatи noto‘g‘ri (ObjectId kutiladi)');

// Bitta restoran buyurtmasi sxemasi
const singleOrderSchema = z.object({
  restaurantId: objectIdSchema,
  restaurantName: z.string(),
  items: z.array(z.object({
    dishId: objectIdSchema.optional(),
    name: z.string(),
    quantity: z.number().int().positive(),
    unitPrice: z.number().nonnegative(),
    selectedOptions: z.array(z.object({ name: z.string(), price: z.number() })).optional(),
    note: z.string().optional(),
  })).min(1),
  subtotal: z.number(),
  deliveryFee: z.number().default(0),
  serviceFee: z.number().default(0),
  etaMinutes: z.number().optional(),
});

// Mijoz bir vaqtda bir necha restorandan buyurtma qilishi mumkin.
// { orders: [...], address, phone, paymentMethod } — har biri alohida Order bo'ladi,
// bitta groupId bilan bog'lanadi.
const batchOrderSchema = z.object({
  orders: z.array(singleOrderSchema).min(1),
  // Yetkazish turi: kuryer yoki o'zi olib ketish
  fulfillment: z.enum(['delivery', 'pickup']).default('delivery'),
  // Manzil — yetkazishda majburiy (pastda tekshiriladi)
  address: z.string().default(''),
  // Vaqt: darhol (tayyor bo'lishi bilan) yoki belgilangan vaqtga
  timingMode: z.enum(['asap', 'scheduled']).default('asap'),
  scheduledFor: z.string().datetime().optional(),
  addressLat: z.number().optional(),
  addressLng: z.number().optional(),
  addressNote: z.string().max(200).optional(),
  cardLast4: z.string().optional().default(''),
  cardBrand: z.string().optional().default(''),
  phone: z.string().optional(),
  paymentMethod: z.enum(['payme', 'click', 'uzum', 'cash']).default('cash'),
  paymentLabel: z.string().optional(),
  useBonus: z.number().nonnegative().default(0), // ishlatmoqchi bo'lган bonus (so'm)
});

const COURIERS = ['Aziz', 'Bek', 'Dilshod', 'Jasur', 'Sardor', 'Ulug\'bek'];

export const orderController = {
  // POST /api/orders
  // Bir yoki bir necha restoran buyurtmasini qabul qiladi (batch).
  create: asyncHandler(async (req, res) => {
    const parsed = batchOrderSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Ma‘lumot noto‘g‘ri', details: parsed.error.issues });
    }
    const { orders, address, phone, paymentMethod, paymentLabel, useBonus,
            fulfillment, timingMode, scheduledFor, cardLast4, cardBrand,
            addressLat, addressLng, addressNote } = parsed.data;

    // Yetkazishda manzil majburiy, olib ketishda shart emas
    if (fulfillment === 'delivery' && !address.trim()) {
      return res.status(400).json({ error: 'Yetkazish uchun manzil kiriting' });
    }
    // Belgilangan vaqt tanlansa — u kelajakda bo'lishi kerak
    const scheduledDate = scheduledFor ? new Date(scheduledFor) : null;
    if (timingMode === 'scheduled') {
      if (!scheduledDate || isNaN(scheduledDate.getTime())) {
        return res.status(400).json({ error: 'Vaqt noto‘g‘ri' });
      }
      if (scheduledDate.getTime() < Date.now() - 60_000) {
        return res.status(400).json({ error: 'Tanlangan vaqt o‘tib ketgan' });
      }
    }

    // Olib ketishda yetkazish haqi olinmaydi
    const isPickup = fulfillment === 'pickup';
    const groupId = 'G' + Date.now() + Math.floor(Math.random() * 1000);
    const io = getIO();

    // ===== SERVER TOMONIDA QAYTA HISOBLASH =====
    // Client yuborgan summalarga ISHONMAYMIZ — qayta hisoblaymiz.
    // Restoran sozlamalari o'zgargan yoki so'rov o'zgartirilgan
    // bo'lishi mumkin.
    // Chegirma qo'shish qoidasi — Super Admin boshqaradi
    const { getSettings } = await import('../models/Settings.js');
    const appSettings = await getSettings();
    const allowStacking = Boolean(appSettings.allowDiscountStacking);

    const restIds = orders.map((o) => o.restaurantId);
    const restDocs = await Restaurant.find({ _id: { $in: restIds } })
      .select('name deliveryFee freeDeliveryThreshold minOrderAmount serviceFeePercent serviceFeeMin serviceFeeMax prepMinutes openTime closeTime timezone workingDays isActive isBlocked isApproved pickupEnabled deliveryEnabled pickupDiscountPercent lat lng delivery')
      .lean();
    const restMap = new Map(restDocs.map((r) => [String(r._id), r]));

    for (const o of orders) {
      const rest = restMap.get(String(o.restaurantId));
      if (!rest) {
        return res.status(400).json({ error: 'Restoran topilmadi' });
      }

      // Restoran ishlayaptimi
      if (rest.isBlocked || !rest.isActive || !rest.isApproved) {
        return res.status(400).json({
          error: `${rest.name} hozircha buyurtma qabul qilmayapti`,
          code: 'RESTAURANT_UNAVAILABLE',
          restaurantId: String(o.restaurantId),
        });
      }

      // Ish vaqti — yopiq bo'lsa buyurtma qabul qilinmaydi.
      // Belgilangan vaqtga buyurtma bundan mustasno: mijoz
      // ochilish vaqtiga rejalashtirishi mumkin.
      if (timingMode !== 'scheduled' && !isOpenTz(rest)) {
        return res.status(400).json({
          error: `${rest.name} hozir yopiq`
            + (rest.openTime ? ` · Ish vaqti ${rest.openTime}–${rest.closeTime}` : ''),
          code: 'RESTAURANT_CLOSED',
          restaurantId: String(o.restaurantId),
          openTime: rest.openTime,
          closeTime: rest.closeTime,
        });
      }

      /*
       * Yetkazib berish yoqilganmi.
       *
       * Ba'zi muassasalarda yetkazish xizmati umuman bo'lmaydi
       * (faqat olib ketish / stol bron qilish). Mijoz ilovasida
       * bu tanlov o'chirilgan ko'rinadi, LEKIN frontendga
       * ISHONMAYMIZ — kimdir to'g'ridan-to'g'ri API'ga so'rov
       * yuborsa ham shu yerda to'xtatiladi.
       */
      if (!isPickup && rest.deliveryEnabled === false) {
        return res.status(400).json({
          error: `${rest.name} yetkazib berish xizmatini ko'rsatmaydi — o'zingiz olib ketishingiz mumkin`,
          code: 'DELIVERY_DISABLED',
          restaurantId: String(o.restaurantId),
        });
      }

      // Olib ketish yoqilganmi
      if (isPickup && !rest.pickupEnabled) {
        return res.status(400).json({
          error: `${rest.name} olib ketishni qo‘llab-quvvatlamaydi`,
          code: 'PICKUP_DISABLED',
          restaurantId: String(o.restaurantId),
        });
      }

      // Taomlar mavjudligini tekshiramiz — STOP qilingan bo'lishi mumkin
      const dishIds = (o.items || []).map((i) => i.dishId).filter(Boolean);
      if (dishIds.length) {
        const unavailable = await Dish.find({
          _id: { $in: dishIds },
          $or: [{ isAvailable: false }, { restaurantId: { $ne: o.restaurantId } }],
        }).select('name isAvailable').lean();

        if (unavailable.length) {
          return res.status(400).json({
            error: `Mavjud emas: ${unavailable.map((d) => d.name).join(', ')}`,
            code: 'DISH_UNAVAILABLE',
            restaurantId: String(o.restaurantId),
            dishes: unavailable.map((d) => d.name),
          });
        }
      }

      // Minimal summa tekshiruvi
      const minCheck = checkMinOrder(o.subtotal, rest, isPickup);
      if (!minCheck.ok) {
        return res.status(400).json({
          error: `${rest.name}: minimal buyurtma ${minCheck.min.toLocaleString('ru-RU')} so‘m. `
            + `Yana ${minCheck.missing.toLocaleString('ru-RU')} so‘mlik mahsulot qo‘shing.`,
          code: 'MIN_ORDER',
          restaurantId: String(o.restaurantId),
          missing: minCheck.missing,
        });
      }

      // Yetkazish va xizmat haqini QAYTA hisoblaymiz
      // ===== YETKAZISH NARXI =====
      // Masofa bo'yicha hisoblanadi. Koordinata yo'q bo'lsa
      // eski usul (freeDeliveryThreshold) ishlaydi.
      if (!isPickup && rest.delivery?.type && addressLat && addressLng) {
        const quote = await quoteDelivery(rest, {
          lat: addressLat, lng: addressLng,
        });

        if (!quote.available) {
          return res.status(400).json({
            error: quote.reason || 'Bu manzilga yetkazib berilmaydi',
            code: quote.code || 'DELIVERY_UNAVAILABLE',
            restaurantId: String(o.restaurantId),
            distanceKm: quote.distanceKm,
          });
        }

        o.deliveryFee = quote.price;
        o._distanceKm = quote.distanceKm;
      } else {
        o.deliveryFee = calcDeliveryFee(o.subtotal, rest, isPickup);
      }
      o.serviceFee = calcServiceFee(o.subtotal, rest);

      /*
       * OLIB KETISH CHEGIRMASI.
       *
       * Ilgari `pickupDiscountPercent` restoran sozlamalarida
       * saqlanardi-yu, HECH QAYERDA ishlatilmasdi — panelda
       * "5%" yozib qo'yilgani bilan mijoz uni ko'rmasdi va
       * to'lamasdi ham. Endi narxga qo'llanadi.
       *
       * Faqat TAOMLAR summasidan hisoblanadi: yetkazish haqi
       * olib ketishda allaqachon nol, xizmat haqidan chegirma
       * berish esa restoran nazarda tutgan narsa emas.
       */
      o._pickupPercent = 0;
      o._pickupDiscount = 0;
      if (isPickup && rest.pickupDiscountPercent > 0) {
        o._pickupPercent = rest.pickupDiscountPercent;
        o._pickupDiscount = Math.round(o.subtotal * rest.pickupDiscountPercent / 100);
      }

      // Aksiya — SERVERDA hisoblanadi, client qiymatiga ishonilmaydi
      const promo = await applyPromotion(o.restaurantId, o.items || [], o.subtotal);
      o._promo = promo;
    }

    // ===== BONUS BILAN TO'LASH =====
    // Butun buyurtма summasi (barcha restoranlar)
    const grandTotal = orders.reduce(
      (s, o) => s + o.subtotal - (o._pickupDiscount || 0)
        + (isPickup ? 0 : (o.deliveryFee || 0)) + (o.serviceFee || 0), 0,
    );
    // Ishlatiladigan bonus: so'ralган, lekin balansдан va summадан oshмаsин
    let bonusToUse = 0;
    if (useBonus > 0) {
      const user = await User.findById(req.userId).select('bonusBalance');
      const available = user?.bonusBalance || 0;
      bonusToUse = Math.min(useBonus, available, grandTotal);
      // Atomik ayirish (poyga holatини oldini oladi — faqat yetarli bo'lsa)
      if (bonusToUse > 0) {
        const upd = await User.updateOne(
          { _id: req.userId, bonusBalance: { $gte: bonusToUse } },
          { $inc: { bonusBalance: -bonusToUse } },
        );
        if (upd.modifiedCount === 0) bonusToUse = 0; // balans yetмади
      }
    }
    let bonusLeft = bonusToUse; // buyurtмаларга taqsimlаnadi

    const created = [];
    for (let i = 0; i < orders.length; i++) {
      const o = orders[i];
      // Olib ketishda yetkazish haqi yo'q
      const fee = isPickup ? 0 : (o.deliveryFee || 0);
      // Aksiya chegirmasi taomlar summasidan ayriladi
      const promoDiscount = o._promo?.discount || 0;
      const orderTotal = Math.max(
        0,
        o.subtotal - promoDiscount - (o._pickupDiscount || 0) + fee + (o.serviceFee || 0),
      );
      // Bonusni shu buyurtmaga qo'llaymiz (ketma-ket, oshib ketmasin)
      // Chegirma qo'shish qoidasi (discount stacking policy).
      // O'chiq bo'lsa aksiya va bonus birga ishlamaydi —
      // faqat eng foydalisi qo'llanadi.
      let orderBonus = Math.min(bonusLeft, orderTotal);

      if (!allowStacking && promoDiscount > 0 && orderBonus > 0) {
        if (promoDiscount >= orderBonus) {
          // Aksiya foydaliroq — bonus ishlatilmaydi
          orderBonus = 0;
        }
        // Aks holda bonus foydaliroq, lekin aksiya allaqachon
        // narxga qo'llanilgan — uni bekor qilish murakkab.
        // Shuning uchun ikkalasi ham qoladi (mijoz foydasiga).
      }
      bonusLeft -= orderBonus;
      const total = orderTotal - orderBonus;

      const doc = await Order.create({
        userId: req.userId,
        restaurantId: o.restaurantId,
        restaurantName: o.restaurantName,
        groupId,
        items: o.items,
        subtotal: o.subtotal,
        deliveryFee: fee,
        serviceFee: o.serviceFee || 0,
        bonusUsed: orderBonus,
        promotionId: o._promo?.promotionId || null,
        promotionName: o._promo?.promotionName || '',
        promotionDiscount: o._promo?.discount || 0,
        pickupDiscount: o._pickupDiscount || 0,
        pickupDiscountPercent: o._pickupPercent || 0,
        total,
        // Karta to'lovi bo'lsa buyurtma TO'LOV KUTILMOQDA holatida
        // yaratiladi — restoranga faqat pul kelgach yuboriladi.
        // Naqd bo'lsa darhol restoranga boradi.
        status: paymentMethod === 'cash' ? 'pending' : 'awaiting_payment',
        fulfillment,
        address: isPickup ? '' : address,
        timingMode,
        scheduledFor: scheduledDate,
        phone,
        paymentMethod,
        paymentLabel,
        cardLast4,
        cardBrand,
        addressLat: addressLat ?? null,
        addressLng: addressLng ?? null,
        addressNote: addressNote || '',
        ...(o._distanceKm != null ? { distanceKm: o._distanceKm } : {}),
        etaMinutes: o.etaMinutes,
        // Kuryer faqat yetkazishda tayinlanadi
        ...(isPickup ? {} : { courierName: COURIERS[Math.floor(Math.random() * COURIERS.length)] }),
      });
      created.push(doc);

      // Aksiya ishlatildi — hisob va limit yangilanadi
      if (o._promo) {
        markPromotionUsed(o._promo.promotionId, o._promo.discount, total)
          .catch((e) => console.error('[promo]', e.message));
      }

      // Real-time: restoranга yangi buyurtma (signal chalinadi)
      io?.to(`restaurant:${o.restaurantId}`).emit('order:new', doc);
      io?.to('admin').emit('order:new', doc);

      // Markaziy bildirishnoma — bazaga yoziladi, socket uzilsa
      // qayta ulanганda yo'qolmaydi
      notify({
        notificationId: `order:${doc._id}`,
        audience: 'restaurant',
        restaurantId: o.restaurantId,
        type: 'order',
        title: 'Yangi buyurtma',
        body: `${doc.items?.length || 0} ta taom · ${doc.total?.toLocaleString('ru-RU') || 0} so'm`,
        refType: 'order',
        refId: doc._id,
        meta: { fulfillment: doc.fulfillment, total: doc.total },
      }).catch((e) => console.error('[notify:order]', e.message));
    }

    res.status(201).json({ groupId, orders: created, bonusUsed: bonusToUse });
  }),

  // GET /api/orders  (foydalanuvchi buyurtmalari — groupId bo'yicha guruhlangan)
  // PATCH /api/orders/:id/cancel — mijoz o'z buyurtmasini bekor qiladi
  //
  // Faqat NAQD to'lovda va restoran QABUL QILGUNCHA.
  // Karta to'lovida mijoz tasdiqlash kodini kiritgan — adashib
  // bosish ehtimoli yo'q, bekor qilish esa pul qaytarishni
  // talab qiladi (uni restoran yoki admin boshqaradi).
  cancelOrder: asyncHandler(async (req, res) => {
    const order = await Order.findOne({
      _id: req.params.id,
      userId: req.userId,
    });

    if (!order) return res.status(404).json({ error: 'Buyurtma topilmadi' });

    if (order.status === 'cancelled') {
      return res.status(400).json({ error: 'Allaqachon bekor qilingan' });
    }

    // Restoran ishni boshlagan bo'lsa bekor qilib bo'lmaydi
    if (order.status !== 'pending' && order.status !== 'awaiting_payment') {
      return res.status(400).json({
        error: 'Restoran buyurtmani qabul qildi — bekor qilib bo‘lmaydi. '
          + 'Restoranga qo‘ng‘iroq qiling.',
        code: 'ALREADY_ACCEPTED',
      });
    }

    // Karta to'lovi va pul o'tgan bo'lsa — o'zi bekor qilolmaydi
    if (order.isPaid) {
      return res.status(400).json({
        error: 'To‘lov amalga oshirilgan. Bekor qilish uchun '
          + 'qo‘llab-quvvatlashga murojaat qiling.',
        code: 'ALREADY_PAID',
      });
    }

    order.status = 'cancelled';
    order.cancelledAt = new Date();
    order.cancelReason = 'Mijoz bekor qildi';
    await order.save();

    // Bonus ishlatilgan bo'lsa qaytaramiz
    if (order.bonusUsed > 0) {
      await User.findByIdAndUpdate(order.userId, {
        $inc: { bonusBalance: order.bonusUsed },
      });
    }

    const io = getIO();
    io?.to(`restaurant:${order.restaurantId}`).emit('order:status', {
      orderId: String(order._id), status: 'cancelled',
    });
    io?.to('admin').emit('order:update', order);

    res.json(order);
  }),

  myOrders: asyncHandler(async (req, res) => {
    const orders = await Order.find({ userId: req.userId }).sort({ createdAt: -1 });
    res.json(orders);
  }),

  // GET /api/orders/group/:groupId  (bitta buyurtma = bir necha restoran)
  getGroup: asyncHandler(async (req, res) => {
    const orders = await Order.find({ groupId: req.params.groupId, userId: req.userId }).sort({ createdAt: 1 });
    if (orders.length === 0) return res.status(404).json({ error: 'Buyurtma topilmadi' });
    res.json(orders);
  }),

  // GET /api/orders/active  (mijozning faol buyurtmalari)
  active: asyncHandler(async (req, res) => {
    const orders = await Order.find({
      userId: req.userId,
      status: { $nin: ['delivered', 'cancelled'] },
    }).sort({ createdAt: -1 });
    res.json(orders);
  }),

  // GET /api/orders/:id
  getOne: asyncHandler(async (req, res) => {
    if (!/^[a-f\d]{24}$/i.test(req.params.id)) return res.status(404).json({ error: 'Buyurtma topilmadi' });
    /*
     * XAVFSIZLIK: userId bilan cheklanadi.
     *
     * ILGARI faqat Order.findById(id) edi — egasi TEKSHIRILMAGAN.
     * Login qilgan istalgan mijoz istalgan buyurtma ID'sini
     * kiritib, BOSHQA mijozning manzili, telefoni, to'lov
     * holatini ko'ra olardi. ID'lar ketma-ket taxmin
     * qilinadigan formatda emas (MongoDB ObjectId), lekin bu
     * "xavfsizlik qorong'ulik orqali" — himoya emas.
     */
    const order = await Order.findOne({ _id: req.params.id, userId: req.userId });
    if (!order) return res.status(404).json({ error: 'Buyurtma topilmadi' });
    res.json(order);
  }),

  // PATCH /api/orders/:id/confirm  — mijoz "Ha, oldim" (delivered) + baho
  confirmDelivery: asyncHandler(async (req, res) => {
    const { rating, comment } = req.body;
    const update = { status: 'delivered', deliveredAt: new Date() };
    if (rating) { update.rating = rating; update.comment = comment; update.ratedAt = new Date(); }
    const order = await Order.findOneAndUpdate(
      { _id: req.params.id, userId: req.userId },
      update,
      { new: true },
    );
    if (!order) return res.status(404).json({ error: 'Buyurtma topilmadi' });

    getIO()?.to(`restaurant:${order.restaurantId}`).emit('order:update', order);
    getIO()?.to('admin').emit('order:update', order);
    res.json(order);
  }),

  // PATCH /api/orders/:id/status  { status }  (restoran/admin)
  updateStatus: asyncHandler(async (req, res) => {
    const { status } = req.body;
    const order = await Order.findByIdAndUpdate(req.params.id, { status }, { new: true }).populate('userId');
    if (!order) return res.status(404).json({ error: 'Buyurtma topilmadi' });

    getIO()?.to(`order:${order._id}`).emit('order:status', { orderId: order._id, status: order.status });

    const user = order.userId;
    const statusText = {
      preparing: '\ud83d\udc68\u200d\ud83c\udf73 Buyurtmangiz tayyorlanmoqda',
      delivering: '\ud83d\udeb4 Buyurtmangiz yo‘lda',
      delivered: '✅ Buyurtmangiz yetkazildi. Yoqimli ishtaha!',
    };
    if (user?.telegramId && statusText[status]) {
      notifyUser(user.telegramId, statusText[status]);
    }
    res.json(order);
  }),
};
