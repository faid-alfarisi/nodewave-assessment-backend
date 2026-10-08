# NodeWave Assessment - Backend API

> **High-Performance Operational Backbone for Mission-Critical Deliverables**  
> Built with **Bun**, **Hono**, **Prisma 6**, **PostgreSQL**, and **@nodewave/prisma-ezfilter**.

**Live Production API**: [https://nodewave-assessment-backend-production-02ed.up.railway.app](https://nodewave-assessment-backend-production-02ed.up.railway.app)  
**Health Check**: [https://nodewave-assessment-backend-production-02ed.up.railway.app/health](https://nodewave-assessment-backend-production-02ed.up.railway.app/health)

---

## 1. Architectural Overview & Design Decisions

This backend is designed as an enterprise-grade operational service orchestrating complex cross-departmental delivery workflows (PM, UI/UX, Frontend, Backend, Client Stakeholders).

* **Runtime: Bun**: Selected for its ultra-fast execution, instant startup, native TypeScript compilation, and built-in performant test runner.
* **HTTP Framework: Hono**: Lightweight, edge-ready, and type-safe router with near-zero overhead.
* **ORM & Database: Prisma 6 + PostgreSQL**: Provides strict relational integrity for Directed Acyclic Graph (DAG) task dependencies, soft deletes, and immutable audit logs.
* **Query Builder: `@nodewave/prisma-ezfilter`**: Enterprise query specification adhering to NodeWave's standard contract for multi-condition filtering, pagination, and sorting.
* **Authentication: JWT + RBAC/ABAC**: Stateless JSON Web Tokens paired with role-based and state-based access controls.
* **Static Assets**: Self-contained local static asset serving for default SVGs and user avatar uploads (`/public/*`, `/uploads/*`).

---

## 2. Core Complex Business Logic

### A. State-Based Dependency Locking (`422 Unprocessable Entity`)
* A task can declare multiple prerequisite dependencies (e.g. Frontend task depends on UI/UX task and Backend API task).
* When an engineer attempts to transition a task to `IN_PROGRESS`, the service verifies that **all prerequisite tasks are `DONE`**.
* If any prerequisite is incomplete, the request is rejected with `HTTP 422 Unprocessable Entity`, returning `code: "DEPENDENCY_BLOCKED"` with a detailed list of unresolved blockers.

### B. Optimistic Concurrency Control (`409 Conflict`)
* Every task record maintains an incremental `version` counter.
* Clients must send their known `version` with every update.
* If a concurrent edit from another user increments the server version, incoming stale updates are rejected with `HTTP 409 Conflict` (`code: "CONCURRENCY_CONFLICT"`), including the latest server state for conflict resolution.

### C. Role-Based & State-Based Permissions (`403 Forbidden`)
* **Product Manager Restriction**: A PM has broad administrative controls, but **cannot transition a task from `IN_PROGRESS` to `DONE`**. Only the assigned engineer executor can mark work complete.
* **Internal Team Restrictions**: Internal members (UI/UX, Frontend, Backend) cannot alter core task titles, descriptions, or toggle `clientVisible`. They can update task status and attach deliverable files.
* **Client Guest Restriction**: Client Guests have strictly read-only access. Any mutation attempt returns `HTTP 403 Forbidden`.

### D. Multi-Tenant Client Guest Isolation & Data Masking
* Client Guests only receive tasks belonging to their assigned project where `clientVisible = true`.
* Internal-only tasks (`clientVisible = false`) are excluded at the database query level.
* **API-Level Data Masking**: Before serialization, engineer profiles (`assignee`), internal departments, internal audit logs, and prerequisite task graphs are sanitized to `null` or empty arrays to protect proprietary internal delivery details.

### E. Immutable Audit Trail & Soft Deletes
* Entities implement soft deletion via `deletedAt`. Soft-deleted tasks are excluded from queries while preserving relational history.
* Every task property alteration automatically generates an immutable `TaskAuditLog` record containing `taskId`, `userId`, `changedColumn`, `oldValue`, `newValue`, and timestamp.

### F. Daily Standup Auto-Summary
* Endpoint `/api/reports/daily-standup` aggregates:
  1. What was completed yesterday (from immutable audit logs).
  2. What is blocked today (tasks in `BLOCKED` status with incomplete prerequisites).
  Grouped by department (`MANAGEMENT`, `UIUX`, `FRONTEND`, `BACKEND`).

---

## 3. Seeded Test Credentials

The database includes pre-configured test accounts (password for all accounts is `password123`):

| Role | Department | Full Name | Email | Permissions / Scope |
| :--- | :--- | :--- | :--- | :--- |
| **Product Manager** | `MANAGEMENT` | Alex Morgan | `pm@nodewave.id` | Full project & task CRUD, sets dependencies. Cannot mark in-progress to done. |
| **Internal Team** | `UIUX` | Sarah Chen | `uiux@nodewave.id` | UI/UX task execution, status updates, attachment uploads. |
| **Internal Team** | `FRONTEND` | Devin Cole | `frontend@nodewave.id` | Frontend task execution (blocked until UI/UX & Backend are Done). |
| **Internal Team** | `BACKEND` | Marcus Vance | `backend@nodewave.id` | Backend task execution (internal task, hidden from Client). |
| **Client Guest** | `CLIENT` | Victoria Sterling | `client@clientcorp.com` | Read-only stakeholder view. Masked data, only client-visible tasks. |

---

## 4. Getting Started & Local Setup

### Prerequisites
* [Bun](https://bun.sh/) (v1.2 or later)
* [PostgreSQL](https://www.postgresql.org/) (v14 or later) running locally or in Docker

### Installation & Database Setup
1. **Clone & install dependencies**:
   ```bash
   git clone https://github.com/faid-alfarisi/nodewave-assessment-backend.git
   cd nodewave-assessment-backend
   bun install
   ```

2. **Configure environment variables**:
   Create a `.env` file in the root directory:
   ```env
   DATABASE_URL="postgresql://postgres:admin@localhost:5432/nodewave_assessment?schema=public"
   JWT_SECRET="nodewave-super-secret-jwt-key-2026-assessment"
   PORT=5000
   ```

3. **Push Prisma Schema & Seed Database**:
   ```bash
   bun x prisma db push
   bun prisma/seed.ts
   ```

4. **Start Development Server**:
   ```bash
   bun run dev
   ```
   Server will start on `http://localhost:5000`.

---

## 5. Automated Unit Testing & Typecheck

Run the test suite using Bun's native test runner:
```bash
bun test
```

Run TypeScript strict typecheck:
```bash
bun run typecheck
```

### Test Coverage Highlights (`tests/tasks.test.ts`):
* Health check endpoint status verification.
* Authentication and Bearer token security guards (`401`).
* Optimistic concurrency version conflict verification (`409`).
* State-based prerequisite dependency enforcement (`422`).
* PM completion restriction (`403`).
* Internal team description protection (`403`).
* Client Guest read-only enforcement (`403`).
* Client Guest data sanitization and masking verification.
* Cross-department daily standup report aggregation.

---

## 6. API Endpoints Reference

### Authentication
* `POST /api/auth/register` - Create account (supports `multipart/form-data` with avatar upload)
* `POST /api/auth/login` - Authenticate and receive JWT token
* `GET  /api/auth/me` - Get current authenticated user profile
* `POST /api/auth/upload-avatar` - Upload new profile avatar

### Projects
* `GET  /api/projects` - List assigned projects with calculated task progress metrics
* `GET  /api/projects/:id` - Project details with members and aggregate progress
* `POST /api/projects` - Create project (PM only)

### Tasks
* `GET    /api/tasks` - List tasks with `@nodewave/prisma-ezfilter` queries & Client data masking
* `POST   /api/tasks` - Create task with optional prerequisite dependencies (PM only)
* `PATCH  /api/tasks/:id` - Update task (enforces version check, dependency locks, and RBAC)
* `DELETE /api/tasks/:id` - Soft delete task (PM only)
* `POST   /api/tasks/:id/attachments` - Upload work attachments

### Reports
* `GET /api/reports/daily-standup` - Structured cross-department standup summary

---

## 7. Continuous Integration (GitHub Actions)

Configured in [`.github/workflows/ci.yml`](.github/workflows/ci.yml):
* Spins up a PostgreSQL 16 container.
* Automatically runs `bun install`, `prisma db push`, `prisma/seed.ts`, `bun test`, and `bun run typecheck` on every push and pull request to `main`.

---

## 8. Production Deployment & Automated Migrations (Railway)

The backend is deployed on [Railway](https://railway.com/) using Docker and a dedicated managed PostgreSQL service.

### Infrastructure Topology
* **Web Service**: Containerized Bun runtime built via [`Dockerfile`](Dockerfile).
* **Database Service**: PostgreSQL 16 provisioned within the same Railway project canvas.
* **Auto-Deploy**: Connected to the `main` branch of `faid-alfarisi/nodewave-assessment-backend` for automated continuous deployment upon every `git push`.

### Automated Database Migrations
Database synchronization is automated as code via [`railway.json`](railway.json) and [`Dockerfile`](Dockerfile):
```dockerfile
CMD ["sh", "-c", "bun x prisma db push && bun prisma/seed.ts && bun run start"]
```
* **On Every Deployment**: When Railway deploys a new commit, the container boots, executes `bun x prisma db push` to reconcile schema changes against PostgreSQL, runs `prisma/seed.ts` (idempotent), and launches the HTTP server on port `5000`.
* **Zero Manual Migrations**: No manual terminal access is required for schema migrations.

### Environment Variables Configured on Railway
| Variable | Description / Value |
| :--- | :--- |
| `DATABASE_URL` | Railway internal connection reference `${{Postgres.DATABASE_URL}}` |
| `JWT_SECRET` | `nodewave-super-secret-jwt-key-2026-assessment` |
| `PORT` | `5000` |

