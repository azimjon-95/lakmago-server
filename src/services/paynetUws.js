import { config } from '../config/index.js';
import { Order } from '../models/Order.js';
import { Transaction } from '../models/Transaction.js';
import { recordSuccess } from './paymentRecord.js';

/*
 * ═══════════════════════════════════════════════════════════
 * PAYNET UWS (Universal Web Service) — kiruvchi RPC server
 * ═══════════════════════════════════════════════════════════
 *
 * Hujjat: "Developer Guide" + OpenAPI 3.4 (Paynet, 2026-08).
 *
 * ARXITEKTURA — CLICK'DAN TUBDAN FARQLI:
 *
 *   Click:  mijoz BIZNING saytimizga keladi -> biz uni Click
 *           sahifasiga yo'naltiramiz -> Click BIZGA webhook
 *           yuboradi (Prepare/Complete).
 *
 *   Paynet: mijoz PAYNET ilovasida bizning xizmatimizni
 *           tanlaydi -> PAYNET bizga so'rov yuboradi (biz hech
 *           qachon Paynet'ga so'rov YUBORMAYMIZ - "bir
 *           yo'nalishlilik" tamoyili, hujjatda alohida
 *           ta'kidlangan).
 *
 * Bitta endpoint (POST /uws), JSON-RPC 2.0. `method` maydoni
 * qaysi amal ekanini bildiradi: GetInformation,
 * PerformTransaction, CheckTransaction, CancelTransaction,
 * GetStatement. (ChangePassword ixtiyoriy, biz amalga
 * oshirmaymiz - parol alohida xavfsiz kanal orqali beriladi.)
 *
 * "MIJOZ" KIM BO'LADI BIZNING TIZIMDA:
 *
 * `fields.client_id` - bu bizning ANKETAMIZDA o'zimiz
 * belgilaydigan maydon (hujjat: "field_name, field_value -
 * hamkor anketasi bo'yicha"). Biz buni Order._id (to'liq
 * MongoDB ObjectId, 24 hex belgi) sifatida ishlatamiz.
 *
 * Mijoz buni QO'LDA KIRITMAYDI - Paynet vakili aytganidek,
 * test muvaffaqiyatli tugagach ular bizga QR/deeplink beradi,
 * o'sha orqali client_id AVTOMATIK to'ldiriladi. Shuning uchun
 * uzun ObjectId muammo emas.
 *
 * ═══ IDEMPOTENTLIK ═══
 * Paynet'ning `transactionId`si - noyob, takrorlanmas. Buni
 * Transaction.providerTransId sifatida saqlaymiz (Click bilan
 * bir xil model, oldingi ishda 'paynet' allaqachon enumga
 * kiritilgan edi). Dublikat PerformTransaction kelsa - 201
 * xatosi, Paynet keyin CheckTransaction chaqiradi.
 *
 * ═══ SLA: 500ms ═══
 * Har bir handler bitta-ikkita oddiy Mongo so'rovi bilan
 * cheklanadi - indekslangan maydonlar bo'yicha (_id, providerTransId).
 */

// ─────────────────────────────────────────────────────────
// Xato konstruktori — JSON-RPC error obyekti
// ─────────────────────────────────────────────────────────

export class PaynetError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const ERR = {
  CLIENT_NOT_FOUND: () => new PaynetError(302, 'Mijoz topilmadi'),
  SERVICE_NOT_FOUND: () => new PaynetError(305, 'Xizmat topilmadi'),
  WRONG_AMOUNT: () => new PaynetError(413, 'Noto\u2018g\u2018ri summa'),
  MISSING_PARAMS: () => new PaynetError(411, 'Bitta yoki bir nechta majburiy parametrlar ko\u2018rsatilmagan'),
  TX_EXISTS: () => new PaynetError(201, 'Tranzaksiya allaqachon mavjud'),
  TX_ALREADY_CANCELLED: () => new PaynetError(202, 'Tranzaksiya allaqachon bekor qilingan'),
  TX_NOT_FOUND: () => new PaynetError(203, 'Tranzaksiya topilmadi'),
  CANCEL_INSUFFICIENT: () => new PaynetError(77, 'Bekor qilish uchun mablag\u2018 yetarli emas'),
};

