import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { resolveGatewayForAgent } from "./config.js";
import { findAgentConfig, isRecord, type Logger } from "./helpers.js";
import { encodeRelayEnvelope, tryDecodeRelayEnvelope } from "./relay-envelope.js";
import type {
  RelayConfig,
  RelayGatewayConfig,
  RelayTurnCancelEnvelope,
  RelayTurnRequestEnvelope,
  UsageSource,
} from "./types.js";

const ACPX_COMMAND = "acpx";

export interface TurnRunResult {
  runId: string;
  sessionKey: string;
}

export interface TurnWaitResult {
  status: "ok" | "error" | "timeout";
  error?: string;
}

export interface TurnMessagesResult {
  messages: unknown[];
}

export interface TurnSpawnResult {
  runId: string;
  responseText: string;
  usage?: {
    input: number;
    output: number;
    total: number;
    source: UsageSource;
  };
}

export interface TurnRunner {
  spawn(params: {
    sessionKey: string;
    message: string;
    extraSystemPrompt: string;
    idempotencyKey: string;
    timeoutSeconds: number;
  }): Promise<TurnSpawnResult>;

  cleanup(sessionKey: string): Promise<void>;

  /** Best-effort cancellation. Implementations may no-op. */
  cancel?(params: {
    requestId: string;
    collabId: string;
    reason: "human_stop" | "orchestrator_abort" | "timeout";
  }): Promise<void>;
}

function extractTextParts(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => extractTextParts(item));
  }

  if (!isRecord(value)) {
    return [];
  }

  const text = value.text;
  if (typeof text === "string") {
    return [text];
  }

  if ("content" in value) {
    return extractTextParts(value.content);
  }

  return [];
}

export function extractLatestAssistantText(messages: unknown[]): string {
  for (const message of [...messages].reverse()) {
    if (!isRecord(message) || message.role !== "assistant") {
      continue;
    }

    const text = extractTextParts(message.content)
      .map((part) => part.trim())
      .filter(Boolean)
      .join("\n");

    if (text) {
      return text;
    }
  }

  return "";
}

export function resolveAgentRuntime(api: OpenClawPluginApi, agentId: string): "native" | "acp" {
  const agent = findAgentConfig(api, agentId);
  return agent?.runtime?.type === "acp" ? "acp" : "native";
}

export function resolveAcpAgent(api: OpenClawPluginApi, agentId: string): string {
  const agent = findAgentConfig(api, agentId);
  return agent?.runtime?.type === "acp"
    ? agent.runtime.acp?.agent ?? agentId
    : agentId;
}

function resolveAcpCwd(api: OpenClawPluginApi, agentId: string): string | undefined {
  const agent = findAgentConfig(api, agentId);
  return agent?.runtime?.type === "acp" ? agent.runtime.acp?.cwd : undefined;
}

export function buildTurnSessionKey(api: OpenClawPluginApi, agentId: string): string {
  const sessionType = resolveAgentRuntime(api, agentId) === "acp" ? "acp" : "subagent";
  return `agent:${agentId}:${sessionType}:${randomUUID()}`;
}

export class TurnRunnerError extends Error {
  constructor(
    readonly status: "error" | "timeout",
    message: string,
  ) {
    super(message);
    this.name = "TurnRunnerError";
  }
}

export class NativeTurnRunner implements TurnRunner {
  constructor(
    private readonly api: OpenClawPluginApi,
    private readonly agentId: string,
    private readonly logger: Logger,
    private readonly onRunCreated?: (params: { runId: string; sessionKey: string }) => void,
  ) {}

  async spawn(params: {
    sessionKey: string;
    message: string;
    extraSystemPrompt: string;
    idempotencyKey: string;
    timeoutSeconds: number;
  }): Promise<TurnSpawnResult> {
    const run = await this.api.runtime.subagent.run({
      sessionKey: params.sessionKey,
      message: params.message,
      extraSystemPrompt: params.extraSystemPrompt,
      deliver: false,
      idempotencyKey: params.idempotencyKey,
    });

    const runId = run.runId;
    this.onRunCreated?.({
      runId,
      sessionKey: params.sessionKey,
    });

    this.logger.info("Spawned collaboration subagent turn", {
      agentId: this.agentId,
      runId,
      sessionKey: params.sessionKey,
      idempotencyKey: params.idempotencyKey,
    });

    const waitResult = await this.api.runtime.subagent.waitForRun({
      runId,
      timeoutMs: params.timeoutSeconds * 1000,
    });

    if (waitResult.status === "timeout") {
      throw new TurnRunnerError(
        "timeout",
        `Turn timed out after ${params.timeoutSeconds}s for agent ${this.agentId}.`,
      );
    }

    if (waitResult.status === "error") {
      throw new TurnRunnerError(
        "error",
        waitResult.error?.trim() || `Turn failed for agent ${this.agentId}.`,
      );
    }

    const sessionMessages = await this.api.runtime.subagent.getSessionMessages({
      sessionKey: params.sessionKey,
      limit: 200,
    });

    return {
      runId,
      responseText: extractLatestAssistantText(sessionMessages.messages),
    };
  }

