import { Counter, Gauge, Histogram, Registry } from 'prom-client';

export const metricsRegistry = new Registry();

export const pollLatency = new Histogram({
  name: 'copytrader_poll_latency_ms',
  help: 'Wallet polling latency in milliseconds',
  buckets: [50, 100, 250, 500, 1000, 3000, 5000],
  registers: [metricsRegistry],
});

export const detectionLatency = new Histogram({
  name: 'copytrader_detection_latency_ms',
  help: 'Detection latency from trade time to ingestion time',
  buckets: [100, 500, 1000, 5000, 15000, 30000],
  registers: [metricsRegistry],
});

export const tradeDetectionLatency = new Histogram({
  name: 'trade_detection_latency',
  help: 'Trade detection latency in milliseconds',
  buckets: [100, 500, 1000, 5000, 15000, 30000],
  registers: [metricsRegistry],
});

export const apiLatency = new Histogram({
  name: 'api_latency',
  help: 'Upstream API latency in milliseconds',
  labelNames: ['adapter'],
  buckets: [50, 100, 250, 500, 1000, 3000, 5000],
  registers: [metricsRegistry],
});

export const ingestionRate = new Counter({
  name: 'ingestion_rate',
  help: 'Count of ingested trades',
  labelNames: ['wallet_tier'],
  registers: [metricsRegistry],
});

export const copyLatency = new Histogram({
  name: 'copytrader_copy_latency_ms',
  help: 'Decision to execution latency in milliseconds',
  buckets: [50, 100, 250, 500, 1000, 3000],
  registers: [metricsRegistry],
});

export const paperPipelineLatency = new Histogram({
  name: 'copytrader_paper_pipeline_latency_ms',
  help: 'Paper copy pipeline stage latency in milliseconds',
  labelNames: ['stage'],
  buckets: [10, 25, 50, 100, 250, 500, 1000, 3000, 5000, 10000, 30000],
  registers: [metricsRegistry],
});

export const paperEndToEndLatency = new Histogram({
  name: 'copytrader_paper_end_to_end_latency_ms',
  help: 'Paper copy end-to-end latency segments in milliseconds',
  labelNames: ['segment'],
  buckets: [100, 500, 1000, 3000, 5000, 10000, 20000, 40000],
  registers: [metricsRegistry],
});

export const decisionsCounter = new Counter({
  name: 'copytrader_decisions_total',
  help: 'Count of copy decisions by action',
  labelNames: ['action'],
  registers: [metricsRegistry],
});

export const skippedReasonCounter = new Counter({
  name: 'copytrader_skipped_reason_total',
  help: 'Count of skipped reasons',
  labelNames: ['reason'],
  registers: [metricsRegistry],
});

export const orderErrorCounter = new Counter({
  name: 'copytrader_order_error_total',
  help: 'Count of order submission errors',
  registers: [metricsRegistry],
});

export const queueBacklogGauge = new Gauge({
  name: 'copytrader_queue_backlog',
  help: 'Current queue waiting jobs',
  labelNames: ['queue'],
  registers: [metricsRegistry],
});
