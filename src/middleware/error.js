
// Async controllerlarni try/catch'siz yozish uchun
export const asyncHandler =
(fn) =>
(req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

export function errorHandler(
err,
_req,
res,
_next)
{
  console.error(err);
  res.status(500).json({ error: 'Server xatosi', message: err.message });
}

export function notFound(_req, res) {
  res.status(404).json({ error: 'Topilmadi' });
}