  async cleanup(sessionKey: string): Promise<void> {
    await this.api.runtime.subagent.deleteSession({
      sessionKey,
      deleteTranscript: true,
    });
  }
}

export class AcpTurnRunner implements TurnRunner {
  private readonly acpxPath = ACPX_COMMAND;

  constructor(
    private readonly api: OpenClawPluginApi,
    private readonly agentId: string,
    private readonly acpAgent: string,
    private readonly logger: Logger,
    private readonly cwd?: string,
  ) {}

  async spawn(params: {
    sessionKey: string;
    message: string;
    extraSystemPrompt: string;
    idempotencyKey: string;
    timeoutSeconds: number;
  }): Promise<TurnSpawnResult> {
    const runId = `acp:${randomUUID()}`;
    const promptFile = `/tmp/collab-prompt-${runId}.txt`;
    const prompt = params.extraSystemPrompt.trim()
      ? `${params.extraSystemPrompt}\n\n${params.message}`
      : params.message;

    await writeFile(promptFile, prompt, "utf8");

    try {
      const result = await this.api.runtime.system.runCommandWithTimeout(
        [
          this.acpxPath,
          "--approve-all",
          "--timeout",
          String(params.timeoutSeconds),
          this.acpAgent,
          "exec",
          "-f",
          promptFile,
        ],
        {
          timeoutMs: (params.timeoutSeconds + 10) * 1000,
          ...(this.cwd ? { cwd: this.cwd } : {}),
        },
      );

      if (result.termination === "timeout") {
        throw new TurnRunnerError(
          "timeout",
          `Turn timed out after ${params.timeoutSeconds}s for agent ${this.agentId}.`,
        );
      }

      if (result.code !== 0) {
        const stderr = result.stderr.trim();
        this.logger.error("ACP agent turn failed", {
          agentId: this.agentId,
          acpAgent: this.acpAgent,
          runId,
          sessionKey: params.sessionKey,
          idempotencyKey: params.idempotencyKey,
          code: result.code,
          termination: result.termination,
          stderr: stderr || undefined,
        });
        throw new TurnRunnerError(
          "error",
          stderr || `ACP agent ${this.acpAgent} failed.`,
        );
      }

      this.logger.info("Spawned ACP collaboration turn", {
        agentId: this.agentId,
        acpAgent: this.acpAgent,
        runId,
        sessionKey: params.sessionKey,
        idempotencyKey: params.idempotencyKey,
      });

      return {
        runId,
        responseText: result.stdout.trim(),
      };
    } finally {
      await unlink(promptFile).catch(() => {});
    }
  }

  async cleanup(): Promise<void> {}
}

export class RelayTurnRunner implements TurnRunner {
  constructor(
    private readonly api: OpenClawPluginApi,
    private readonly agentId: string,
    private readonly targetGateway: RelayGatewayConfig,
    private readonly localGatewayId: string,
    private readonly logger: Logger,
  ) {}

  private buildRelayEnv(): NodeJS.ProcessEnv {
    return {
      OPENCLAW_GATEWAY_URL: `ws://127.0.0.1:${this.targetGateway.port}`,
      OPENCLAW_GATEWAY_TOKEN: this.targetGateway.token,
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
    };
  }

  private buildRelayCommand(message: string): string[] {
    return ["openclaw", "agent", "--agent", "main", "-m", message];
  }

