type LoopName =
  | 'wallet-poll-scheduler'
  | 'portfolio-snapshot'
  | 'wallet-analytics'
  | 'market-intelligence'
  | 'paper-session-tick'
  | 'reconciliation'
  | 'memory-sample';

type LoopStatus = {
  intervalMs: number;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  consecutiveFailures: number;
  totalRuns: number;
  totalFailures: number;
  lastError: string | null;
};

type RuntimeOpsState = {
  instanceId: string;
  startedAt: string | null;
  schedulerEnabled: boolean;
  schedulerLeader: boolean;
  schedulerLeaseKey: string | null;
  schedulerLeaseAcquiredAt: string | null;
  schedulerLeaseRenewedAt: string | null;
  loops: Partial<Record<LoopName, LoopStatus>>;
  workerCompleted: number;
  workerFailed: number;
  duplicatePollSkips: number;
  decisionFailures: number;
  memorySamples: Array<{ at: string; rssMb: number; heapUsedMb: number; externalMb: number }>;
};

const MAX_MEMORY_SAMPLES = 120;

const state: RuntimeOpsState = {
  instanceId: 'unknown',
  startedAt: null,
  schedulerEnabled: true,
  schedulerLeader: false,
  schedulerLeaseKey: null,
  schedulerLeaseAcquiredAt: null,
  schedulerLeaseRenewedAt: null,
  loops: {},
  workerCompleted: 0,
  workerFailed: 0,
  duplicatePollSkips: 0,
  decisionFailures: 0,
  memorySamples: [],
};

function ensureLoop(name: LoopName, intervalMs: number): LoopStatus {
  const existing = state.loops[name];
  if (existing) {
    if (existing.intervalMs !== intervalMs) {
      existing.intervalMs = intervalMs;
    }
    return existing;
  }
  const created: LoopStatus = {
    intervalMs,
    lastStartedAt: null,
    lastFinishedAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    consecutiveFailures: 0,
    totalRuns: 0,
    totalFailures: 0,
    lastError: null,
  };
  state.loops[name] = created;
  return created;
}

export function markRuntimeStarted(input: {
  instanceId: string;
  schedulerEnabled: boolean;
  schedulerLeaseKey: string;
}) {
  state.instanceId = input.instanceId;
  state.startedAt = new Date().toISOString();
  state.schedulerEnabled = input.schedulerEnabled;
  state.schedulerLeaseKey = input.schedulerLeaseKey;
}

export function markSchedulerLeadership(isLeader: boolean, leaseTouched: boolean) {
  state.schedulerLeader = isLeader;
  const now = new Date().toISOString();
  if (isLeader && !state.schedulerLeaseAcquiredAt) {
    state.schedulerLeaseAcquiredAt = now;
  }
  if (leaseTouched) {
    state.schedulerLeaseRenewedAt = now;
  }
}

export function markLoopStart(name: LoopName, intervalMs: number) {
  const loop = ensureLoop(name, intervalMs);
  loop.lastStartedAt = new Date().toISOString();
  loop.totalRuns += 1;
}

export function markLoopSuccess(name: LoopName, intervalMs: number) {
  const loop = ensureLoop(name, intervalMs);
  const now = new Date().toISOString();
  loop.lastFinishedAt = now;
  loop.lastSuccessAt = now;
  loop.consecutiveFailures = 0;
  loop.lastError = null;
}

export function markLoopFailure(name: LoopName, intervalMs: number, error: unknown) {
  const loop = ensureLoop(name, intervalMs);
  const now = new Date().toISOString();
  loop.lastFinishedAt = now;
  loop.lastFailureAt = now;
  loop.consecutiveFailures += 1;
  loop.totalFailures += 1;
  loop.lastError = error instanceof Error ? error.message : String(error);
}

export function incrementWorkerCompleted() {
  state.workerCompleted += 1;
}

export function incrementWorkerFailed() {
  state.workerFailed += 1;
}

export function incrementDuplicatePollSkip() {
  state.duplicatePollSkips += 1;
}

export function incrementDecisionFailure() {
  state.decisionFailures += 1;
}

export function sampleMemoryUsage() {
  const mem = process.memoryUsage();
  state.memorySamples.push({
    at: new Date().toISOString(),
    rssMb: Math.round((mem.rss / 1024 / 1024) * 100) / 100,
    heapUsedMb: Math.round((mem.heapUsed / 1024 / 1024) * 100) / 100,
    externalMb: Math.round((mem.external / 1024 / 1024) * 100) / 100,
  });
  if (state.memorySamples.length > MAX_MEMORY_SAMPLES) {
    state.memorySamples.splice(0, state.memorySamples.length - MAX_MEMORY_SAMPLES);
  }
}

export function getRuntimeOpsSnapshot() {
  return {
    ...state,
    uptimeSec: Math.floor(process.uptime()),
  };
}
