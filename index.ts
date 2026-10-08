import app from './src/index';

const port = parseInt(process.env.PORT || '5000', 10);
console.log(`[START] NodeWave API Server listening on http://localhost:${port}`);

export default {
  port,
  fetch: app.fetch,
};