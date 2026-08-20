import { describe, expect, it } from "vitest";
import {
  appContract,
  botFieldsAfterPatchAreSeparate,
  CreateBotInput,
  ProductEventType,
  UpdateBotInput,
} from "./index.js";

describe("contracts", () => {
  it("parses bot create input", () => {
    const parsed = CreateBotInput.parse({ name: "Chief" });
    expect(parsed.title).toBe("");
    expect(parsed.notifyOnFinish).toBe(true);
  });

  it("rejects a field-name sync that crosses a persona into the description", () => {
    const crossed = {
      description: "You are Chief.",
      instructions: "You are Chief.",
    };

    expect(() => CreateBotInput.parse({ name: "Chief", ...crossed })).toThrow(
      "Description must remain separate from instructions",
    );
    expect(() => UpdateBotInput.parse({ botId: "bot-1", ...crossed })).toThrow(
      "Description must remain separate from instructions",
    );
  });

  it("rejects a partial patch that crosses the stored persona", () => {
    expect(
      botFieldsAfterPatchAreSeparate(
        { description: "Short blurb.", instructions: "You are Chief." },
        { description: "You are Chief." },
      ),
    ).toBe(false);
  });

  it("exposes the product rpc surface", () => {
    expect(appContract.models.beginOAuth).toBeTruthy();
    expect(appContract.bootstrap).toBeTruthy();
    expect(appContract.models.completeOAuth).toBeTruthy();
    expect(appContract.bots.create).toBeTruthy();
    expect(appContract.bots.archive).toBeTruthy();
    expect(appContract.bots.restore).toBeTruthy();
    expect(appContract.bots.remove).toBeTruthy();
    expect(appContract.threads.subscribe).toBeTruthy();
    expect(appContract.threads.clear).toBeTruthy();
    expect(appContract.voice.prepare).toBeTruthy();
    expect(appContract.notifications.registerPush).toBeTruthy();
    expect(ProductEventType.options).toContain("thread.message.created");
    expect(ProductEventType.options).toContain("thread.cleared");
    expect(ProductEventType.options).toContain("thread.subagent");
    expect(ProductEventType.options).toContain("bot.spawned");
  });
});
