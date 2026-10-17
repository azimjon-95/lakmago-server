/*
 * Reklama oynalari — sof mantiq (bazasiz testlanadi): matnni tozalash, faollik, mijozga ko'rinish.
 */
export const TEMPLATES = ['brush', 'coupon', 'sunburst', 'image'];
export const LIMITS = { title: 90, footer: 70, link: 200 };
export const MAX_ACTIVE = 5;

/**
 * Matn: boshqaruv belgilari olinadi, bo'shliqlar yig'iladi, uzunlik cheklanadi.
 * Urg'u belgisi `*`: juft bo'lmasa oxirgisi olib tashlanadi; ko'pi bilan 2 ta urg'u bo'lagi.
 * Natija har doim oddiy matn — mijozda React uni xavfsiz chiqaradi.
 */
export function cleanText(raw, max) {
  let s = String(raw ?? '')
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F\u200B-\u200F\u2028-\u202E\uFEFF]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
  // Urg'u bo'laklari: ko'pi bilan 2 ta, juft yulduzcha
  let n = 0;
  s = s.replace(/\*([^*]*)\*/g, (m, inner) => (inner.trim() && ++n <= 2 ? `*${inner.trim()}*` : inner));
  if ((s.match(/\*/g) || []).length % 2) s = s.replace(/\*(?=[^*]*$)/, '');
  // Uzunlik yulduzchalarsiz hisoblanadi (ko'rinadigan matn)
  const visible = s.replace(/\*/g, '');
  if (visible.length > max) {
    let out = ''; let count = 0;
    for (const ch of s) { if (ch !== '*') { if (count >= max) break; count++; } out += ch; }
    s = out.trim();
    if ((s.match(/\*/g) || []).length % 2) s += '*';
  }
  return s;
}

/** Havola: ilova ichidagi yo'l (/...) yoki https; boshqasi (javascript:, http:, //) — bo'sh */
export function cleanLink(raw) {
  const s = String(raw ?? '').trim().slice(0, LIMITS.link);
  if (!s) return '';
  if (/^\/(?!\/)[\w\-./?=&%#]*$/.test(s)) return s;
  if (/^https:\/\/[^\s<>"']+$/i.test(s)) return s;
  return '';
}

const cleanUrl = (raw) => (/^https:\/\/[^\s<>"']+$/i.test(String(raw ?? '').trim()) ? String(raw).trim().slice(0, 500) : '');
const toDate = (v) => { if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? undefined : d; };

/**
 * Admin kiritgan ma'lumotdan saqlanadigan qism. `partial` — PATCH (faqat berilgan maydonlar).
 * @returns {{ data: object, error?: string }}
 */
export function sanitizePromo(input = {}, { partial = false } = {}) {
  const data = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(input, k);
  if (!partial || has('template')) {
    if (!TEMPLATES.includes(input.template ?? 'brush')) return { data, error: 'Shablon noto‘g‘ri' };
    data.template = input.template ?? 'brush';
  }
  // "Faqat rasm" (image) — matn shart emas, rasm majburiy
  const imageOnly = (input.template ?? (partial ? undefined : 'brush')) === 'image';
  if (!partial || has('title')) {
    data.title = cleanText(input.title, LIMITS.title);
    if (!imageOnly && data.title.replace(/\*/g, '').trim().length < 3) return { data, error: 'Sarlavhani yozing (kamida 3 belgi)' };
  }
  if (!partial || has('footer')) data.footer = cleanText(input.footer, LIMITS.footer);
  if (!partial || has('imageUrl')) {
    data.imageUrl = cleanUrl(input.imageUrl);
    if (input.imageUrl && !data.imageUrl) return { data, error: 'Rasm havolasi noto‘g‘ri (https bo‘lishi kerak)' };
  }
  if (imageOnly && (!partial || has('imageUrl')) && !data.imageUrl) return { data, error: '“Faqat rasm” uchun rasm yuklang' };
  if (!partial || has('link')) {
    data.link = cleanLink(input.link);
    if (input.link && !data.link) return { data, error: 'Havola noto‘g‘ri: /market kabi yo‘l yoki https:// manzil yozing' };
  }
  if (!partial || has('active')) data.active = Boolean(input.active);
  if (!partial || has('frequency')) data.frequency = input.frequency === 'once' ? 'once' : 'daily';
  for (const k of ['startsAt', 'endsAt']) {
    if (!partial || has(k)) {
      const d = toDate(input[k]);
      if (d === undefined) return { data, error: 'Sana noto‘g‘ri' };
      data[k] = d;
    }
  }
  if (data.startsAt && data.endsAt && data.startsAt >= data.endsAt) return { data, error: 'Tugash sanasi boshlanishdan keyin bo‘lsin' };
  return { data };
}

/** Hozir mijozlarga ko'rinadimi */
export function isLive(p, now = new Date()) {
  if (!p?.active) return false;
  if (p.startsAt && new Date(p.startsAt) > now) return false;
  if (p.endsAt && new Date(p.endsAt) <= now) return false;
  return true;
}

/** Mijozga yuboriladigan qism (statistika va ichki maydonlarsiz) */
export const publicView = (p) => ({
  id: String(p._id), key: `${p._id}:${p.version ?? 1}`, template: p.template, title: p.title, footer: p.footer || '',
  imageUrl: p.imageUrl || '', link: p.link || '', frequency: p.frequency || 'daily',
});
