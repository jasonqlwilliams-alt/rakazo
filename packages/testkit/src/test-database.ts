import { assertTestDatabaseUrl, prepareTestDatabase } from "@rakazo/db/database-guard";

/**
 * Vitest global setup. Postgres-gated tests (VERIFY_DATABASE) write freely, so before any test
 * file loads, both database URLs must name a disposable test database. The main one is created
 * when missing and migrated when migrations are pending.
 */
export async function prepareTestDatabases(env: NodeJS.ProcessEnv): Promise<void> {
  if (!env.VERIFY_DATABASE) return;
  if (env.REALTIME_DATABASE_URL) {
    assertTestDatabaseUrl(env.REALTIME_DATABASE_URL, "REALTIME_DATABASE_URL");
  }
  if (env.DATABASE_URL) await prepareTestDatabase(env.DATABASE_URL);
}

export default function setup() {
  return prepareTestDatabases(process.env);
}
