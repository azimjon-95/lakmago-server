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

/*
 * ═══════════════════════════════════════════════════════════
 * YETKAZISH NARXI — BITTA QAT'IY NARX
 * ═══════════════════════════════════════════════════════════
 *
 * SODDALASHTIRILDI: avval "yetkazish turi" (free/paid/disabled)
 * va masofaga qarab bosqichli hisob bor edi (bepul masofa,
 * boshlang'ich narx, har km uchun narx, eng ko'p narx).
 * Amalda restoranlar buni to'ldirmасdi va mijoz yakuniy narxni
 * oldindan bilolmasdi.
 *
 * ENDI:
 *   • restoran BITTA yetkazish narxini belgilaydi (deliveryFee);
 *   • 0 bo'lsa — yetkazish BEPUL;
 *   • buyurtma summasi `freeDeliveryThreshold` dan oshsa — bepul;
 *   • `deliveryEnabled = false` bo'lsa — yetkazish umuman yo'q;
 *   • masofa radiusni tekshiradi va perKm rejimida narxga
 *     ta'sir qiladi (`delivery.pricingMode`).
 *
 * @param {number}  distanceKm  haqiqiy yo'l masofasi (km)
 * @param {object}  restaurant  deliveryEnabled, deliveryFee,
 *                              freeDeliveryThreshold, delivery.maxDistanceKm
 * @param {number}  [subtotal]  taom summasi — bepul chegara uchun
 * @returns {{ available, price, free, reason, code, distanceKm, maxKm }}
 */
export function calcDeliveryPrice(distanceKm, restaurant, subtotal = 0) {
  // Restoran yetkazib bermaydi
  if (restaurant?.deliveryEnabled === false) {
    return {
      available: false,
      price: 0,
      free: false,
      reason: 'Bu restoran yetkazib bermaydi',
      code: 'DELIVERY_DISABLED',
    };
  }

  // Radius — undan uzoqqa yetkazilmaydi
  const maxKm = Number(restaurant?.delivery?.maxDistanceKm) || 0;
  if (maxKm > 0 && Number.isFinite(distanceKm) && distanceKm > maxKm) {
    return {
      available: false,
      price: 0,
      free: false,
      reason: `Manzil juda uzoq — ${distanceKm} km. Yetkazish ${maxKm} km gacha.`,
      code: 'OUT_OF_RANGE',
      distanceKm,
      maxKm,
    };
  }

  /*
   * ═══ NARXNI HISOBLASH ═══
   *
   * Ikki rejim:
   *   flat  — restoran belgilagan bitta narx;
   *   perKm — bepul masofadan keyin har km uchun narx.
   *
   * perKm rejimida masofa NOMA'LUM bo'lsa (koordinata yo'q),
   * qat'iy narxga qaytamiz: mijozdan noaniq summa olib
   * bo'lmaydi, "0" deb ko'rsatish esa restoranni zarar qiladi.
   */
  const mode = restaurant?.delivery?.pricingMode === 'perKm' ? 'perKm' : 'flat';
  const flatFee = Math.max(0, Math.round(Number(restaurant?.deliveryFee) || 0));

  let fee = flatFee;
  let breakdown = null;

  if (mode === 'perKm') {
    const perKm = Math.max(0, Math.round(Number(restaurant?.delivery?.perKm) || 0));
    const freeKm = Math.max(0, Number(restaurant?.delivery?.freeKm) || 0);

    if (!Number.isFinite(distanceKm)) {
      breakdown = { mode: 'perKm', fallback: true, perKm, freeKm };
    } else {
      // Bepul masofadan keyingi qism uchun to'lanadi
      const paidKm = Math.max(0, distanceKm - freeKm);
      /*
       * 100 so'mgacha yaxlitlanadi — mijoz "4 733 so'm" kabi
       * g'alati summani ko'rmasin.
       */
      fee = Math.round((paidKm * perKm) / 100) * 100;
      breakdown = {
        mode: 'perKm', perKm, freeKm,
        distanceKm: Math.round(distanceKm * 10) / 10,
        paidKm: Math.round(paidKm * 10) / 10,
      };
    }
  }

  // Narx 0 — yetkazish bepul
  if (fee === 0) {
    return { available: true, price: 0, free: true, distanceKm, maxKm, breakdown };
  }

  /*
   * Bepul yetkazish chegarasi: buyurtma summasi shu miqdordan
   * oshsa, restoran yetkazishni o'z zimmasiga oladi.
   * 0 = chegara yo'q (doim pullik).
   */
  const threshold = Math.max(0, Number(restaurant?.freeDeliveryThreshold) || 0);
  if (threshold > 0 && Number(subtotal) >= threshold) {
    return { available: true, price: 0, free: true, distanceKm, maxKm, threshold, breakdown };
  }

  return { available: true, price: fee, free: false, distanceKm, maxKm, threshold, breakdown };
}

/**
 * To'liq hisob: masofa + narx.
 *
 * @param {object} restaurant - lat, lng, delivery
 * @param {object} customer - { lat, lng }
 */
export async function quoteDelivery(restaurant, customer, subtotal = 0) {
  /*
   * Koordinata yo'q — masofani hisoblab bo'lmaydi. Buyurtmani
   * RAD ETMAYMIZ: narx baribir bitta, masofa faqat radius uchun
   * kerak edi. Radius tekshiruvisiz narx qaytariladi.
   */
  if (!restaurant?.lat || !restaurant?.lng || !customer?.lat || !customer?.lng) {
    const quote = calcDeliveryPrice(NaN, restaurant, subtotal);
    return {
      ...quote,
      distanceKm: null,
      reason: quote.reason || 'Masofa aniqlanmadi — radius tekshirilmadi',
    };
  }

  const distanceKm = await roadDistanceKm(
    { lat: restaurant.lat, lng: restaurant.lng },
    { lat: customer.lat, lng: customer.lng },
  );

  return calcDeliveryPrice(distanceKm, restaurant, subtotal);
}
