/*
 * ═══════════════════════════════════════════════════════════
 * HAFTALIK HISOB-KITOB — JURNALDAN HISOBLANADIGAN KO'RINISH
 * ═══════════════════════════════════════════════════════════
 *
 * Bu modul HECH NARSA YOZMAYDI. Mavjud Ledger yozuvlarini oladi va ularni
 * Toshkent vaqti bo'yicha 7 kunlik haftalarga (dushanba 00:00 — yakshanba
 * 23:59) taqsimlaydi. Mavjud "Moliya" hisoboti (balans, tushum, komissiya)
 * o'zgarmaydi — bu uning ustidagi QULAYLIK: qaysi hafta to'langan, qaysi
 * haftada qarz qolgan.
 *
 * ─── QOIDALAR (egasi qarori, 2026-11-23) ───
 *  1. RESTORAN QARZI (naqd buyurtma komissiyasi) — keyingi karta tushumlari
 *     (restaurant_due +) kelgan sari ENG ESKI haftadan boshlab (FIFO) o'zi
 *     yopiladi. Mavjud "keyingi karta to'lovlaridan yopiladi" qoidasining
 *     o'zi, faqat haftalar kesimida ko'rsatiladi.
 *  2. LOKMAGO QARZI (karta buyurtmasi bo'yicha restoran ulushi) — to'lanmaguncha
 *     O'Z HAFTASIDA turadi. Admin to'laganda:
 *       • hafta tanlangan bo'lsa (payout meta.weekStart) — avval shu haftaga;
 *       • tanlanmagan bo'lsa (yoki ortib qolsa) — eng eski ochiq haftadan.
 *  3. Bir haftaning ichida naqd qarz shu haftaning karta ulushi bilan
 *     qoplanadi (haftalik sof hisob). Eski haftadagi LokmaGo qarzini yangi
 *     naqd qarz "yemaydi" — u yangi karta tushumini kutadi.
 *
 * ─── BALANSGA TA'SIR ───
 * Qaysi yozuv Restaurant.balance ni o'zgartiradi — billing.js bo'yicha:
 *   restaurant_due      → amount (karta: +ulush, naqd: −komissiya, qaytarish: teskari)
 *   bonus_compensation  → amount (+)
 *   payout              → amount (−)
 *   adjustment "…delivery tushumidan" (promo qarzi payout'dan ushlangan) → −amount
 *   boshqalar (commission, payment_in, refund, qo'lda adjustment) → 0
 * Shu sababli barcha haftalar qoldig'ining yig'indisi = jurnal bo'yicha balans.
 * Restaurant.balance undan farq qilsa (audit topgan farq), bu yashirilmaydi —
 * `drift` sifatida qaytariladi.
 *
 * ─── BIRLIK ───
 * Ichki hisob butun TIYINDA (Float xatosi yo'q), chiqish SO'MDA (hisobotning
 * qolgan qismi bilan bir xil).
 */
import { zoneDate, addDaysYmd } from './restaurantTime.js';

export const WEEK_TZ = 'Asia/Tashkent';
export const WEEK_STARTS_ON = 'monday';

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const PROMO_SETTLEMENT_NOTE = /delivery tushumidan/;
const REFUND_NOTE = /[Qq]aytarish/;

const toT = (som) => Math.round((Number(som) || 0) * 100);
const toSom = (tiyin) => Math.round(tiyin) / 100;

/** "2026-11-23" — haftaning dushanbasi (Toshkent vaqti bo'yicha). */
export function weekStartOf(date) {
  const { ymd } = zoneDate(WEEK_TZ, new Date(date));
  const [y, m, d] = ymd.split('-').map(Number);
  const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;   // dushanba = 0
  return addDaysYmd(ymd, -dow);
}

export const weekEndOf = (weekStart) => addDaysYmd(weekStart, 6);

/** Haftaning boshlanishi bo'la oladimi: to'g'ri sana va dushanba. */
export function isWeekStart(ymd) {
  if (!YMD.test(String(ymd || ''))) return false;
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.toISOString().slice(0, 10) !== ymd) return false;
  return dt.getUTCDay() === 1;
}

/**
 * Jurnal yozuvini hodisaga aylantiradi.
 * @returns {null | { kind, sign: 'accrual'|'settlement', tiyin, ... }}
 */
