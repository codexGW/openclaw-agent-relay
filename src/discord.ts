import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { resolveDiscordAccount } from "openclaw/plugin-sdk/discord";
import type { Logger } from "./helpers.js";

const DISCORD_API_BASE = "https://discord.com/api/v10";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
const CHANNEL_TYPE_GUILD_TEXT = 0;
const CHANNEL_TYPE_GUILD_ANNOUNCEMENT = 5;
const CHANNEL_TYPE_PUBLIC_THREAD = 11;
const WEBHOOK_CHUNK_SIZE = 1900;

export interface DiscordChannelInfo {
  id: string;
  type: number;
  name?: string;
  guild_id?: string;
}

export interface DiscordAuthor {
  id?: string;
  username?: string;
  bot?: boolean;
}

export interface DiscordMessage {
  id: string;
  content?: string;
  webhook_id?: string;
  author?: DiscordAuthor;
}

export interface DiscordWebhookInfo {
  id: string;
  token: string;
  name?: string;
}

export interface DiscordThreadInfo {
  id: string;
  name?: string;
}

export interface DiscordPreflightResult {
  botId?: string;
  channel: DiscordChannelInfo;
}

export interface WebhookPostResult {
  messageId?: string;
}

export class DiscordApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "DiscordApiError";
  }
}

function assertDiscordPath(path: string): void {
  if (!path.startsWith("/")) {
    throw new Error("Discord API path must start with '/'.");
  }
}

function trimTo(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(0, limit);
}

function compareSnowflakes(left: string, right: string): number {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  if (leftValue === rightValue) {
    return 0;
  }
  return leftValue < rightValue ? -1 : 1;
}

function chunkText(text: string, limit = WEBHOOK_CHUNK_SIZE): string[] {
  const normalized = text.trim();
  if (!normalized) {
    return [""];
  }
  if (normalized.length <= limit) {
    return [normalized];
  }

  const paragraphs = normalized.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current);
      current = "";
    }

    if (paragraph.length <= limit) {
      current = paragraph;
      continue;
    }

    let remaining = paragraph;
    while (remaining.length > limit) {
      let splitIndex = remaining.lastIndexOf("\n", limit);
      if (splitIndex < Math.floor(limit * 0.5)) {
        splitIndex = remaining.lastIndexOf(" ", limit);
      }
      if (splitIndex < Math.floor(limit * 0.5)) {
        splitIndex = limit;
      }
      chunks.push(remaining.slice(0, splitIndex).trimEnd());
      remaining = remaining.slice(splitIndex).trimStart();
    }

    current = remaining;
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text || response.statusText;
  } catch {
    return response.statusText || `HTTP ${response.status}`;
  }
}

