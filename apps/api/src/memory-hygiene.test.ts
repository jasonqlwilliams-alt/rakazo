import { createRouterClient } from "@orpc/server";
import type { AdapterContext } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { MarkdownMemoryStore } from "@rakazo/memory";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

interface StoredDoc {
  id: string;
  spaceId: string;
  userId: string;
  botId: string | null;
  scope: string;
  path: string;
  content: string;
  revision: number;
  updatedAt: Date;
}

function createFixture(initialDocs: StoredDoc[]) {
  const actor = {
    userId: "user-1",
    spaceId: "space-1",
    email: "owner@example.test",
    isDeploymentOwner: false,
  } satisfies Actor;

  const docs = initialDocs.map((doc) => ({ ...doc }));
  const revisions: Array<{ documentId: string; revision: number; content: string }> = [];

  const matchesScope = (scope: string, filter: unknown): boolean => {
    if (!filter) return true;
    if (typeof filter === "string") return scope === filter;
    if (typeof filter === "object" && filter !== null && "in" in filter) {
      return ((filter as { in: string[] }).in ?? []).includes(scope);
    }
    return true;
  };

  const matchesOr = (doc: StoredDoc, clauses?: Array<{ botId?: string | null }>): boolean => {
    if (!clauses) return true;
    return clauses.some((clause) => doc.botId === (clause.botId ?? null));
  };

  const prisma = {
    memoryDocument: {
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: {
            spaceId: string;
            userId: string;
            botId?: string;
            scope?: unknown;
            path?: string;
            OR?: Array<{ botId?: string | null }>;
          };
        }) =>
          docs.filter(
            (doc) =>
              doc.spaceId === where.spaceId &&
              doc.userId === where.userId &&
              (where.botId === undefined || doc.botId === where.botId) &&
              (where.path === undefined || doc.path === where.path) &&
              matchesScope(doc.scope, where.scope) &&
              matchesOr(doc, where.OR),
          ),
      ),
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where: {
            id?: string;
            spaceId?: string;
            userId?: string;
            scope?: string;
            botId?: string | null;
            path?: string;
          };
        }) =>
          docs.find(
            (doc) =>
              (where.id === undefined || doc.id === where.id) &&
              (where.spaceId === undefined || doc.spaceId === where.spaceId) &&
              (where.userId === undefined || doc.userId === where.userId) &&
              (where.scope === undefined || doc.scope === where.scope) &&
              (where.botId === undefined || doc.botId === where.botId) &&
              (where.path === undefined || doc.path === where.path),
          ) ?? null,
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: { scope?: string; path?: string; content?: string; revision?: number };
        }) => {
          const doc = docs.find((entry) => entry.id === where.id);
          if (!doc) throw new Error("Document not found");
          Object.assign(doc, data, { updatedAt: new Date("2026-11-04T12:00:00.000Z") });
          return { ...doc };
        },
      ),
    },
    memoryRevision: {
      create: vi.fn(
        async ({ data }: { data: { documentId: string; revision: number; content: string } }) => {
          revisions.push(data);
          return data;
        },
      ),
    },
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(prisma)),
  };

  const memory = new MarkdownMemoryStore(prisma as unknown as PrismaClient);
  const client = createRouterClient(
    createRouter({
      prisma: prisma as unknown as PrismaClient,
      memory,
      env: { webOrigin: "http://127.0.0.1", sandboxProvider: "fake", agentRuntime: "scripted" },
    } as RouterDeps),
    { context: { actor } },
  );

  return { actor, client, docs, memory, prisma, revisions };
}

