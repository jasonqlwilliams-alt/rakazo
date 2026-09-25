import { describe, expect, it } from "vitest";
import { prepareTestDatabases } from "./test-database.js";

// Nothing listens on port 1: a refusal proves the setup stopped before it tried to connect,
// because any connection attempt would fail with ECONNREFUSED instead.
const SERVER = "postgres://rakazo:rakazo@127.0.0.1:1";

describe("Postgres test setup", () => {
  it("refuses a non-test database before connecting", async () => {
    await expect(
      prepareTestDatabases({ VERIFY_DATABASE: "1", DATABASE_URL: `${SERVER}/rakazo` }),
    ).rejects.toThrow(/Refusing to use database "rakazo" from DATABASE_URL/);
  });

  it("refuses a non-test realtime database before connecting", async () => {
    await expect(
      prepareTestDatabases({
        VERIFY_DATABASE: "1",
        DATABASE_URL: `${SERVER}/rakazo_test`,
        REALTIME_DATABASE_URL: `${SERVER}/rakazo`,
      }),
    ).rejects.toThrow(/Refusing to use database "rakazo" from REALTIME_DATABASE_URL/);
  });

  it("leaves the database alone when Postgres tests are off", async () => {
    await expect(
      prepareTestDatabases({ DATABASE_URL: `${SERVER}/rakazo` }),
    ).resolves.toBeUndefined();
  });
});
