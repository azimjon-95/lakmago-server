/*
 * ═══ TAOM TAKLIFI: KIMGA, QACHON, QAYSI TAOM, QAYSI MATN (toza funksiyalar) ═══
 *
 * Kafolatlar (tests/promo-push.test.mjs):
 *  • bir qurilmaga kuniga ko'pi bilan 2 ta (slot: lunch, dinner) — jurnaldagi unique indeks ham qo'riqlaydi;
 *  • shablon 14 kun ichida, taom 7 kun ichida shu qurilmaga TAKRORLANMAYDI; kechagi restoran iloji boricha boshqa;
 *  • bir mijozning boshqa qurilmasiga bugun ketgan shablon/taom bu qurilmaga ketmaydi;
 *  • bir slotda shablonlar hammaga teng taqsimlanadi (kam ishlatilgani ustun) — hammaga har xil;
 *  • tanlov deterministik (deviceId+kun+slot urug'i) — qayta urinishda bir xil natija, lekin qurilmalar orasida farqli.
 */
import { TEMPLATES, groupOf, EXCLUDED_CATEGORIES } from './promoPushTemplates.js';
import { latinToCyrillic } from './translitUz.js';

export const TEMPLATE_COOLDOWN_DAYS = 14;
export const DISH_COOLDOWN_DAYS = 7;
export const TITLE_MAX = 60;
export const BODY_MAX = 170;
export const SLOTS = ['lunch', 'dinner'];

/* ───── vaqt (Toshkent, UTC+5, yozgi vaqt yo'q) ───── */
const TZ_OFFSET_MIN = 5 * 60;
export function tashkentParts(date = new Date()) {
  const d = new Date(date.getTime() + TZ_OFFSET_MIN * 60_000);
  const day = d.toISOString().slice(0, 10);
  return { day, minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
}
export const toMin = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m) return null;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return v >= 0 && v < 24 * 60 ? v : null;
};
export const dayShift = (day, delta) => new Date(Date.parse(`${day}T00:00:00Z`) + delta * 86_400_000).toISOString().slice(0, 10);

/* ───── urug'li tasodif ───── */
export function hash32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Qurilmaning shu slotdagi yuborish daqiqasi (oyna ichida, qurilma uchun doimiy-ish):
 * hamma bir daqiqada olmasin (server va restoranlar yuklamasi) va har kuni bir xil soniyada ham kelmasin.
 */
export function targetMinute(deviceId, day, slot, from, to) {
  const span = Math.max(1, to - from);
  return from + (hash32(`${deviceId}|${day}|${slot}`) % span);
}

/** Hozir qaysi slot oynasi ochiq (yoki null) */
export function activeSlot(minutes, windows) {
  for (const slot of SLOTS) {
    const w = windows[slot];
    if (w && w.from != null && w.to != null && minutes >= w.from && minutes < w.to) return slot;
  }
  return null;
}

/** Qurilma hozir yuborilishi kerakmi (o'z daqiqasi keldi va oyna yopilmagan) */
export function isDue({ deviceId, day, minutes, slot, window }) {
  if (!window || minutes < window.from || minutes >= window.to) return false;
  return minutes >= targetMinute(deviceId, day, slot, window.from, window.to);
}

/* ───── matn ───── */
const som = (n) => `${Math.round(Number(n) || 0).toLocaleString('ru-RU').replace(/[\s  ,]/g, ' ')} so‘m`;
const sumRu = (n) => `${Math.round(Number(n) || 0).toLocaleString('ru-RU').replace(/[\s  ,]/g, ' ')} сум`;
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

export function renderTemplate(tpl, lang, { dish, rest, price }) {
  const src = lang === 'ru' ? tpl.ru : tpl.uz;
  const fill = (s) => {
    const base = lang === 'uzc' ? latinToCyrillic(s) : s;
    const p = lang === 'ru' ? sumRu(price) : lang === 'uzc' ? latinToCyrillic(som(price)) : som(price);
    return clean(base.replaceAll('{dish}', clean(dish)).replaceAll('{rest}', clean(rest)).replaceAll('{price}', p));
  };
  return { title: fill(src[0]), body: fill(src[1]) };
}

