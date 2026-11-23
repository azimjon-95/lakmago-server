import mongoose from 'mongoose';

/*
 * ═══════════════════════════════════════════════════════════════
 * MOLIYAVIY YOZUVLAR UCHUN TRANZAKSIYA QATLAMI
 * ═══════════════════════════════════════════════════════════════
 *
 * Arxitektura TAXMIN bilan tanlanmaydi: baza turi ishga tushganda HAQIQIY `hello` buyrug'i bilan aniqlanadi.
 *   • replica set / sharded → `session.withTransaction` (bir nechta hujjat bir butun: hammasi yoki hech biri;
 *     TransientTransactionError / UnknownTransactionCommitResult da drayver o'zi qayta urinadi);
 *   • standalone            → tranzaksiyasiz. Bu holatda ham takroriy yozuv IMKONSIZ (unique postingKey va
 *     atomik claim), lekin bir nechta hujjat orasidagi atomiklik yo'q — buni yashirmaymiz: yarim qolgan
 *     settlement `financeSettlement.state = 'SETTLING'` bo'lib qoladi va finance:audit uni ko'rsatadi.
 *
 * Har ikkala rejimda IDEMPOTENTLIK bir xil: unique indeks + atomik findOneAndUpdate. Tranzaksiya faqat
 * ATOMIKLIKni qo'shadi. Majburlash uchun: FINANCE_TX=off (doim tranzaksiyasiz) yoki FINANCE_TX=on
 * (tranzaksiya qo'llanmasa xato — ishga tushmaslik yaxshiroq).
 */

let topologyPromise = null;

/** Haqiqiy baza turi: 'replicaset' | 'sharded' | 'standalone' (ulanish bo'lmasa 'unknown'). */
export function detectTopology() {
  if (!topologyPromise) {
    topologyPromise = (async () => {
      const db = mongoose.connection?.db;
      if (!db) { topologyPromise = null; return 'unknown'; }
      const h = await db.admin().command({ hello: 1 });
      if (h.msg === 'isdbgrid') return 'sharded';
      if (h.setName) return 'replicaset';
      return 'standalone';
    })().catch((e) => { topologyPromise = null; console.error('[finance-tx] topologiya aniqlanmadi:', e.message); return 'unknown'; });
  }
  return topologyPromise;
}

/** Faqat testlar uchun: keshni tozalash (boshqa bazaga ulanganda). */
export function _resetTopologyCache() { topologyPromise = null; }

export async function transactionsSupported() {
  const mode = String(process.env.FINANCE_TX || 'auto').toLowerCase();
  if (mode === 'off') return false;
  const t = await detectTopology();
  const ok = t === 'replicaset' || t === 'sharded';
  if (mode === 'on' && !ok) throw new Error(`FINANCE_TX=on, lekin baza ${t} — tranzaksiya qo'llab-quvvatlanmaydi`);
  return ok;
}

/**
 * `fn(session)` ni moliyaviy birlik sifatida bajaradi. Tranzaksiya bo'lmasa session = null.
 * fn ichida HAR BIR yozish/o'qish `{ session }` bilan chaqirilishi kerak (null bo'lsa mongoose e'tiborsiz qoldiradi).
 * Tashqi yon ta'sirlar (socket, Telegram, boshqa servislar) fn ICHIDA BO'LMASLIGI kerak — tranzaksiya qayta
 * urinilsa ular ikki marta bajarilardi.
 */
export async function runFinanceTx(fn) {
  if (!(await transactionsSupported())) return fn(null);
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => { result = await fn(session); }, {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
    });
    return result;
  } finally {
    await session.endSession();
  }
}

/** Duplicate key (unique indeks) xatosi — idempotent "allaqachon bor" holati. */
export const isDuplicateKey = (e) => {
  // Bulk yozuvda (insertMany) HAMMA xato dublikat bo'lishi kerak — aralash xato "allaqachon bor" emas
  const list = e?.writeErrors ?? e?.result?.result?.writeErrors;
  if (Array.isArray(list) && list.length) return list.every((w) => (w?.code ?? w?.err?.code) === 11000);
  return e?.code === 11000;
};
