import { isBffEventsEnabled, enqueueOrderEvent } from '../services/bffEvents.js';

/*
 * ═══════════════════════════════════════════════════════════
 * BUYURTMA HODISALARI — MODEL DARAJASIDA, AVTOMATIK
 * ═══════════════════════════════════════════════════════════
 *
 * cacheInvalidation.js bilan BIR XIL falsafa. Buyurtma holatini yozadigan
 * joy ~25 ta: panel, Telegram bot, kuryer havolasi (qabul/topshirdim),
 * mijoz "Oldim" (bot) va "Ha, oldim" (ilova), restoran eslatmasi, 12
 * soatlik avto-yakunlash (updateMany!), Click/Payme/karta to'lovi, mijoz
 * bekor qilishi, Android gateway... Har birida qo'lda "BFF ga xabar ber"
 * yozilsa, biri albatta unutiladi va restoran ilovasi eskirgan holatni
 * ko'radi. Model plagini esa Order QANDAY yo'l bilan o'zgartirilsa ham
 * (hatto hali yozilmagan kod ham) hodisani o'zi beradi.
 *
 * QAYSI YOZUV → QAYSI HODISA (faqat status/to'lov/eslatma o'zgarganda):
 *   status pending      → created   (naqd: yaratilganda; karta: to'lov o'tgach)
 *   status cancelled    → cancelled
 *   status delivered    → delivered
 *   accepted/preparing/ready/delivering → updated
 *   isPaid o'zgardi     → updated
 *   restaurantReminder  → updated   (yetkazish tasdig'i so'ralgan: ilova tugmani ko'rsatadi)
 *   qolgani (dailyNumber, paymentLock, deliveryCheck hisoblagichi, baho…) → hodisa YO'Q
 *
 * KO'RINMAS BUYURTMALAR yuborilmaydi (qat'iy qoida: pul yechilmaguncha
 * buyurtma restoranga umuman bormaydi — misc.js create):
 *   • zal (dinein) — gateway ro'yxatida yo'q;
 *   • awaiting_payment (va undan bekor bo'lgan — abandonedOrders).
 *
 * Xato hodisa navbatiga yozilmasa ham buyurtma yozuvi buzilmaydi.
 */

const isBffOn = () => isBffEventsEnabled();

const kindForStatus = (status) => {
  if (!status || status === 'awaiting_payment') return null;
  if (status === 'pending') return 'created';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'delivered') return 'delivered';
  return 'updated';
};

/** Yangilash hujjatidan yozilayotgan maydonlar: { $set: {...}, top-level } birlashtiriladi. */
function writtenFields(update) {
  const u = update || {};
  const out = { ...(u.$set || {}) };
  for (const [k, v] of Object.entries(u)) if (!k.startsWith('$')) out[k] = v;
  return out;
}

function classify(fields) {
  if ('status' in fields) return { status: fields.status, kind: kindForStatus(fields.status) };
  if ('isPaid' in fields) return { status: null, kind: 'updated' };
  const reminder = Object.keys(fields).some((k) => k === 'restaurantReminder' || k.startsWith('restaurantReminder.'));
  return { status: null, kind: reminder ? 'updated' : null };
}

const safe = async (fn) => {
  try { await fn(); } catch (e) { console.error('[orderEvents]', e.message); }
};

export function orderEventsPlugin(schema) {
  // ── doc.save() / Order.create() ──
  schema.pre('save', function preSave() {
    this.$locals.orderEv = {
      isNew: this.isNew,
      statusMod: this.isModified('status'),
      paidMod: this.isModified('isPaid'),
    };
  });
  schema.post('save', async function postSave(doc) {
    if (!isBffOn()) return;
    const ev = this.$locals?.orderEv || {};
    let kind = null;
    if (ev.isNew) kind = doc.status === 'pending' ? 'created' : null;
    else if (ev.statusMod) kind = kindForStatus(doc.status);
    else if (ev.paidMod) kind = 'updated';
    if (!kind || doc.fulfillment === 'dinein' || doc.status === 'awaiting_payment') return;
    await safe(() => enqueueOrderEvent(kind, { orderId: doc._id, restaurantId: doc.restaurantId }));
  });

  // ── findOneAndUpdate / findByIdAndUpdate ──
  schema.pre('findOneAndUpdate', function preFindOneAndUpdate() {
    this._orderEv = isBffOn() ? classify(writtenFields(this.getUpdate())) : null;
  });
  schema.post('findOneAndUpdate', async function postFindOneAndUpdate(doc) {
    const ev = this._orderEv;
    if (!ev?.kind || !doc) return; // doc yo'q — filtr mos kelmadi, hech narsa o'zgarmadi
    if (doc.fulfillment === 'dinein') return;
    /*
     * `new: false` bo'lsa doc — ESKI holat (masalan awaiting_payment → pending
     * to'lov chiqarishida). Shuning uchun ko'rinmaslikni holat YOZILAYOTGAN
     * bo'lsa uning nishonidan (kindForStatus), yozilmayotgan bo'lsa (faqat
     * isPaid/eslatma) hujjatning o'z holatidan aniqlaymiz.
     */
    if (!ev.status && doc.status === 'awaiting_payment') return;
    await safe(() => enqueueOrderEvent(ev.kind, { orderId: doc._id, restaurantId: doc.restaurantId }));
  });

  // ── updateOne / updateMany: hujjat QAYTMAYDI — o'zgarishdan OLDIN mos hujjatlar olinadi ──
  const bulkOpts = { document: false, query: true };
  schema.pre('updateOne', bulkOpts, prefetch);
  schema.pre('updateMany', bulkOpts, prefetch);
  schema.post('updateOne', bulkOpts, publishPrefetched);
  schema.post('updateMany', bulkOpts, publishPrefetched);
}

async function prefetch() {
  this._orderEv = null;
  if (!isBffOn()) return;
  const ev = classify(writtenFields(this.getUpdate()));
  if (!ev.kind) return; // status/to'lov/eslatma tegilmayapti — qo'shimcha so'rov KERAK EMAS
  const q = this.model.find(this.getFilter()).select('_id restaurantId fulfillment status').lean();
  q.limit(this.op === 'updateOne' ? 1 : 1000);
  this._orderEv = { ...ev, rows: await q };
}

async function publishPrefetched() {
  const ev = this._orderEv;
  if (!ev?.kind) return;
  for (const r of ev.rows || []) {
    if (r.fulfillment === 'dinein') continue;
    // Hech qachon ko'rinmagan (to'lanmagan) buyurtma: 'created' dan boshqa hodisa yo'q
    if (r.status === 'awaiting_payment' && ev.kind !== 'created') continue;
    await safe(() => enqueueOrderEvent(ev.kind, { orderId: r._id, restaurantId: r.restaurantId }));
  }
}