export function classifyEntry(l) {
  const t = toT(l.amount);
  switch (l.type) {
    case 'restaurant_due': {
      if (t === 0) return null;
      const note = l.meta?.note || '';
      const kind = t > 0
        ? (REFUND_NOTE.test(note) ? 'refund' : 'card')
        : (REFUND_NOTE.test(note) ? 'refund' : (l.isCash ? 'cash' : 'other'));
      return { sign: 'accrual', kind, tiyin: t };
    }
    case 'bonus_compensation':
      return t === 0 ? null : { sign: 'accrual', kind: 'bonus', tiyin: t };
    case 'payout':
      // Jurnalda manfiy; to'langan summa musbat sifatida
      return t === 0 ? null : {
        sign: 'settlement', kind: 'payout', tiyin: -t,
        targetWeek: isWeekStart(l.meta?.weekStart) ? l.meta.weekStart : null,
      };
    case 'adjustment':
      if (!PROMO_SETTLEMENT_NOTE.test(l.meta?.note || '')) return null;
      // Jurnalda musbat, balansdan esa ayirilgan — payout bilan birga ushlangan promo qarzi
      return t === 0 ? null : { sign: 'settlement', kind: 'promo', tiyin: t };
    default:
      return null;
  }
}

/** Balansga ta'sir qiladigan jurnal turlari (so'rov filtri uchun). */
export const BALANCE_LEDGER_TYPES = ['restaurant_due', 'bonus_compensation', 'payout', 'adjustment'];

function emptyWeek(weekStart) {
  return {
    weekStart,
    weekEnd: weekEndOf(weekStart),
    // Hafta ichida hisoblangan (tiyin)
    card: 0, cash: 0, refund: 0, bonus: 0, other: 0, orders: 0,
    // LokmaGo → restoran
    payable: 0,                 // ochiq qoldiq
    paidAllocations: [],        // { at, tiyin, kind, ledgerId, note, targeted }
    // Restoran → LokmaGo
    receivable: 0,              // ochiq qoldiq
    closedBy: [],               // { at, tiyin, fromWeek, kind } — keyingi karta tushumi yopgan
    debtsCovered: [],           // shu haftaning karta tushumi qaysi eski qarzlarni yopgan
  };
}

/**
 * Bitta restoranning jurnal yozuvlaridan haftalik hisob.
 *
 * @param {Array} entries  shu restoranning yozuvlari ({ _id, type, amount, createdAt, isCash, meta })
 * @param {{ now?: Date }} [opts]
 */