// ─────────────────────────────────────────────────────────
// Sana formatlash
// ─────────────────────────────────────────────────────────

/** Bizning javoblarimiz uchun STANDART format: YYYY-MM-dd HH:mm:ss (GMT+5). */
function formatStandardDate(d = new Date()) {
  const tz = new Date(d.getTime() + 5 * 60 * 60 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${tz.getUTCFullYear()}-${p(tz.getUTCMonth() + 1)}-${p(tz.getUTCDate())} `
    + `${p(tz.getUTCHours())}:${p(tz.getUTCMinutes())}:${p(tz.getUTCSeconds())}`;
}

/**
 * `CheckTransaction.params.timestamp` — YAGONA istisno,
 * `EEE MMM dd HH:mm:ss z yyyy` formatida keladi (masalan
 * "Mon Jun 16 06:12:41 UZT 2021"). Biz buni PARSE QILMAYMIZ —
 * bu faqat Paynet tomonidan yuborilgan ma'lumot, javobimizda
 * ishlatilmaydi (javobda o'zimizning standart formatdagi
 * timestamp'imiz qaytadi). Faqat qabul qilishimiz kifoya.
 */

/** providerTrnId — MongoDB ObjectId'dan qisqa raqamli identifikator. */
function shortNumericId(objectId) {
  const hexTail = String(objectId).slice(-8);
  const n = parseInt(hexTail, 16);
  return Number.isFinite(n) ? n : Date.now();
}

// ─────────────────────────────────────────────────────────
// Yordamchi: Order <-> client_id
// ─────────────────────────────────────────────────────────

const OBJECT_ID_RE = /^[a-f\d]{24}$/i;

async function findOrderByClientId(clientId) {
  if (!clientId || !OBJECT_ID_RE.test(String(clientId))) return null;
  return Order.findById(clientId);
}

// ─────────────────────────────────────────────────────────
// 1. GetInformation — mijoz/buyurtma mavjudligini tekshirish
// ─────────────────────────────────────────────────────────

async function handleGetInformation(params) {
  const { serviceId, fields } = params || {};
  if (!serviceId || !fields?.client_id) throw ERR.MISSING_PARAMS();
  if (String(serviceId) !== String(config.paynet.serviceId)) throw ERR.SERVICE_NOT_FOUND();

  const order = await findOrderByClientId(fields.client_id);

  /*
   * Faqat 'awaiting_payment' holatidagi buyurtma "to'lovga
   * tayyor" hisoblanadi. Boshqa holatlar (allaqachon to'langan,
   * bekor qilingan, umuman mavjud emas) — hammasi "mijoz
   * topilmadi", chunki Paynet uchun bular bir xil natija:
   * bu client_id bilan HOZIR to'lov qabul qilib bo'lmaydi.
   */
  if (!order || order.status !== 'awaiting_payment') throw ERR.CLIENT_NOT_FOUND();

  return {
    status: 0,
    timestamp: formatStandardDate(),
    fields: {
      // Mijozga Paynet ekranida ko'rsatiladi — order summasi va nomi
      name: `LokmaGo buyurtma #${String(order._id).slice(-6)}`,
      amount: String(Math.round(order.total * 100)),   // tiyinda
    },
  };
}

// ─────────────────────────────────────────────────────────
// 2. PerformTransaction — pulni qabul qilish
// ─────────────────────────────────────────────────────────

