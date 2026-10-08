import { Hono } from 'hono';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { authMiddleware, requireRoles } from '../middlewares/auth';
import { Role, TaskStatus } from '@prisma/client';
import { BuildQueryFilter } from '@nodewave/prisma-ezfilter';

export const tasksRouter = new Hono();

tasksRouter.use('*', authMiddleware);

const taskQueryBuilder = new BuildQueryFilter({
  allowedFields: ['status', 'department', 'clientVisible', 'projectId', 'assigneeId', 'title'],
  defaultSearchMode: 'insensitive',
});

// 1. List Tasks (with @nodewave/prisma-ezfilter & Client Guest data masking)
tasksRouter.get('/', async (c) => {
  const user = c.get('user');
  const queryParams = c.req.query();

  const ezFilterInput: any = {};
  if (queryParams.filters) {
    try {
      ezFilterInput.filters = JSON.parse(queryParams.filters);
    } catch {
      ezFilterInput.filters = {};
    }
  }
  if (queryParams.searchFilters) {
    try {
      ezFilterInput.searchFilters = JSON.parse(queryParams.searchFilters);
    } catch {
      ezFilterInput.searchFilters = {};
    }
  }
  if (queryParams.page) ezFilterInput.page = parseInt(queryParams.page, 10);
  if (queryParams.rows) ezFilterInput.rows = parseInt(queryParams.rows, 10);
  if (queryParams.orderKey) ezFilterInput.orderKey = queryParams.orderKey;
  if (queryParams.orderRule) ezFilterInput.orderRule = queryParams.orderRule as 'asc' | 'desc';

  const ezResult = taskQueryBuilder.build(ezFilterInput);
  const baseWhere: any = {
    deletedAt: null,
    ...(ezResult.query?.where || {}),
  };

  if (user.role === Role.CLIENT_GUEST) {
    baseWhere.clientVisible = true;
    baseWhere.project = {
      clientId: user.userId,
    };
  } else if (user.role === Role.INTERNAL_TEAM) {
    baseWhere.project = {
      members: {
        some: { userId: user.userId },
      },
    };
  }

  const tasks = await prisma.task.findMany({
    where: baseWhere,
    take: ezResult.query?.take || 50,
    skip: ezResult.query?.skip || 0,
    orderBy: ezResult.query?.orderBy || { createdAt: 'desc' },
    include: {
      project: { select: { id: true, name: true } },
      assignee: {
        select: {
          id: true,
          fullName: true,
          avatarUrl: true,
          department: true,
        },
      },
      dependencies: {
        include: {
          prerequisiteTask: {
            select: { id: true, title: true, status: true, department: true },
          },
        },
      },
      prerequisiteFor: {
        include: {
          dependentTask: {
            select: { id: true, title: true, status: true, department: true },
          },
        },
      },
      attachments: {
        where: { deletedAt: null },
      },
      auditLogs: {
        orderBy: { createdAt: 'desc' },
        take: 10,
        include: {
          user: { select: { id: true, fullName: true } },
        },
      },
    },
  });

  const totalCount = await prisma.task.count({ where: baseWhere });

  // Data Masking for Client Guest:
  const sanitized = tasks.map((task) => {
    if (user.role === Role.CLIENT_GUEST) {
      return {
        id: task.id,
        title: task.title,
        description: task.description,
        status: task.status,
        projectId: task.projectId,
        project: task.project,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        assignee: null,
        department: null,
        auditLogs: [],
        dependencies: [],
      };
    }
    return task;
  });

  return c.json({
    data: sanitized,
    meta: {
      page: ezFilterInput.page || 1,
      rows: ezFilterInput.rows || sanitized.length,
      total: totalCount,
    },
  });
});

// 2. Create Task (PM only)
const createTaskSchema = z.object({
  title: z.string().min(2),
  description: z.string().optional(),
  department: z.enum(['MANAGEMENT', 'UIUX', 'FRONTEND', 'BACKEND', 'CLIENT']),
  projectId: z.string().uuid(),
  assigneeId: z.string().uuid().optional(),
  clientVisible: z.boolean().default(false),
  dependencyIds: z.array(z.string().uuid()).optional(),
});

