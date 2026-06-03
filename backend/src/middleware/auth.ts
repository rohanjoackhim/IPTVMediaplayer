import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { getDb } from '../db';
import { JWTPayload } from '../types';

export interface AuthRequest extends Request {
  user?: {
    id: string;
    email: string;
  };
}

const JWT_SECRET = process.env.JWT_SECRET || 'default-secret-change-me';

export function generateToken(userId: string, email: string): string {
  return jwt.sign(
    { userId, email },
    JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

export function verifyToken(token: string): JWTPayload {
  return jwt.verify(token, JWT_SECRET) as JWTPayload;
}

export function authMiddleware(req: AuthRequest, res: Response, next: NextFunction): void {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Unauthorized - No token provided' });
      return;
    }

    const token = authHeader.substring(7);
    const decoded = verifyToken(token);

    req.user = {
      id: decoded.userId,
      email: decoded.email,
    };

    next();
  } catch (error) {
    res.status(401).json({ error: 'Unauthorized - Invalid token' });
  }
}

export async function apiKeyMiddleware(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const apiKey = (req.headers['x-api-key'] as string) || (req.query as Record<string, string>).apiKey;

    if (!apiKey) {
      res.status(401).json({ error: 'Unauthorized - No API key provided' });
      return;
    }

    const db = getDb();
    const keyRecord = await db('api_keys').where({ key: apiKey, is_active: 1 }).first();

    if (!keyRecord) {
      res.status(401).json({ error: 'Unauthorized - Invalid API key' });
      return;
    }

    if (keyRecord.expires_at && new Date(keyRecord.expires_at) < new Date()) {
      res.status(401).json({ error: 'Unauthorized - API key expired' });
      return;
    }

    await db('api_keys').where({ id: keyRecord.id }).update({ last_used_at: db.raw('CURRENT_TIMESTAMP') });

    const user = await db('users').select('id', 'email').where({ id: keyRecord.user_id }).first();

    if (!user) {
      res.status(401).json({ error: 'Unauthorized - User not found' });
      return;
    }

    req.user = user;
    next();
  } catch (error) {
    console.error('API Key middleware error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}
