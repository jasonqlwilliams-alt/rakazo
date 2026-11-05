import type { AdapterContext, MemoryStore } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { loadAgentMemoryContext, recallLocalMemory } from "./memory-context.js";

const context = {
  spaceId: "space",
  userId: "owner",
  botId: "bot",
} as AdapterContext;

const docs = [
  {
    id: "core",
    path: "MEMORY.md",
    content: "Core preference: concise answers.",
    revision: 1,
  },
  {
    id: "archive",
    path: "archive.md",
    content: "unrelated historical material ".repeat(10_000),
    revision: 2,
  },
  {
    id: "match",
    path: "orchids.md",
    content: "Orchids need filtered light and careful watering.",
    revision: 3,
  },
];

function memory() {
  const read = vi.fn(async (input: { scope: string; path?: string }) => ({
    documents:
      input.scope === "bot" ? docs.filter((d) => !input.path || d.path === input.path) : [],
  }));
  return { read, store: { read } as unknown as MemoryStore };
}

describe("task-relevant local memory", () => {
  it("emits the full memory store unchanged when all documents already fit maxBytes", async () => {
    const store = {
      read: async ({ scope }: { scope: string }) => ({
        documents:
          scope === "user"
            ? [{ id: "u1", path: "preferences.md", revision: 1, content: "User likes tea." }]
            : [
                {
                  id: "b1",
                  path: "project-notes.md",
                  revision: 2,
                  content: "HOLD: Wait for sign-off before publishing.\n\nUnrelated fact: cedar.",
                },
                {
                  id: "b2",
                  path: "state/holds_index.md",
                  revision: 1,
                  content: "Active hold index entry.",
                },
              ],
      }),
    } as unknown as MemoryStore;

    const result = await loadAgentMemoryContext(store, "bot", context, 32 * 1024, {
      query: "Yes, go ahead",
    });

    expect(result).toContain("User likes tea.");
    expect(result).toContain("Unrelated fact: cedar.");
    expect(result).toContain("Active hold index entry.");
    expect(result).not.toContain("<memory_constraints>");
    expect(result).not.toContain("Memory excerpts selected for this task");
  });

  it.each([1, 2])("keeps %i complete document(s) at the exact byte boundary", async (count) => {
    const documents = Array.from({ length: count }, (_, index) => ({
      id: `note-${index}`,
      path: `note-${index}.md`,
      revision: 1,
      content: `Cedar project note ${index}.`,
    }));
    const store = {
      read: async ({ scope }: { scope: string }) => ({
        documents: scope === "bot" ? documents : [],
      }),
    } as unknown as MemoryStore;
    const query = { query: "unrelated orchids" };
    const full = await loadAgentMemoryContext(store, "bot", context, 32 * 1024, query);
    const exactBytes = Buffer.byteLength(full!);

    const exact = await loadAgentMemoryContext(store, "bot", context, exactBytes, query);

    expect(exact).toBe(full);
    expect(Buffer.byteLength(exact!)).toBe(exactBytes);
    for (const document of documents) expect(exact).toContain(document.content);
  });

  it("clamps a tiny memory window without protected constraints", async () => {
    const store = {
      read: async ({ scope }: { scope: string }) => ({
        documents:
          scope === "bot"
            ? [{ id: "note", path: "note.md", revision: 1, content: "Ordinary cedar facts." }]
            : [],
      }),
    } as unknown as MemoryStore;

    const result = await loadAgentMemoryContext(store, "bot", context, 64, {
      query: "unrelated orchids",
    });

    expect(Buffer.byteLength(result!)).toBeLessThanOrEqual(64);
    expect(result).not.toContain("Ordinary cedar facts.");
  });

  it("keeps protected constraints intact when the memory window is tiny", async () => {
    const rule = "HOLD: Do not publish the draft.";
    const store = {
      read: async ({ scope }: { scope: string }) => ({
        documents:
          scope === "bot" ? [{ id: "rule", path: "rules.md", revision: 1, content: rule }] : [],
      }),
    } as unknown as MemoryStore;

    const result = await loadAgentMemoryContext(store, "bot", context, 64, {
      query: "unrelated orchids",
    });

    expect(result).toContain("<memory_constraints>");
    expect(result).toContain(rule);
    expect(Buffer.byteLength(result!)).toBeGreaterThan(64);
  });

  it("preserves a distant hold and appended correction on an unrelated task", async () => {
    const hold = "HOLD: Do not publish the draft without direct approval.";
    const correction = "CORRECTION: Earlier permission is WITHDRAWN; review is still required.";
    const tail = "The prior exception is no longer applicable.";
    const content =
      "old material ".repeat(40_000) +
      `\n\n${hold}\n\n` +
      "more history ".repeat(5000) +
      `\n\n${correction}\n\n${tail}\n\nReceipt footer.\n\n`;
    const store = {
      read: async ({ scope }: { scope: string }) => ({
        documents:
          scope === "user" ? [] : [{ id: "rules", path: "old-log.md", revision: 9, content }],
      }),
    } as unknown as MemoryStore;
    const result = await loadAgentMemoryContext(store, "bot", context, 256, { query: "orchids" });
    expect(result).toContain(hold);
    expect(result).toContain(correction);
    expect(result).toContain(tail);
    expect(result!.indexOf(hold)).toBeLessThan(result!.indexOf(correction));
  });

  it.each([
    "state/holds_index",
    "state/holds_index.md",
    "state/holds_index_20261102.md",
    "state/holds-index-2026-11-02.md",
  ])(
    "pins a complete hold index at %s without duplicating it inside durable excerpts",
    async (indexPath) => {
      const content = "current restrictions and their original references\n".repeat(50);
      const rule = "Do not send the report until its owner approves.";
      const filler = "background log entry\n".repeat(400);
      const store = {
        read: async ({ scope }: { scope: string }) => ({
          documents:
            scope === "user"
              ? []
              : [
                  { id: "index", path: indexPath, revision: 2, content },
                  { id: "rule", path: "limits.md", revision: 1, content: rule },
                  { id: "filler", path: "notes.md", revision: 1, content: filler },
                ],
        }),
      } as unknown as MemoryStore;
      const result = await loadAgentMemoryContext(store, "bot", context, 2048, {
        query: "holds index status",
      });
      expect(result).toContain(content);
      expect(result).toContain(rule);
      expect(result!.split(content.trim()).length - 1).toBe(1);
    },
  );

  it("fails closed instead of truncating an oversized protected rule", async () => {
    const store = {
      read: async ({ scope }: { scope: string }) => ({
        documents:
          scope === "user"
            ? []
            : [
                {
                  id: "rule",
                  path: "rules.md",
                  revision: 1,
                  content: `HOLD: ${"x".repeat(270_000)}`,
                },
              ],
      }),
    } as unknown as MemoryStore;
    await expect(
      loadAgentMemoryContext(store, "bot", context, 1024, { query: "irrelevant" }),
    ).rejects.toThrow("refusing to truncate holds or corrections");
  });

  it("pages multibyte originals and repairs an offset inside a surrogate pair", async () => {
    const content = "🙂".repeat(5000);
    const store = {
      read: async () => ({
        documents: [{ id: "unicode", path: "unicode.md", revision: 1, content }],
      }),
    } as unknown as MemoryStore;
    let offset: number | null = 0;
    let restored = "";
    while (offset !== null) {
      const result = await recallLocalMemory(store, "bot", context, {
        path: "unicode.md",
        scope: "bot",
        offset,
      });
      const page = result.documents[0]!;
      restored += page.content;
      offset = "nextOffset" in page ? page.nextOffset : null;
    }
    expect(restored).toBe(content);
    const result = await recallLocalMemory(store, "bot", context, {
      path: "unicode.md",
      scope: "bot",
      offset: 1,
    });
    expect(result.documents[0]!.content).toMatch(/^🙂/);
  });

  it("keeps core preferences and task facts without injecting an irrelevant archive", async () => {
    const { store } = memory();
    const result = await loadAgentMemoryContext(store, "bot", context, 12 * 1024, {
      query: "How should I water orchids?",
    });
    expect(result).toContain("concise answers");
    expect(result).toContain("careful watering");
    expect(result).not.toContain("unrelated historical material");
    expect(result).toContain("recall_memory");
    expect(Buffer.byteLength(result!)).toBeLessThanOrEqual(12 * 1024);
    expect(docs[1]!.content.length).toBeGreaterThan(200_000);
  });

  it("ranks matching bot memory ahead of lower-scoring user memory and core filler", async () => {
    const store = {
      read: async ({ scope }: { scope: string }) => ({
        documents:
          scope === "user"
            ? [
                {
                  id: "weak",
                  path: "garden.md",
                  revision: 1,
                  content: "I like orchids.",
                },
                ...Array.from({ length: 12 }, (_, index) => ({
                  id: `unrelated-${index}`,
                  path: `unrelated-${index}.md`,
                  revision: 1,
                  content: "Stored preference.",
                })),
              ]
            : [
                {
                  id: "strong",
                  path: "orchids.md",
                  revision: 1,
                  content: "Orchids need filtered light.",
                },
                {
                  id: "large",
                  path: "large.md",
                  revision: 1,
                  content: "Unrelated history. ".repeat(1_000),
                },
              ],
      }),
    } as unknown as MemoryStore;

    const result = await loadAgentMemoryContext(store, "bot", context, 12 * 1024, {
      query: "orchids",
    });

    expect(result).toContain("## orchids.md");
    expect(result).toContain("## garden.md");
    expect(result!.indexOf("## orchids.md")).toBeLessThan(result!.indexOf("## garden.md"));
  });

  it.each(["AI", "3D"])("selects two-character task memory for %s", async (term) => {
    const store = {
      read: async ({ scope }: { scope: string }) => ({
        documents:
          scope === "user"
            ? []
            : [
                {
                  id: "match",
                  path: `${term.toLowerCase()}.md`,
                  revision: 1,
                  content: `${term} project details.`,
                },
                {
                  id: "stop-word",
                  path: "to.md",
                  revision: 1,
                  content: "Unrelated material.",
                },
                {
                  id: "large",
                  path: "history.md",
                  revision: 1,
                  content: "Old history. ".repeat(3_000),
                },
              ],
      }),
    } as unknown as MemoryStore;

    const result = await loadAgentMemoryContext(store, "bot", context, 12 * 1024, {
      query: `to ${term}`,
    });

    expect(result).toContain(`## ${term.toLowerCase()}.md`);
    expect(result).toContain(`${term} project details.`);
    expect(result).not.toContain("## to.md");
    expect(Buffer.byteLength(result!)).toBeLessThanOrEqual(12 * 1024);
  });

  it.each(["orchid-care", "orchid_care", "orchid/care"])(
    "matches compound task terms against separate words for %s",
    async (query) => {
      const store = {
        read: async ({ scope }: { scope: string }) => ({
          documents:
            scope === "user"
              ? []
              : [
                  {
                    id: "match",
                    path: "garden.md",
                    revision: 1,
                    content: "Orchid care requires filtered light.",
                  },
                  {
                    id: "large",
                    path: "history.md",
                    revision: 1,
                    content: "Old history. ".repeat(3_000),
                  },
                ],
        }),
      } as unknown as MemoryStore;

      const selected = await loadAgentMemoryContext(store, "bot", context, 12 * 1024, {
        query,
      });
      const recalled = await recallLocalMemory(store, "bot", context, { query });

      expect(selected).toContain("Orchid care requires filtered light.");
      expect(recalled.documents.map((document) => document.path)).toContain("garden.md");
    },
  );

  it("does not let incidental short substrings displace matching memory", async () => {
    const store = {
      read: async ({ scope }: { scope: string }) => ({
        documents:
          scope === "user"
            ? []
            : [
                {
                  id: "match",
                  path: "ai.md",
                  revision: 1,
                  updatedAt: "2026-01-01T00:00:00Z",
                  content: "Model decisions for this project.",
                },
                ...Array.from({ length: 12 }, (_, index) => ({
                  id: `incidental-${index}`,
                  path: `daily-${index}.md`,
                  revision: 1,
                  updatedAt: "2026-11-01T00:00:00Z",
                  content: "Unrelated historical material. ".repeat(100),
                })),
              ],
      }),
    } as unknown as MemoryStore;

    const selected = await loadAgentMemoryContext(store, "bot", context, 12 * 1024, {
      query: "AI",
    });
    const recalled = await recallLocalMemory(store, "bot", context, { query: "AI" });

    expect(selected).toContain("## ai.md");
    expect(selected).not.toContain("## daily-0.md");
    expect(recalled).toMatchObject({
      totalDocuments: 1,
      documents: [{ path: "ai.md" }],
    });
  });

  it("anchors an oversized excerpt to a whole short term", async () => {
    const store = {
      read: async ({ scope }: { scope: string }) => ({
        documents:
          scope === "user"
            ? []
            : [
                {
                  id: "match",
                  path: "notes.md",
                  revision: 1,
                  content: `AI defines project scope. ${"filler ".repeat(1_000)}daily`,
                },
              ],
      }),
    } as unknown as MemoryStore;

    const selected = await loadAgentMemoryContext(store, "bot", context, 12 * 1024, {
      query: "AI",
    });

    expect(selected).toContain("AI defines project scope.");
  });

  it("keeps the first fact and a later match from an oversized document", async () => {
    const store = {
      read: async ({ scope }: { scope: string }) => ({
        documents:
          scope === "user"
            ? []
            : [
                {
                  id: "notes",
                  path: "notes.md",
                  revision: 1,
                  content: `Orchids need filtered light. ${"background ".repeat(3_000)}Orchids`,
                },
              ],
      }),
    } as unknown as MemoryStore;

    const selected = await loadAgentMemoryContext(store, "bot", context, 12 * 1024, {
      query: "orchids",
    });

    expect(selected).toContain("Orchids need filtered light.");
    expect(selected).toContain("Orchids\n[excerpt;");
    expect(Buffer.byteLength(selected!)).toBeLessThanOrEqual(12 * 1024);
  });

  it("reserves excerpt space for a late matching task term", async () => {
    const content = [
      "Alpha context.",
      "Alpha follow-up.",
      "Beta context.",
      "Beta follow-up.",
      "Gamma context.",
      "Gamma follow-up.",
      "Orchids need filtered light.",
    ].join("\n" + "background ".repeat(800));
    const store = {
      read: async ({ scope }: { scope: string }) => ({
        documents:
          scope === "bot" ? [{ id: "notes", path: "notes.md", revision: 1, content }] : [],
      }),
    } as unknown as MemoryStore;

    const selected = await loadAgentMemoryContext(store, "bot", context, 12 * 1024, {
      query: "alpha beta gamma orchids",
    });

    expect(selected).toContain("Alpha context.");
    expect(selected).toContain("Orchids need filtered light.");
    expect(Buffer.byteLength(selected!)).toBeLessThanOrEqual(12 * 1024);
  });

  it("keeps early and late multibyte facts with hundreds of repeated task terms", async () => {
    const setupTerms = Array.from({ length: 250 }, (_, index) =>
      `setup${index.toString().padStart(3, "0")}`,
    );
    const content =
      setupTerms
        .map((term) => `${term} starts 🌺. ${"background🌺".repeat(5)} ${term} ends 🌺.`)
        .join("\n") +
      `\n${"history🌺".repeat(500)}\nOrchids need filtered light 🌺.`;
    const store = {
      read: async ({ scope }: { scope: string }) => ({
        documents:
          scope === "bot" ? [{ id: "notes", path: "notes.md", revision: 1, content }] : [],
      }),
    } as unknown as MemoryStore;
    const query = `${setupTerms.join(" ")} orchids background`;
    expect(Buffer.byteLength(content)).toBeGreaterThan(12 * 1024);

    const selected = await loadAgentMemoryContext(store, "bot", context, 12 * 1024, { query });
    const recalled = await recallLocalMemory(store, "bot", context, { query });

    expect(selected).toContain("setup000 starts 🌺.");
    expect(selected).toContain("Orchids need filtered light 🌺.");
    expect(selected).not.toContain("�");
    expect(Buffer.byteLength(selected!)).toBeLessThanOrEqual(12 * 1024);
    expect(recalled.documents[0]?.content).toContain("Orchids need filtered light 🌺.");
    expect(recalled.documents[0]?.content).not.toContain("�");
    expect(Buffer.byteLength(recalled.documents[0]?.content ?? "")).toBeLessThanOrEqual(1200);
  });

  it("keeps a late match in a short local recall snippet", async () => {
    const content = `${"Background notes. ".repeat(110)}Orchids need filtered light.`;
    const store = {
      read: async ({ scope }: { scope: string }) => ({
        documents:
          scope === "bot" ? [{ id: "notes", path: "notes.md", revision: 1, content }] : [],
      }),
    } as unknown as MemoryStore;
    expect(Buffer.byteLength(content)).toBeGreaterThan(1200);
    expect(Buffer.byteLength(content)).toBeLessThan(4096);

    const recalled = await recallLocalMemory(store, "bot", context, { query: "orchids" });

    expect(recalled.documents[0]?.content).toContain("Orchids need filtered light.");
    expect(Buffer.byteLength(recalled.documents[0]?.content ?? "")).toBeLessThanOrEqual(1200);
  });

  it("selects a relevant memory after more than 64 setup terms", async () => {
    const store = {
      read: async ({ scope }: { scope: string }) => ({
        documents:
          scope === "user"
            ? []
            : [
                {
                  id: "match",
                  path: "orchids.md",
                  revision: 1,
                  content: "Orchids need filtered light.",
                },
                {
                  id: "large",
                  path: "history.md",
                  revision: 1,
                  content: "Unrelated history. ".repeat(3_000),
                },
              ],
      }),
    } as unknown as MemoryStore;
    const setup = Array.from({ length: 64 }, (_, index) => `setup${index}`).join(" ");

    const result = await loadAgentMemoryContext(store, "bot", context, 12 * 1024, {
      query: `${setup} orchids`,
    });

    expect(result).toContain("## orchids.md");
    expect(result).toContain("Orchids need filtered light.");
  });

  it("searches original documents, lists with omitted query, and reads archived scope", async () => {
    const read = vi.fn(async (input: { scope: string; botId?: string; path?: string }) => ({
      documents:
        input.scope === "archive"
          ? [
              {
                id: "arch-1",
                path: "2026-11-04/log.md",
                content: "Archived cedar milestone details.",
                revision: 4,
              },
            ].filter((d) => !input.path || d.path === input.path)
          : input.scope === "bot"
            ? docs.filter((d) => !input.path || d.path === input.path)
            : [],
    }));
    const store = { read } as unknown as MemoryStore;

    const listed = await recallLocalMemory(store, "bot", context, { scope: "archive" });
    expect(listed.documents).toEqual([
      expect.objectContaining({
        path: "2026-11-04/log.md",
        scope: "archive",
        revision: 4,
        content: undefined,
      }),
    ]);
    expect(read).toHaveBeenCalledWith({ scope: "archive", botId: "bot" }, context);

    const found = await recallLocalMemory(store, "bot", context, {
      query: "historical",
    });
    expect(found.documents[0]?.path).toBe("archive.md");
    let offset: number | null = 0;
    let content = "";
    while (offset !== null) {
      const result = await recallLocalMemory(store, "bot", context, {
        path: "archive.md",
        scope: "bot",
        offset,
      });
      const page = result.documents[0]!;
      expect(Buffer.byteLength(page.content!)).toBeLessThanOrEqual(4096);
      content += page.content;
      offset = "nextOffset" in page ? page.nextOffset : null;
    }
    expect(content).toBe(docs[1]!.content);
  });

  it("retains a bounded relevant excerpt from the end of an oversized document", async () => {
    const store = {
      read: async ({ scope }: { scope: string }) => ({
        documents:
          scope === "user"
            ? []
            : [
                {
                  id: "large",
                  path: "notes.md",
                  revision: 1,
                  content: `${"old text ".repeat(50_000)}\nUniqueCedar fact near the end.`,
                },
              ],
      }),
    } as unknown as MemoryStore;
    const result = await loadAgentMemoryContext(store, "bot", context, 2048, {
      query: "UniqueCedar",
    });
    expect(result).toContain("UniqueCedar fact");
    expect(Buffer.byteLength(result!)).toBeLessThanOrEqual(2048);
  });
});
