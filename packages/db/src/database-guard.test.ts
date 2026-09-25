import { describe, expect, it } from "vitest";
import {
  assertTestDatabaseUrl,
  guardPrismaCommand,
  isTestDatabaseName,
  prismaCommand,
} from "./database-guard.js";

// Nothing listens on port 1, so any connection attempt would fail with ECONNREFUSED instead.
const UNREACHABLE = "postgres://rakazo:secret@127.0.0.1:1";

describe("database guard", () => {
  it("accepts only names with test as their own word", () => {
    for (const name of [
      "test",
      "rakazo_test",
      "rakazo-test",
      "test_rakazo",
      "integration_3_test",
    ]) {
      expect(isTestDatabaseName(name)).toBe(true);
    }
    for (const name of ["rakazo", "postgres", "latest", "contest_db", "testing", "rakazotest"]) {
      expect(isTestDatabaseName(name)).toBe(false);
    }
  });

  it("names the database in the refusal without echoing credentials", () => {
    expect(() => assertTestDatabaseUrl(`${UNREACHABLE}/rakazo`, "DATABASE_URL")).toThrow(
      /Refusing to use database "rakazo" from DATABASE_URL/,
    );
    expect(() => assertTestDatabaseUrl(`${UNREACHABLE}/rakazo`, "DATABASE_URL")).not.toThrow(
      /secret/,
    );
    expect(() => assertTestDatabaseUrl("not a url", "DATABASE_URL")).toThrow(/not a database URL/);
  });

  it("reads the Prisma command from CLI arguments", () => {
    expect(prismaCommand(["migrate", "deploy", "--schema", "x"])).toBe("migrate deploy");
    expect(prismaCommand(["db", "push"])).toBe("db push");
    expect(prismaCommand(["generate"])).toBe("generate");
    expect(prismaCommand(["--version"])).toBe("");
    expect(prismaCommand([])).toBe("");
  });

  it("does not connect for commands that cannot write", async () => {
    const env = { DATABASE_URL: `${UNREACHABLE}/rakazo` };
    for (const args of [["generate"], ["validate"], ["migrate", "status"], ["--version"]]) {
      await expect(guardPrismaCommand(args, env)).resolves.toBeUndefined();
    }
  });

  it("checks the database before a write command runs", async () => {
    await expect(
      guardPrismaCommand(["migrate", "deploy"], { DATABASE_URL: `${UNREACHABLE}/rakazo` }),
    ).rejects.toThrow(/ECONNREFUSED/);
  });
});
