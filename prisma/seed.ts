import { PrismaClient, Role, Department, TaskStatus } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('[START] Starting database seeding...');

  await prisma.taskAuditLog.deleteMany();
  await prisma.taskAttachment.deleteMany();
  await prisma.taskDependency.deleteMany();
  await prisma.task.deleteMany();
  await prisma.projectMember.deleteMany();
  await prisma.project.deleteMany();
  await prisma.user.deleteMany();

  const defaultPassword = await bcrypt.hash('password123', 10);

  const pmUser = await prisma.user.create({
    data: {
      email: 'pm@nodewave.id',
      passwordHash: defaultPassword,
      fullName: 'Alex Morgan (Product Manager)',
      avatarUrl: '/public/default-avatars/pm.svg',
      role: Role.PRODUCT_MANAGER,
      department: Department.MANAGEMENT,
    },
  });

  const uiuxUser = await prisma.user.create({
    data: {
      email: 'uiux@nodewave.id',
      passwordHash: defaultPassword,
      fullName: 'Sarah Chen (UI/UX Designer)',
      avatarUrl: '/public/default-avatars/uiux.svg',
      role: Role.INTERNAL_TEAM,
      department: Department.UIUX,
    },
  });

  const feUser = await prisma.user.create({
    data: {
      email: 'frontend@nodewave.id',
      passwordHash: defaultPassword,
      fullName: 'Devin Cole (Frontend Engineer)',
      avatarUrl: '/public/default-avatars/frontend.svg',
      role: Role.INTERNAL_TEAM,
      department: Department.FRONTEND,
    },
  });

  const beUser = await prisma.user.create({
    data: {
      email: 'backend@nodewave.id',
      passwordHash: defaultPassword,
      fullName: 'Marcus Vance (Backend Engineer)',
      avatarUrl: '/public/default-avatars/backend.svg',
      role: Role.INTERNAL_TEAM,
      department: Department.BACKEND,
    },
  });

  const clientUser = await prisma.user.create({
    data: {
      email: 'client@clientcorp.com',
      passwordHash: defaultPassword,
      fullName: 'Victoria Sterling (Client Stakeholder)',
      avatarUrl: '/public/default-avatars/client.svg',
      role: Role.CLIENT_GUEST,
      department: Department.CLIENT,
    },
  });

  console.log('[OK] Created users: PM, UI/UX, Frontend, Backend, Client Guest');

  const project = await prisma.project.create({
    data: {
      name: 'OmniFlow Enterprise ERP & Delivery Platform',
      description: 'Mission-critical digital transformation platform with end-to-end operational visibility.',
      clientId: clientUser.id,
      members: {
        create: [
          { userId: pmUser.id },
          { userId: uiuxUser.id },
          { userId: feUser.id },
          { userId: beUser.id },
        ],
      },
    },
  });

  console.log(`[OK] Created project: ${project.name}`);

  const taskA = await prisma.task.create({
    data: {
      title: 'Design High-Fidelity Design System & Component Library',
      description: 'Create responsive tokens, atomic components, and dark/light themes in Figma.',
      status: TaskStatus.IN_PROGRESS,
      department: Department.UIUX,
      clientVisible: true,
      projectId: project.id,
      assigneeId: uiuxUser.id,
      version: 1,
    },
  });

  const taskB = await prisma.task.create({
    data: {
      title: 'Build REST APIs & Audit Trail Middleware',
      description: 'Implement Hono endpoints with RBAC, state validations, and optimistic concurrency locks.',
      status: TaskStatus.TODO,
      department: Department.BACKEND,
      clientVisible: false,
      projectId: project.id,
      assigneeId: beUser.id,
      version: 1,
    },
  });

  const taskC = await prisma.task.create({
    data: {
      title: 'Frontend Interactive Task Board & Dynamic Dependency Views',
      description: 'Slice Next.js 16 components, connect TanStack Query, and enforce action lock states.',
      status: TaskStatus.BLOCKED,
      department: Department.FRONTEND,
      clientVisible: true,
      projectId: project.id,
      assigneeId: feUser.id,
      version: 1,
    },
  });

  const taskD = await prisma.task.create({
    data: {
      title: 'Initial Project Architecture & Requirements Scope',
      description: 'Stakeholder sign-off on PRD and operational constraints.',
      status: TaskStatus.DONE,
      department: Department.MANAGEMENT,
      clientVisible: true,
      projectId: project.id,
      assigneeId: pmUser.id,
      version: 1,
    },
  });

  await prisma.taskDependency.createMany({
    data: [
      { dependentTaskId: taskC.id, prerequisiteTaskId: taskA.id },
      { dependentTaskId: taskC.id, prerequisiteTaskId: taskB.id },
    ],
  });

  console.log('[OK] Established Task Dependencies (Task C depends on Task A and Task B)');

  await prisma.taskAuditLog.createMany({
    data: [
      {
        taskId: taskD.id,
        userId: pmUser.id,
        changedColumn: 'status',
        oldValue: 'IN_PROGRESS',
        newValue: 'DONE',
      },
      {
        taskId: taskA.id,
        userId: uiuxUser.id,
        changedColumn: 'status',
        oldValue: 'TODO',
        newValue: 'IN_PROGRESS',
      },
      {
        taskId: taskC.id,
        userId: pmUser.id,
        changedColumn: 'status',
        oldValue: 'TODO',
        newValue: 'BLOCKED',
      },
    ],
  });

  console.log('[OK] Initialized Audit Logs');
  console.log('[FINISH] Seeding completed successfully!');
}

main()
  .catch((e) => {
    console.error('[ERROR] Error during seeding:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