  async spawn(params: {
    sessionKey: string;
    message: string;
    extraSystemPrompt: string;
    idempotencyKey: string;
    timeoutSeconds: number;
  }): Promise<TurnSpawnResult> {
    const requestId = randomUUID();

    const envelope: RelayTurnRequestEnvelope = {
      kind: "collab.turn.request",
      protocolVersion: 1,
      requestId,
      // collabId not available in spawn context
      collabId: "",
      originGatewayId: this.localGatewayId,
      targetGatewayId: this.targetGateway.gatewayId,
      agentId: this.agentId,
      idempotencyKey: params.idempotencyKey,
      timeoutSeconds: params.timeoutSeconds,
      message: params.message,
      extraSystemPrompt: params.extraSystemPrompt,
    };

    const encodedMessage = encodeRelayEnvelope(envelope);

    const result = await this.api.runtime.system.runCommandWithTimeout(
      this.buildRelayCommand(encodedMessage),
      {
        timeoutMs: (params.timeoutSeconds + 15) * 1000,
        env: this.buildRelayEnv(),
      },
    );

    if (result.termination === "timeout") {
      throw new TurnRunnerError(
        "timeout",
        `Relay turn timed out after ${params.timeoutSeconds}s for agent ${this.agentId} on gateway ${this.targetGateway.gatewayId}.`,
      );
    }

    if (result.code !== 0) {
      const stderr = result.stderr.trim();
      this.logger.error("Relay turn failed", {
        agentId: this.agentId,
        gatewayId: this.targetGateway.gatewayId,
        requestId,
        code: result.code,
        stderr: stderr || undefined,
      });
      throw new TurnRunnerError(
        "error",
        stderr || `Relay turn failed for agent ${this.agentId} on gateway ${this.targetGateway.gatewayId}.`,
      );
    }

    const resultEnvelope = tryDecodeRelayEnvelope(result.stdout);

    if (resultEnvelope?.kind === "collab.turn.result") {
      if (resultEnvelope.status === "error") {
        throw new TurnRunnerError(
          "error",
          resultEnvelope.error ?? `Remote agent ${this.agentId} returned an error.`,
        );
      }

      if (resultEnvelope.status === "timeout") {
        throw new TurnRunnerError(
          "timeout",
          resultEnvelope.error ?? `Remote agent ${this.agentId} timed out.`,
        );
      }

      this.logger.info("Relay turn completed (envelope)", {
        agentId: this.agentId,
        gatewayId: this.targetGateway.gatewayId,
        requestId,
        usageSource: resultEnvelope.usage?.source,
      });

      return {
        runId: requestId,
        responseText: resultEnvelope.responseText ?? "",
        ...(resultEnvelope.usage ? { usage: resultEnvelope.usage } : {}),
      };
    }

    const rawResponseText = result.stdout.trim();
    const estimatedTokens = Math.max(100, Math.ceil(rawResponseText.length / 4));

    this.logger.info("Relay turn completed (raw fallback)", {
      agentId: this.agentId,
      gatewayId: this.targetGateway.gatewayId,
      requestId,
    });
    return {
      runId: requestId,
      responseText: rawResponseText,
      usage: {
        input: 0,
        output: estimatedTokens,
        total: estimatedTokens,
        source: "estimated" as UsageSource,
      },
    };
  }

  async cleanup(): Promise<void> {
    // No local session to clean up for relay turns.
  }

  async cancel(params: {
    requestId: string;
    collabId: string;
    reason: "human_stop" | "orchestrator_abort" | "timeout";
  }): Promise<void> {
    const envelope: RelayTurnCancelEnvelope = {
      kind: "collab.turn.cancel",
      protocolVersion: 1,
      requestId: params.requestId,
      collabId: params.collabId,
      reason: params.reason,
    };

    const encodedMessage = encodeRelayEnvelope(envelope);

    try {
      await this.api.runtime.system.runCommandWithTimeout(
        this.buildRelayCommand(encodedMessage),
        {
          timeoutMs: 10_000,
          env: this.buildRelayEnv(),
        },
      );
      this.logger.info("Sent relay cancel envelope", {
        agentId: this.agentId,
        gatewayId: this.targetGateway.gatewayId,
        requestId: params.requestId,
        reason: params.reason,
      });
    } catch (error) {
      this.logger.warn("Failed to send relay cancel envelope", {
        agentId: this.agentId,
        gatewayId: this.targetGateway.gatewayId,
        requestId: params.requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export function createTurnRunner(
  api: OpenClawPluginApi,
  agentId: string,
  logger: Logger,
  onRunCreated?: (params: { runId: string; sessionKey: string }) => void,
  relayConfig?: RelayConfig,
): TurnRunner {
  if (relayConfig) {
    const gateway = resolveGatewayForAgent(relayConfig, agentId);
    if (gateway) {
      return new RelayTurnRunner(api, agentId, gateway, relayConfig.localGatewayId, logger);
    }
  }

  const runtimeType = resolveAgentRuntime(api, agentId);
  if (runtimeType === "acp") {
    return new AcpTurnRunner(
      api,
      agentId,
      resolveAcpAgent(api, agentId),
      logger,
      resolveAcpCwd(api, agentId),
    );
  }
  return new NativeTurnRunner(api, agentId, logger, onRunCreated);
}
