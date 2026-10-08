import { Hono } from 'hono';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma';
import { signToken } from '../lib/jwt';
import { authMiddleware, type AppEnv } from '../middlewares/auth';
import { promises as fs } from 'fs';
import path from 'path';

export const authRouter = new Hono<AppEnv>();

// Helper to save uploaded avatar file locally
async function saveAvatarFile(file: File): Promise<string> {
  const bytes = await file.arrayBuffer();
  const buffer = Buffer.from(bytes);
  const ext = path.extname(file.name) || '.png';
  const fileName = `avatar-${Date.now()}-${Math.random().toString(36).substring(2, 9)}${ext}`;
  const uploadDir = path.join(process.cwd(), 'uploads', 'avatars');

  await fs.mkdir(uploadDir, { recursive: true });
  const filePath = path.join(uploadDir, fileName);
  await fs.writeFile(filePath, buffer);

  return `/uploads/avatars/${fileName}`;
}

// 1. Dedicated Avatar Upload Endpoint
authRouter.post('/upload-avatar', async (c) => {
  try {
    const body = await c.req.parseBody();
    const file = body['avatar'];

    if (!file || !(file instanceof File)) {
      return c.json({ error: 'No avatar file uploaded' }, 400);
    }

    // Limit file size (max 5MB)
    if (file.size > 5 * 1024 * 1024) {
      return c.json({ error: 'Avatar file size must be less than 5MB' }, 400);
    }

    const avatarUrl = await saveAvatarFile(file);
    return c.json({ avatarUrl });
  } catch (err: any) {
    return c.json({ error: 'Failed to upload avatar', details: err.message }, 500);
  }
});

// 2. Register with optional avatarUrl
const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  fullName: z.string().min(2),
  role: z.enum(['PRODUCT_MANAGER', 'INTERNAL_TEAM', 'CLIENT_GUEST']),
  department: z.enum(['MANAGEMENT', 'UIUX', 'FRONTEND', 'BACKEND', 'CLIENT']),
  avatarUrl: z.string().optional(),
});

authRouter.post('/register', async (c) => {
  try {
    // Check if multipart form data or json
    const contentType = c.req.header('Content-Type') || '';
    let email = '';
    let password = '';
    let fullName = '';
    let role: any = 'INTERNAL_TEAM';
    let department: any = 'FRONTEND';
    let avatarUrl: string | undefined = undefined;

    if (contentType.includes('multipart/form-data')) {
      const body = await c.req.parseBody();
      email = String(body['email'] || '');
      password = String(body['password'] || '');
      fullName = String(body['fullName'] || '');
      role = body['role'];
      department = body['department'];

      const file = body['avatar'];
      if (file && file instanceof File && file.size > 0) {
        avatarUrl = await saveAvatarFile(file);
      }
    } else {
      const body = await c.req.json();
      const parsed = registerSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: 'Validation failed', details: parsed.error.issues }, 400);
      }
      email = parsed.data.email;
      password = parsed.data.password;
      fullName = parsed.data.fullName;
      role = parsed.data.role;
      department = parsed.data.department;
      avatarUrl = parsed.data.avatarUrl;
    }

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return c.json({ error: 'Email already registered' }, 409);
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        fullName,
        role,
        department,
        avatarUrl: avatarUrl || null,
      },
    });

    const token = signToken({
      userId: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      department: user.department,
    });

    return c.json(
      {
        message: 'Registration successful',
        token,
        user: {
          id: user.id,
          email: user.email,
          fullName: user.fullName,
          avatarUrl: user.avatarUrl,
          role: user.role,
          department: user.department,
        },
      },
      201
    );
  } catch (error: any) {
    return c.json({ error: 'Server error during registration', details: error.message }, 500);
  }
});

// 3. Login
const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

authRouter.post('/login', async (c) => {
  try {
    const body = await c.req.json();
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Invalid credentials format', details: parsed.error.issues }, 400);
    }

    const { email, password } = parsed.data;
    const user = await prisma.user.findUnique({
      where: { email, deletedAt: null },
    });

    if (!user) {
      return c.json({ error: 'Invalid email or password' }, 401);
    }

    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) {
      return c.json({ error: 'Invalid email or password' }, 401);
    }

    const token = signToken({
      userId: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      department: user.department,
    });

    return c.json({
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        avatarUrl: user.avatarUrl,
        role: user.role,
        department: user.department,
      },
    });
  } catch (error: any) {
    return c.json({ error: 'Server error during login', details: error.message }, 500);
  }
});

// 4. Current Profile (Me)
authRouter.get('/me', authMiddleware, async (c) => {
  const userPayload = c.get('user');
  const user = await prisma.user.findUnique({
    where: { id: userPayload.userId },
    select: {
      id: true,
      email: true,
      fullName: true,
      avatarUrl: true,
      role: true,
      department: true,
      createdAt: true,
    },
  });

  if (!user) {
    return c.json({ error: 'User not found' }, 404);
  }

  return c.json({ user });
});
