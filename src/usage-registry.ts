import type { RunUsageSnapshot } from "./types.js";
import type { Logger } from "./helpers.js";

type LlmOutputEvent = {
  runId: string;
  provider: string;
  model: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
};

type SubagentEndedEvent = {
  runId?: string;
  outcome?: "ok" | "error" | "timeout" | "killed" | "reset" | "deleted";
  error?: string;
};

type MutableRunEntry = RunUsageSnapshot & {
  collabId: string;
  startedAt: number;
};

export class UsageRegistry {
  private readonly byRunId = new Map<string, MutableRunEntry>();

  constructor(private readonly logger: Logger) {}

  trackRun(params: {
    collabId: string;
    runId: string;
    sessionKey: string;
    agentId: string;
    startedAt: number;
  }): void {
    this.byRunId.set(params.runId, {
      collabId: params.collabId,
      runId: params.runId,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      startedAt: params.startedAt,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    });
  }

  recordLlmOutput(event: LlmOutputEvent): void {
    const entry = this.byRunId.get(event.runId);
    if (!entry) {
      return;
    }

    entry.provider = event.provider;
    entry.model = event.model;
    entry.input = event.usage?.input ?? entry.input;
    entry.output = event.usage?.output ?? entry.output;
    entry.cacheRead = event.usage?.cacheRead ?? entry.cacheRead;
    entry.cacheWrite = event.usage?.cacheWrite ?? entry.cacheWrite;
    entry.total = event.usage?.total ?? entry.total ?? entry.input + entry.output;
  }

  recordSubagentEnded(event: SubagentEndedEvent): void {
    if (!event.runId) {
      return;
    }

    const entry = this.byRunId.get(event.runId);
    if (!entry) {
      return;
    }

    if (event.outcome) {
      entry.outcome = event.outcome;
    }
    if (event.error?.trim()) {
      entry.error = event.error.trim();
    }
  }

  snapshot(runId: string): RunUsageSnapshot | undefined {
    const entry = this.byRunId.get(runId);
    if (!entry) {
      return undefined;
    }

    return {
      runId: entry.runId,
      sessionKey: entry.sessionKey,
      agentId: entry.agentId,
      input: entry.input,
      output: entry.output,
      cacheRead: entry.cacheRead,
      cacheWrite: entry.cacheWrite,
      total: entry.total || entry.input + entry.output,
      ...(entry.provider ? { provider: entry.provider } : {}),
      ...(entry.model ? { model: entry.model } : {}),
      ...(entry.outcome ? { outcome: entry.outcome } : {}),
      ...(entry.error ? { error: entry.error } : {}),
    };
  }

  clear(runId: string): void {
    this.byRunId.delete(runId);
  }

  pruneOlderThan(maxAgeMs: number): void {
    const cutoff = Date.now() - maxAgeMs;
    for (const [runId, entry] of this.byRunId) {
      if (entry.startedAt < cutoff) {
        this.logger.debug?.("Pruning stale run usage entry", {
          runId,
          collabId: entry.collabId,
        });
        this.byRunId.delete(runId);
      }
    }
  }
}