async function handlePerformTransaction(params) {
  const {
    amount, serviceId, transactionId, fields,
  } = params || {};

  if (!amount || !serviceId || !transactionId || !fields?.client_id) throw ERR.MISSING_PARAMS();
  if (String(serviceId) !== String(config.paynet.serviceId)) throw ERR.SERVICE_NOT_FOUND();

  /*
   * IDEMPOTENTLIK — birinchi tekshiruv.
   *
   * Agar bu transactionId bilan yozuv ALLAQACHON bor — bu
   * dublikat so'rov (tarmoq uzilishi, Paynet qayta yuborgan).
   * 201 qaytaramiz, Paynet keyin CheckTransaction chaqiradi va
   * asl natijani o'sha yerdan biladi. Pul IKKINCHI MARTA
   * yechilmaydi.
   */
  const existingTx = await Transaction.findOne({
    provider: 'paynet',
    providerTransId: String(transactionId),
  });
  if (existingTx) throw ERR.TX_EXISTS();

  const order = await findOrderByClientId(fields.client_id);
  if (!order || order.status !== 'awaiting_payment') throw ERR.CLIENT_NOT_FOUND();

  /*
   * Summani TEKSHIRISH — mijoz Paynet ekranida ko'rgan summani
   * o'zgartirib to'lay olmaydi. Ikkalasi ham tiyinda solishtiriladi.
   */
  const expectedTiyin = Math.round(order.total * 100);
  if (Number(amount) !== expectedTiyin) throw ERR.WRONG_AMOUNT();

  /*
   * Tranzaksiya YOZUVI OLDINDAN — pul "qabul qilindi" deb
   * belgilashdan OLDIN. Agar keyingi qadam (recordSuccess)
   * yiqilib qolsa ham, izlar qoladi va keyingi CheckTransaction
   * yoki qayta ishlov (retryPendingDispatch) buyurtmani
   * to'g'rilaydi — xuddi Click oqimida bo'lgani kabi.
   */
  const tx = await Transaction.create({
    provider: 'paynet',
    providerTransId: String(transactionId),
    orderId: order._id,
    userId: order.userId,
    amount: expectedTiyin,
    state: 2,   // to'g'ridan-to'g'ri muvaffaqiyatli — Paynet "prepare" bosqichini talab qilmaydi
    performTime: Date.now(),
  });

  await recordSuccess({
    order,
    provider: 'paynet',
    providerTransactionId: String(transactionId),
    transactionId: tx._id,
    amountTiyin: expectedTiyin,
  });

  return {
    providerTrnId: shortNumericId(tx._id),
    fields: { client_id: String(fields.client_id) },
    timestamp: formatStandardDate(),
  };
}

// ─────────────────────────────────────────────────────────
// 3. CheckTransaction — holatni so'rash
// ─────────────────────────────────────────────────────────

async function handleCheckTransaction(params) {
  const { serviceId, transactionId } = params || {};
  if (!serviceId || !transactionId) throw ERR.MISSING_PARAMS();
  if (String(serviceId) !== String(config.paynet.serviceId)) throw ERR.SERVICE_NOT_FOUND();

  const tx = await Transaction.findOne({
    provider: 'paynet',
    providerTransId: String(transactionId),
  });

  /*
   * MUHIM: topilmasa XATO EMAS — muvaffaqiyatli javob,
   * transactionState: 3 ("topilmadi"). Hujjatda alohida
   * ta'kidlangan: "Xato emas! transactionState: 3 bilan
   * result qaytaring".
   */
  if (!tx) {
    return {
      providerTrnId: 0,
      timestamp: formatStandardDate(),
      transactionState: 3,
    };
  }

  // state: 2=muvaffaqiyatli (bizda), manfiy=bekor qilingan
  const transactionState = tx.state === 2 ? 1 : 2;

  return {
    providerTrnId: shortNumericId(tx._id),
    timestamp: formatStandardDate(),
    transactionState,
  };
}

// ─────────────────────────────────────────────────────────
// 4. CancelTransaction — bekor qilish
// ─────────────────────────────────────────────────────────

