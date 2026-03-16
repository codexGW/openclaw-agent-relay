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
      "agent-relay": {
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
    "alsoAllow": ["agent-relay"]
  }
}
```

Restart your gateway.

### About the relay config

Yeah, this part looks janky. You're pointing the plugin back at your own gateway, which feels like it shouldn't be necessary. It shouldn't. But OpenClaw's plugin API doesn't expose the internal agent-calling method to plugin tools right now, so the plugin shells out to `openclaw agent -m` instead. That needs your gateway's port and token to connect back to itself. If OpenClaw fixes this upstream, the relay config goes away and setup gets a lot simpler. Until then, set it up once and forget about it.

If you have agents on multiple gateways, add each gateway to the `gateways` array with its port, token, and the agent IDs it hosts.

## How to use it

Once the plugin is configured, just ask your agent in natural language. It has a `collab` tool and will figure out the parameters.

### Agent IDs

The agent IDs you use in the collab must match the `id` field in your gateway's `agents.list` config. These are the same IDs you see in `openclaw.json` under `agents.list[].id`. For example, if your config has agents with ids `researcher` and `reviewer`, those are the names you use.

### Getting the channel ID

The collab needs a Discord channel ID to create the thread in. To get one: open Discord, right-click the channel, and click **Copy Channel ID**. If you don't see that option, enable Developer Mode in Discord settings (App Settings > Advanced > Developer Mode).

### Example prompts

```
Start a collab between researcher and reviewer to debate whether
Rust or Go is better for CLI tools. Channel: 1234567890123456789
```

```
Run a collab between analyst and writer. Have them work together
on a summary of this article: [paste URL]. Use channel 1234567890123456789.
Max 6 turns.
```

```
I want researcher and critic to review my business plan.
Channel: 1234567890123456789. Keep it to 4 turns.
```

You can override settings per-collab by mentioning them in the prompt. The agent maps things like "max 6 turns" to the right parameter.

### What happens next

A new thread appears in the Discord channel you specified. You'll see:

1. A status message with the collab settings
2. Agents posting back and forth, each under their own name
3. A summary when it finishes or gets stopped

### Jumping in

You can participate while a collab is running:

- **Interject**: type anything in the thread. Your message gets included in the next agent's context, so the agent will see and respond to what you said.
- **Stop**: type `/stop` in the thread. The collab ends after the current turn finishes.
- **Watch**: each turn posts in real time. You don't have to do anything.

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

**Tool doesn't show up**: Add `"agent-relay"` to `tools.alsoAllow`. Without it the agent can't see the tool.

**"must NOT have additional properties"**: You have an old or misspelled key in the collab config. Valid keys are `maxTurns`, `turnTimeoutSeconds`, `turnDelayMs`, `discordAccountId`, `relay`, `threadAutoArchiveMinutes`, and `webhookNamePrefix`.

## License

MIT
