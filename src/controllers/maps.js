import { asyncHandler } from '../middleware/error.js';
import { config } from '../config/index.js';

/**
 * Yandex Maps proksisi.
 *
 * Kalitlar serverda qoladi — brauzerga chiqmaydi. Bu to'g'ri
 * yondashuv: kalit ochiq bo'lsa boshqalar ishlatib kvotani
 * tugatishi mumkin.
 */
export const mapsController = {
  // GET /api/maps/config — xarita ishlatish mumkinmi
  config: asyncHandler(async (_req, res) => {
    res.json({
      enabled: Boolean(config.yandex.mapsKey),
      // JS API uchun kalit kerak — uni brauzerga berishga majburmiz,
      // lekin Yandex kabinetida domen cheklovi qo'yiladi
      mapsKey: config.yandex.mapsKey || '',
    });
  }),

  // GET /api/maps/geocode?q=... — manzil bo'yicha qidirish
  geocode: asyncHandler(async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'So\u2018rov bo\u2018sh' });

    const key = config.yandex.geocoderKey;
    if (!key) return res.status(503).json({ error: 'Xarita sozlanmagan' });

    try {
      const url = new URL('https://geocode-maps.yandex.ru/1.x/');
      url.searchParams.set('apikey', key);
      url.searchParams.set('geocode', q);
      url.searchParams.set('format', 'json');
      url.searchParams.set('lang', 'ru_RU');
      url.searchParams.set('results', '5');
      // O'zbekiston bilan cheklaymiz
      url.searchParams.set('bbox', '55.9,37.1~73.2,45.6');
      url.searchParams.set('rspn', '1');

      const r = await fetch(url);
      const data = await r.json();

      const found = data?.response?.GeoObjectCollection?.featureMember || [];
      res.json(found.map((f) => {
        const g = f.GeoObject;
        const [lng, lat] = g.Point.pos.split(' ').map(Number);
        return {
          name: g.metaDataProperty?.GeocoderMetaData?.text || g.name,
          lat,
          lng,
        };
      }));
    } catch (e) {
      console.error('[maps] geocode:', e.message);
      res.status(502).json({ error: 'Qidiruv xatosi' });
    }
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
      return res.status(400).json({ error: 'Koordinata noto\u2018g\u2018ri' });
    }

    const restaurant = await Restaurant.findById(req.query.restaurantId)
      .select('name lat lng delivery deliveryFee')
      .lean();

    if (!restaurant) {
      return res.status(404).json({ error: 'Restoran topilmadi' });
    }

    const quote = await quoteDelivery(restaurant, { lat, lng });

    res.json({
      restaurantId: String(restaurant._id),
      restaurantName: restaurant.name,
      distanceKm: quote.distanceKm,
      deliveryAvailable: quote.available,
      deliveryPrice: quote.price,
      ...(quote.reason ? { reason: quote.reason, code: quote.code } : {}),
      ...(quote.breakdown ? { breakdown: quote.breakdown } : {}),
    });
  }),

  // GET /api/maps/reverse?lat=&lng= — koordinatadan manzil
  reverse: asyncHandler(async (req, res) => {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: 'Koordinata noto\u2018g\u2018ri' });
    }

    const key = config.yandex.geocoderKey;
    if (!key) return res.json({ address: '' });

    try {
      const url = new URL('https://geocode-maps.yandex.ru/1.x/');
      url.searchParams.set('apikey', key);
      // Yandex tartibi: uzunlik, kenglik
      url.searchParams.set('geocode', `${lng},${lat}`);
      url.searchParams.set('format', 'json');
      url.searchParams.set('lang', 'ru_RU');
      url.searchParams.set('results', '1');

      const r = await fetch(url);
      const data = await r.json();
      const g = data?.response?.GeoObjectCollection?.featureMember?.[0]?.GeoObject;

      res.json({
        address: g?.metaDataProperty?.GeocoderMetaData?.text || '',
      });
    } catch (e) {
      console.error('[maps] reverse:', e.message);
      res.json({ address: '' });
    }
  }),
};
