import { Client, Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { RealtimeListenerClient } from "./realtime.js";
import { PostgresRealtimeFanout } from "./realtime.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

describePostgres("PostgresRealtimeFanout (PostgreSQL contract)", () => {
  it("reconnects a real listener and signals durable catch-up for a missed notification", async () => {
    const pool = new Pool({ connectionString: databaseUrl! });
    const table = `realtime_contract_events_${process.pid}_${Date.now()}`;
    const listenerClients: Client[] = [];
    const signals: string[] = [];
    const seen: string[] = [];
    let cursor = 0;
    let drainError: unknown;
    let draining = Promise.resolve();
    let allowReconnect!: () => void;
    const reconnectAllowed = new Promise<void>((resolve) => {
      allowReconnect = resolve;
    });

    await pool.query(`CREATE TABLE ${table} (id bigserial PRIMARY KEY, body text NOT NULL)`);
    const realtime = new PostgresRealtimeFanout({
      connectionString: databaseUrl!,
      publisher: {
        query: async (sql, values) => pool.query(sql, values),
      },
      clientFactory: () => {
        const client = new Client({ connectionString: databaseUrl! });
        const listener = client as RealtimeListenerClient;
        if (listenerClients.length > 0) {
          const connect = listener.connect.bind(listener);
          vi.spyOn(listener, "connect").mockImplementation(async () => {
            await connect();
            // Keep LISTEN and its catch-up behind the disconnected event's commit.
            await reconnectAllowed;
          });
        }
        listenerClients.push(client);
        return listener;
      },
      reconnectBaseMs: 100,
      reconnectMaxMs: 100,
      random: () => 0,
    });

    try {
      const unsubscribe = await realtime.subscribe("thread:contract", (signal) => {
        signals.push(signal);
        draining = draining
          .then(async () => {
            const result = await pool.query<{ id: string; body: string }>(
              `SELECT id, body FROM ${table} WHERE id > $1 ORDER BY id`,
              [cursor],
            );
            for (const row of result.rows) {
              cursor = Number(row.id);
              seen.push(row.body);
            }
          })
          .catch((error: unknown) => {
            drainError = error;
          });
      });

      await vi.waitFor(() => expect(signals).toEqual([""]), { timeout: 5_000 });
      const pidResult = await listenerClients[0]!.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      const listenerPid = pidResult.rows[0]!.pid;

      await pool.query(`INSERT INTO ${table} (body) VALUES ($1)`, ["notified-event"]);
      await realtime.publish("thread:contract", "durable-event-available");
      await vi.waitFor(() => expect(seen).toEqual(["notified-event"]), { timeout: 5_000 });

      await pool.query("SELECT pg_terminate_backend($1)", [listenerPid]);
      await vi.waitFor(() => expect(listenerClients).toHaveLength(2), { timeout: 5_000 });
      await pool.query(`INSERT INTO ${table} (body) VALUES ($1)`, ["missed-while-disconnected"]);
      await realtime.publish("thread:contract", "missed-notification");
      expect(signals).toEqual(["", "durable-event-available"]);
      expect(seen).toEqual(["notified-event"]);
      allowReconnect();

      await vi.waitFor(
        () => {
          expect(listenerClients.length).toBeGreaterThanOrEqual(2);
          expect(signals.filter((signal) => signal === "")).toHaveLength(2);
          expect(seen).toEqual(["notified-event", "missed-while-disconnected"]);
        },
        { timeout: 10_000, interval: 25 },
      );
      await draining;
      expect(drainError).toBeUndefined();
      expect(signals).toContain("durable-event-available");
      expect(signals).not.toContain("missed-notification");
      await unsubscribe();
    } finally {
      allowReconnect();
      await realtime.close();
      await pool.query(`DROP TABLE IF EXISTS ${table}`).catch(() => undefined);
      await pool.end();
    }
  });
});
