import type { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../auth/token.js';

export function makeAuthMiddleware(secret: string): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.header('authorization');
    const bearer = header?.startsWith('Bearer ') ? header.slice(7) : null;
    const token = bearer ?? (req.cookies?.token as string | undefined) ?? null;
    if (token && verifyToken(secret, token)) { next(); return; }
    res.status(401).json({ error: 'unauthorized' });
  };
}
