import type { TurnRecord } from "./types.js";

export class BudgetTracker {
  private readonly records: TurnRecord[] = [];

  constructor(private readonly maxTotalTokens?: number) {}

  recordTurn(record: TurnRecord): void {
    this.records.push(record);
  }

  turns(): readonly TurnRecord[] {
    return this.records;
  }

  totalInputTokens(): number {
    return this.records.reduce((sum, record) => sum + record.inputTokens, 0);
  }

  totalOutputTokens(): number {
    return this.records.reduce((sum, record) => sum + record.outputTokens, 0);
  }

  totalUsed(): number {
    return this.records.reduce((sum, record) => sum + record.totalTokens, 0);
  }

  remaining(): number {
    if (this.maxTotalTokens === undefined) {
      return 0;
    }
    return Math.max(0, this.maxTotalTokens - this.totalUsed());
  }

  summary(): string {
    if (this.maxTotalTokens === undefined) {
      return `${this.records.length} turns, ${this.totalUsed().toLocaleString()} tokens used`;
    }
    return `${this.records.length} turns, ${this.totalUsed().toLocaleString()} / ${this.maxTotalTokens.toLocaleString()} tokens used`;
  }
}
