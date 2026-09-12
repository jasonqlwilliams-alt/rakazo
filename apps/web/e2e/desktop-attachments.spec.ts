import { readFileSync, writeFileSync } from "node:fs";
import type { ThreadSnapshot } from "@rakazo/contracts";
import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, openNewSpace, signup } from "./helpers";

test("desktop keeps shared attachments in default and additional spaces after picker retirement", async ({
  page,
}, testInfo) => {
  // Execute the shipped preload with only Electron's host boundary emulated.
  await page.addInitScript(
    (source) => {
      const electron = {
        contextBridge: {
          exposeInMainWorld: (name: string, value: unknown) =>
            Object.defineProperty(window, name, { value }),
        },
        ipcRenderer: {
          invoke: async (channel: string) => {
            if (channel === "desktop.window.state") {
              return { minimized: false, maximized: false, fullScreen: false };
            }
            if (channel === "desktop.update.state") {
              return {
                phase: "idle",
                currentVersion: "0.1.6",
                availableVersion: null,
                percent: null,
                message: null,
                checkedAt: null,
              };
            }
            throw new Error(`Unexpected desktop IPC: ${channel}`);
          },
          on: () => {},
          off: () => {},
        },
      };
      new Function("require", "process", source)(
        (name: string) => {
          if (name !== "electron") throw new Error(`Unexpected preload module: ${name}`);
          return electron;
        },
        { platform: "linux" },
      );
    },
    readFileSync(new URL("../../desktop/src/preload.cjs", import.meta.url), "utf8"),
  );

  const retired = await page.request.post("/api/desktop-files", {
    multipart: { botId: "unused" },
  });
  expect(retired.status()).toBe(404);
  await signup(
    page,
    `desktop-attachments-${Date.now()}@rakazo.test`,
    "password12",
    "Attachment Tester",
  );
  await completeOnboarding(page);
  const bridgeKeys = await page.evaluate(() => Object.keys(window.rakazoDesktop ?? {}).sort());
  expect(bridgeKeys).not.toContain("file");

  // A deterministic image makes the actual preview and reloaded image visible in screenshots.
  const imageBase64 = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 240;
    canvas.height = 120;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#e5e7eb";
    context.fillRect(0, 0, 240, 120);
    context.fillStyle = "#111827";
    context.font = "20px sans-serif";
    context.fillText("Attachment sample", 24, 65);
    return canvas.toDataURL("image/png").split(",")[1]!;
  });
  const observations: unknown[] = [{ bridgeKeys, retiredAnonymousStatus: retired.status() }];
  const defaultSpaceId = await page.evaluate(() => localStorage.getItem("rakazo:space-id"));
  let defaultBotId = "";

  for (const space of ["default", "additional"]) {
    if (space === "additional") {
      await openNewSpace(page);
      const dialog = page.getByRole("dialog", { name: "New space" });
      await dialog.getByLabel("Name").fill("Photo review");
      await dialog.getByRole("button", { name: "Create space", exact: true }).click();
      await completeOnboarding(page);
      await page.waitForURL(
        (url) => /^\/app\/[^/]+$/.test(url.pathname) && url.pathname !== `/app/${defaultBotId}`,
      );
    }
    const botId = activeBotId(page);
    if (space === "default") defaultBotId = botId;
    else expect(botId).not.toBe(defaultBotId);
    const spaceId = await page.evaluate(() => localStorage.getItem("rakazo:space-id"));
    if (space === "additional") {
      expect(spaceId).toBeTruthy();
      expect(spaceId).not.toBe(defaultSpaceId);
    }
    const headers = spaceId ? { "x-rakazo-space-id": spaceId } : {};
    const imageName = `${space}-sample.png`;
    const noteName = `${space}-notes.txt`;
    const note = `Notes for the ${space} space.`;
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Attach file", exact: true }).click();
    await (await chooser).setFiles([
      { name: imageName, mimeType: "image/png", buffer: Buffer.from(imageBase64, "base64") },
      { name: noteName, mimeType: "text/plain", buffer: Buffer.from(note) },
    ]);
    await expect(page.getByRole("button", { name: `Remove ${imageName}`, exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: `Remove ${noteName}`, exact: true })).toBeVisible();
    await captureScreenshot(page, testInfo, `${space}-attachment-preview`);
    await page.getByPlaceholder("Message Chief").fill(`Please review the ${space} attachments.`);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByRole("button", { name: `Remove ${imageName}`, exact: true })).toHaveCount(0);

    const response = await page.request.post("/rpc/threads/get", { headers, data: { json: { botId } } });
    expect(response.ok()).toBe(true);
    const snapshot = ((await response.json()) as { json: ThreadSnapshot }).json;
    const message = snapshot.messages.find(
      (item) =>
        item.role === "user" &&
        item.blocks.some((block) => block.kind === "image" && block.name === imageName),
    );
    expect(message?.blocks).toEqual(
      expect.arrayContaining([
        { kind: "text", text: `Please review the ${space} attachments.` },
        expect.objectContaining({ kind: "image", name: imageName }),
        expect.objectContaining({ kind: "file", name: noteName }),
      ]),
    );
    for (const block of message!.blocks) {
      if (block.kind !== "image" && block.kind !== "file") continue;
      const fetched = await page.request.post("/rpc/artifacts/get", {
        headers,
        data: { json: { botId, artifactId: block.artifactId } },
      });
      expect(fetched.ok()).toBe(true);
      const artifact = (await fetched.json()).json;
      expect(artifact.contentBase64).toBe(
        block.kind === "image" ? imageBase64 : Buffer.from(note).toString("base64"),
      );
    }
    const removedRoute = await page.request.post("/api/desktop-files", {
      headers,
      multipart: { botId },
    });
    expect(removedRoute.status()).toBe(404);
    await page.reload();
    const image = page.getByRole("img", { name: imageName, exact: true });
    await expect(image).toBeVisible();
    await expect
      .poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth))
      .toBe(240);
    await expect(page.getByText(noteName, { exact: true })).toBeVisible();
    await captureScreenshot(page, testInfo, `${space}-attachments-persisted`);
    observations.push({
      space,
      spaceId,
      botId,
      message,
      retiredAuthenticatedStatus: removedRoute.status(),
      retrievedBytesMatch: true,
    });
  }
  const responsePath = testInfo.outputPath("attachment-round-trip.json");
  writeFileSync(responsePath, JSON.stringify(observations, null, 2));
  await testInfo.attach("attachment-round-trip", {
    contentType: "application/json",
    path: responsePath,
  });
});
