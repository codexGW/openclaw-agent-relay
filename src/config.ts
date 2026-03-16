import type { OpenClawPluginConfigSchema } from "openclaw/plugin-sdk/compat";
import { isRecord } from "./helpers.js";
import type { CollabPluginConfig, RelayConfig, RelayGatewayConfig } from "./types.js";

const THREAD_AUTO_ARCHIVE_VALUES = [60, 1440, 4320, 10080] as const;

type ParseIssue = {
  path: Array<string | number>;
  message: string;
};

export const DEFAULT_COLLAB_PLUGIN_CONFIG: CollabPluginConfig = {
  maxTurns: 10,
  turnTimeoutSeconds: 120,
  turnDelayMs: 2_000,
  // discordAccountId omitted — resolveDiscordAccount uses the configured default
  threadAutoArchiveMinutes: 1440,
  webhookNamePrefix: "Agent Relay",
};

function pushIssue(issues: ParseIssue[], path: string, message: string): void {
  issues.push({ path: [path], message });
}

function pushIssueAtPath(issues: ParseIssue[], path: Array<string | number>, message: string): void {
  issues.push({ path, message });
}

function readInteger(
  raw: Record<string, unknown>,
  key: keyof CollabPluginConfig,
  fallback: number,
  issues: ParseIssue[],
  opts: { min?: number; max?: number } = {},
): number {
  const value = raw[key];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    pushIssue(issues, String(key), `${String(key)} must be an integer.`);
    return fallback;
  }
  if (opts.min !== undefined && value < opts.min) {
    pushIssue(issues, String(key), `${String(key)} must be >= ${opts.min}.`);
    return fallback;
  }
  if (opts.max !== undefined && value > opts.max) {
    pushIssue(issues, String(key), `${String(key)} must be <= ${opts.max}.`);
    return fallback;
  }
  return value;
}

function readString(
  raw: Record<string, unknown>,
  key: keyof CollabPluginConfig,
  fallback: string,
  issues: ParseIssue[],
): string {
  const value = raw[key];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "string") {
    pushIssue(issues, String(key), `${String(key)} must be a string.`);
    return fallback;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    pushIssue(issues, String(key), `${String(key)} cannot be empty.`);
    return fallback;
  }
  return trimmed;
}

export function parseRelayConfig(
  value: unknown,
):
  | { success: true; data: RelayConfig }
  | { success: false; issues: ParseIssue[] } {
  const issues: ParseIssue[] = [];

  if (!isRecord(value)) {
    return {
      success: false,
      issues: [{ path: ["relay"], message: "relay must be an object." }],
    };
  }

  const localGatewayIdRaw = value.localGatewayId;
  const localGatewayId =
    typeof localGatewayIdRaw === "string" ? localGatewayIdRaw.trim() : "";
  if (!localGatewayId) {
    pushIssueAtPath(
      issues,
      ["relay", "localGatewayId"],
      "localGatewayId must be a non-empty string.",
    );
  }

  const gatewaysRaw = value.gateways;
  const gateways: RelayGatewayConfig[] = [];
  if (!Array.isArray(gatewaysRaw)) {
    pushIssueAtPath(issues, ["relay", "gateways"], "gateways must be an array.");
  } else if (gatewaysRaw.length === 0) {
    pushIssueAtPath(issues, ["relay", "gateways"], "gateways must be a non-empty array.");
  } else {
    for (const [index, gatewayRaw] of gatewaysRaw.entries()) {
      if (!isRecord(gatewayRaw)) {
        pushIssueAtPath(issues, ["relay", "gateways", index], "gateway must be an object.");
        continue;
      }

      const gatewayIdRaw = gatewayRaw.gatewayId;
      const gatewayId =
        typeof gatewayIdRaw === "string" ? gatewayIdRaw.trim() : "";
      if (!gatewayId) {
        pushIssueAtPath(
          issues,
          ["relay", "gateways", index, "gatewayId"],
          "gatewayId must be a non-empty string.",
        );
      }

      const portRaw = gatewayRaw.port;
      const port = typeof portRaw === "number" && Number.isInteger(portRaw) ? portRaw : undefined;
      if (port === undefined) {
        pushIssueAtPath(issues, ["relay", "gateways", index, "port"], "port must be an integer.");
      } else if (port < 1 || port > 65535) {
        pushIssueAtPath(
          issues,
          ["relay", "gateways", index, "port"],
          "port must be between 1 and 65535.",
        );
      }

      const tokenRaw = gatewayRaw.token;
      const token = typeof tokenRaw === "string" ? tokenRaw.trim() : "";
      if (!token) {
        pushIssueAtPath(
          issues,
          ["relay", "gateways", index, "token"],
          "token must be a non-empty string.",
        );
      }

      const agentsRaw = gatewayRaw.agents;
      const agents: string[] = [];
      if (!Array.isArray(agentsRaw)) {
        pushIssueAtPath(issues, ["relay", "gateways", index, "agents"], "agents must be an array.");
      } else if (agentsRaw.length === 0) {
        pushIssueAtPath(
          issues,
          ["relay", "gateways", index, "agents"],
          "agents must be a non-empty array.",
        );
      } else {
        for (const [agentIndex, agentRaw] of agentsRaw.entries()) {
          if (typeof agentRaw !== "string" || !agentRaw.trim()) {
            pushIssueAtPath(
              issues,
              ["relay", "gateways", index, "agents", agentIndex],
              "agents entries must be non-empty strings.",
            );
            continue;
          }
          agents.push(agentRaw.trim());
        }
      }

      if (gatewayId && port !== undefined && port >= 1 && port <= 65535 && token && agents.length > 0) {
        gateways.push({
          gatewayId,
          port,
          token,
          agents,
        });
      }
    }
  }

  if (issues.length > 0) {
    return { success: false, issues };
  }

  return {
    success: true,
    data: {
      localGatewayId,
      gateways,
    },
  };
}

