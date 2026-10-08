import { Hono } from 'hono';
import { prisma } from '../lib/prisma';
import { authMiddleware } from '../middlewares/auth';
import { Role } from '@prisma/client';

export const reportsRouter = new Hono();

reportsRouter.use('*', authMiddleware);

reportsRouter.get('/daily-standup', async (c) => {
  const user = c.get('user');

  if (user.role === Role.CLIENT_GUEST) {
    return c.json({ error: 'Forbidden: Daily standup report is an internal team resource' }, 403);
  }

  const now = new Date();
  const startOfYesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 0, 0, 0);
  const endOfYesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 23, 59, 59, 999);

  const completedAuditEntries = await prisma.taskAuditLog.findMany({
    where: {
      changedColumn: 'status',
      newValue: 'DONE',
      createdAt: {
        gte: startOfYesterday,
        lte: endOfYesterday,
      },
    },
    include: {
      task: {
        select: {
          id: true,
          title: true,
          department: true,
          projectId: true,
          project: { select: { name: true } },
        },
      },
      user: {
        select: { id: true, fullName: true, department: true },
      },
    },
  });

  const blockedTasks = await prisma.task.findMany({
    where: {
      status: 'BLOCKED',
      deletedAt: null,
    },
    include: {
      project: { select: { name: true } },
      assignee: { select: { fullName: true } },
      dependencies: {
        include: {
          prerequisiteTask: {
            select: { id: true, title: true, status: true, department: true },
          },
        },
      },
    },
  });

  const departments = ['MANAGEMENT', 'UIUX', 'FRONTEND', 'BACKEND'];
  const summaryByDepartment: Record<string, { completedYesterday: any[]; blockedToday: any[] }> = {};

  for (const dept of departments) {
    summaryByDepartment[dept] = {
      completedYesterday: completedAuditEntries
        .filter((entry) => entry.task.department === dept)
        .map((entry) => ({
          taskId: entry.task.id,
          taskTitle: entry.task.title,
          projectName: entry.task.project.name,
          completedBy: entry.user?.fullName || 'Unknown',
          completedAt: entry.createdAt,
        })),
      blockedToday: blockedTasks
        .filter((task) => task.department === dept)
        .map((task) => ({
          taskId: task.id,
          taskTitle: task.title,
          projectName: task.project.name,
          assignee: task.assignee?.fullName || 'Unassigned',
          blockingPrerequisites: task.dependencies.map((d) => ({
            prerequisiteTitle: d.prerequisiteTask.title,
            prerequisiteDept: d.prerequisiteTask.department,
            currentStatus: d.prerequisiteTask.status,
          })),
        })),
    };
  }

  return c.json({
    reportDate: now.toISOString(),
    reportingPeriod: {
      startOfYesterday: startOfYesterday.toISOString(),
      endOfYesterday: endOfYesterday.toISOString(),
    },
    summaryByDepartment,
    rawMetrics: {
      totalCompletedYesterday: completedAuditEntries.length,
      totalBlockedToday: blockedTasks.length,
    },
  });
});

