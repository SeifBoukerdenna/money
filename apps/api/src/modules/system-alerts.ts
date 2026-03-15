import { prisma } from '../lib/prisma.js';
import { Prisma } from '@prisma/client';

const db = prisma as unknown as Record<string, any>;

type AlertSeverity = 'INFO' | 'WARN' | 'CRITICAL';

type RaiseAlertInput = {
  dedupeKey: string;
  alertType: string;
  severity: AlertSeverity;
  title: string;
  message: string;
  walletId?: string | null;
  sessionId?: string | null;
  payloadJson?: Record<string, unknown> | null;
};

export async function raiseSystemAlert(input: RaiseAlertInput) {
  const now = new Date();
  return db.systemAlert.upsert({
    where: { dedupeKey: input.dedupeKey },
    update: {
      alertType: input.alertType,
      severity: input.severity,
      title: input.title,
      message: input.message,
      walletId: input.walletId ?? null,
      sessionId: input.sessionId ?? null,
      ...(input.payloadJson !== undefined
        ? {
            payloadJson:
              input.payloadJson === null
                ? Prisma.JsonNull
                : (input.payloadJson as Prisma.InputJsonValue),
          }
        : {}),
      status: 'OPEN',
      lastSeenAt: now,
      resolvedAt: null,
      count: { increment: 1 },
    },
    create: {
      dedupeKey: input.dedupeKey,
      alertType: input.alertType,
      severity: input.severity,
      title: input.title,
      message: input.message,
      walletId: input.walletId ?? null,
      sessionId: input.sessionId ?? null,
      ...(input.payloadJson !== undefined
        ? {
            payloadJson:
              input.payloadJson === null
                ? Prisma.JsonNull
                : (input.payloadJson as Prisma.InputJsonValue),
          }
        : {}),
      status: 'OPEN',
      firstSeenAt: now,
      lastSeenAt: now,
      count: 1,
    },
  });
}

export async function listSystemAlerts(input: {
  status?: 'OPEN' | 'RESOLVED' | 'ALL';
  limit?: number;
  walletId?: string;
  sessionId?: string;
}) {
  const where: Record<string, unknown> = {};
  if (input.status && input.status !== 'ALL') {
    where.status = input.status;
  }
  if (input.walletId) {
    where.walletId = input.walletId;
  }
  if (input.sessionId) {
    where.sessionId = input.sessionId;
  }

  const rows: Array<Record<string, any>> = await db.systemAlert.findMany({
    where,
    include: {
      wallet: { select: { id: true, label: true, address: true } },
      session: {
        select: {
          id: true,
          status: true,
          trackedWalletAddress: true,
        },
      },
    },
    orderBy: [{ lastSeenAt: 'desc' }, { createdAt: 'desc' }],
    take: Math.max(1, Math.min(200, input.limit ?? 50)),
  });

  return rows.map((row: Record<string, any>) => ({
    id: row.id,
    dedupeKey: row.dedupeKey,
    alertType: row.alertType,
    severity: row.severity,
    status: row.status,
    title: row.title,
    message: row.message,
    wallet: row.wallet
      ? {
          id: row.wallet.id,
          label: row.wallet.label,
          address: row.wallet.address,
        }
      : null,
    session: row.session
      ? {
          id: row.session.id,
          status: row.session.status,
          trackedWalletAddress: row.session.trackedWalletAddress,
        }
      : null,
    payload: row.payloadJson,
    count: row.count,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    resolvedAt: row.resolvedAt,
    createdAt: row.createdAt,
  }));
}
