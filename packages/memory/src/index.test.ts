import type { AdapterContext } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { appendMemoryContent, MarkdownMemoryStore } from "./index.js";

const context: AdapterContext = {
  operationId: "read-memory",
  traceId: "read-memory",
  spaceId: "workspace-1",
  userId: "user-1",
  signal: new AbortController().signal,
};

describe("memory store contract shape", () => {
  it("declares markdown portability", () => {
    const store = new MarkdownMemoryStore({} as never);
    expect(store.describe().capabilities.markdownPortable).toBe(true);
  });

  it("reads the most recently updated documents first", async () => {
    const updatedAt = new Date("2026-08-16T10:00:00.000Z");
    const findMany = vi
      .fn()
      .mockResolvedValue([
        { id: "memory-1", path: "facts.md", content: "A fact", revision: 3, updatedAt },
      ]);
    const store = new MarkdownMemoryStore({ memoryDocument: { findMany } } as never);

    await expect(store.read({ scope: "bot", botId: "bot-1" }, context)).resolves.toEqual({
      documents: [
        {
          id: "memory-1",
          path: "facts.md",
          content: "A fact",
          revision: 3,
          updatedAt: updatedAt.toISOString(),
        },
      ],
    });
    expect(findMany).toHaveBeenCalledWith({
      where: {
        spaceId: "workspace-1",
        userId: "user-1",
        scope: "bot",
        botId: "bot-1",
      },
      orderBy: [{ updatedAt: "desc" }, { path: "asc" }],
    });
  });
});

describe("commit path normalisation", () => {
  it.each(["bot: history/digest.md", "bot/history/digest.md", "  history/digest.md  "])(
    "resolves %j to the real document instead of creating a second one",
    async (path) => {
      const { store, prisma } = storeWithDocument({
        id: "memory-1",
        path: "history/digest.md",
        content: "# Digest\n\nOriginal entry",
        revision: 1,
      });

      const result = await store.commit(
        { scope: "bot", botId: "bot-1", path, content: "New entry", mode: "append" },
        context,
      );

      expect(prisma.memoryDocument.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ path: "history/digest.md" }) }),
      );
      expect(prisma.memoryDocument.create).not.toHaveBeenCalled();
      expect(prisma.memoryDocument.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "memory-1" } }),
      );
      expect(result.path).toBe("history/digest.md");
    },
  );

  it.each(["notes: today.md", "history/my digest.md", "bot: ", "/etc/passwd", "../../escape.md"])(
    "rejects %j rather than silently creating a document",
    async (path) => {
      const { store, prisma } = storeWithDocument(undefined);

      await expect(
        store.commit({ scope: "bot", botId: "bot-1", path, content: "fact" }, context),
      ).rejects.toThrow(/memory path/i);
      expect(prisma.memoryDocument.create).not.toHaveBeenCalled();
      expect(prisma.memoryDocument.update).not.toHaveBeenCalled();
    },
  );

  it("defaults an empty path to MEMORY.md", async () => {
    const { store, prisma } = storeWithDocument(undefined);

    await store.commit({ scope: "bot", botId: "bot-1", path: "", content: "fact" }, context);

    expect(prisma.memoryDocument.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ path: "MEMORY.md" }) }),
    );
  });
});

describe("commit merge semantics", () => {
  it("keeps the document's other facts when one new fact is remembered", async () => {
    const existingContent = "# Profile\n\n- Lives in Berlin\n- Prefers dark roast coffee\n";
    const { store, prisma } = storeWithDocument({
      id: "memory-1",
      path: "profile.md",
      content: existingContent,
      revision: 1,
    });

    const result = await store.commit(
      {
        scope: "bot",
        botId: "bot-1",
        path: "profile.md",
        content: "- Ships on Fridays",
        mode: "append",
      },
      context,
    );

    expect(result.content).toContain("- Lives in Berlin");
    expect(result.content).toContain("- Prefers dark roast coffee");
    expect(result.content).toContain("- Ships on Fridays");
    expect(result.content.length).toBeGreaterThan(existingContent.length);
    expect(prisma.memoryRevision.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ content: result.content }) }),
    );
  });

  it("replaces the whole document only when asked to", async () => {
    const { store } = storeWithDocument({
      id: "memory-1",
      path: "profile.md",
      content: "- Lives in Berlin\n",
      revision: 1,
    });

    const result = await store.commit(
      {
        scope: "bot",
        botId: "bot-1",
        path: "profile.md",
        content: "- Lives in Lisbon\n",
        mode: "replace",
      },
      context,
    );

    expect(result.content).toBe("- Lives in Lisbon\n");
  });
});

describe("appendMemoryContent", () => {
  it("separates the new fact from the existing document", () => {
    expect(appendMemoryContent("# Memory\n\n- one\n", "- two")).toBe(
      "# Memory\n\n- one\n\n- two\n",
    );
  });

  it("ignores a fact already stored", () => {
    const existing = "# Memory\n\n- one\n";
    expect(appendMemoryContent(existing, "- one")).toBe(existing);
    expect(appendMemoryContent(existing, "  - one  ")).toBe(existing);
  });

  it("ignores an empty fact and seeds an empty document", () => {
    expect(appendMemoryContent("- one\n", "   ")).toBe("- one\n");
    expect(appendMemoryContent("", "- one")).toBe("- one\n");
  });
});

function storeWithDocument(existing: Record<string, unknown> | undefined) {
  const prisma = {
    memoryDocument: {
      findFirst: vi.fn().mockResolvedValue(existing ?? null),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...existing,
        ...data,
      })),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "memory-new",
        revision: 1,
        ...data,
      })),
    },
    memoryRevision: { create: vi.fn().mockResolvedValue({}) },
  };
  const transactional = {
    ...prisma,
    $transaction: vi.fn(async (fn: (tx: typeof prisma) => unknown) => fn(prisma)),
  };
  return { store: new MarkdownMemoryStore(transactional as never), prisma };
}
