import type { AIUsageLog } from './schemas';

export interface AIUsageSnapshot {
  callsByTask: Record<string, number>;
  callsByModel: Record<string, number>;
  inputTokensByTask: Record<string, number>;
  outputTokensByTask: Record<string, number>;
  inputTokensByModel: Record<string, number>;
  outputTokensByModel: Record<string, number>;
  estimatedCostByTask: Record<string, number>;
  estimatedCostByModel: Record<string, number>;
  failures: number;
  schemaFailures: number;
  retries: number;
  escalations: number;
  latencies: { count: number; totalMs: number; maxMs: number };
  ocrFailures: number;
  plannerRepairs: number;
}

function increment(bucket: Record<string, number>, key: string, amount = 1): void {
  bucket[key] = (bucket[key] || 0) + amount;
}

/** Isolate-local aggregate; callers may forward snapshots to existing logs/analytics. */
export class AIUsageLedger {
  private readonly snapshotValue: AIUsageSnapshot = {
    callsByTask: {}, callsByModel: {}, inputTokensByTask: {}, outputTokensByTask: {},
    inputTokensByModel: {}, outputTokensByModel: {},
    estimatedCostByTask: {}, estimatedCostByModel: {}, failures: 0, schemaFailures: 0,
    retries: 0, escalations: 0, latencies: { count: 0, totalMs: 0, maxMs: 0 },
    ocrFailures: 0, plannerRepairs: 0,
  };

  record(log: AIUsageLog): void {
    increment(this.snapshotValue.callsByTask, log.task);
    increment(this.snapshotValue.callsByModel, log.physicalModel || log.model);
    increment(this.snapshotValue.inputTokensByTask, log.task, log.inputTokens);
    increment(this.snapshotValue.outputTokensByTask, log.task, log.outputTokens);
    increment(this.snapshotValue.inputTokensByModel, log.physicalModel || log.model, log.inputTokens);
    increment(this.snapshotValue.outputTokensByModel, log.physicalModel || log.model, log.outputTokens);
    increment(this.snapshotValue.estimatedCostByTask, log.task, log.estimatedCostUsd ?? log.estimatedCost);
    increment(this.snapshotValue.estimatedCostByModel, log.physicalModel || log.model, log.estimatedCostUsd ?? log.estimatedCost);
    if (log.status === 'error') this.snapshotValue.failures += 1;
    if (log.failureCode === 'SCHEMA_VALIDATION' || log.failureCode === 'INVALID_RESPONSE') this.snapshotValue.schemaFailures += 1;
    if ((log.attempt ?? 1) > 1) this.snapshotValue.retries += 1;
    if (log.escalationReason === 'controlled_escalation') this.snapshotValue.escalations += 1;
    if (log.task === 'receipt_scan' || log.task === 'receipt_ocr' || log.task === 'label_ocr') {
      if (log.status === 'error') this.snapshotValue.ocrFailures += 1;
    }
    if (log.task === 'weekly_plan_repair'
      || (log.task === 'weekly_plan' && log.escalationReason === 'bounded_repair')) {
      this.snapshotValue.plannerRepairs += 1;
    }
    this.snapshotValue.latencies.count += 1;
    this.snapshotValue.latencies.totalMs += Math.max(0, log.latencyMs);
    this.snapshotValue.latencies.maxMs = Math.max(this.snapshotValue.latencies.maxMs, log.latencyMs);
  }

  snapshot(): AIUsageSnapshot {
    return JSON.parse(JSON.stringify(this.snapshotValue)) as AIUsageSnapshot;
  }
}