export function resolveGatewayForAgent(
  relay: RelayConfig | undefined,
  agentId: string,
): RelayGatewayConfig | undefined {
  if (!relay) {
    return undefined;
  }
  return relay.gateways.find((gateway) => gateway.agents.includes(agentId));
}

export function safeParseCollabPluginConfig(
  value: unknown,
):
  | { success: true; data: CollabPluginConfig }
  | { success: false; issues: ParseIssue[] } {
  const issues: ParseIssue[] = [];

  if (value === undefined) {
    return {
      success: true,
      data: DEFAULT_COLLAB_PLUGIN_CONFIG,
    };
  }

  if (!isRecord(value)) {
    return {
      success: false,
      issues: [
        {
          path: [],
          message: "Plugin config must be an object.",
        },
      ],
    };
  }

  const threadAutoArchiveMinutes = readInteger(
    value,
    "threadAutoArchiveMinutes",
    DEFAULT_COLLAB_PLUGIN_CONFIG.threadAutoArchiveMinutes,
    issues,
  );

  if (!THREAD_AUTO_ARCHIVE_VALUES.includes(threadAutoArchiveMinutes as (typeof THREAD_AUTO_ARCHIVE_VALUES)[number])) {
    pushIssue(
      issues,
      "threadAutoArchiveMinutes",
      `threadAutoArchiveMinutes must be one of ${THREAD_AUTO_ARCHIVE_VALUES.join(", ")}.`,
    );
  }

  const parsed: CollabPluginConfig = {
    maxTurns: readInteger(value, "maxTurns", DEFAULT_COLLAB_PLUGIN_CONFIG.maxTurns, issues, {
      min: 1,
      max: 64,
    }),
    turnTimeoutSeconds: readInteger(
      value,
      "turnTimeoutSeconds",
      DEFAULT_COLLAB_PLUGIN_CONFIG.turnTimeoutSeconds,
      issues,
      { min: 5, max: 3600 },
    ),
    turnDelayMs: readInteger(value, "turnDelayMs", DEFAULT_COLLAB_PLUGIN_CONFIG.turnDelayMs, issues, {
      min: 0,
      max: 60_000,
    }),
    ...(value.discordAccountId !== undefined
      ? typeof value.discordAccountId === "string" && value.discordAccountId.trim()
        ? { discordAccountId: value.discordAccountId.trim() }
        : (() => {
            pushIssue(issues, "discordAccountId", "discordAccountId must be a non-empty string when provided.");
            return {};
          })()
      : {}),
    threadAutoArchiveMinutes: (THREAD_AUTO_ARCHIVE_VALUES.includes(
      threadAutoArchiveMinutes as (typeof THREAD_AUTO_ARCHIVE_VALUES)[number],
    )
      ? threadAutoArchiveMinutes
      : DEFAULT_COLLAB_PLUGIN_CONFIG.threadAutoArchiveMinutes) as CollabPluginConfig["threadAutoArchiveMinutes"],
    webhookNamePrefix: readString(
      value,
      "webhookNamePrefix",
      DEFAULT_COLLAB_PLUGIN_CONFIG.webhookNamePrefix,
      issues,
    ),
    ...(value.relay !== undefined
      ? (() => {
          const relayResult = parseRelayConfig(value.relay);
          if (relayResult.success) {
            return { relay: relayResult.data };
          }
          issues.push(...relayResult.issues);
          return {};
        })()
      : {}),
  };

  if (issues.length > 0) {
    return {
      success: false,
      issues,
    };
  }

  return {
    success: true,
    data: parsed,
  };
}

