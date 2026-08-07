import { config } from '../config/index.js';

/**
 * Yetkazish masofasi va narxi.
 *
 * Masofa Yandex Routing orqali — haqiqiy yo'l bo'yicha,
 * to'g'ri chiziq emas.
 */

// Yandex javoblari keshi — bir manzil qayta-qayta so'ralmasin
const routeCache = new Map();
const CACHE_TTL = 10 * 60_000;   // 10 daqiqa
const CACHE_MAX = 500;

function cacheKey(a, b) {
  const r = (n) => Number(n).toFixed(4);
  return `${r(a.lat)},${r(a.lng)}|${r(b.lat)},${r(b.lng)}`;
}

/**
 * Ikki nuqta orasidagi to'g'ri chiziq masofasi (km).
 * Yandex ishlamasa zaxira sifatida ishlatiladi.
 */
export function haversineKm(a, b) {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const lat1 = a.lat * Math.PI / 180;
  const lat2 = b.lat * Math.PI / 180;

  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Haqiqiy yo'l masofasi — Yandex Routing.
 *
 * Kalit yo'q yoki xato bo'lsa to'g'ri chiziq masofasiga
 * 1.3 koeffitsient qo'llanadi (shahar yo'llari uchun odatiy).
 */
export async function roadDistanceKm(from, to) {
  const key = cacheKey(from, to);
  const hit = routeCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.km;

  const apiKey = config.yandex?.routingKey || config.yandex?.geocoderKey;

  let km;
  let source = 'estimate';

  if (apiKey) {
    try {
      const url = new URL('https://api.routing.yandex.net/v2/route');
      url.searchParams.set('apikey', apiKey);
      url.searchParams.set('waypoints', `${from.lat},${from.lng}|${to.lat},${to.lng}`);
      url.searchParams.set('mode', 'driving');

      const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
      const data = await res.json();

      const meters = data?.route?.legs?.[0]?.status === 'OK'
        ? data.route.legs[0].steps?.reduce((s, x) => s + (x.length?.value || 0), 0)
        : null;

      if (meters > 0) {
        km = meters / 1000;
        source = 'yandex';
      }
    } catch {
      /* zaxiraga o'tamiz */
    }
  }

  if (km == null) {
    // Shahar yo'llari to'g'ri chiziqdan ~30% uzunroq
    km = haversineKm(from, to) * 1.3;
  }

  km = Math.round(km * 10) / 10;

  // Kesh
  if (routeCache.size >= CACHE_MAX) {
    routeCache.delete(routeCache.keys().next().value);
  }
  routeCache.set(key, { km, at: Date.now() });

  return km;
}

/**
 * Yetkazish narxini hisoblaydi.
 *
 * FREE     — har doim bepul
 * PAID     — basePrice + (masofa − freeKm) × extraKmPrice
 * DISABLED — yetkazish yo'q
 *
 * @returns {{ available, price, reason }}
 */
export function calcDeliveryPrice(distanceKm, delivery) {
  const type = delivery?.type || 'free';

  if (type === 'disabled') {
    return {
      available: false,
      price: 0,
      reason: 'Bu restoran yetkazib bermaydi',
      code: 'DELIVERY_DISABLED',
    };
  }

  // Radius tekshiruvi
  const maxKm = Number(delivery?.maxDistanceKm) || 0;
  if (maxKm > 0 && distanceKm > maxKm) {
    return {
      available: false,
      price: 0,
      reason: `Manzil juda uzoq — ${distanceKm} km. `
        + `Yetkazish ${maxKm} km gacha.`,
      code: 'OUT_OF_RANGE',
      distanceKm,
      maxKm,
    };
  }

  if (type === 'free') {
    return { available: true, price: 0, distanceKm };
  }

  // PAID
  const p = delivery?.pricing || {};
  const freeKm = Number(p.freeKm) || 0;
  const basePrice = Number(p.basePrice) || 0;
  const extraKmPrice = Number(p.extraKmPrice) || 0;
  const maxPrice = Number(p.maxPrice) || 0;

  const extraKm = Math.max(0, distanceKm - freeKm);
  // Yarim km ham to'liq hisoblanadi — mijozga tushunarli
  let price = basePrice + Math.ceil(extraKm) * extraKmPrice;

  if (maxPrice > 0 && price > maxPrice) price = maxPrice;

  return {
    available: true,
    price: Math.max(0, Math.round(price)),
    distanceKm,
    breakdown: {
      basePrice,
      freeKm,
      extraKm: Math.ceil(extraKm),
      extraKmPrice,
    },
  };
}

/**
 * To'liq hisob: masofa + narx.
 *
 * @param {object} restaurant - lat, lng, delivery
 * @param {object} customer - { lat, lng }
 */
export async function quoteDelivery(restaurant, customer) {
  // Koordinata yo'q — masofani hisoblab bo'lmaydi
  if (!restaurant?.lat || !restaurant?.lng) {
    return {
      available: true,
      price: Number(restaurant?.deliveryFee) || 0,
      distanceKm: null,
      reason: 'Restoran koordinatasi belgilanmagan',
    };
  }

  if (!customer?.lat || !customer?.lng) {
    return {
      available: true,
      price: Number(restaurant?.deliveryFee) || 0,
      distanceKm: null,
      reason: 'Manzil koordinatasi yo\u2018q',
    };
  }

  const distanceKm = await roadDistanceKm(
    { lat: restaurant.lat, lng: restaurant.lng },
    { lat: customer.lat, lng: customer.lng },
  );

  return calcDeliveryPrice(distanceKm, restaurant.delivery);
}
