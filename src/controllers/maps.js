import { asyncHandler } from '../middleware/error.js';
import { config } from '../config/index.js';
import { googleGeocode, googleReverse, hasGoogleKey } from '../services/googleMaps.js';
import { routeBetween } from '../services/routeGeometry.js';

/**
 * Google Maps proksisi (services/googleMaps.js).
 *
 * SERVER kaliti (Routes/Geocoding) brauzerga chiqmaydi. Brauzerga faqat alohida BRAUZER kaliti beriladi (Maps JavaScript
 * API, HTTP referrer bo'yicha cheklangan) — u baribir sahifada ko'rinadi, shuning uchun server kalitidan ajratilgan.
 */
// O'zbekiston va atrofi: marshrut so'rovi tashqariga chiqmasin (har so'rov pullik — suiiste'molga qarshi)
const inRegion = (lat, lng) => lat >= 36 && lat <= 46.5 && lng >= 54 && lng <= 75.5;

export const mapsController = {
  // GET /api/maps/config — xarita ishlatish mumkinmi (provider: 'google')
  config: asyncHandler(async (_req, res) => {
    res.json({
      provider: 'google',
      enabled: Boolean(config.google.browserKey),
      // Maps JavaScript API kaliti — brauzerga berishga majburmiz, lekin Google kabinetida HTTP referrer cheklovi qo'yiladi
      mapsKey: config.google.browserKey || '',
    });
  }),

  // GET /api/maps/geocode?q=...&lang= — manzil bo'yicha qidirish
  geocode: asyncHandler(async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'So‘rov bo‘sh' });
    if (!hasGoogleKey()) return res.status(503).json({ error: 'Xarita sozlanmagan' });

    const found = await googleGeocode(q, req.query.lang);
    if (found === null) {
      console.error('[maps] geocode: Google javob bermadi');
      return res.status(502).json({ error: 'Qidiruv xatosi' });
    }
    res.json(found);
  }),

  /**
   * GET /api/maps/route?fromLat=&fromLng=&toLat=&toLng=
   *
   * Haqiqiy yo'l bo'yicha marshrut: { points: [[lat,lng],…], distanceKm, distanceM, durationMin, durationS, source }.
   * source: 'google' | 'osrm' | 'straight' (straight — marshrut topilmadi: mijoz soxta chiziq/raqam CHIZMAYDI).
   * Mijoz brauzeri Google'ning Directions xizmatini O'ZI chaqirmaydi: bitta kalit, kesh, OSRM zaxirasi va narx nazorati serverda.
   */
  route: asyncHandler(async (req, res) => {
    const n = (k) => Number(req.query[k]);
    const a = { lat: n('fromLat'), lng: n('fromLng') };
    const b = { lat: n('toLat'), lng: n('toLng') };
    if (![a.lat, a.lng, b.lat, b.lng].every(Number.isFinite)) return res.status(400).json({ error: 'Koordinata noto‘g‘ri' });
    if (!inRegion(a.lat, a.lng) || !inRegion(b.lat, b.lng)) return res.status(400).json({ error: 'Koordinata hududdan tashqarida' });
    res.json(await routeBetween(a, b));
  }),

  /**
   * GET /api/maps/delivery-quote?restaurantId=&lat=&lng=
   *
   * Masofa va yetkazish narxi. Buyurtma berishdan oldin
   * mijozga ko'rsatiladi.
   */
  deliveryQuote: asyncHandler(async (req, res) => {
    const { Restaurant } = await import('../models/Restaurant.js');
    const { quoteDelivery } = await import('../services/deliveryEngine.js');

    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: 'Koordinata noto‘g‘ri' });
    }

    const restaurant = await Restaurant.findById(req.query.restaurantId)
      .select('name lat lng delivery deliveryFee deliveryEnabled freeDeliveryThreshold')
      .lean();

    if (!restaurant) {
      return res.status(404).json({ error: 'Restoran topilmadi' });
    }

    /*
     * `subtotal` — savat summasi. Bepul yetkazish chegarasi shunga
     * qarab qo'llanadi: usiz mijoz chegaradan oshgan buyurtmada ham
     * to'liq yetkazish narxini ko'rardi.
     */
    const subtotal = Math.max(0, Number(req.query.subtotal) || 0);
    const quote = await quoteDelivery(restaurant, { lat, lng }, subtotal);

    res.json({
      restaurantId: String(restaurant._id),
      restaurantName: restaurant.name,
      distanceKm: quote.distanceKm,
      deliveryAvailable: quote.available,
      deliveryPrice: quote.price,
      deliveryFree: Boolean(quote.free),
      freeDeliveryThreshold: quote.threshold || 0,
      ...(quote.reason ? { reason: quote.reason, code: quote.code } : {}),
      ...(quote.breakdown ? { breakdown: quote.breakdown } : {}),
    });
  }),

  // GET /api/maps/reverse?lat=&lng=&lang= — koordinatadan manzil: { address, street, city } (kalit yo'q/xato — bo'sh manzil)
  reverse: asyncHandler(async (req, res) => {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: 'Koordinata noto‘g‘ri' });
    }
    const r = await googleReverse(lat, lng, req.query.lang);
    res.json(r || { address: '', street: '', city: '' });
  }),
};
