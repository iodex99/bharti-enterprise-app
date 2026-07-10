import type { NextFunction, Request, Response } from 'express';
import type { ZodType } from 'zod';

/** Validate req.body with a zod schema; replaces body with the parsed (typed) value. */
export function validateBody(schema: ZodType) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const first = result.error.issues[0];
      const path = first?.path.join('.') ?? '';
      res.status(400).json({
        error: `${path ? path + ': ' : ''}${first?.message ?? 'Invalid input'}`,
        issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
      return;
    }
    req.body = result.data;
    next();
  };
}
