import type { Context, Next } from 'hono';
import { verifyToken, type TokenPayload } from '../lib/jwt';
import { Role } from '@prisma/client';

export type AuthContext = Context<{
  Variables: {
    user: TokenPayload;
  };
}>;

export async function authMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized: Missing or invalid token format' }, 401);
  }

  const token = authHeader.substring(7);
  try {
    const decoded = verifyToken(token);
    c.set('user', decoded);
    await next();
  } catch (error) {
    return c.json({ error: 'Unauthorized: Invalid or expired token' }, 401);
  }
}

export function requireRoles(...allowedRoles: Role[]) {
  return async (c: Context, next: Next) => {
    const user = c.get('user') as TokenPayload | undefined;
    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    if (!allowedRoles.includes(user.role)) {
      return c.json({ error: 'Forbidden: Insufficient privileges for this role' }, 403);
    }

    await next();
  };
}

