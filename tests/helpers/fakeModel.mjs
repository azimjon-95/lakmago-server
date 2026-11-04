/*
 * Testlar uchun xotiradagi soxta Mongo kolleksiyasi (baza kerak emas).
 * Qo'llab-quvvatlanadi: nuqtali yo'llar, tenglik (ObjectId ↔ satr), null (maydon yo'q ham), $in, $nin, $ne, $exists, $or, $and;
 * yangilash: $set, $inc (nuqtali). findOneAndUpdate ATOMIK (JS bir oqimli) — poyga holatini ketma-ket sinash mumkin.
 */
export const get = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
const same = (a, b) => (a == null && b == null) || (Array.isArray(a) ? a.some((x) => String(x) === String(b)) : a != null && b != null && String(a) === String(b));

export function matches(doc, filter = {}) {
  return Object.entries(filter).every(([k, cond]) => {
    if (k === '$or') return cond.some((f) => matches(doc, f));
    if (k === '$and') return cond.every((f) => matches(doc, f));
    const v = get(doc, k);
    if (cond && typeof cond === 'object' && !Array.isArray(cond) && !(cond.constructor?.name === 'ObjectId')
      && Object.keys(cond).some((x) => x.startsWith('$'))) {
      return Object.entries(cond).every(([op, arg]) => {
        if (op === '$in') return arg.some((a) => same(v, a));
        if (op === '$nin') return !arg.some((a) => same(v, a));
        if (op === '$ne') return !same(v, arg);
        if (op === '$exists') return (v !== undefined) === Boolean(arg);
        if (op === '$gte') return v >= arg;
        if (op === '$gt') return v > arg;
        if (op === '$lte') return v <= arg;
        if (op === '$lt') return v < arg;
        throw new Error(`fakeModel: ${op} qo'llab-quvvatlanmaydi`);
      });
    }
    return same(v, cond);
  });
}

function setPath(obj, path, val) {
  const ks = path.split('.'); let o = obj;
  for (const k of ks.slice(0, -1)) { if (o[k] == null || typeof o[k] !== 'object') o[k] = {}; o = o[k]; }
  o[ks.at(-1)] = val;
}

export function applyUpdate(doc, update) {
  const u = update.$set || update.$inc ? update : { $set: update };
  for (const [k, v] of Object.entries(u.$set || {})) setPath(doc, k, v);
  for (const [k, v] of Object.entries(u.$inc || {})) setPath(doc, k, (Number(get(doc, k)) || 0) + v);
}

// structuredClone ObjectId'ni oddiy obyektga aylantiradi — ID'lar va sanalar SAQLANADIGAN chuqur nusxa
function clone(v) {
  if (v == null || typeof v !== 'object') return v;
  if (v._bsontype === 'ObjectId' || v instanceof Date) return v;
  if (Array.isArray(v)) return v.map(clone);
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)]));
}
function chain(getter) {
  const q = { select: () => q, populate: () => q, sort: () => q, limit: () => q, lean: async () => clone(getter()), then: (a, b) => Promise.resolve(clone(getter())).then(a, b) };
  return q;
}

/** Model statik metodlarini store bilan almashtiradi. store.docs — massiv. */
export function bindModel(Model, store) {
  Model.findById = (id) => chain(() => store.docs.find((d) => same(d._id, id)) || null);
  Model.findOne = (f) => chain(() => store.docs.find((d) => matches(d, f)) || null);
  Model.find = (f = {}) => chain(() => store.docs.filter((d) => matches(d, f)));
  Model.exists = async (f) => (store.docs.some((d) => matches(d, f)) ? { _id: 1 } : null);
  Model.countDocuments = async (f) => store.docs.filter((d) => matches(d, f)).length;
  Model.findOneAndUpdate = (f, update, opts = {}) => chain(() => {
    const d = store.docs.find((x) => matches(x, f));
    if (!d) return null;
    const before = clone(d);
    applyUpdate(d, update);
    return opts.new === false ? before : d;
  });
  Model.findByIdAndUpdate = (id, update) => Model.findOneAndUpdate({ _id: id }, update, { new: true });
  Model.updateOne = async (f, update) => { const d = store.docs.find((x) => matches(x, f)); if (d) applyUpdate(d, update); return { modifiedCount: d ? 1 : 0 }; };
  return store;
}
