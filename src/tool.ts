import { randomUUID } from "node:crypto";
import { Type, type Static } from "@sinclair/typebox";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
  OpenClawPluginToolFactory,
} from "openclaw/plugin-sdk/lobster";
import { toErrorMessage } from "./helpers.js";
import { runCollaboration } from "./orchestrator.js";
import type { CollabPluginConfig, CollabRequest, CollabSummary } from "./types.js";
import type { UsageRegistry } from "./usage-registry.js";

const CollabToolParametersSchema = Type.Object(
  {
    agents: Type.Array(Type.String({ minLength: 1 }), {
      minItems: 2,
      maxItems: 2,
    }),
    prompt: Type.String({ minLength: 1 }),
    channelId: Type.String({ minLength: 1 }),
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    maxTurns: Type.Optional(Type.Integer({ minimum: 1, maximum: 64 })),
    turnTimeoutSeconds: Type.Optional(Type.Integer({ minimum: 5, maximum: 3600 })),
    turnDelayMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 60000 })),
  },
  {
    additionalProperties: false,
  },
);

type CollabToolParameters = Static<typeof CollabToolParametersSchema>;

function buildRequest(
  params: CollabToolParameters,
  pluginConfig: CollabPluginConfig,
): CollabRequest {
  return {
    agents: [params.agents[0]!.trim(), params.agents[1]!.trim()],
    prompt: params.prompt.trim(),
    channelId: params.channelId.trim(),
    ...(params.title?.trim() ? { title: params.title.trim() } : {}),
    maxTurns: params.maxTurns ?? pluginConfig.maxTurns,
    turnTimeoutSeconds: params.turnTimeoutSeconds ?? pluginConfig.turnTimeoutSeconds,
    turnDelayMs: params.turnDelayMs ?? pluginConfig.turnDelayMs,
  };
}

function buildFailureDetails(
  collabId: string,
  requesterAgentId: string,
  errorMessage: string,
): CollabSummary {
  const now = Date.now();
  return {
    collabId,
    requesterAgentId,
    terminalState: "failed",
    phase: "finalizing",
    turnsCompleted: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalTokens: 0,
    startedAt: now,
    finishedAt: now,
    lastError: errorMessage,
  };
}

export function createCollabToolFactory(
  api: OpenClawPluginApi,
  deps: {
    pluginConfig: CollabPluginConfig;
    usageRegistry: UsageRegistry;
  },
): OpenClawPluginToolFactory {
  return (ctx: OpenClawPluginToolContext) => {
    const requesterAgentId = ctx.agentId?.trim();
    if (!requesterAgentId) {
      return null;
    }

    const tool = {
      name: "collab",
      label: "Collaborate",
      ownerOnly: true,
      description:
        "Run a supervised two-agent collaboration in a Discord thread. Creates a fresh webhook per collaboration, posts turns chronologically, and cleans up child transcripts on every path.",
      parameters: CollabToolParametersSchema,
      async execute(toolCallId: string, params: CollabToolParameters, signal?: AbortSignal) {
        const collabId = `collab:${randomUUID()}`;

        try {
          const request = buildRequest(params, deps.pluginConfig);
          const outcome = await runCollaboration({
            collabId,
            api,
            pluginConfig: deps.pluginConfig,
            usageRegistry: deps.usageRegistry,
            requesterAgentId,
            toolCallId,
            request,
            ...(signal ? { signal } : {}),
          });

          return {
            content: [{ type: "text", text: outcome.summaryText }],
            details: outcome.details,
          };
        } catch (error) {
          const message = toErrorMessage(error);
          const details = buildFailureDetails(collabId, requesterAgentId, message);
          return {
            content: [{ type: "text", text: `Collaboration failed: ${message}` }],
            details,
          };
        }
      },
    } satisfies AnyAgentTool;

    return tool;
  };
}
