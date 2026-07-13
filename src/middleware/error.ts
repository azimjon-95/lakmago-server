import { Request, Response, NextFunction } from 'express';

// Async controllerlarni try/catch'siz yozish uchun
export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  console.error(err);
  res.status(500).json({ error: 'Server xatosi', message: err.message });
}

export function notFound(_req: Request, res: Response) {
  res.status(404).json({ error: 'Topilmadi' });
}