tasksRouter.post('/', requireRoles(Role.PRODUCT_MANAGER), async (c) => {
  try {
    const body = await c.req.json();
    const parsed = createTaskSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Validation failed', details: parsed.error.issues }, 400);
    }

    const { title, description, department, projectId, assigneeId, clientVisible, dependencyIds } = parsed.data;
    const user = c.get('user');

    let initialStatus = TaskStatus.TODO;
    if (dependencyIds && dependencyIds.length > 0) {
      const prerequisites = await prisma.task.findMany({
        where: { id: { in: dependencyIds }, deletedAt: null },
      });

      const allDone = prerequisites.every((p) => p.status === TaskStatus.DONE);
      if (!allDone) {
        initialStatus = TaskStatus.BLOCKED;
      }
    }

    const task = await prisma.task.create({
      data: {
        title,
        description,
        department,
        projectId,
        assigneeId,
        clientVisible,
        status: initialStatus,
        version: 1,
        ...(dependencyIds && dependencyIds.length > 0
          ? {
              dependencies: {
                create: dependencyIds.map((prereqId) => ({
                  prerequisiteTaskId: prereqId,
                })),
              },
            }
          : {}),
      },
    });

    await prisma.taskAuditLog.create({
      data: {
        taskId: task.id,
        userId: user.userId,
        changedColumn: 'created',
        oldValue: null,
        newValue: JSON.stringify({ title, department, status: initialStatus }),
      },
    });

    return c.json({ data: task }, 201);
  } catch (error: any) {
    return c.json({ error: 'Failed to create task', details: error.message }, 500);
  }
});

// 3. Update Task with State-Based Permissions, Concurrency Locking & Audit Trail
const updateTaskSchema = z.object({
  title: z.string().min(2).optional(),
  description: z.string().optional(),
  status: z.enum(['TODO', 'IN_PROGRESS', 'DONE', 'BLOCKED']).optional(),
  assigneeId: z.string().uuid().nullable().optional(),
  clientVisible: z.boolean().optional(),
  department: z.enum(['MANAGEMENT', 'UIUX', 'FRONTEND', 'BACKEND', 'CLIENT']).optional(),
  version: z.number().int().min(1),
});

tasksRouter.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const user = c.get('user');

  try {
    const body = await c.req.json();
    const parsed = updateTaskSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Validation failed', details: parsed.error.issues }, 400);
    }

    const updates = parsed.data;

    const currentTask = await prisma.task.findFirst({
      where: { id, deletedAt: null },
      include: {
        dependencies: {
          include: { prerequisiteTask: true },
        },
      },
    });

    if (!currentTask) {
      return c.json({ error: 'Task not found' }, 404);
    }

    // A. Concurrency & Optimistic Locking check
    if (currentTask.version !== updates.version) {
      return c.json(
        {
          error: 'Conflict: The task was updated by another user in the meantime.',
          code: 'CONCURRENCY_CONFLICT',
          serverVersion: currentTask.version,
          currentData: {
            title: currentTask.title,
            description: currentTask.description,
            status: currentTask.status,
            version: currentTask.version,
          },
        },
        409
      );
    }

    // B. Role-Based & State-Based Access Control
    if (user.role === Role.PRODUCT_MANAGER) {
      if (currentTask.status === TaskStatus.IN_PROGRESS && updates.status === TaskStatus.DONE) {
        return c.json(
          {
            error: 'Forbidden: Product Managers cannot move a task from In Progress to Done. Only the assigned executor can complete it.',
          },
          403
        );
      }
    }

    if (user.role === Role.INTERNAL_TEAM) {
      const isMember = await prisma.projectMember.findFirst({
        where: { projectId: currentTask.projectId, userId: user.userId },
      });
      if (!isMember) {
        return c.json({ error: 'Forbidden: You are not a member of this project' }, 403);
      }

      if (updates.description !== undefined && updates.description !== currentTask.description) {
        return c.json(
          { error: 'Forbidden: Internal team members cannot change the core task description' },
          403
        );
      }
      if (updates.title !== undefined && updates.title !== currentTask.title) {
        return c.json({ error: 'Forbidden: Internal team members cannot change the task title' }, 403);
      }
      if (updates.clientVisible !== undefined && updates.clientVisible !== currentTask.clientVisible) {
        return c.json({ error: 'Forbidden: Only PMs can change client visibility' }, 403);
      }

      if (updates.status === TaskStatus.IN_PROGRESS) {
        const incompletePrerequisites = currentTask.dependencies.filter(
          (d) => d.prerequisiteTask.status !== TaskStatus.DONE
        );

        if (incompletePrerequisites.length > 0) {
          const blockers = incompletePrerequisites
            .map((d) => `"${d.prerequisiteTask.title}" (${d.prerequisiteTask.department} - ${d.prerequisiteTask.status})`)
            .join(', ');
          return c.json(
            {
              error: `Dependency Lock: Cannot move task to In Progress because prerequisite task(s) are not Done: ${blockers}`,
              code: 'DEPENDENCY_BLOCKED',
            },
            422
          );
        }
      }
    }

    if (user.role === Role.CLIENT_GUEST) {
      return c.json({ error: 'Forbidden: Client Guests have read-only access' }, 403);
    }

    // C. Perform Update with Version Increment & Audit Diff Tracking
    const auditLogsToCreate: { changedColumn: string; oldValue: string | null; newValue: string | null }[] = [];

    const updatePayload: any = {
      version: currentTask.version + 1,
    };

    const trackChange = (column: string, oldVal: any, newVal: any) => {
      if (newVal !== undefined && newVal !== oldVal) {
        updatePayload[column] = newVal;
        auditLogsToCreate.push({
          changedColumn: column,
          oldValue: oldVal !== null && oldVal !== undefined ? String(oldVal) : null,
          newValue: newVal !== null && newVal !== undefined ? String(newVal) : null,
        });
      }
    };

    trackChange('title', currentTask.title, updates.title);
    trackChange('description', currentTask.description, updates.description);
    trackChange('status', currentTask.status, updates.status);
    trackChange('assigneeId', currentTask.assigneeId, updates.assigneeId);
    trackChange('clientVisible', currentTask.clientVisible, updates.clientVisible);
    trackChange('department', currentTask.department, updates.department);

    const [updatedTask] = await prisma.$transaction([
      prisma.task.update({
        where: { id: currentTask.id },
        data: updatePayload,
      }),
      ...auditLogsToCreate.map((log) =>
        prisma.taskAuditLog.create({
          data: {
            taskId: currentTask.id,
            userId: user.userId,
            changedColumn: log.changedColumn,
            oldValue: log.oldValue,
            newValue: log.newValue,
          },
        })
      ),
    ]);

    // Check if moving to DONE unlocks any dependent tasks
    if (updates.status === TaskStatus.DONE) {
      const dependentLinks = await prisma.taskDependency.findMany({
        where: { prerequisiteTaskId: currentTask.id },
        include: {
          dependentTask: {
            include: {
              dependencies: { include: { prerequisiteTask: true } },
            },
          },
        },
      });

      for (const link of dependentLinks) {
        const depTask = link.dependentTask;
        if (depTask.status === TaskStatus.BLOCKED) {
          const allOtherPrereqsDone = depTask.dependencies.every(
            (d) => d.prerequisiteTaskId === currentTask.id || d.prerequisiteTask.status === TaskStatus.DONE
          );
          if (allOtherPrereqsDone) {
            await prisma.task.update({
              where: { id: depTask.id },
              data: { status: TaskStatus.TODO, version: depTask.version + 1 },
            });
            await prisma.taskAuditLog.create({
              data: {
                taskId: depTask.id,
                userId: user.userId,
                changedColumn: 'status',
                oldValue: 'BLOCKED',
                newValue: 'TODO (Auto-unblocked)',
              },
            });
          }
        }
      }
    }

    return c.json({ data: updatedTask });
  } catch (err: any) {
    return c.json({ error: 'Failed to update task', details: err.message }, 500);
  }
});

