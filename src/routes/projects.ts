import { Hono } from 'hono';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { authMiddleware, requireRoles } from '../middlewares/auth';
import { Role } from '@prisma/client';

export const projectsRouter = new Hono();

projectsRouter.use('*', authMiddleware);

// List projects based on role
projectsRouter.get('/', async (c) => {
  const user = c.get('user');

  let projects;
  if (user.role === Role.PRODUCT_MANAGER) {
    projects = await prisma.project.findMany({
      where: { deletedAt: null },
      include: {
        members: { include: { user: { select: { id: true, fullName: true, role: true, department: true } } } },
        _count: { select: { tasks: { where: { deletedAt: null } } } },
      },
      orderBy: { createdAt: 'desc' },
    });
  } else if (user.role === Role.CLIENT_GUEST) {
    projects = await prisma.project.findMany({
      where: { clientId: user.userId, deletedAt: null },
      select: {
        id: true,
        name: true,
        description: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  } else {
    projects = await prisma.project.findMany({
      where: {
        deletedAt: null,
        members: { some: { userId: user.userId } },
      },
      include: {
        members: { include: { user: { select: { id: true, fullName: true, role: true, department: true } } } },
        _count: { select: { tasks: { where: { deletedAt: null } } } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  // Calculate completion percentage for each project
  const enriched = await Promise.all(
    projects.map(async (project) => {
      const totalTasks = await prisma.task.count({
        where: {
          projectId: project.id,
          deletedAt: null,
          ...(user.role === Role.CLIENT_GUEST ? { clientVisible: true } : {}),
        },
      });

      const completedTasks = await prisma.task.count({
        where: {
          projectId: project.id,
          status: 'DONE',
          deletedAt: null,
          ...(user.role === Role.CLIENT_GUEST ? { clientVisible: true } : {}),
        },
      });

      const progressPercent = totalTasks === 0 ? 0 : Math.round((completedTasks / totalTasks) * 100);

      return {
        ...project,
        metrics: {
          totalTasks,
          completedTasks,
          progressPercent,
        },
      };
    })
  );

  return c.json({ data: enriched });
});

// Create project (PM only)
const createProjectSchema = z.object({
  name: z.string().min(2),
  description: z.string().optional(),
  clientId: z.string().optional(),
  memberIds: z.array(z.string()).optional(),
});

projectsRouter.post('/', requireRoles(Role.PRODUCT_MANAGER), async (c) => {
  try {
    const body = await c.req.json();
    const parsed = createProjectSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Validation failed', details: parsed.error.issues }, 400);
    }

    const { name, description, clientId, memberIds } = parsed.data;
    const user = c.get('user');

    const project = await prisma.project.create({
      data: {
        name,
        description,
        clientId,
        members: {
          create: [
            { userId: user.userId },
            ...(memberIds || []).map((uid) => ({ userId: uid })),
          ],
        },
      },
      include: {
        members: { include: { user: { select: { id: true, fullName: true } } } },
      },
    });

    return c.json({ data: project }, 201);
  } catch (err: any) {
    return c.json({ error: 'Failed to create project', details: err.message }, 500);
  }
});

// Get Single Project Details with ABAC check
projectsRouter.get('/:id', async (c) => {
  const id = c.req.param('id');
  const user = c.get('user');

  const project = await prisma.project.findFirst({
    where: { id, deletedAt: null },
    include: {
      members: {
        include: {
          user: {
            select: { id: true, fullName: true, role: true, department: true, avatarUrl: true },
          },
        },
      },
    },
  });

  if (!project) {
    return c.json({ error: 'Project not found' }, 404);
  }

  // ABAC check
  if (user.role === Role.CLIENT_GUEST) {
    if (project.clientId !== user.userId) {
      return c.json({ error: 'Forbidden: Access restricted to assigned client' }, 403);
    }
  } else if (user.role === Role.INTERNAL_TEAM) {
    const isMember = project.members.some((m) => m.userId === user.userId);
    if (!isMember) {
      return c.json({ error: 'Forbidden: You are not a member of this project' }, 403);
    }
  }

  // Metrics calculation
  const totalTasks = await prisma.task.count({
    where: {
      projectId: id,
      deletedAt: null,
      ...(user.role === Role.CLIENT_GUEST ? { clientVisible: true } : {}),
    },
  });

  const completedTasks = await prisma.task.count({
    where: {
      projectId: id,
      status: 'DONE',
      deletedAt: null,
      ...(user.role === Role.CLIENT_GUEST ? { clientVisible: true } : {}),
    },
  });

  const progressPercent = totalTasks === 0 ? 0 : Math.round((completedTasks / totalTasks) * 100);

  const sanitizedProject = {
    ...project,
    members: user.role === Role.CLIENT_GUEST ? [] : project.members,
    metrics: {
      totalTasks,
      completedTasks,
      progressPercent,
    },
  };

  return c.json({ data: sanitizedProject });
});

