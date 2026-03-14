import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';

import { registerRoutes } from './routes.js';

export async function createApp() {
  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });
  await app.register(sensible);
  await app.register(websocket);
  await registerRoutes(app);
  return app;
}
