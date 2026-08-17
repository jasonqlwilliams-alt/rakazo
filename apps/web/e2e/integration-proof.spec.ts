import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { expect, test } from "@playwright/test";

// `pg` belongs to @rakazo/db, not to this app; resolve it from there rather than
// adding a dependency to apps/web for a verification-only spec.
const pg = createRequire(new URL("../../../packages/db/index.js", import.meta.url))("pg");

/**
 * Live proof for fm/rakazo-integrate-and-run-i2, run against a clone of the real
 * database so the eight production seats are the fixture. Not part of the normal
 * suite: it needs VERIFY_DATABASE_URL and a signed-in real account.
 */

const DATABASE_URL = process.env.VERIFY_DATABASE_URL;
const EMAIL = process.env.VERIFY_EMAIL;
const PASSWORD = process.env.VERIFY_PASSWORD;

test.skip(!DATABASE_URL || !EMAIL || !PASSWORD, "verification-only spec");

async function seat(name: string) {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  const { rows } = await client.query(
    `select id, name, title, description, instructions
       from bots
      where name = $1 and "workspaceId" = '450778855ed0fb6ea768c820623b7622'`,
    [name],
  );
  await client.end();
  const row = rows[0];
  return {
    ...row,
    bytes: Buffer.byteLength(row.instructions, "utf8"),
    hash: createHash("md5").update(row.instructions).digest("hex"),
  };
}

async function signIn(page: import("@playwright/test").Page) {
  await page.goto("/sign-in");
  await page.getByPlaceholder("Your email address").fill(EMAIL!);
  await page.getByPlaceholder("Password").fill(PASSWORD!);
  await page.getByRole("button", { name: /Sign in/i }).click();
  await page.waitForURL(/\/app/, { timeout: 30_000 });
}

test("Settings Save leaves a real seat's persona byte-identical", async ({ page }, testInfo) => {
  const before = await seat("Spur");
  expect(before.bytes).toBeGreaterThan(1500); // a real persona, not a blurb

  await signIn(page);
  await page.goto(`/app/${before.id}`);

  // Open the settings panel for this seat.
  await page.locator("main").getByRole("button", { name: "Spur", exact: true }).click();
  const nameInput = page.locator("label:has-text('Name') input");
  await expect(nameInput).toHaveValue("Spur");
  await page.screenshot({ path: testInfo.outputPath("settings-open.png"), fullPage: true });

  // Press Save with the panel exactly as the user finds it.
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByPlaceholder("Message Spur")).toBeVisible({ timeout: 20_000 });

  const after = await seat("Spur");
  expect(after.bytes).toBe(before.bytes);
  expect(after.hash).toBe(before.hash);
  expect(after.instructions).toBe(before.instructions);

  // Editing the description and saving must still not touch the persona.
  await page.locator("main").getByRole("button", { name: "Spur", exact: true }).click();
  const description = page.locator("label:has-text('Description') textarea");
  await description.fill("edited by the integration proof");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByPlaceholder("Message Spur")).toBeVisible({ timeout: 20_000 });

  const edited = await seat("Spur");
  expect(edited.description).toBe("edited by the integration proof");
  expect(edited.hash).toBe(before.hash);
  expect(edited.bytes).toBe(before.bytes);
  await page.screenshot({ path: testInfo.outputPath("after-save.png"), fullPage: true });
});

test("the 4s bot-list poll keeps the open seat", async ({ page }) => {
  const thor = await seat("Thor");
  await signIn(page);
  await page.goto(`/app/${thor.id}`);
  await expect(page.getByPlaceholder("Message Thor")).toBeVisible({ timeout: 20_000 });

  // The poll runs every 4s; before the botIdRef fix it navigated back to list[0].
  await page.waitForTimeout(14_000);

  expect(new URL(page.url()).pathname).toBe(`/app/${thor.id}`);
  await expect(page.getByPlaceholder("Message Thor")).toBeVisible();
});
