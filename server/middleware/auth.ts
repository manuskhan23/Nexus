import { Request, Response, NextFunction } from 'express';
import { getRedis, UserDoc, UserModel } from '../models';
import { verifyAccessToken } from '../services/auth/crypto';

export interface AuthenticatedRequest extends Request {
  userId?: string;
  user?: UserDoc;
}

export async function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const token = header.slice(7);
  try {
    const payload = verifyAccessToken(token);
    const user = await UserModel.findById(payload.sub);
    if (!user) {
      res.status(401).json({ error: 'User account not found' });
      return;
    }
    req.userId = user._id;
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired access token' });
  }
}

const memoryBuckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(maxRequests: number, windowMs: number) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const key = `rl:${req.ip}:${req.baseUrl}${req.path}`;
    const redis = getRedis();

    if (redis) {
      try {
        const count = await redis.incr(key);
        if (count === 1) {
          await redis.pexpire(key, windowMs);
        }
        if (count > maxRequests) {
          res.status(429).json({ error: 'Too many requests. Please try again shortly.' });
          return;
        }
        next();
        return;
      } catch {
        // Fall through to in-memory limiter if Redis hiccups
      }
    }

    const now = Date.now();
    const current = memoryBuckets.get(key);
    if (!current || current.resetAt < now) {
      memoryBuckets.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }

    if (current.count >= maxRequests) {
      res.status(429).json({ error: 'Too many requests. Please try again shortly.' });
      return;
    }

    current.count += 1;
    next();
  };
}
