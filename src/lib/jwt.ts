import jwt from 'jsonwebtoken';
import { Role, Department } from '@prisma/client';

const JWT_SECRET = process.env.JWT_SECRET || 'nodewave-super-secret-jwt-key-2026-assessment';

export interface TokenPayload {
  userId: string;
  email: string;
  fullName: string;
  role: Role;
  department: Department;
}

export function signToken(payload: TokenPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}

export function verifyToken(token: string): TokenPayload {
  return jwt.verify(token, JWT_SECRET) as TokenPayload;
}

