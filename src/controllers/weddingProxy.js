import { asyncHandler } from '../middleware/error.js';

/*
 * ═══ LOKMA TO'YXONALARI — ADMIN PROKSI ═══
 *
 * To'yxonalar — ALOHIDA server va ALOHIDA baza (lokma-toyxonalar-server).
 * LokmaGo admin paneli unga to'g'ridan-to'g'ri ulanmaydi: so'rov shu
 * server orqali o'tadi va bu yerda `X-Admin-Key` qo'shiladi. Natijada:
 *   • admin kaliti brauzerga HECH QACHON chiqmaydi;
 *   • kirish LokmaGo admin sessiyasi (auth + requireRole('admin')) bilan;
 *   • LokmaGo va to'yxona ma'lumotlari aralashmaydi — bu yerda hech narsa
 *     saqlanmaydi, faqat uzatiladi.
 *
 * .env:
 *   WEDDING_API_URL=http://127.0.0.1:4100      (to'yxona serveri, /api siz)
 *   WEDDING_ADMIN_KEY=<to'yxona serveridagi ADMIN_API_KEY>
 *
 *   /api/admin/wedding/<yo'l>  →  WEDDING_API_URL/api/admin/<yo'l>
 */
const TIMEOUT_MS = 20_000;
// Faqat ma'lum bo'limlar — ixtiyoriy yo'lni proksilash yo'q
const ALLOWED = /^(stats|venues|vendors|bookings|payments|subscriptions|slots)(\/[a-f0-9]{24})?(\/(block|unblock|confirm|cancel|account))?$/i;
// To'yxona egasi (CRM) — faqat o'z bo'limlari
const OWNER_ALLOWED = /^(me|calendar|reservations|bookings|transactions|employees|finance\/summary)(\/[a-f0-9]{24})?$/i;

/** To'yxona serveriga so'rov (kalit shu yerda qo'shiladi). Tarmoq xatosida null. */
export async function weddingFetch(path, { method = 'GET', body, headers = {} } = {}) {
  const base = String(process.env.WEDDING_API_URL || '').replace(/\/+$/, '');
  const key = process.env.WEDDING_ADMIN_KEY || '';
  if (!base || !key) return { status: 503, data: { error: 'To‘yxonalar serveri ulanmagan', code: 'WEDDING_NOT_CONFIGURED' } };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`${base}${path}`, {
      method,
      headers: { 'X-Admin-Key': key, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    let data = null;
    try { data = await r.json(); } catch { /* bo'sh */ }
    if (!r.ok && data && data.message && !data.error) data = { ...data, error: data.message };
    return { status: r.status, data: data ?? {} };
  } catch (e) {
    return { status: 502, data: { error: e?.name === 'AbortError' ? 'To‘yxonalar serveri javob bermadi' : 'To‘yxonalar serveriga ulanib bo‘lmadi', code: 'WEDDING_UNAVAILABLE' } };
  } finally {
    clearTimeout(timer);
  }
}

/*
 * To'yxona EGASI proksisi: /api/owner/wedding/<yo'l> → /api/owner/<yo'l>.
 * To'yxona ID — FAQAT tokendan (req.venueId), brauzer o'zgartira olmaydi.
 */
export const weddingOwnerProxy = asyncHandler(async (req, res) => {
  if (!req.venueId) return res.status(403).json({ error: 'Ruxsat yo‘q' });
  const sub = String(req.params[0] || '').replace(/^\/+|\/+$/g, '');
  if (!OWNER_ALLOWED.test(sub)) return res.status(404).json({ error: 'Topilmadi' });
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query || {})) if (typeof v === 'string' && v !== '') qs.set(k, v);
  const hasBody = !['GET', 'HEAD', 'DELETE'].includes(req.method);
  const { status, data } = await weddingFetch(`/api/owner/${sub}${qs.toString() ? `?${qs}` : ''}`, {
    method: req.method, body: hasBody ? (req.body ?? {}) : undefined, headers: { 'X-Venue-Id': String(req.venueId) },
  });
  res.status(status).json(data);
});

export const weddingProxy = asyncHandler(async (req, res) => {
  const base = String(process.env.WEDDING_API_URL || '').replace(/\/+$/, '');
  const key = process.env.WEDDING_ADMIN_KEY || '';
  if (!base || !key) {
    return res.status(503).json({ error: 'To‘yxonalar serveri ulanmagan (WEDDING_API_URL / WEDDING_ADMIN_KEY)', code: 'WEDDING_NOT_CONFIGURED' });
  }
  const sub = String(req.params[0] || '').replace(/^\/+|\/+$/g, '');
  if (!ALLOWED.test(sub)) return res.status(404).json({ error: 'Topilmadi' });

  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query || {})) {
    if (typeof v === 'string' && v !== '') qs.set(k, v);
  }
  const url = `${base}/api/admin/${sub}${qs.toString() ? `?${qs}` : ''}`;
  const hasBody = !['GET', 'HEAD', 'DELETE'].includes(req.method);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let upstream;
  try {
    upstream = await fetch(url, {
      method: req.method,
      headers: {
        'X-Admin-Key': key,
        Accept: 'application/json',
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      },
      body: hasBody ? JSON.stringify(req.body ?? {}) : undefined,
      signal: ctrl.signal,
    });
  } catch (e) {
    const timeout = e?.name === 'AbortError';
    return res.status(502).json({
      error: timeout ? 'To‘yxonalar serveri javob bermadi' : 'To‘yxonalar serveriga ulanib bo‘lmadi',
      code: 'WEDDING_UNAVAILABLE',
    });
  } finally {
    clearTimeout(timer);
  }

  let data = null;
  try { data = await upstream.json(); } catch { /* bo'sh javob */ }
  // To'yxona serveri xatoni {message} bilan beradi — panel {error} kutadi
  if (!upstream.ok && data && data.message && !data.error) data = { ...data, error: data.message };
  res.status(upstream.status).json(data ?? {});
});
