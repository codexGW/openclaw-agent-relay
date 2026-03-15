import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { BudgetTracker } from "./budget.js";
import { resolveGatewayForAgent } from "./config.js";
import {
  buildTurnSessionKey,
  createTurnRunner,
  resolveAcpAgent,
  resolveAgentRuntime,
  TurnRunnerError,
} from "./turn-runner.js";
import {
  buildThreadName,
  createCollabThread,
  createFreshWebhook,
  deleteWebhook,
  listThreadMessagesAfter,
  postStatusMessage,
  postWebhookMessage,
  preflightDiscord,
  readHumanInterjections,
  resolveDiscordBot,
} from "./discord.js";
import { findAgentConfig, toErrorMessage, type Logger } from "./helpers.js";
import type {
  CollabPhase,
  CollabPluginConfig,
  CollabRequest,
  CollabRunOutcome,
  CollabSummary,
  CollabTerminalState,
  TurnRecord,
  TurnRunnerKind,
  UsageSource,
} from "./types.js";
import type { UsageRegistry } from "./usage-registry.js";

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("Collaboration aborted.");
  }
}

function buildIdempotencyKey(
  toolCallId: string,
  collabId: string,
  turn: number,
  agentId: string,
): string {
  return `${toolCallId}:${collabId}:turn:${turn}:agent:${agentId}`;
}

function buildExtraSystemPrompt(params: {
  collabId: string;
  turn: number;
  maxTurns: number;
}): string {
  return [
    "You are participating in a supervised collaboration.",
    `Collaboration ID: ${params.collabId}`,
    `Turn: ${params.turn + 1} of ${params.maxTurns}`,
    "Return only your substantive response. Do not mention internal runtime details, webhooks, or session keys.",
  ].join("\n");
}

