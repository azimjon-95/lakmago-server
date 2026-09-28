import { zonedToUtc, addDaysYmd } from './restaurantTime.js';

/*
 * ═══════════════════════════════════════════════════════════
 * MOLIYA — SANA ORALIG'I
 * ═══════════════════════════════════════════════════════════
 *
 * Buxgalter "kecha qancha o'tkazildi" deb so'raganda "kecha" —
 * TOSHKENT kuni (00:00 dan 24:00 gacha), UTC emas. UTC bo'yicha
 * kesilsa, Toshkent vaqti bilan 00:00–05:00 orasidagi yozuvlar
 * noto'g'ri kunga tushardi.
 *
 * Qabul qilinadigan shakllar:
 *   • "2026-09-27"            — Toshkent kuni, ikkala chegara ham
 *                               KIRADI (from=to bo'lsa — bir kun);
 *   • ISO vaqt ("...T...Z")   — avvalgidek aniq lahza (eski
 *                               chaqiruvlar buzilmasin).
 *
 * Noto'g'ri sana jimgina e'tiborsiz QOLDIRILMAYDI: filtr
 * ishlamay qolsa, buxgalter hammasini "kecha" deb o'ylab
 * yuborishi mumkin — shuning uchun xato ko'tariladi (400).
 */

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 400;
const TZ = 'Asia/Tashkent';

export class PeriodError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PeriodError';
    this.status = 400;
  }
}

function parseEdge(value, isEnd) {
  const s = String(value).trim();
  if (YMD.test(s)) {
    const at = zonedToUtc(isEnd ? addDaysYmd(s, 1) : s, '00:00', TZ);
    if (!at || Number.isNaN(at.getTime())) throw new PeriodError(`Noto‘g‘ri sana: ${s}`);
    return { at, exclusive: isEnd };
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new PeriodError(`Noto‘g‘ri sana: ${s}`);
  return { at: d, exclusive: false };
}

/**
 * @param {string|undefined} from
 * @param {string|undefined} to
 * @returns {null | { start: Date|null, end: Date|null, endExclusive: boolean, cond: object }}
 *   `cond` — Mongo shartiga tayyor ({ $gte, $lt|$lte }).
 *   Ikkalasi ham bo'sh bo'lsa `null` (filtr yo'q).
 */
export function resolvePeriod(from, to) {
  if (!from && !to) return null;

  const a = from ? parseEdge(from, false) : null;
  const b = to ? parseEdge(to, true) : null;

  if (a && b) {
    const diff = b.at.getTime() - a.at.getTime();
    // Teskari oraliq (yoki bo'sh: bir xil lahza va oxiri KIRMAYDI)
    if (diff < 0 || (diff === 0 && b.exclusive)) {
      throw new PeriodError('Boshlanish sanasi tugash sanasidan keyin bo‘lishi mumkin emas');
    }
    if (diff / 86_400_000 > MAX_DAYS) {
      throw new PeriodError(`Oraliq ${MAX_DAYS} kundan oshmasligi kerak`);
    }
  }

  const cond = {};
  if (a) cond.$gte = a.at;
  if (b) cond[b.exclusive ? '$lt' : '$lte'] = b.at;
  return { start: a?.at || null, end: b?.at || null, endExclusive: Boolean(b?.exclusive), cond };
}

/**
 * Buyurtma "yetkazilgan" sanasi bo'yicha oralig'i.
 *
 * `updatedAt` ISHLATILMAYDI: mijoz keyinroq baho qoldirsa yoki
 * xodim "To'lov qilindi"ni bossa `updatedAt` o'zgaradi va eski
 * buyurtma boshqa kunga "ko'chib" ketardi. `deliveredAt` esa
 * yakunlanganda BIR MARTA yoziladi. Eski (deliveredAt yo'q)
 * buyurtmalar uchun updatedAt — yagona mavjud belgi.
 *
 * $expr/$ifNull o'rniga $or: har ikkala MongoDB'da ishlaydi.
 */
export function deliveredWindow(period) {
  if (!period) return {};
  return {
    $or: [
      { deliveredAt: period.cond },
      { deliveredAt: null, updatedAt: period.cond },
    ],
  };
}

/** "Naqd" yoki "karta" — mavjud hisoblagich bilan AYNAN bir xil qoida. */
export function paymentGroupFilter(method) {
  if (method === 'cash') return { paymentMethod: 'cash' };
  if (method === 'card') return { paymentMethod: { $ne: 'cash' } };
  return {};
}