describe("memory scope filtering and archiving", () => {
  it("filters list and exportMarkdown to bot and user scopes by default while allowing explicit archive reads", async () => {
    const now = new Date("2026-11-04T00:00:00.000Z");
    const { client } = createFixture([
      {
        id: "doc-bot",
        spaceId: "space-1",
        userId: "user-1",
        botId: "bot-1",
        scope: "bot",
        path: "MEMORY.md",
        content: "Bot note",
        revision: 1,
        updatedAt: now,
      },
      {
        id: "doc-user",
        spaceId: "space-1",
        userId: "user-1",
        botId: null,
        scope: "user",
        path: "preferences.md",
        content: "User note",
        revision: 1,
        updatedAt: now,
      },
      {
        id: "doc-quarantine",
        spaceId: "space-1",
        userId: "user-1",
        botId: "bot-1",
        scope: "quarantine",
        path: "quarantined.md",
        content: "Quarantined payload",
        revision: 1,
        updatedAt: now,
      },
      {
        id: "doc-archive",
        spaceId: "space-1",
        userId: "user-1",
        botId: "bot-1",
        scope: "archive",
        path: "2026-11-01/log.md",
        content: "Archived payload",
        revision: 2,
        updatedAt: now,
      },
    ]);

    const active = await client.memory.list({});
    expect(active.map((doc) => doc.id)).toEqual(["doc-bot", "doc-user"]);

    const archived = await client.memory.list({ scope: "archive" });
    expect(archived.map((doc) => doc.id)).toEqual(["doc-archive"]);

    const exported = await client.memory.exportMarkdown({});
    expect(exported).toContain("Bot note");
    expect(exported).toContain("User note");
    expect(exported).not.toContain("Quarantined payload");
    expect(exported).not.toContain("Archived payload");

    const botExport = await client.memory.exportMarkdown({ scope: "bot" });
    expect(botExport).toContain("Bot note");
    expect(botExport).not.toContain("User note");
    expect(botExport).not.toContain("Archived payload");

    const userExport = await client.memory.exportMarkdown({ scope: "user" });
    expect(userExport).toContain("User note");
    expect(userExport).not.toContain("Bot note");
    expect(userExport).not.toContain("Archived payload");

    const archiveExport = await client.memory.exportMarkdown({ scope: "archive" });
    expect(archiveExport).toContain("Archived payload");
    expect(archiveExport).not.toContain("Bot note");
    expect(archiveExport).not.toContain("User note");

    await expect(
      client.memory.exportMarkdown({ scope: "quarantine" as "archive" }),
    ).rejects.toThrow();

    await expect(
      client.memory.update({ documentId: "doc-quarantine", content: "edited" }),
    ).rejects.toThrow("Only bot or user memory documents can be edited.");
    await expect(
      client.memory.update({ documentId: "doc-archive", content: "edited" }),
    ).rejects.toThrow("Only bot or user memory documents can be edited.");
  });

  it("moves bot or user documents to archive on collision-safe dated paths and records a revision", async () => {
    const now = new Date("2026-11-04T00:00:00.000Z");
    const today = new Date().toISOString().slice(0, 10);
    const { client, revisions } = createFixture([
      {
        id: "doc-1",
        spaceId: "space-1",
        userId: "user-1",
        botId: "bot-1",
        scope: "bot",
        path: "log/monthly.md",
        content: "First monthly log",
        revision: 3,
        updatedAt: now,
      },
      {
        id: "doc-existing-archive",
        spaceId: "space-1",
        userId: "user-1",
        botId: "bot-1",
        scope: "archive",
        path: `${today}/log/monthly.md`,
        content: "Earlier archived log",
        revision: 2,
        updatedAt: now,
      },
    ]);

    const archived = await client.memory.archive({ documentId: "doc-1" });
    expect(archived).toMatchObject({
      id: "doc-1",
      scope: "archive",
      botId: "bot-1",
      path: `${today}/log/monthly-2.md`,
      content: "First monthly log",
      revision: 4,
    });
    expect(revisions).toEqual([
      {
        documentId: "doc-1",
        revision: 4,
        content: "First monthly log",
      },
    ]);
    await expect(client.memory.archive({ documentId: "doc-1" })).rejects.toThrow(
      "Only bot or user memory documents can be archived.",
    );
  });

  it("isolates MarkdownMemoryStore archive reads to the requesting bot and shared user archives", async () => {
    const now = new Date("2026-11-04T00:00:00.000Z");
    const { memory } = createFixture([
      {
        id: "arch-bot-1",
        spaceId: "space-1",
        userId: "user-1",
        botId: "bot-1",
        scope: "archive",
        path: "2026-11-04/own.md",
        content: "Bot 1 archive",
        revision: 1,
        updatedAt: now,
      },
      {
        id: "arch-user",
        spaceId: "space-1",
        userId: "user-1",
        botId: null,
        scope: "archive",
        path: "2026-11-04/shared.md",
        content: "Shared user archive",
        revision: 1,
        updatedAt: now,
      },
      {
        id: "arch-bot-2",
        spaceId: "space-1",
        userId: "user-1",
        botId: "bot-2",
        scope: "archive",
        path: "2026-11-04/other.md",
        content: "Bot 2 private archive",
        revision: 1,
        updatedAt: now,
      },
    ]);

    const snapshot = await memory.read({ scope: "archive", botId: "bot-1" }, {
      spaceId: "space-1",
      userId: "user-1",
      operationId: "op",
      traceId: "tr",
      signal: new AbortController().signal,
    } as AdapterContext);
    expect(snapshot.documents.map((doc) => doc.id)).toEqual(["arch-bot-1", "arch-user"]);
  });
});
