import { execFileSync } from "node:child_process";
import path from "node:path";
import { createDb } from "@rakazo/db";
import {
  DATABASE_ENVIRONMENT_VARIABLE,
  PRODUCTION_DATABASE_MARKER,
} from "@rakazo/db/database-guard";
import { afterAll, describe, expect, it } from "vitest";
import { prepareTestDatabases } from "./test-database.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

const created = new Set<string>();

/** Advisory lock Prisma Migrate holds while it reads or applies migrations. */
const PRISMA_MIGRATE_LOCK = 72707369;

function urlFor(name: string) {
  const url = new URL(databaseUrl!);
  url.pathname = `/${name}`;
  return url.toString();
}

async function query<T>(url: string, sql: string): Promise<T[]> {
  const { prisma, pool } = createDb(url);
  try {
    return (await pool.query(sql)).rows as T[];
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

async function createDatabase(name: string, comment?: string) {
  created.add(name);
  await query(urlFor("postgres"), `create database "${name}"`);
  if (comment) await query(urlFor(name), `comment on database "${name}" is '${comment}'`);
}

async function tableCount(name: string) {
  const [row] = await query<{ count: string }>(
    urlFor(name),
    "select count(*) from information_schema.tables where table_schema = 'public'",
  );
  return Number(row!.count);
}

async function marker(name: string) {
  const [row] = await query<{ marker: string | null }>(
    urlFor(name),
    "select shobj_description(oid, 'pg_database') as marker from pg_database where datname = current_database()",
  );
  return row!.marker;
}

function prisma(args: string[], env: Record<string, string>) {
  const childEnv = { ...process.env };
  delete childEnv[DATABASE_ENVIRONMENT_VARIABLE];
  Object.assign(childEnv, env);
  try {
    execFileSync("pnpm", ["exec", "prisma", ...args], {
      cwd: path.resolve(import.meta.dirname, "../../db"),
      env: childEnv,
      stdio: "pipe",
    });
    return "";
  } catch (error) {
    const { stdout, stderr } = error as { stdout?: Buffer; stderr?: Buffer };
    return `${stdout ?? ""}${stderr ?? ""}`;
  }
}

describePostgres("database guard against a real server", () => {
  afterAll(async () => {
    for (const name of created) {
      await query(urlFor("postgres"), `drop database if exists "${name}" with (force)`);
    }
  });

  it("refuses a real non-test database and leaves it untouched", async () => {
    await createDatabase("guard_live_like");
    await expect(
      prepareTestDatabases({ VERIFY_DATABASE: "1", DATABASE_URL: urlFor("guard_live_like") }),
    ).rejects.toThrow(/Refusing to use database "guard_live_like"/);
    expect(await tableCount("guard_live_like")).toBe(0);
  });

  it("refuses a production-marked database even when its name says test", async () => {
    await createDatabase("guard_marked_test", PRODUCTION_DATABASE_MARKER);
    await expect(
      prepareTestDatabases({ VERIFY_DATABASE: "1", DATABASE_URL: urlFor("guard_marked_test") }),
    ).rejects.toThrow(/marked as production/);
    expect(await tableCount("guard_marked_test")).toBe(0);
  });

  it("creates and migrates a missing test database, never marking it as production", async () => {
    created.add("guard_fresh_test");
    const claim = process.env[DATABASE_ENVIRONMENT_VARIABLE];
    // A deployment's claim can leak in from a checkout's .env; the test database must stay unmarked.
    process.env[DATABASE_ENVIRONMENT_VARIABLE] = "production";
    try {
      await prepareTestDatabases({
        VERIFY_DATABASE: "1",
        DATABASE_URL: urlFor("guard_fresh_test"),
      });
    } finally {
      if (claim === undefined) delete process.env[DATABASE_ENVIRONMENT_VARIABLE];
      else process.env[DATABASE_ENVIRONMENT_VARIABLE] = claim;
    }
    const [row] = await query<{ count: string }>(
      urlFor("guard_fresh_test"),
      "select count(*) from _prisma_migrations where finished_at is not null",
    );
    expect(Number(row!.count)).toBeGreaterThan(0);
    expect(await marker("guard_fresh_test")).toBeNull();
  });

  it("migrates an existing test database that has never been migrated", async () => {
    await createDatabase("guard_empty_test");
    await prepareTestDatabases({ VERIFY_DATABASE: "1", DATABASE_URL: urlFor("guard_empty_test") });
    expect(await tableCount("guard_empty_test")).toBeGreaterThan(0);
  });

  it("does not run Prisma on a test database with no pending migrations", async () => {
    const url = urlFor("guard_fresh_test");
    const { prisma: client, pool } = createDb(url);
    const session = await pool.connect();
    try {
      // Prisma would wait for this lock and then fail, so returning proves it never ran.
      await session.query("select pg_advisory_lock($1)", [PRISMA_MIGRATE_LOCK]);
      await prepareTestDatabases({ VERIFY_DATABASE: "1", DATABASE_URL: url });
    } finally {
      session.release();
      await client.$disconnect();
      await pool.end();
    }
  });

  it("stops Prisma from migrating or resetting a production-marked database", async () => {
    const url = urlFor("guard_marked_test");
    const refusal = prisma(["migrate", "deploy"], { DATABASE_URL: url });
    expect(refusal).toMatch(
      /Refusing prisma migrate deploy: the database is marked as production\. It belongs to its deployment, and only that deployment's own service migrates it\./,
    );
    expect(refusal).not.toContain(DATABASE_ENVIRONMENT_VARIABLE);
    expect(
      prisma(["migrate", "reset", "--force"], {
        DATABASE_URL: url,
        [DATABASE_ENVIRONMENT_VARIABLE]: "production",
      }),
    ).toMatch(/Refusing prisma migrate reset/);
    for (const args of [
      ["--config", "prisma.config.ts", "migrate", "deploy"],
      ["--config=prisma.config.ts", "migrate", "deploy"],
      ["migrate", "--config", "prisma.config.ts", "deploy"],
    ]) {
      expect(prisma(args, { DATABASE_URL: url })).toMatch(/Refusing prisma migrate deploy/);
    }
    expect(await tableCount("guard_marked_test")).toBe(0);
  });

  it("lets the owning deployment migrate and mark its database", async () => {
    await createDatabase("guard_owned");
    const env = {
      DATABASE_URL: urlFor("guard_owned"),
      [DATABASE_ENVIRONMENT_VARIABLE]: "production",
    };
    expect(prisma(["migrate", "deploy"], env)).toBe("");
    expect(await marker("guard_owned")).toBe(PRODUCTION_DATABASE_MARKER);
    expect(await tableCount("guard_owned")).toBeGreaterThan(0);
    expect(prisma(["migrate", "deploy"], env)).toBe("");
    expect(prisma(["migrate", "deploy"], { DATABASE_URL: urlFor("guard_owned") })).toMatch(
      /marked as production/,
    );
  });
});
