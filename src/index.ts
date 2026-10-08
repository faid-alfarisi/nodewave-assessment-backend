import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { serveStatic } from '@hono/node-server/serve-static';
import { authRouter } from './routes/auth';
import { projectsRouter } from './routes/projects';
import { tasksRouter } from './routes/tasks';
import { reportsRouter } from './routes/reports';

const app = new Hono();

app.use('*', logger());
app.use(
  '*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    exposeHeaders: ['Content-Length'],
    maxAge: 600,
  })
);

// Serve static assets: default avatars & user uploads
app.use('/public/*', serveStatic({ root: './' }));
app.use('/uploads/*', serveStatic({ root: './' }));

app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'nodewave-assessment-backend',
    timestamp: new Date().toISOString(),
  });
});

app.route('/api/auth', authRouter);
app.route('/api/projects', projectsRouter);
app.route('/api/tasks', tasksRouter);
app.route('/api/reports', reportsRouter);

app.notFound((c) => {
  return c.json({ error: 'Endpoint not found' }, 404);
});

app.onError((err, c) => {
  console.error('Unhandled server error:', err);
  return c.json({ error: 'Internal Server Error', message: err.message }, 500);
});

export default app;
