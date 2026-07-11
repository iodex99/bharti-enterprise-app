import type { NextFunction, Request, Response } from 'express';

/**
 * Route-param guard: numeric ids only. Without this, Number('abc') = NaN reaches
 * better-sqlite3 bindings and throws a 500; garbage ids should just be a 404.
 * Usage: router.param('id', idParamGuard) — once per router that uses :id.
 */
export function idParamGuard(
  _req: Request,
  res: Response,
  next: NextFunction,
  value: string,
): void {
  if (!/^\d{1,15}$/.test(value)) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  next();
}