// 4. Soft Delete Task (PM only)
tasksRouter.delete('/:id', requireRoles(Role.PRODUCT_MANAGER), async (c) => {
  const id = c.req.param('id');
  const user = c.get('user');

  const task = await prisma.task.findFirst({ where: { id, deletedAt: null } });
  if (!task) {
    return c.json({ error: 'Task not found' }, 404);
  }

  await prisma.task.update({
    where: { id },
    data: { deletedAt: new Date(), version: task.version + 1 },
  });

  await prisma.taskAuditLog.create({
    data: {
      taskId: id,
      userId: user.userId,
      changedColumn: 'deletedAt',
      oldValue: null,
      newValue: new Date().toISOString(),
    },
  });

  return c.json({ message: 'Task soft deleted successfully' });
});

// 5. Upload Attachment
const attachmentSchema = z.object({
  fileName: z.string().min(1),
  fileUrl: z.string().url(),
  fileSize: z.number().optional(),
  mimeType: z.string().optional(),
});

tasksRouter.post('/:id/attachments', async (c) => {
  const taskId = c.req.param('id');
  const user = c.get('user');

  if (user.role === Role.CLIENT_GUEST) {
    return c.json({ error: 'Forbidden: Client Guests cannot upload attachments' }, 403);
  }

  const body = await c.req.json();
  const parsed = attachmentSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.issues }, 400);
  }

  const { fileName, fileUrl, fileSize, mimeType } = parsed.data;

  const attachment = await prisma.taskAttachment.create({
    data: {
      taskId,
      uploadedById: user.userId,
      fileName,
      fileUrl,
      fileSize,
      mimeType,
    },
  });

  await prisma.taskAuditLog.create({
    data: {
      taskId,
      userId: user.userId,
      changedColumn: 'attachment',
      oldValue: null,
      newValue: fileName,
    },
  });

  return c.json({ data: attachment }, 201);
});