function buildTurnInput(params: {
  turn: number;
  originalPrompt: string;
  previousAgentId: string;
  previousAgentTurn: number;
  previousResponseText: string;
  humanInterjections: string[];
}): string {
  if (params.turn === 0) {
    return params.originalPrompt;
  }

  const framedPrompt = [
    params.originalPrompt,
    "",
    `The following is ${params.previousAgentId}'s response from turn ${params.previousAgentTurn + 1}. Evaluate it on its merits and continue.`,
    "---",
    params.previousResponseText,
    "---",
  ];

  if (params.humanInterjections.length === 0) {
    return framedPrompt.join("\n");
  }

  return [
    ...framedPrompt,
    "",
    "Human interjections were added after that response. Address them directly where relevant.",
    "[Human interjection]",
    ...params.humanInterjections,
  ].join("\n");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(done, ms);

    function cleanup(): void {
      signal?.removeEventListener("abort", onAbort);
    }

    function done(): void {
      cleanup();
      resolve();
    }

    function onAbort(): void {
      clearTimeout(timeout);
      cleanup();
      reject(new Error("Collaboration aborted."));
    }

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function assertAgentPreflight(
  api: OpenClawPluginApi,
  requesterAgentId: string,
  targetAgents: [string, string],
): void {
  const [left, right] = targetAgents;
  if (left === right) {
    throw new Error("The collaboration tool requires two distinct target agents.");
  }

  const requester = findAgentConfig(api, requesterAgentId);
  if (!requester) {
    throw new Error(`Requesting agent "${requesterAgentId}" is not defined in agents.list.`);
  }

  const missing = targetAgents.filter((agentId) => !findAgentConfig(api, agentId));
  if (missing.length > 0) {
    throw new Error(`Unknown target agent(s): ${missing.join(", ")}.`);
  }

  // Agents routed through relay don't need native/ACP permission checks
  const pluginConfig = api.pluginConfig as CollabPluginConfig | undefined;
  const relayConfig = pluginConfig?.relay;
  const nativeTargets = targetAgents.filter((agentId) => resolveAgentRuntime(api, agentId) === "native" && !resolveGatewayForAgent(relayConfig, agentId));
  const acpTargets = targetAgents.filter((agentId) => resolveAgentRuntime(api, agentId) === "acp" && !resolveGatewayForAgent(relayConfig, agentId));

  const allowedNativeAgents = requester.subagents?.allowAgents ?? [];
  const missingNativePermissions = nativeTargets.filter(
    (agentId) =>
      !allowedNativeAgents.includes("*") && !allowedNativeAgents.includes(agentId),
  );

  if (missingNativePermissions.length > 0) {
    throw new Error(
      `Agent "${requesterAgentId}" cannot spawn native collaborator(s) ${missingNativePermissions.join(", ")}. Add them to subagents.allowAgents.`,
    );
  }

  const allowedAcpAgents = api.config.acp?.allowedAgents ?? [];
  const missingAcpPermissions = acpTargets.filter((agentId) => {
    const acpAgent = resolveAcpAgent(api, agentId);
    return (
      !allowedAcpAgents.includes("*") &&
      !allowedAcpAgents.includes(agentId) &&
      !allowedAcpAgents.includes(acpAgent)
    );
  });

  if (missingAcpPermissions.length > 0) {
    throw new Error(
      `ACP collaborator(s) ${missingAcpPermissions.join(", ")} are not allowed. Add them to acp.allowedAgents.`,
    );
  }
}

function buildStartBody(request: CollabRequest, collabId: string): string {
  return [
    `- Collaboration ID: ${collabId}`,
    `- Agents: ${request.agents[0]} ↔ ${request.agents[1]}`,
    `- Max turns: ${request.maxTurns}`,
    `- Turn timeout: ${request.turnTimeoutSeconds}s`,
    "",
    "Type in this thread to interject before the next turn.",
  ].join("\n");
}

function buildTurnPost(record: TurnRecord): string {
  const header = `**${record.agentId}** — turn ${record.turn + 1} (${record.totalTokens.toLocaleString()} tokens)`;
  return `${header}\n\n${record.text}`;
}

function buildFinalStatusTitle(state: CollabTerminalState): string {
  switch (state) {
    case "complete":
      return "Collaboration Complete";
    case "timeout":
      return "Collaboration Timed Out";
    case "cancelled":
      return "Collaboration Cancelled";
    case "failed":
    default:
      return "Collaboration Failed";
  }
}

function buildFinalStatusBody(details: CollabSummary, budget: BudgetTracker): string {
  const hasEstimatedUsage = budget.turns().some((t) => t.usageIncomplete);
  const usageNote = hasEstimatedUsage ? " ⚠️ some turns have estimated usage" : "";
  const lines = [
    `- Collaboration ID: ${details.collabId}`,
    `- Requesting agent: ${details.requesterAgentId}`,
    `- Terminal state: ${details.terminalState}`,
    `- Turns completed: ${details.turnsCompleted}`,
    `- Input tokens: ${details.totalInputTokens.toLocaleString()}`,
    `- Output tokens: ${details.totalOutputTokens.toLocaleString()}`,
    `- Total tokens: ${details.totalTokens.toLocaleString()}${usageNote}`,
  ];

  if (details.lastError) {
    lines.push(`- Reason: ${details.lastError}`);
  }

  if (budget.turns().length > 0) {
    lines.push("", "**Per-turn usage**");
    for (const turn of budget.turns()) {
      lines.push(
        `- Turn ${turn.turn + 1} (${turn.agentId}): ${turn.inputTokens.toLocaleString()} in / ${turn.outputTokens.toLocaleString()} out`,
      );
    }
  }

  return lines.join("\n");
}

function buildToolSummaryText(details: CollabSummary, budget: BudgetTracker): string {
  const prefixByState: Record<CollabTerminalState, string> = {
    complete: "Collaboration complete.",
    failed: "Collaboration failed.",
    timeout: "Collaboration timed out.",
    cancelled: "Collaboration cancelled.",
  };

  const threadPart = details.threadId ? ` Thread ${details.threadId}.` : "";
  const reasonPart = details.lastError ? ` Reason: ${details.lastError}` : "";
  const hasEstimatedUsage = budget.turns().some((t) => t.usageIncomplete);
  const usageNote = hasEstimatedUsage ? " ⚠️ some turns have estimated usage" : "";

  return `${prefixByState[details.terminalState]}${threadPart} ${details.turnsCompleted} turns completed${usageNote}.${reasonPart}`;
}

function buildSummary(params: {
  collabId: string;
  requesterAgentId: string;
  threadId?: string;
  webhookId?: string;
  terminalState: CollabTerminalState;
  phase: CollabPhase;
  budget: BudgetTracker;
  startedAt: number;
  finishedAt: number;
  lastError?: string;
}): CollabSummary {
  return {
    collabId: params.collabId,
    requesterAgentId: params.requesterAgentId,
    terminalState: params.terminalState,
    phase: params.phase,
    turnsCompleted: params.budget.turns().length,
    totalInputTokens: params.budget.totalInputTokens(),
    totalOutputTokens: params.budget.totalOutputTokens(),
    totalTokens: params.budget.totalUsed(),
    startedAt: params.startedAt,
    finishedAt: params.finishedAt,
    ...(params.threadId ? { threadId: params.threadId } : {}),
    ...(params.webhookId ? { webhookId: params.webhookId } : {}),
    ...(params.lastError ? { lastError: params.lastError } : {}),
  };
}

export async function runCollaboration(params: {
  collabId: string;
  api: OpenClawPluginApi;
  pluginConfig: CollabPluginConfig;
  usageRegistry: UsageRegistry;
  requesterAgentId: string;
  toolCallId: string;
  request: CollabRequest;
  signal?: AbortSignal;
}): Promise<CollabRunOutcome> {
  const startedAt = Date.now();
  const budget = new BudgetTracker();

  let phase: CollabPhase = "starting";
  let terminalState: CollabTerminalState = "failed";
  let lastError: string | undefined;
  let threadId: string | undefined;
  let webhookId: string | undefined;
  let botToken: string | undefined;
  let summary: CollabSummary | undefined;
  let cursorMessageId: string | undefined;
  let webhook:
    | {
        id: string;
        token: string;
      }
    | undefined;

  const logger: Logger = params.api.runtime.logging.getChildLogger({
    pluginId: params.api.id,
    collabId: params.collabId,
    toolCallId: params.toolCallId,
    requesterAgentId: params.requesterAgentId,
    channelId: params.request.channelId,
  });

  try {
    assertNotAborted(params.signal);
    assertAgentPreflight(params.api, params.requesterAgentId, params.request.agents);

    const bot = await resolveDiscordBot(params.api, params.pluginConfig.discordAccountId);
    botToken = bot.token;

    await preflightDiscord(params.api, {
      token: bot.token,
      accountId: bot.accountId,
      channelId: params.request.channelId,
      logger,
      ...(params.signal ? { signal: params.signal } : {}),
    });

    webhook = await createFreshWebhook(
      bot.token,
      params.request.channelId,
      `${params.pluginConfig.webhookNamePrefix} ${params.collabId.slice(-8)}`,
      params.signal,
    );
    webhookId = webhook.id;

    const thread = await createCollabThread(
      bot.token,
      params.request.channelId,
      buildThreadName(params.request.title),
      params.pluginConfig.threadAutoArchiveMinutes,
      params.signal,
    );
    threadId = thread.id;

    const startedPost = await postStatusMessage(webhook, {
      threadId,
      title: "Collaboration Started",
      body: buildStartBody(params.request, params.collabId),
      ...(params.signal ? { signal: params.signal } : {}),
    });
    cursorMessageId = startedPost.messageId;

    let currentAgentIndex = 0;
    let currentInput = buildTurnInput({
      turn: 0,
      originalPrompt: params.request.prompt,
      previousAgentId: "",
      previousAgentTurn: 0,
      previousResponseText: "",
      humanInterjections: [],
    });

    terminalState = "complete";

    for (let turn = 0; turn < params.request.maxTurns; turn += 1) {
      assertNotAborted(params.signal);

      const agentId = currentAgentIndex === 0 ? params.request.agents[0] : params.request.agents[1];
      const sessionKey = buildTurnSessionKey(params.api, agentId);
      const idempotencyKey = buildIdempotencyKey(
        params.toolCallId,
        params.collabId,
        turn,
        agentId,
      );
      const turnStartedAt = Date.now();
      let runId: string | undefined;
      const runner = createTurnRunner(params.api, agentId, logger, ({ runId: createdRunId, sessionKey: createdSessionKey }) => {
        params.usageRegistry.trackRun({
          collabId: params.collabId,
          runId: createdRunId,
          sessionKey: createdSessionKey,
          agentId,
          startedAt: turnStartedAt,
        });
      }, params.pluginConfig.relay);
      const runnerKind: TurnRunnerKind = params.pluginConfig.relay && resolveGatewayForAgent(params.pluginConfig.relay, agentId)
        ? "relay"
        : resolveAgentRuntime(params.api, agentId) === "acp"
          ? "acp"
          : "native";

      phase = "running_turn";
      logger.info("Starting turn", {
        turn: turn + 1,
        agentId,
        runnerKind,
        sessionKey,
      });

      try {
        const { runId: resolvedRunId, responseText, usage: spawnUsage } = await runner.spawn({
          sessionKey,
          message: currentInput,
          extraSystemPrompt: buildExtraSystemPrompt({
            collabId: params.collabId,
            turn,
            maxTurns: params.request.maxTurns,
          }),
          idempotencyKey,
          timeoutSeconds: params.request.turnTimeoutSeconds,
        });
        runId = resolvedRunId;

        if (!responseText) {
          terminalState = "failed";
          lastError = `Agent ${agentId} produced no assistant text for turn ${turn + 1}.`;
          logger.error("Subagent turn produced no extractable assistant text", {
            turn: turn + 1,
            agentId,
            runId,
            sessionKey,
          });
          break;
        }

        const registryUsage = params.usageRegistry.snapshot(runId);
        let usageSource: UsageSource = "unknown";
        let input = 0;
        let output = 0;
        let total = 0;

        if (registryUsage && registryUsage.total > 0) {
          input = registryUsage.input;
          output = registryUsage.output;
          total = registryUsage.total || input + output;
          usageSource = "exact";
        } else if (spawnUsage) {
          input = spawnUsage.input;
          output = spawnUsage.output;
          total = spawnUsage.total || input + output;
          usageSource = spawnUsage.source;
        } else {
          const estimatedOutput = Math.max(100, Math.ceil(responseText.length / 4));
          input = 0;
          output = estimatedOutput;
          total = estimatedOutput;
          usageSource = "estimated";
        }

        const turnRecord: TurnRecord = {
          turn,
          agentId,
          sessionKey,
          runId,
          inputTokens: input,
          outputTokens: output,
          totalTokens: total,
          text: responseText,
          startedAt: turnStartedAt,
          completedAt: Date.now(),
          usageSource,
          usageIncomplete: usageSource !== "exact",
        };
        budget.recordTurn(turnRecord);

        phase = "posting";
        const previousCursorMessageId = cursorMessageId;

        const postResult = await postWebhookMessage(webhook, {
          threadId,
          username: agentId,
          content: buildTurnPost(turnRecord),
          ...(params.signal ? { signal: params.signal } : {}),
        });

        if (turn < params.request.maxTurns - 1 && params.request.turnDelayMs > 0) {
          phase = "waiting_human";
          await sleep(params.request.turnDelayMs, params.signal);
        }

        const threadMessages = await listThreadMessagesAfter(
          bot.token,
          threadId,
          previousCursorMessageId,
          params.signal,
        );
        const humanInterjections = readHumanInterjections(threadMessages);
        const requestedStop = humanInterjections.some((message) => message.toLowerCase().includes("/stop"));

        cursorMessageId =
          threadMessages[threadMessages.length - 1]?.id ??
          postResult.messageId ??
          previousCursorMessageId;

        if (requestedStop) {
          terminalState = "cancelled";
          lastError = "Human stop command received.";
          logger.info("Stopping collaboration because a human requested /stop", {
            turn: turn + 1,
            agentId,
            threadId,
          });

          if (runner.cancel && runId) {
            await runner.cancel({
              requestId: runId,
              collabId: params.collabId,
              reason: "human_stop",
            }).catch(() => {});
          }

          break;
        }

        currentInput = buildTurnInput({
          turn: turn + 1,
          originalPrompt: params.request.prompt,
          previousAgentId: agentId,
          previousAgentTurn: turn,
          previousResponseText: responseText,
          humanInterjections,
        });

        currentAgentIndex = 1 - currentAgentIndex;
      } catch (error) {
        if (error instanceof TurnRunnerError) {
          if (error.status === "timeout") {
            terminalState = "timeout";
            lastError = `Turn ${turn + 1} timed out after ${params.request.turnTimeoutSeconds}s for agent ${agentId}.`;
            logger.warn("Agent turn timed out", {
              turn: turn + 1,
              agentId,
              runId,
            });
            break;
          }

          terminalState = "failed";
          lastError = error.message.trim() || `Turn ${turn + 1} failed for agent ${agentId}.`;
          logger.error("Agent turn failed", {
            turn: turn + 1,
            agentId,
            runId,
            error: error.message,
          });
          break;
        }

        throw error;
      } finally {
        try {
          await runner.cleanup(sessionKey);
        } catch (error) {
          logger.warn("Failed to clean up turn session", {
            sessionKey,
            runId,
            error: toErrorMessage(error),
          });
        }

        if (runId) {
          params.usageRegistry.clear(runId);
        }
      }
    }
  } catch (error) {
    terminalState = params.signal?.aborted ? "cancelled" : "failed";
    lastError = toErrorMessage(error);
    logger.error("Collaboration orchestration failed", {
      error: lastError,
      phase,
      threadId,
      webhookId,
    });
  } finally {
    phase = "finalizing";
    summary = buildSummary({
      collabId: params.collabId,
      requesterAgentId: params.requesterAgentId,
      ...(threadId ? { threadId } : {}),
      ...(webhookId ? { webhookId } : {}),
      terminalState,
      phase,
      budget,
      startedAt,
      finishedAt: Date.now(),
      ...(lastError ? { lastError } : {}),
    });

    if (threadId && webhook) {
      try {
        await postStatusMessage(webhook, {
          threadId,
          title: buildFinalStatusTitle(summary.terminalState),
          body: buildFinalStatusBody(summary, budget),
          ...(params.signal ? { signal: params.signal } : {}),
        });
      } catch (error) {
        logger.warn("Failed to post final status message", {
          threadId,
          webhookId,
          error: toErrorMessage(error),
        });
      }
    }

    if (botToken && webhookId) {
      try {
        await deleteWebhook(botToken, webhookId, params.signal);
      } catch (error) {
        logger.warn("Failed to delete collaboration webhook", {
          webhookId,
          error: toErrorMessage(error),
        });
      }
    }
  }

  const details =
    summary ??
    buildSummary({
      collabId: params.collabId,
      requesterAgentId: params.requesterAgentId,
      ...(threadId ? { threadId } : {}),
      ...(webhookId ? { webhookId } : {}),
      terminalState,
      phase,
      budget,
      startedAt,
      finishedAt: Date.now(),
      ...(lastError ? { lastError } : {}),
    });

  return {
    summaryText: buildToolSummaryText(details, budget),
    details,
  };
}
