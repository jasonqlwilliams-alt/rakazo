import { describe, expect, it } from "vitest";
import {
  appContract,
  CreateBotInput,
  DirectMessageBlockSchema,
  ProductEventType,
} from "./index.js";

describe("contracts", () => {
  it("parses bot create input", () => {
    const parsed = CreateBotInput.parse({ name: "Chief" });
    expect(parsed.title).toBe("");
    expect(parsed.notifyOnFinish).toBe(true);
  });

  it("exposes the product rpc surface", () => {
    expect(appContract.models.beginOAuth).toBeTruthy();
    expect(appContract.models.completeOAuth).toBeTruthy();
    expect(appContract.bots.create).toBeTruthy();
    expect(appContract.bots.archive).toBeTruthy();
    expect(appContract.bots.restore).toBeTruthy();
    expect(appContract.bots.remove).toBeTruthy();
    expect(appContract.threads.subscribe).toBeTruthy();
    expect(appContract.threads.sendToBot).toBeTruthy();
    expect(appContract.notifications.registerPush).toBeTruthy();
    expect(ProductEventType.options).toContain("thread.message.created");
    expect(ProductEventType.options).toContain("thread.subagent");
    expect(ProductEventType.options).toContain("bot.spawned");
  });

  it("parses a recipient-side direct message block", () => {
    expect(
      DirectMessageBlockSchema.parse({
        kind: "direct_message",
        fromBotId: "bot-eleusis",
        fromName: "Eleusis",
        toBotId: "bot-thor",
        toName: "Thor",
        text: "hold the venue list",
        direction: "received",
      }),
    ).toMatchObject({ kind: "direct_message", direction: "received" });
  });
});
