import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

/**
 * Tests and Prisma commands reach whatever database their environment names, so a stray
 * DATABASE_URL can migrate or fill a live database. Tests only accept a disposable database
 * named as one, and a deployment marks the database it owns so Prisma commands from any
 * other checkout refuse to write to it.
 */

/** Database comment the owning deployment sets on first `migrate deploy`. */
export const PRODUCTION_DATABASE_MARKER = "rakazo:production";

/** Set to `production` only where the deployment that owns DATABASE_URL runs its migrations. */
export const DATABASE_ENVIRONMENT_VARIABLE = "RAKAZO_DATABASE_ENVIRONMENT";

const DB_PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = path.join(DB_PACKAGE_DIR, "prisma/migrations");

const WRITE_COMMANDS = new Set([
  "migrate deploy",
  "migrate dev",
  "migrate reset",
  "migrate resolve",
  "db push",
  "db execute",
  "db seed",
  "studio",
]);

/** Commands that can drop data, so never run on a production database. */
const RESET_COMMANDS = new Set(["migrate dev", "migrate reset", "db push"]);

export function databaseName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.slice(1));
}

/** A disposable test database has `test` as its own word in its name, such as `rakazo_test`. */
export function isTestDatabaseName(name: string): boolean {
  return /(^|[_-])test($|[_-])/i.test(name);
}

export function assertTestDatabaseUrl(url: string, variable: string): void {
  let name: string;
  try {
    name = databaseName(url);
  } catch {
    throw new Error(`${variable} is not a database URL.`);
  }
  if (!isTestDatabaseName(name)) {
    throw new Error(
      `Refusing to use database "${name}" from ${variable}: tests only run against a disposable database with "test" as its own word in the name, such as "rakazo_test".`,
    );
  }
}

async function readMarker(client: Client): Promise<string | null> {
  const { rows } = await client.query<{ marker: string | null }>(
    "select shobj_description(oid, 'pg_database') as marker from pg_database where datname = current_database()",
  );
  return rows[0]?.marker ?? null;
}

async function withClient<T>(url: string, use: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await use(client);
  } finally {
    await client.end();
  }
}

/** The Prisma CLI command in `args`, such as `migrate deploy`, or "" when there is none. */
export function prismaCommand(args: readonly string[]): string {
  const [first, second] = args;
  if (!first || first.startsWith("-")) return "";
  if ((first === "migrate" || first === "db") && second && !second.startsWith("-")) {
    return `${first} ${second}`;
  }
  return first;
}

/**
 * Runs from `prisma.config.ts` before every Prisma CLI command. A production-marked database
 * accepts writes only from its owning deployment and never accepts a reset. The owning
 * deployment marks an unmarked database the first time it applies migrations.
 */
export async function guardPrismaCommand(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const command = prismaCommand(args);
  const url = env.DATABASE_URL;
  if (!WRITE_COMMANDS.has(command) || !url) return;
  const owner = env[DATABASE_ENVIRONMENT_VARIABLE] === "production";
  await withClient(url, async (client) => {
    const marker = await readMarker(client);
    if (marker === PRODUCTION_DATABASE_MARKER) {
      if (RESET_COMMANDS.has(command)) {
        throw new Error(
          `Refusing prisma ${command}: the database is marked as production and this command can drop data.`,
        );
      }
      if (!owner) {
        throw new Error(
          `Refusing prisma ${command}: the database is marked as production. It belongs to its deployment, and only that deployment's own service migrates it.`,
        );
      }
      return;
    }
    // A test database stays disposable even when the environment claims production.
    if (!owner || command !== "migrate deploy" || isTestDatabaseName(databaseName(url))) return;
    if (marker !== null) {
      process.stderr.write(
        "The production database already has a comment, so it was not marked as production.\n",
      );
      return;
    }
    try {
      await client.query(
        `do $$ begin execute format('comment on database %I is %L', current_database(), '${PRODUCTION_DATABASE_MARKER}'); end $$`,
      );
    } catch (error) {
      process.stderr.write(
        `Could not mark the database as production: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  });
}

async function hasPendingMigrations(client: Client): Promise<boolean> {
  const { rows } = await client
    .query<{ migration_name: string }>(
      "select migration_name from _prisma_migrations where finished_at is not null and rolled_back_at is null",
    )
    .catch((error: { code?: string }) => {
      // 42P01: no migration has ever run here.
      if (error.code === "42P01") return { rows: [] };
      throw error;
    });
  const applied = new Set(rows.map((row) => row.migration_name));
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true }).some(
    (entry) => entry.isDirectory() && !applied.has(entry.name),
  );
}

/**
 * Makes `url` ready for Postgres-gated tests: refuses a non-test name before connecting,
 * refuses a production-marked database, creates the database when missing, and applies
 * migrations when any are pending.
 */
export async function prepareTestDatabase(url: string): Promise<void> {
  assertTestDatabaseUrl(url, "DATABASE_URL");
  const pending = await withClient(url, async (client) => {
    if ((await readMarker(client)) === PRODUCTION_DATABASE_MARKER) {
      throw new Error(
        `Refusing to use database "${databaseName(url)}" from DATABASE_URL: it is marked as production.`,
      );
    }
    return hasPendingMigrations(client);
  }).catch(async (error: { code?: string }) => {
    // 3D000: the database does not exist yet.
    if (error.code !== "3D000") throw error;
    const server = new URL(url);
    server.pathname = "/postgres";
    await withClient(server.toString(), (client) =>
      client.query(`create database "${databaseName(url).replaceAll('"', '""')}"`),
    );
    return true;
  });
  if (!pending) return;
  try {
    execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy"], {
      cwd: DB_PACKAGE_DIR,
      env: { ...process.env, DATABASE_URL: url },
      stdio: "pipe",
    });
  } catch (error) {
    const { stdout, stderr } = error as { stdout?: Buffer; stderr?: Buffer };
    throw new Error(`Could not migrate the test database:\n${stdout ?? ""}${stderr ?? ""}`);
  }
}
