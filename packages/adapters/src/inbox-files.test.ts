import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { LocalAgentHomeStore } from "./home.js";
import { storeBotInboxImages } from "./inbox-files.js";

const context = {
  operationId: "attach-test",
  traceId: "attach-test",
  spaceId: "workspace-1",
  userId: "user-1",
  botId: "bot-1",
  signal: new AbortController().signal,
};
const dirs: string[] = [];
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03]);

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("bot inbox images", () => {
  it("copies a photo into both the active team workspace and durable home", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-inbox-"));
    dirs.push(root);
    const home = new LocalAgentHomeStore(root);
    const sandbox = new FakeSandboxProvider();
    const computer = await sandbox.provision(
      { botId: "team-workspace-1", homePath: home.pathFor("team-workspace-1") },
      context,
    );

    const [stored] = await storeBotInboxImages(
      { home, sandbox },
      {
        botId: "bot-1",
        homeKey: "team-workspace-1",
        mode: "team",
        computer,
        files: [{ name: "Jason photo.PNG", bytes: png }],
        createId: () => "fixed-id-123456789",
      },
      context,
    );

    expect(stored).toEqual({
      name: "Jason photo.PNG",
      path: "inbox/fixed-id-123-Jason-photo.png",
      size: png.byteLength,
      mimeType: "image/png",
    });
    const workspacePath = `bots/bot-1/${stored!.path}`;
    expect(await sandbox.readFile(computer, workspacePath, context)).toEqual(png);
    expect(await readFile(path.join(home.pathFor("team-workspace-1"), workspacePath))).toEqual(
      Buffer.from(png),
    );
  });

  it("rejects a non-image before writing either copy", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-inbox-"));
    dirs.push(root);
    const home = new LocalAgentHomeStore(root);
    const sandbox = new FakeSandboxProvider();
    const computer = await sandbox.provision(
      { botId: "bot-1", homePath: home.pathFor("bot-1") },
      context,
    );

    await expect(
      storeBotInboxImages(
        { home, sandbox },
        {
          botId: "bot-1",
          homeKey: "bot-1",
          mode: "dedicated",
          computer,
          files: [{ name: "not-a-photo.png", bytes: new TextEncoder().encode("no") }],
        },
        context,
      ),
    ).rejects.toThrow(/not a supported image/);
    expect(sandbox.boxes.get(computer.id)?.files.size).toBe(0);
  });
});
