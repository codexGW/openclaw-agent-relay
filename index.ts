import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { createCollabPluginConfigSchema, parseCollabPluginConfig } from "./src/config.js";
import { createCollabToolFactory } from "./src/tool.js";
import { UsageRegistry } from "./src/usage-registry.js";

const plugin = {
  id: "collab",
  name: "Agent Collaboration",
  description: "Supervised two-agent collaboration in Discord threads.",
  configSchema: createCollabPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    const pluginConfig = parseCollabPluginConfig(api.pluginConfig);
    const usageRegistry = new UsageRegistry(
      api.runtime.logging.getChildLogger({
        pluginId: "collab",
        subsystem: "usage-registry",
      }),
    );

    api.on("llm_output", (event) => {
      usageRegistry.pruneOlderThan(30 * 60 * 1000);
      usageRegistry.recordLlmOutput(event);
    });

    api.on("subagent_ended", (event) => {
      usageRegistry.pruneOlderThan(30 * 60 * 1000);
      usageRegistry.recordSubagentEnded(event);
    });

    api.registerTool(
      createCollabToolFactory(api, {
        pluginConfig,
        usageRegistry,
      }),
      { optional: true },
    );
  },
};

export default plugin;

export { encodeRelayEnvelope, tryDecodeRelayEnvelope } from "./src/relay-envelope.js";
export type {
  RelayConfig,
  RelayGatewayConfig,
  RelayEnvelope,
  RelayTurnRequestEnvelope,
  RelayTurnResultEnvelope,
  RelayTurnCancelEnvelope,
  UsageSource,
  TurnRunnerKind,
} from "./src/types.js";
export { resolveGatewayForAgent, parseRelayConfig } from "./src/config.js";
