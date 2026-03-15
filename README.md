# Agent Relay

OpenClaw plugin that puts two agents in a Discord thread and lets them go back and forth. You watch, jump in, or `/stop` whenever.

**Discord only.** This plugin uses Discord threads, webhooks, and message polling. It won't work on other channels like Telegram or Signal.

## What happens

You tell your agent to start a collab. The plugin creates a Discord thread, picks up the two agents you named, and runs a turn loop: Agent A talks, then Agent B responds, then A again, and so on. Each turn posts to the thread under the agent's name using a webhook. Between turns there's a short pause where it checks if you typed `/stop` or said something. If you did, your message gets fed into the next turn's context.

When it hits the turn limit or you stop it, it posts a summary and cleans up the webhook.

## Setup

Clone into your extensions folder:

```bash
git clone https://github.com/codexGW/openclaw-agent-relay.git ~/.openclaw/extensions/collab
```

Then add this to `~/.openclaw/openclaw.json`. You need to fill in your own gateway port and token, which are in the same file under `gateway.port` and `gateway.auth.token`.

```jsonc
{
  "plugins": {
    "load": { "paths": ["~/.openclaw/extensions/collab"] },
    "entries": {
      "collab": {
        "enabled": true,
        "config": {
          "maxTurns": 10,
          "turnTimeoutSeconds": 120,
          "turnDelayMs": 2000,
          "relay": {
            "localGatewayId": "my-gateway",
            "gateways": [{
              "gatewayId": "my-gateway",
              "port": 18789,
              "token": "YOUR_GATEWAY_TOKEN",
              "agents": ["agent-a", "agent-b"]
            }]
          }
        }
      }
    }
  },
  "tools": {
    "alsoAllow": ["collab"]
  }
}
```

Restart your gateway.

### About the relay config

You'd expect the plugin to just call your agents directly, but OpenClaw's plugin API doesn't expose that method to plugin tools right now. So the plugin shells out to `openclaw agent -m` instead, which means it needs to know your gateway's port and token to connect back to itself. Weird, but it works. Set it up once and forget about it.

If you have agents on multiple gateways, add each gateway to the `gateways` array with its port, token, and the agent IDs it hosts.

## How to use it

Tell your agent something like:

```
Start a collab between analyst and reviewer to debate X. Channel: 1234567890
```

You need the Discord channel ID. Right-click a channel with Developer Mode on and copy it.

The agent figures out the tool call. You'll see a thread pop up with agents taking turns.

### Jumping in

Type anything in the thread during a collab. Your message gets included in the next agent's prompt. Type `/stop` to end it early.

## Config options

| Option | Default | What it does |
|--------|---------|-------------|
| `maxTurns` | 10 | Stops the loop after this many turns |
| `turnTimeoutSeconds` | 120 | Kills a turn if the agent takes too long |
| `turnDelayMs` | 2000 | Wait between turns, also how long it listens for `/stop` |
| `discordAccountId` | your default | Which Discord bot to use, usually just leave it out |
| `relay` | required | Gateway connection info, see setup above |

## You'll need

- OpenClaw 2026.3.13+
- Discord (this plugin is Discord-only)
- A Discord bot that can manage webhooks and create threads
- At least 2 agents in your gateway config
- Your gateway auth token (it's already in your config file)

## Common issues

**"Unknown target agent(s)"**: The agent ID doesn't match anything in `agents.list` in your config. Double check the `id` fields.

**"Plugin runtime subagent methods..."**: You're missing the relay config. Add the `relay` block shown above and restart.

**Tool doesn't show up**: Add `"collab"` to `tools.alsoAllow`. Without it the agent can't see the tool.

**"must NOT have additional properties"**: You have an old or misspelled key in the collab config. Valid keys are `maxTurns`, `turnTimeoutSeconds`, `turnDelayMs`, `discordAccountId`, `relay`, `threadAutoArchiveMinutes`, and `webhookNamePrefix`.

## License

MIT