async function discordRequest<T>(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  assertDiscordPath(path);

  const headers = new Headers(init.headers);
  if (!headers.has("Authorization")) {
    headers.set("Authorization", `Bot ${token}`);
  }
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  let response: Response | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    response = await fetch(`${DISCORD_API_BASE}${path}`, {
      ...init,
      headers,
    });

    if (response.status === 429) {
      const retryBody = await response.json().catch(() => ({})) as Record<string, unknown>;
      const retryAfter = typeof retryBody.retry_after === "number" ? retryBody.retry_after : 1;
      await sleep(Math.ceil(retryAfter * 1000) + 250);
      continue;
    }
    break;
  }

  if (!response || !response.ok) {
    throw new DiscordApiError(
      response?.status ?? 0,
      `Discord API ${path} failed: ${response?.status ?? "no response"} ${response ? await readErrorBody(response) : "exhausted retries"}`,
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export function buildThreadName(title?: string): string {
  const raw = title?.trim() || "Collaboration";
  return trimTo(raw, 100);
}

export async function resolveDiscordBot(
  api: OpenClawPluginApi,
  accountId?: string,
): Promise<{ accountId: string; token: string }> {
  const account = resolveDiscordAccount({
    cfg: api.config,
    ...(accountId ? { accountId } : {}),
  });

  const token = account.token?.trim();
  if (!token) {
    throw new Error(`Discord account "${account.accountId}" is missing a bot token.`);
  }

  return {
    accountId: account.accountId,
    token,
  };
}

export async function preflightDiscord(
  api: OpenClawPluginApi,
  params: {
    token: string;
    accountId: string;
    channelId: string;
    logger: Logger;
    signal?: AbortSignal;
  },
): Promise<DiscordPreflightResult> {
  const probe = await api.runtime.channel.discord.probeDiscord(params.token, 10_000, {
    includeApplication: true,
  });
  if (!probe.ok) {
    throw new Error(`Discord preflight failed: ${probe.error ?? "probe failed"}`);
  }

  const audit = await api.runtime.channel.discord.auditChannelPermissions({
    token: params.token,
    accountId: params.accountId,
    channelIds: [params.channelId],
    timeoutMs: 10_000,
  });

  const auditEntry = audit.channels.find((channel) => channel.channelId === params.channelId);
  if (!audit.ok || !auditEntry?.ok) {
    const missing = auditEntry?.missing?.join(", ");
    throw new Error(
      missing
        ? `Discord channel preflight failed. Missing permissions: ${missing}`
        : "Discord channel preflight failed.",
    );
  }

  const channel = await discordRequest<DiscordChannelInfo>(params.token, `/channels/${params.channelId}`, {
    ...(params.signal ? { signal: params.signal } : {}),
  });

  if (
    channel.type !== CHANNEL_TYPE_GUILD_TEXT &&
    channel.type !== CHANNEL_TYPE_GUILD_ANNOUNCEMENT
  ) {
    throw new Error(
      `Channel ${params.channelId} has unsupported type ${channel.type}. Use a standard text or announcement channel as the collaboration parent.`,
    );
  }

  const botId = probe.bot?.id;
  params.logger.info("Discord preflight passed", {
    channelId: params.channelId,
    channelType: channel.type,
    ...(botId ? { botId } : {}),
  });

  return {
    ...(botId ? { botId } : {}),
    channel,
  };
}

export async function createFreshWebhook(
  token: string,
  channelId: string,
  name: string,
  signal?: AbortSignal,
): Promise<DiscordWebhookInfo> {
  const webhook = await discordRequest<DiscordWebhookInfo>(token, `/channels/${channelId}/webhooks`, {
    method: "POST",
    body: JSON.stringify({
      name: trimTo(name, 80),
    }),
    ...(signal ? { signal } : {}),
  });

  if (!webhook.token) {
    throw new Error(`Created webhook ${webhook.id} does not include a token.`);
  }

  return webhook;
}

export async function deleteWebhook(
  token: string,
  webhookId: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await discordRequest<void>(token, `/webhooks/${webhookId}`, {
      method: "DELETE",
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (error instanceof DiscordApiError && error.status === 404) {
      return;
    }
    throw error;
  }
}

export async function createCollabThread(
  token: string,
  channelId: string,
  name: string,
  autoArchiveMinutes: number,
  signal?: AbortSignal,
): Promise<DiscordThreadInfo> {
  return await discordRequest<DiscordThreadInfo>(token, `/channels/${channelId}/threads`, {
    method: "POST",
    body: JSON.stringify({
      name: trimTo(name, 100),
      type: CHANNEL_TYPE_PUBLIC_THREAD,
      auto_archive_duration: autoArchiveMinutes,
    }),
    ...(signal ? { signal } : {}),
  });
}

export async function postWebhookMessage(
  webhook: DiscordWebhookInfo,
  params: {
    threadId: string;
    username: string;
    content: string;
    avatarUrl?: string;
    signal?: AbortSignal;
  },
): Promise<WebhookPostResult> {
  const chunks = chunkText(params.content, WEBHOOK_CHUNK_SIZE);
  let lastMessageId: string | undefined;

  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    const chunk = chunks[chunkIndex]!;
    const query = new URLSearchParams({
      wait: "true",
      thread_id: params.threadId,
    });

    const url = `${DISCORD_API_BASE}/webhooks/${webhook.id}/${webhook.token}?${query.toString()}`;
    const body = JSON.stringify({
      content: chunk,
      username: trimTo(params.username, 80),
      avatar_url: params.avatarUrl,
      allowed_mentions: { parse: [] },
    });
    const fetchInit = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      ...(params.signal ? { signal: params.signal } : {}),
    };

    let response: Response | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      response = await fetch(url, fetchInit);

      if (response.status === 429) {
        const retryBody = await response.json().catch(() => ({})) as Record<string, unknown>;
        const retryAfter = typeof retryBody.retry_after === "number" ? retryBody.retry_after : 1;
        await sleep(Math.ceil(retryAfter * 1000) + 250);
        continue;
      }
      break;
    }

    if (!response || !response.ok) {
      throw new DiscordApiError(
        response?.status ?? 0,
        `Discord webhook send failed: ${response?.status ?? "no response"} ${response ? await readErrorBody(response) : "exhausted retries"}`,
      );
    }

    const message = (await response.json()) as DiscordMessage;
    lastMessageId = message.id;

    // Small delay between chunks to avoid rate limits
    if (chunkIndex < chunks.length - 1) {
      await sleep(350);
    }
  }

  return {
    ...(lastMessageId ? { messageId: lastMessageId } : {}),
  };
}

export async function postStatusMessage(
  webhook: DiscordWebhookInfo,
  params: {
    threadId: string;
    title: string;
    body: string;
    signal?: AbortSignal;
  },
): Promise<WebhookPostResult> {
  const content = [`**${params.title}**`, "", params.body].join("\n");
  return await postWebhookMessage(webhook, {
    threadId: params.threadId,
    username: "Collab Status",
    content,
    ...(params.signal ? { signal: params.signal } : {}),
  });
}

export async function listThreadMessagesAfter(
  token: string,
  threadId: string,
  afterMessageId: string | undefined,
  signal?: AbortSignal,
): Promise<DiscordMessage[]> {
  const query = new URLSearchParams({ limit: "100" });
  if (afterMessageId) {
    query.set("after", afterMessageId);
  }

  const messages = await discordRequest<DiscordMessage[]>(
    token,
    `/channels/${threadId}/messages?${query.toString()}`,
    { ...(signal ? { signal } : {}) },
  );

  return [...messages].sort((left, right) => compareSnowflakes(left.id, right.id));
}

function normalizeMessageText(message: DiscordMessage): string | undefined {
  const content = typeof message.content === "string" ? message.content.trim() : "";
  return content.length > 0 ? content : undefined;
}

export function readHumanInterjections(messages: DiscordMessage[]): string[] {
  return messages
    .filter((message) => !message.webhook_id && message.author?.bot !== true)
    .map(normalizeMessageText)
    .filter((value): value is string => Boolean(value));
}
