import { Queue, Worker } from 'bullmq';

import { config } from '../config.js';

const queueConnection = { url: config.REDIS_URL };

export const ingestQueue = new Queue('ingest', { connection: queueConnection });
export const decisionQueue = new Queue('decision', { connection: queueConnection });
export const executionQueue = new Queue('execution', { connection: queueConnection });

export function createWorker(name: string, processor: ConstructorParameters<typeof Worker>[1]) {
  return new Worker(name, processor, { connection: queueConnection });
}