export function parseCollabPluginConfig(value: unknown): CollabPluginConfig {
  const result = safeParseCollabPluginConfig(value);
  if (!result.success) {
    throw new Error(result.issues.map((issue) => issue.message).join(" "));
  }
  return result.data;
}

export function createCollabPluginConfigSchema(): OpenClawPluginConfigSchema {
  return {
    parse(value: unknown) {
      return parseCollabPluginConfig(value);
    },
    safeParse(value: unknown) {
      const result = safeParseCollabPluginConfig(value);
      if (result.success) {
        return {
          success: true,
          data: result.data,
        };
      }
      return {
        success: false,
        error: {
          issues: result.issues,
        },
      };
    },
    validate(value: unknown) {
      const result = safeParseCollabPluginConfig(value);
      if (result.success) {
        return {
          ok: true,
          value: result.data,
        };
      }
      return {
        ok: false,
        errors: result.issues.map((issue) => issue.message),
      };
    },
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        maxTurns: { type: "integer", minimum: 1, maximum: 64, default: 10 },
        turnTimeoutSeconds: {
          type: "integer",
          minimum: 5,
          maximum: 3600,
          default: 120,
        },
        turnDelayMs: {
          type: "integer",
          minimum: 0,
          maximum: 60000,
          default: 2000,
        },
        discordAccountId: {
          type: "string",
          default: "default",
        },
        relay: {
          type: "object",
          additionalProperties: false,
          required: ["localGatewayId", "gateways"],
          properties: {
            localGatewayId: {
              type: "string",
              minLength: 1,
            },
            gateways: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["gatewayId", "port", "token", "agents"],
                properties: {
                  gatewayId: {
                    type: "string",
                    minLength: 1,
                  },
                  port: {
                    type: "integer",
                    minimum: 1,
                    maximum: 65535,
                  },
                  token: {
                    type: "string",
                    minLength: 1,
                  },
                  agents: {
                    type: "array",
                    minItems: 1,
                    items: {
                      type: "string",
                      minLength: 1,
                    },
                  },
                },
              },
            },
          },
        },
        threadAutoArchiveMinutes: {
          type: "integer",
          enum: [60, 1440, 4320, 10080],
          default: 1440,
        },
        webhookNamePrefix: {
          type: "string",
          default: "OpenClaw Collab",
        },
      },
    },
    uiHints: {
      maxTurns: {
        label: "Default Max Turns",
        help: "Upper bound for total turns per collaboration.",
      },
      turnTimeoutSeconds: {
        label: "Turn Timeout Seconds",
        help: "Passed to waitForRun(timeoutMs).",
        advanced: true,
      },
      turnDelayMs: {
        label: "Turn Delay Milliseconds",
        help: "Also used as the human interjection collection window.",
        advanced: true,
      },
      discordAccountId: {
        label: "Discord Account ID",
        help: "Discord account used for thread and webhook operations.",
      },
      threadAutoArchiveMinutes: {
        label: "Thread Auto Archive",
        help: "Discord auto-archive duration for collaboration threads.",
        advanced: true,
      },
      webhookNamePrefix: {
        label: "Webhook Name Prefix",
        help: "Each collaboration creates a new webhook with this prefix.",
        advanced: true,
      },
    },
  };
}
