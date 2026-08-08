
// Async controllerlarni try/catch'siz yozish uchun
export const asyncHandler =
(fn) =>
(req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

/**
 * Xato ishlovchisi.
 *
 * Avval hamma narsa 500 "Server xatosi" bo'lib qaytardi va
 * sabab faqat serverda qolardi — panel yoki ofitsiant nima
 * bo'lganini bila olmasdi.
 *
 * Endi ma'lum turdagi xatolar tushunarli 400 javob bo'ladi,
 * noma'lumlari esa logda so'rov konteksti bilan yoziladi.
 */
export function errorHandler(err, req, res, _next) {
  // Mongoose: majburiy maydon yoki enum mos kelmadi
  if (err?.name === 'ValidationError') {
    const first = Object.values(err.errors || {})[0];
    console.error('[validation]', req.method, req.originalUrl, err.message);
    return res.status(400).json({
      error: first?.message || 'Ma\u2018lumot noto\u2018g\u2018ri',
      code: 'VALIDATION',
      field: first?.path,
    });
  }

  // Mongoose: ObjectId yoki son formati noto'g'ri
  if (err?.name === 'CastError') {
    console.error('[cast]', req.method, req.originalUrl, err.message);
    return res.status(400).json({
      error: 'Ma\u2018lumot formati noto\u2018g\u2018ri',
      code: 'CAST',
      field: err.path,
    });
  }

  // Takrorlanuvchi unique qiymat
  if (err?.code === 11000) {
    const field = Object.keys(err.keyPattern || {})[0] || 'qiymat';
    console.error('[duplicate]', req.method, req.originalUrl, field);
    return res.status(400).json({
      error: `Bu ${field} allaqachon band`,
      code: 'DUPLICATE',
      field,
    });
  }

  // Noma'lum xato — so'rov konteksti bilan logga yoziladi
  console.error('[500]', req.method, req.originalUrl, '\n', err);
  res.status(500).json({
    error: 'Server xatosi',
    message: err?.message || '',
  });
}

export function notFound(_req, res) {
  res.status(404).json({ error: 'Topilmadi' });
}
