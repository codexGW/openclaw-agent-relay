export interface CollabPluginConfig {
  maxTurns: number;
  turnTimeoutSeconds: number;
  turnDelayMs: number;
  discordAccountId?: string;
  relay?: RelayConfig;
  threadAutoArchiveMinutes: 60 | 1440 | 4320 | 10080;
  webhookNamePrefix: string;
}

export interface CollabRequest {
  agents: [string, string];
  prompt: string;
  channelId: string;
  title?: string;
  maxTurns: number;
  turnTimeoutSeconds: number;
  turnDelayMs: number;
}

export type CollabPhase =
  | "starting"
  | "running_turn"
  | "posting"
  | "waiting_human"
  | "finalizing";

export type CollabTerminalState =
  | "complete"
  | "failed"
  | "timeout"
  | "cancelled";

export interface TurnRecord {
  turn: number;
  agentId: string;
  sessionKey: string;
  runId: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  text: string;
  startedAt: number;
  completedAt: number;
  usageSource?: UsageSource;
  usageIncomplete?: boolean;
}

export interface CollabSummary {
  collabId: string;
  requesterAgentId: string;
  threadId?: string;
  webhookId?: string;
  terminalState: CollabTerminalState;
  phase: CollabPhase;
  turnsCompleted: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  startedAt: number;
  finishedAt: number;
  lastError?: string;
}

export interface RunUsageSnapshot {
  runId: string;
  sessionKey: string;
  agentId: string;
  provider?: string;
  model?: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  outcome?: "ok" | "error" | "timeout" | "killed" | "reset" | "deleted";
  error?: string;
}

export interface CollabRunOutcome {
  summaryText: string;
  details: CollabSummary;
}

// --- Relay Protocol Types (Phase 1) ---

/** How token usage was obtained */
export type UsageSource = "exact" | "reported" | "estimated" | "unknown";

/** Which runner executed a turn */
export type TurnRunnerKind = "native" | "acp" | "relay";

/** Configuration for a remote gateway reachable via relay */
export interface RelayGatewayConfig {
  /** Unique gateway identifier */
  gatewayId: string;
  /** Local port the target gateway listens on */
  port: number;
  /** Gateway auth token for the target */
  token: string;
  /** Agent IDs hosted on this gateway */
  agents: string[];
}

/** Top-level relay configuration */
export interface RelayConfig {
  /** This gateway's identifier */
  localGatewayId: string;
  /** Remote gateways */
  gateways: RelayGatewayConfig[];
}

// --- Relay Envelope Types ---

export interface RelayTurnRequestEnvelope {
  kind: "collab.turn.request";
  protocolVersion: 1;
  requestId: string;
  collabId: string;
  originGatewayId: string;
  targetGatewayId: string;
  agentId: string;
  idempotencyKey: string;
  timeoutSeconds: number;
  message: string;
  extraSystemPrompt: string;
}

export interface RelayTurnResultEnvelope {
  kind: "collab.turn.result";
  protocolVersion: 1;
  requestId: string;
  collabId: string;
  status: "ok" | "error" | "timeout";
  responseText?: string;
  error?: string;
  usage?: {
    input: number;
    output: number;
    total: number;
    source: UsageSource;
  };
}

export interface RelayTurnCancelEnvelope {
  kind: "collab.turn.cancel";
  protocolVersion: 1;
  requestId: string;
  collabId: string;
  reason: "human_stop" | "orchestrator_abort" | "timeout";
}

export type RelayEnvelope =
  | RelayTurnRequestEnvelope
  | RelayTurnResultEnvelope
  | RelayTurnCancelEnvelope;