async function handleCancelTransaction(params) {
  const { serviceId, transactionId } = params || {};
  if (!serviceId || !transactionId) throw ERR.MISSING_PARAMS();
  if (String(serviceId) !== String(config.paynet.serviceId)) throw ERR.SERVICE_NOT_FOUND();

  const tx = await Transaction.findOne({
    provider: 'paynet',
    providerTransId: String(transactionId),
  });
  if (!tx) throw ERR.TX_NOT_FOUND();
  if (tx.state < 0) throw ERR.TX_ALREADY_CANCELLED();

  /*
   * BIZNING BEKOR QILISH QOIDAMIZ:
   *
   * Buyurtma hali restoranga TOPSHIRILMAGAN bo'lsa (status
   * 'pending'/'accepted'/'preparing'/'ready'/'delivering') —
   * bekor qilish ruxsat etiladi.
   *
   * Allaqachon yetkazib berilgan bo'lsa — mijoz mahsulotni
   * "sarflagan" hisoblanadi, bekor qilib bo'lmaydi (77).
   *
   * Bu ENG SODDA qoida (faqat 'delivered' rad etiladi).
   * Vaqt chegarasi (masalan 24 soat) — bu biznes qarori,
   * kerak bo'lsa keyinroq qo'shiladi (306 xatosi shu uchun).
   */
  const order = await Order.findById(tx.orderId);
  if (order?.status === 'delivered') throw ERR.CANCEL_INSUFFICIENT();

  tx.state = -2;
  tx.cancelTime = Date.now();
  await tx.save();

  if (order && order.status !== 'delivered' && order.status !== 'cancelled') {
    order.status = 'cancelled';
    order.isPaid = false;
    await order.save();
  }

  return {
    providerTrnId: shortNumericId(tx._id),
    timestamp: formatStandardDate(),
    transactionState: 2,
  };
}

// ─────────────────────────────────────────────────────────
// 5. GetStatement — davr uchun solishtirish
// ─────────────────────────────────────────────────────────

function parseStandardDate(s) {
  // "YYYY-MM-dd HH:mm:ss" (GMT+5) -> UTC Date
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m;
  return new Date(Date.UTC(+y, +mo - 1, +d, +h - 5, +mi, +se));
}

async function handleGetStatement(params) {
  const { serviceId, dateFrom, dateTo } = params || {};
  if (!serviceId || !dateFrom || !dateTo) throw ERR.MISSING_PARAMS();
  if (String(serviceId) !== String(config.paynet.serviceId)) throw ERR.SERVICE_NOT_FOUND();

  const from = parseStandardDate(dateFrom);
  const to = parseStandardDate(dateTo);
  if (!from || !to) throw new PaynetError(414, 'Sana va vaqt formati noto\u2018g\u2018ri');

  // FAQAT muvaffaqiyatli (state=2) — bekor qilinganlar KIRITILMAYDI
  const rows = await Transaction.find({
    provider: 'paynet',
    state: 2,
    createdAt: { $gte: from, $lte: to },
  }).lean();

  return {
    statements: rows.map((r) => ({
      amount: r.amount,
      transactionId: Number(r.providerTransId),
      providerTrnId: shortNumericId(r._id),
      timestamp: formatStandardDate(new Date(r.performTime || r.createdAt)),
    })),
  };
}

// ─────────────────────────────────────────────────────────
// Dispatcher
// ─────────────────────────────────────────────────────────

const HANDLERS = {
  GetInformation: handleGetInformation,
  PerformTransaction: handlePerformTransaction,
  CheckTransaction: handleCheckTransaction,
  CancelTransaction: handleCancelTransaction,
  GetStatement: handleGetStatement,
};

/**
 * Bitta JSON-RPC so'rovni qayta ishlaydi va JSON-RPC javob
 * obyektini qaytaradi (hech qachon throw qilmaydi — barcha
 * xatolar RpcErrorResponse shakliga o'raladi, chunki HTTP
 * qatlami har doim 200 bilan javob berishi kerak, faqat auth
 * xatosida 401).
 */
export async function handlePaynetRpc(body) {
  const { jsonrpc, method, id, params } = body || {};

  if (jsonrpc !== '2.0' || typeof method !== 'string') {
    return { jsonrpc: '2.0', id: id ?? null, error: { code: -32600, message: 'Noto\u2018g\u2018ri so\u2018rov' } };
  }

  const handler = HANDLERS[method];
  if (!handler) {
    return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Metod topilmadi' } };
  }

  try {
    const result = await handler(params);
    return { jsonrpc: '2.0', id, result };
  } catch (e) {
    if (e instanceof PaynetError) {
      return { jsonrpc: '2.0', id, error: { code: e.code, message: e.message } };
    }
    console.error('[paynet:uws]', method, e);
    return { jsonrpc: '2.0', id, error: { code: -32603, message: 'Ichki xatolik' } };
  }
}
