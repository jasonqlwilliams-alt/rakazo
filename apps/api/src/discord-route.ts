import type { DiscordRoundtableBridge } from "@rakazo/adapters";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

/** Discord interaction payloads are a few KB; anything larger is not a real interaction. */
export const MAX_DISCORD_INTERACTION_BYTES = 64_000;

export function mountDiscordInteractionsRoute(
  app: Hono,
  bridge: DiscordRoundtableBridge | undefined,
): void {
  app.post(
    "/integrations/discord/interactions",
    bodyLimit({
      maxSize: MAX_DISCORD_INTERACTION_BYTES,
      onError: (c) => c.json({ error: "Interaction payload is too large" }, 413),
    }),
    async (c) => {
      if (!bridge) return c.json({ error: "Discord bridge is not configured" }, 404);
      const rawBody = await c.req.text();
      const result = await bridge.handleHttpRequest({
        signature: c.req.header("x-signature-ed25519") ?? "",
        timestamp: c.req.header("x-signature-timestamp") ?? "",
        rawBody,
      });
      const response = c.json(result.body, result.status as 200 | 400 | 401 | 503);
      result.afterResponse?.();
      return response;
    },
  );
}