/* ───── tanlash ───── */
/**
 * @param device    { deviceId, userId, lang }
 * @param slot      'lunch' | 'dinner'
 * @param day       'YYYY-MM-DD' (Toshkent)
 * @param dishes    [{ dishId, name, price, category, restaurantId, restaurantName, imageUrl, hit }]
 * @param history   shu qurilmaning so'nggi jurnallari [{ day, templateId, dishId, restaurantId }]
 * @param siblings  shu mijozning BOSHQA qurilmalariga bugun ketganlar [{ templateId, dishId }]
 * @param usage     Map<templateId, number> — bu slotda bugun necha marta ishlatilgani (hammaga har xil)
 * @param templates (test uchun almashtirish mumkin)
 * @returns null | { templateId, dish, title, body }
 */
export function pickPromo({ device, slot, day, dishes, history = [], siblings = [], usage = new Map(), templates = TEMPLATES }) {
  const lang = ['uz', 'uzc', 'ru'].includes(device.lang) ? device.lang : 'uz';
  const tplCut = dayShift(day, -TEMPLATE_COOLDOWN_DAYS);
  const dishCut = dayShift(day, -DISH_COOLDOWN_DAYS);
  const yesterday = dayShift(day, -1);

  const usedTpl = new Set(history.filter((h) => h.day > tplCut).map((h) => h.templateId));
  const usedDish = new Set(history.filter((h) => h.day > dishCut && h.dishId).map((h) => String(h.dishId)));
  const recentRest = new Set(history.filter((h) => h.day >= yesterday && h.restaurantId).map((h) => String(h.restaurantId)));
  for (const s of siblings) { if (s.templateId) usedTpl.add(s.templateId); if (s.dishId) usedDish.add(String(s.dishId)); }

  const pool = dishes.filter((d) => d && d.dishId && clean(d.name) && Number(d.price) > 0
    && !EXCLUDED_CATEGORIES.includes(d.category) && !usedDish.has(String(d.dishId)));
  if (!pool.length) return null;

  const rand = rng(hash32(`${device.deviceId}|${day}|${slot}`));
  // Taom og'irligi: rasmli ×3, xit ×2, kechagi restoran ×0.25 (butunlay taqiqlanmaydi — tanlov kam bo'lsa)
  const weightOf = (d) => (d.imageUrl ? 3 : 1) * (d.hit ? 2 : 1) * (recentRest.has(String(d.restaurantId)) ? 0.25 : 1);
  const order = [];
  const left = pool.slice();
  // 12 tagacha nomzod (og'irlikli tasodifiy tartib) — har biriga mos shablon qidiriladi
  while (left.length && order.length < 12) {
    const total = left.reduce((s, d) => s + weightOf(d), 0);
    let r = rand() * total;
    let idx = 0;
    for (; idx < left.length - 1; idx++) { r -= weightOf(left[idx]); if (r <= 0) break; }
    order.push(left.splice(idx, 1)[0]);
  }

  const slotOk = (t) => t.slot === 'any' || t.slot === slot;
  for (const dish of order) {
    const g = groupOf(dish.category);
    const fits = templates.filter((t) => slotOk(t) && !usedTpl.has(t.id) && (!t.cats || (g && t.cats.includes(g))));
    if (!fits.length) continue;
    // Taomga xos shablon ("Qozon qaynadi" — osh uchun) yarim holatda ustun, LEKIN faqat umumiy shablonlardan
    // ko'p ishlatilmagan bo'lsa: aks holda kam sonli xos shablonlar (salat — 2 ta) hammaga bir xil kelib qoladi.
    const use = (t) => usage.get(t.id) || 0;
    const minAll = Math.min(...fits.map(use));
    const specific = fits.filter((t) => t.cats && use(t) <= minAll + 1);
    const base = specific.length && rand() < 0.5 ? specific : fits;
    // Eng kam ishlatilgani birinchi, tenglar orasida tasodifiy; uzunlikka sig'magani o'tkazib yuboriladi
    const ordered = base.map((t) => [use(t), rand(), t])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((x) => x[2]);
    for (const tpl of ordered) {
      const msg = renderTemplate(tpl, lang, { dish: dish.name, rest: dish.restaurantName, price: dish.price });
      if (msg.title.length > TITLE_MAX || msg.body.length > BODY_MAX) continue;
      return { templateId: tpl.id, dish, ...msg };
    }
  }
  return null;
}