export function buildRestaurantWeeks(entries, { now = new Date() } = {}) {
  const sorted = [...entries].sort((a, b) => {
    const d = new Date(a.createdAt) - new Date(b.createdAt);
    return d !== 0 ? d : String(a._id).localeCompare(String(b._id));
  });

  const weeks = new Map();
  const week = (ws) => {
    if (!weeks.has(ws)) weeks.set(ws, emptyWeek(ws));
    return weeks.get(ws);
  };
  const ascending = () => [...weeks.keys()].sort();

  let ledgerBalance = 0;

  for (const l of sorted) {
    const ev = classifyEntry(l);
    if (!ev) continue;
    const at = new Date(l.createdAt);
    const ws = weekStartOf(at);
    const w = week(ws);
    const id = l._id ? String(l._id) : null;

    if (ev.sign === 'accrual') {
      ledgerBalance += ev.tiyin;
      w[ev.kind] += ev.tiyin;
      if (ev.kind === 'card' || ev.kind === 'cash') w.orders += 1;

      if (ev.tiyin > 0) {
        // 1-qoida: karta tushumi avval eng eski ochiq restoran qarzlarini yopadi
        let left = ev.tiyin;
        for (const k of ascending()) {
          if (left <= 0) break;
          const v = weeks.get(k);
          if (v.receivable <= 0) continue;
          const take = Math.min(v.receivable, left);
          v.receivable -= take;
          left -= take;
          v.closedBy.push({ at, tiyin: take, fromWeek: ws, kind: ev.kind });
          if (k !== ws) w.debtsCovered.push({ at, tiyin: take, week: k });
        }
        w.payable += left;
      } else {
        // 3-qoida: naqd qarz avval shu haftaning o'z ochiq ulushi bilan qoplanadi
        let debt = -ev.tiyin;
        const take = Math.min(w.payable, debt);
        w.payable -= take;
        debt -= take;
        w.receivable += debt;
      }
    } else {
      // To'lov (payout) yoki payout'dan ushlangan promo qarzi
      ledgerBalance -= ev.tiyin;
      let left = ev.tiyin;
      const order = ascending().filter((k) => weeks.get(k).payable > 0);
      if (ev.targetWeek && weeks.get(ev.targetWeek)?.payable > 0) {
        order.splice(order.indexOf(ev.targetWeek), 1);
        order.unshift(ev.targetWeek);
      }
      for (const k of order) {
        if (left <= 0) break;
        const v = weeks.get(k);
        const take = Math.min(v.payable, left);
        v.payable -= take;
        left -= take;
        v.paidAllocations.push({
          at, tiyin: take, kind: ev.kind, ledgerId: id,
          note: l.meta?.note || '', targeted: k === ev.targetWeek, paidInWeek: ws,
        });
      }
      if (left > 0) {
        // Jurnal bo'yicha qarzdan ortiq to'langan: restoran qarzi sifatida (keyingi tushumdan yopiladi)
        w.receivable += left;
        w.overpaid = (w.overpaid || 0) + left;
      }
    }
  }

  const current = weekStartOf(now);
  const out = [...weeks.values()].map((w) => {
    const paid = w.paidAllocations.reduce((a, x) => a + x.tiyin, 0);
    const closed = w.closedBy.reduce((a, x) => a + x.tiyin, 0);
    const obligation = paid + w.payable;          // shu haftaning LokmaGo majburiyati (sof)
    const debt = closed + w.receivable;           // shu haftaning restoran qarzi
    let status = 'settled';
    if (w.payable > 0) status = paid > 0 ? 'partial' : 'open';
    else if (w.receivable > 0) status = closed > 0 ? 'debt_closing' : 'debt';
    return {
      weekStart: w.weekStart,
      weekEnd: w.weekEnd,
      current: w.weekStart === current,
      status,
      orders: w.orders,
      cardShare: toSom(w.card),
      cashDebt: toSom(-w.cash),
      refunds: toSom(w.refund),
      bonus: toSom(w.bonus),
      other: toSom(w.other),
      obligation: toSom(obligation),
      paid: toSom(paid),
      payable: toSom(w.payable),
      paidPercent: obligation > 0 ? Math.round((paid / obligation) * 100) : null,
      debt: toSom(debt),
      debtClosed: toSom(closed),
      receivable: toSom(w.receivable),
      debtClosedPercent: debt > 0 ? Math.round((closed / debt) * 100) : null,
      overpaid: toSom(w.overpaid || 0),
      // Qoldiq: + LokmaGo restoranga qarz, − restoran LokmaGo'ga qarz
      remaining: toSom(w.payable - w.receivable),
      payments: w.paidAllocations.map((p) => ({
        at: p.at, amount: toSom(p.tiyin), kind: p.kind, ledgerId: p.ledgerId,
        note: p.note, targeted: p.targeted, paidInWeek: p.paidInWeek,
      })),
      debtClosings: w.closedBy.map((c) => ({ at: c.at, amount: toSom(c.tiyin), fromWeek: c.fromWeek })),
      coveredOldDebts: w.debtsCovered.map((c) => ({ at: c.at, amount: toSom(c.tiyin), week: c.week })),
    };
  }).sort((a, b) => (a.weekStart < b.weekStart ? 1 : -1));   // yangisi birinchi

  const openPayable = out.reduce((a, w) => a + toT(w.payable), 0);
  const openReceivable = out.reduce((a, w) => a + toT(w.receivable), 0);

  return {
    currentWeek: current,
    ledgerBalance: toSom(ledgerBalance),
    openPayable: toSom(openPayable),
    openReceivable: toSom(openReceivable),
    weeks: out,
  };
}

/**
 * Barcha haftalar ro'yxati (navigatsiya uchun): eng eski faollikdan joriy haftagacha,
 * har biri bo'yicha restoranlar kesimidagi yig'indi.
 */
export function buildWeekIndex(perRestaurant, { now = new Date() } = {}) {
  const current = weekStartOf(now);
  const agg = new Map();
  let earliest = current;
  for (const r of perRestaurant) {
    for (const w of r.weeks) {
      if (w.weekStart < earliest) earliest = w.weekStart;
      if (!agg.has(w.weekStart)) agg.set(w.weekStart, { payable: 0, receivable: 0, obligation: 0, paid: 0, orders: 0, restaurants: 0, openRestaurants: 0 });
      const a = agg.get(w.weekStart);
      a.payable += toT(w.payable);
      a.receivable += toT(w.receivable);
      a.obligation += toT(w.obligation);
      a.paid += toT(w.paid);
      a.orders += w.orders;
      a.restaurants += 1;
      if (w.payable > 0 || w.receivable > 0) a.openRestaurants += 1;
    }
  }
  const list = [];
  for (let ws = current; ws >= earliest; ws = addDaysYmd(ws, -7)) {
    const a = agg.get(ws) || { payable: 0, receivable: 0, obligation: 0, paid: 0, orders: 0, restaurants: 0, openRestaurants: 0 };
    list.push({
      weekStart: ws,
      weekEnd: weekEndOf(ws),
      current: ws === current,
      orders: a.orders,
      restaurants: a.restaurants,
      openRestaurants: a.openRestaurants,
      obligation: toSom(a.obligation),
      paid: toSom(a.paid),
      payable: toSom(a.payable),
      receivable: toSom(a.receivable),
    });
    if (list.length > 520) break;   // 10 yil — himoya
  }
  return list;
}
