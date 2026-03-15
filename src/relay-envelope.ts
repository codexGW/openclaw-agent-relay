import type { RelayEnvelope } from "./types.js";

const RELAY_PREFIX = "[COLLAB_RELAY] ";

export function encodeRelayEnvelope(envelope: RelayEnvelope): string {
  return `${RELAY_PREFIX}${JSON.stringify(envelope)}`;
}

export function tryDecodeRelayEnvelope(text: string): RelayEnvelope | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(RELAY_PREFIX)) return null;
  try {
    const json = JSON.parse(trimmed.slice(RELAY_PREFIX.length));
    if (
      typeof json === "object" &&
      json !== null &&
      typeof json.kind === "string" &&
      json.kind.startsWith("collab.turn.")
    ) {
      return json as RelayEnvelope;
    }
    return null;
  } catch {
    return null;
  }
}
