import { describe, it, expect, beforeAll } from 'bun:test';
import app from '../src/index';
import { prisma } from '../src/lib/prisma';
import { signToken } from '../src/lib/jwt';
import { Role, Department, TaskStatus } from '@prisma/client';

describe('NodeWave Assessment API Test Suite', () => {
  let pmToken: string;
  let frontendToken: string;
  let uiuxToken: string;
  let clientToken: string;

  let taskAId: string; // UI/UX Task (IN_PROGRESS)
  let taskBId: string; // Backend Task (TODO, clientVisible: false)
  let taskCId: string; // Frontend Task (BLOCKED, depends on A & B)
  let projectId: string;

  beforeAll(async () => {
    // Retrieve seeded users
    const pm = await prisma.user.findUnique({ where: { email: 'pm@nodewave.id' } });
    const fe = await prisma.user.findUnique({ where: { email: 'frontend@nodewave.id' } });
    const uiux = await prisma.user.findUnique({ where: { email: 'uiux@nodewave.id' } });
    const client = await prisma.user.findUnique({ where: { email: 'client@clientcorp.com' } });

    if (!pm || !fe || !uiux || !client) {
      throw new Error('Database must be seeded prior to running test suite. Run: bun prisma/seed.ts');
    }

    pmToken = signToken({
      userId: pm.id,
      email: pm.email,
      fullName: pm.fullName,
      role: pm.role,
      department: pm.department,
    });

    frontendToken = signToken({
      userId: fe.id,
      email: fe.email,
      fullName: fe.fullName,
      role: fe.role,
      department: fe.department,
    });

    uiuxToken = signToken({
      userId: uiux.id,
      email: uiux.email,
      fullName: uiux.fullName,
      role: uiux.role,
      department: uiux.department,
    });

    clientToken = signToken({
      userId: client.id,
      email: client.email,
      fullName: client.fullName,
      role: client.role,
      department: client.department,
    });

    // Retrieve seeded tasks
    const tasks = await prisma.task.findMany({
      orderBy: { createdAt: 'asc' },
    });

    const taskA = tasks.find((t) => t.department === Department.UIUX);
    const taskB = tasks.find((t) => t.department === Department.BACKEND);
    const taskC = tasks.find((t) => t.department === Department.FRONTEND);

    if (!taskA || !taskB || !taskC) {
      throw new Error('Seeded tasks not found');
    }

    taskAId = taskA.id;
    taskBId = taskB.id;
    taskCId = taskC.id;
    projectId = taskA.projectId;
  });

  // 1. Health Check
  describe('Health Check Endpoint', () => {
    it('should return 200 and healthy status', async () => {
      const res = await app.request('/health');
      expect(res.status).toBe(200);

      const json: any = await res.json();
      expect(json.status).toBe('ok');
      expect(json.service).toBe('nodewave-assessment-backend');
    });
  });

  // 2. Authentication Guards
  describe('Authentication & Authorization Guards', () => {
    it('should reject unauthenticated request with 401', async () => {
      const res = await app.request('/api/tasks');
      expect(res.status).toBe(401);
    });

    it('should reject request with invalid token with 401', async () => {
      const res = await app.request('/api/tasks', {
        headers: { Authorization: 'Bearer invalid-dummy-token' },
      });
      expect(res.status).toBe(401);
    });
  });

  // 3. Optimistic Concurrency Control
  describe('Optimistic Concurrency Control (Version Locking)', () => {
    it('should return 409 Conflict when updating with a stale version', async () => {
      const staleVersion = 999;

      const res = await app.request(`/api/tasks/${taskAId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${uiuxToken}`,
        },
        body: JSON.stringify({
          status: 'IN_PROGRESS',
          version: staleVersion,
        }),
      });

      expect(res.status).toBe(409);
      const json: any = await res.json();
      expect(json.code).toBe('CONCURRENCY_CONFLICT');
      expect(json.serverVersion).toBeDefined();
    });
  });

  // 4. State-Based Dependency Rule
  describe('State-Based Dependency Enforcement', () => {
    it('should block moving a dependent task to IN_PROGRESS when prerequisites are not DONE (422)', async () => {
      const currentTaskC = await prisma.task.findUniqueOrThrow({ where: { id: taskCId } });

      const res = await app.request(`/api/tasks/${taskCId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${frontendToken}`,
        },
        body: JSON.stringify({
          status: 'IN_PROGRESS',
          version: currentTaskC.version,
        }),
      });

      expect(res.status).toBe(422);
      const json: any = await res.json();
      expect(json.code).toBe('DEPENDENCY_BLOCKED');
      expect(json.error).toContain('Dependency Lock');
    });
  });

  // 5. Role-Based & State-Based Permissions
  describe('Role-Based & State-Based Access Control', () => {
    it('should forbid PM from transitioning an IN_PROGRESS task to DONE (403)', async () => {
      const currentTaskA = await prisma.task.findUniqueOrThrow({ where: { id: taskAId } });

      const res = await app.request(`/api/tasks/${taskAId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${pmToken}`,
        },
        body: JSON.stringify({
          status: 'DONE',
          version: currentTaskA.version,
        }),
      });

      expect(res.status).toBe(403);
      const json: any = await res.json();
      expect(json.error).toContain('Product Managers cannot move a task from In Progress to Done');
    });

    it('should forbid internal team members from modifying core description (403)', async () => {
      const currentTaskA = await prisma.task.findUniqueOrThrow({ where: { id: taskAId } });

      const res = await app.request(`/api/tasks/${taskAId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${uiuxToken}`,
        },
        body: JSON.stringify({
          description: 'Hacked description by engineer',
          version: currentTaskA.version,
        }),
      });

      expect(res.status).toBe(403);
      const json: any = await res.json();
      expect(json.error).toContain('Internal team members cannot change the core task description');
    });

    it('should forbid Client Guest from performing any updates (403)', async () => {
      const currentTaskA = await prisma.task.findUniqueOrThrow({ where: { id: taskAId } });

      const res = await app.request(`/api/tasks/${taskAId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${clientToken}`,
        },
        body: JSON.stringify({
          status: 'DONE',
          version: currentTaskA.version,
        }),
      });

      expect(res.status).toBe(403);
      const json: any = await res.json();
      expect(json.error).toContain('Client Guests have read-only access');
    });
  });

  // 6. Client Guest Isolation & Data Masking
  describe('Client Guest Multi-Tenant Isolation & Data Masking', () => {
    it('should mask sensitive engineer data and exclude internal-only tasks for Client Guest', async () => {
      const res = await app.request('/api/tasks', {
        headers: {
          Authorization: `Bearer ${clientToken}`,
        },
      });

      expect(res.status).toBe(200);
      const json: any = await res.json();
      expect(Array.isArray(json.data)).toBe(true);

      // Verify taskB (clientVisible: false) is NOT present
      const foundTaskB = json.data.find((t: any) => t.id === taskBId);
      expect(foundTaskB).toBeUndefined();

      // Verify all returned tasks have engineer details masked
      for (const task of json.data) {
        expect(task.assignee).toBeNull();
        expect(task.department).toBeNull();
        expect(task.auditLogs).toEqual([]);
        expect(task.dependencies).toEqual([]);
      }
    });
  });

  // 7. Daily Standup Report
  describe('Daily Standup Report Endpoint', () => {
    it('should return aggregated completed and blocked items per department', async () => {
      const res = await app.request('/api/reports/daily-standup', {
        headers: {
          Authorization: `Bearer ${pmToken}`,
        },
      });

      expect(res.status).toBe(200);
      const json: any = await res.json();
      expect(json.reportDate).toBeDefined();
      expect(json.summaryByDepartment).toBeDefined();
      expect(json.summaryByDepartment.FRONTEND).toBeDefined();
      expect(json.summaryByDepartment.UIUX).toBeDefined();
      expect(json.summaryByDepartment.BACKEND).toBeDefined();
      expect(json.rawMetrics).toBeDefined();
    });
  });
});
