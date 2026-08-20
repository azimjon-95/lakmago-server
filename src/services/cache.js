import Redis from 'ioredis';

/**
 * Redis kesh qatlami.
 *
 * ENG MUHIM QOIDA: Redis MAJBURIY EMAS.
 *
 * REDIS_URL berilmasa yoki Redis ishlamay qolsa — dastur
 * ODDIY ISHLAYVERADI, shunchaki keshsiz (to'g'ridan-to'g'ri
 * MongoDB'dan). Kesh — tezlashtirish vositasi, ishlashning
 * SHARTI emas. Aks holda Redis yiqilsa butun platforma
 * to'xtab qolardi — bu qabul qilib bo'lmaydigan xavf.
 *
 * Shuning uchun barcha funksiyalar xatoni yutadi va
 * null/false qaytaradi — chaqiruvchi kod har doim bazaga
 * murojaat qila oladigan zaxira yo'liga ega bo'lishi kerak.
 */

let client = null;
let ready = false;

/** Ulanishga urinish. Muvaffaqiyatsiz bo'lsa — jim, keshsiz davom. */
export function initCache() {
  const url = process.env.REDIS_URL;
  if (!url) {
    console.log('[cache] REDIS_URL berilmagan — kesh o\u2018chirilgan (dastur keshsiz ishlaydi)');
    return null;
  }

  client = new Redis(url, {
    // Cheksiz qayta urinish serverni bo'g'ib qo'ymasin
    maxRetriesPerRequest: 2,
    retryStrategy: (times) => (times > 5 ? null : Math.min(times * 200, 2000)),
    lazyConnect: false,
    enableOfflineQueue: false,
  });

  client.on('ready', () => {
    ready = true;
    console.log('[cache] Redis ulandi');
  });
  client.on('error', (e) => {
    // Faqat birinchi xatoni chiqaramiz — loglar to'lib ketmasin
    if (ready) console.warn('[cache] Redis xatosi:', e.message);
    ready = false;
  });
  client.on('end', () => { ready = false; });

  return client;
}

export function getRedis() {
  return ready ? client : null;
}

/** Redis ishlayaptimi — socket adapter va h.k. uchun. */
export function isCacheReady() {
  return ready;
}

/* ═══════════════════════════════════════════
   Asosiy amallar — barchasi xavfsiz (xato yutiladi)
   ═══════════════════════════════════════════ */

export async function cacheGet(key) {
  if (!ready) return null;
  try {
    const raw = await client.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function cacheSet(key, value, ttlSec = 300) {
  if (!ready) return false;
  try {
    await client.set(key, JSON.stringify(value), 'EX', ttlSec);
    return true;
  } catch {
    return false;
  }
}

export async function cacheDel(...keys) {
  if (!ready || !keys.length) return false;
  try {
    await client.del(...keys);
    return true;
  } catch {
    return false;
  }
}

/**
 * Naqsh bo'yicha o'chirish (masalan `rest:123:*`).
 *
 * SCAN ishlatiladi, KEYS EMAS: KEYS butun bazani bloklaydi va
 * katta bazada serverni qotirib qo'yadi — ishlab chiqarishda
 * xavfli. SCAN esa bo'lak-bo'lak yuradi.
 */
export async function cacheDelPattern(pattern) {
  if (!ready) return false;
  try {
    let cursor = '0';
    do {
      const [next, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = next;
      if (keys.length) await client.del(...keys);
    } while (cursor !== '0');
    return true;
  } catch {
    return false;
  }
}

/**
 * "Bor bo'lsa keshdan, yo'q bo'lsa bazadan olib keshla".
 *
 * Eng ko'p ishlatiladigan naqsh — kontrollerlarda takroriy
 * kod yozmaslik uchun.
 */
export async function cached(key, ttlSec, loader) {
  const hit = await cacheGet(key);
  if (hit !== null) return hit;

  const fresh = await loader();
  // undefined ni keshlamaymiz — "topilmadi" va "kesh yo'q"
  // holatlarini aralashtirmaslik uchun
  if (fresh !== undefined && fresh !== null) {
    await cacheSet(key, fresh, ttlSec);
  }
  return fresh;
}

/* ═══════════════════════════════════════════
   Kalit nomlari — bitta joyda, chalkashmasin
   ═══════════════════════════════════════════ */

export const KEYS = {
  restaurantFull: (id) => `rest:${id}:full`,
  restaurantDishes: (id) => `rest:${id}:dishes`,
  restaurantAny: (id) => `rest:${id}:*`,
  catalogList: (q) => `catalog:list:${q}`,
  catalogAny: () => 'catalog:*',
  bannerAds: () => 'ads:banner',
};

/** TTL qiymatlari (soniyada) — ma'lumot o'zgarish tezligiga qarab. */
export const TTL = {
  restaurantFull: 300,    // 5 daq — restoran profili kam o'zgaradi
  dishes: 180,            // 3 daq — menyu/stop-list tez-tez o'zgaradi
  catalog: 120,           // 2 daq — mijoz ko'radigan ro'yxat
  ads: 120,               // 2 daq
};
