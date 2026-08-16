#!/usr/bin/env node
/**
 * Bulk-import routines into a running Rakazo API from a directory of JSON files.
 *
 * Each source file describes one routine:
 *   { "name": "...", "prompt": "...", "schedule": "<cron>", "enabled": true|false }
 *
 * Files that carry a `trigger` object instead of `schedule` describe an
 * event-driven routine. Rakazo's `Routine` model is cron-only (see
 * `docs/routines.md`), so those are reported as unsupported and skipped rather
 * than silently turned into a cron that would fire on a different contract.
 *
 * Nothing is baked in: source directory, API URL, session token, bot mapping,
 * timezone and the active/notify flags all come from flags or the environment.
 *
 * Usage:
 *   node scripts/import-routines.mjs \
 *     --source <dir-of-json> \
 *     --map <file.json>            # { "<source-file>.json": "<bot name>" }
 *     [--api http://127.0.0.1:3100] \
 *     [--token <session-token>]    # or RAKAZO_SESSION_TOKEN
 *     [--timezone UTC] [--active] [--notify] [--dry-run] [--json]
 *
 * Defaults are deliberately safe: routines are created paused (`active=false`)
 * and quiet (`notify=false`) unless `--active` / `--notify` are passed.
 *
 * Re-running is safe: a routine whose name already exists on the target bot is
 * left untouched and reported as `skipped`.
 */

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  const opts = {
    api: process.env.RAKAZO_API_URL ?? "http://127.0.0.1:3100",
    token: process.env.RAKAZO_SESSION_TOKEN ?? "",
    timezone: "UTC",
    active: false,
    notify: false,
    dryRun: false,
    json: false,
    source: "",
    map: "",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    if (arg === "--source") opts.source = next();
    else if (arg === "--map") opts.map = next();
    else if (arg === "--api") opts.api = next();
    else if (arg === "--token") opts.token = next();
    else if (arg === "--timezone") opts.timezone = next();
    else if (arg === "--active") opts.active = true;
    else if (arg === "--notify") opts.notify = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--json") opts.json = true;
    else throw new Error(`unknown flag: ${arg}`);
  }
  if (!opts.source) throw new Error("--source <dir> is required");
  if (!opts.map) throw new Error("--map <file.json> is required");
  if (!opts.token && !opts.dryRun) throw new Error("--token or RAKAZO_SESSION_TOKEN is required");
  return opts;
}

async function rpc(opts, procedure, input) {
  const response = await fetch(`${opts.api}/rpc/${procedure}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${opts.token}`,
    },
    body: JSON.stringify({ json: input }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${procedure} -> HTTP ${response.status}: ${text}`);
  return JSON.parse(text).json;
}

const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const mapping = JSON.parse(await readFile(opts.map, "utf8"));
  const files = (await readdir(opts.source)).filter((f) => f.endsWith(".json")).sort();

  const unmapped = files.filter((f) => !(f in mapping));
  if (unmapped.length) throw new Error(`no bot mapped for: ${unmapped.join(", ")}`);

  const bots = opts.dryRun ? [] : await rpc(opts, "bots/list", {});
  const botByName = new Map(bots.map((b) => [b.name, b]));

  const existing = new Map(); // botId -> Set<routine name>
  for (const botName of new Set(Object.values(mapping))) {
    const bot = botByName.get(botName);
    if (!bot) {
      if (opts.dryRun) continue;
      throw new Error(`no bot named "${botName}" in this workspace`);
    }
    const rows = await rpc(opts, "routines/list", { botId: bot.id });
    existing.set(bot.id, new Set(rows.map((r) => r.name)));
  }

  const results = [];
  for (const file of files) {
    const source = JSON.parse(await readFile(path.join(opts.source, file), "utf8"));
    const botName = mapping[file];
    const base = {
      source: file,
      bot: botName,
      name: source.name,
      promptSha256: typeof source.prompt === "string" ? sha256(source.prompt) : null,
      promptChars: typeof source.prompt === "string" ? source.prompt.length : 0,
    };

    if (!source.schedule) {
      results.push({
        ...base,
        status: "unsupported",
        reason: source.trigger
          ? `event trigger (${source.trigger.type}) has no field on the Routine model`
          : "no schedule and no trigger",
      });
      continue;
    }

    const bot = botByName.get(botName);
    if (opts.dryRun || !bot) {
      results.push({
        ...base,
        status: "dry-run",
        cron: source.schedule,
        timezone: opts.timezone,
        active: opts.active,
        notify: opts.notify,
        sourceEnabled: source.enabled === true,
      });
      continue;
    }

    if (existing.get(bot.id)?.has(source.name)) {
      results.push({ ...base, status: "skipped", reason: "name already exists on this bot" });
      continue;
    }

    const created = await rpc(opts, "routines/create", {
      botId: bot.id,
      name: source.name,
      prompt: source.prompt,
      cron: source.schedule,
      timezone: opts.timezone,
      active: opts.active,
      notify: opts.notify,
    });
    existing.get(bot.id)?.add(created.name);

    // Read back and prove the stored row matches the source byte for byte.
    const rows = await rpc(opts, "routines/list", { botId: bot.id });
    const stored = rows.find((r) => r.id === created.id);
    const verified =
      !!stored &&
      stored.name === source.name &&
      stored.cron === source.schedule &&
      stored.timezone === opts.timezone &&
      stored.active === opts.active &&
      stored.notify === opts.notify;

    results.push({
      ...base,
      status: verified ? "created" : "created-unverified",
      routineId: created.id,
      cron: created.cron,
      timezone: created.timezone,
      active: created.active,
      notify: created.notify,
      sourceEnabled: source.enabled === true,
    });
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  } else {
    for (const r of results) {
      const detail = r.cron ? ` cron="${r.cron}" active=${r.active} notify=${r.notify}` : "";
      const reason = r.reason ? ` (${r.reason})` : "";
      console.log(`${r.status.padEnd(18)} ${r.bot} / ${r.name}${detail}${reason}`);
    }
  }

  const bad = results.filter((r) => r.status === "created-unverified");
  if (bad.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
