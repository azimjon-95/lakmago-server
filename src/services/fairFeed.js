/*
 * ═══════════════════════════════════════════════════════════
 * ADOLATLI TASMA — bosh sahifa «Tavsiya qilamiz» / «Super Chegirmalar»
 * ═══════════════════════════════════════════════════════════
 *
 * MUAMMO: /dishes/all faqat createdAt bo'yicha tartiblanardi.
 * Menyusini yangi import qilgan 3-4 restoran birinchi 50 taomni
 * to'liq egallab, qolgan restoranlar mijoz uzoq aylantirmaguncha
 * umuman ko'rinmasdi ("meniki chiqmayapti" shikoyati).
 *
 * YECHIM: restoranlar bo'yicha navbatma-navbat (round-robin):
 * R1, R2 … Rn, R1, R2 … — 10 restoran bo'lsa birinchi 10 taom
 * 10 xil restorandan. Restoranlar tartibi va har birining ichidagi
 * taomlar — urug' (seed) bilan aralashtirilgan.
 *
 * ─── BARQARORLIK — NEGA _id BO'YICHA SARALANADI ───
 * Tartib har sahifa so'rovida QAYTA hisoblanadi (server holat
 * saqlamaydi). Urug' bir xil bo'lsa ham, aralashtirishga kirgan
 * ro'yxatning o'zi boshqa tartibda kelsa — natija boshqacha bo'ladi
 * va 2-sahifa 1-sahifadan boshqa ketma-ketlikdan kesiladi: taomlar
 * takrorlanadi yoki tushib qoladi. MongoDB `sort`siz so'rovda tartibni
 * kafolatlamaydi — shuning uchun chaqiruvchi `_id` bo'yicha saralangan
 * ro'yxat berishi SHART, bu yerda esa guruhlar ham kalit bo'yicha
 * saralanadi (Map tartibiga bog'liq emas).
 *
 * Cursor: `fair|{seed}|{offset}` — urug' butun aylantirish davomida
 * bir xil qoladi, offset — nechta taom allaqachon berilgan.
 */

/** Urug'li tasodifiy son generatori (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, seed) {
  const a = [...arr];
  const rnd = rng(seed);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const MAX_SEED = 2 ** 32;

/** Urug' to'g'rimi (butun, 0 ≤ s < 2³²). */
export function isValidSeed(s) {
  return Number.isInteger(s) && s >= 0 && s < MAX_SEED;
}

export function randomSeed() {
  return Math.floor(Math.random() * 2 ** 31);
}

/**
 * `fair|{seed}|{offset}` ni o'qiydi. Noto'g'ri bo'lsa `null` —
 * chaqiruvchi birinchi sahifani qaytaradi (500 xato emas).
 */
export function parseFairCursor(raw) {
  if (typeof raw !== 'string' || !raw.startsWith('fair|')) return null;
  const [, s, o] = raw.split('|');
  const seed = Number(s);
  const offset = Number(o);
  if (!isValidSeed(seed) || !Number.isInteger(offset) || offset < 0) return null;
  return { seed, offset };
}

export function makeFairCursor(seed, offset) {
  return `fair|${seed}|${offset}`;
}

/**
 * Adolatli tartib. Kiruvchi ro'yxat `_id` bo'yicha saralangan
 * bo'lishi kerak (yuqoridagi izoh). Faqat `_id` va `restaurantId`
 * ishlatiladi — to'liq hujjat shart emas.
 *
 * @param {Array<{_id, restaurantId}>} items
 * @param {number} seed
 * @returns {Array} shu elementlar, adolatli tartibda
 */
export function fairOrder(items, seed) {
  const byRest = new Map();
  for (const d of items) {
    const k = String(d.restaurantId);
    if (!byRest.has(k)) byRest.set(k, []);
    byRest.get(k).push(d);
  }
  // Guruhlar kalit bo'yicha — Map qo'shilish tartibiga bog'liq bo'lmasin
  const keys = [...byRest.keys()].sort();
  const queues = shuffle(keys, seed).map((k, i) => shuffle(byRest.get(k), seed + (i + 1) * 97));

  const out = [];
  for (let added = true; added;) {
    added = false;
    for (const q of queues) {
      if (q.length) { out.push(q.shift()); added = true; }
    }
  }
  return out;
}
