import type { BridgeLogger } from "./types.js";

const SECRET_KEY = /token|authorization|secret|password|api[_-]?key|cookie|publickey|public_key/i;
const BODY_KEY = /^(content|prompt|text|body|message|rawbody|raw_body)$/i;

export function sanitizeLogFields(
  fields?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!fields) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SECRET_KEY.test(key)) out[key] = "[redacted]";
    else if (BODY_KEY.test(key)) out[key] = "[omitted]";
    else out[key] = value;
  }
  return out;
}

export function createBridgeLogger(
  sink: Pick<Console, "info" | "warn" | "error"> = console,
): BridgeLogger {
  return {
    info(event, fields) {
      sink.info(event, sanitizeLogFields(fields));
    },
    warn(event, fields) {
      sink.warn(event, sanitizeLogFields(fields));
    },
    error(event, fields) {
      sink.error(event, sanitizeLogFields(fields));
    },
  };
}
