import type {
  AdapterContext,
  MemoryCommitRequest,
  MemoryExportRequest,
  MemoryReadRequest,
  MemoryRevision,
  MemorySearchRequest,
  MemorySearchResult,
  MemorySnapshot,
  MemoryStore,
  PortableFile,
} from "@rakazo/adapter-kit";
import { requireMemoryPath } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";

export class MarkdownMemoryStore implements MemoryStore {
  constructor(private readonly prisma: PrismaClient) {}

  describe() {
    return {
      id: "markdown",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { search: true, revisions: true, markdownPortable: true },
    };
  }

  async read(request: MemoryReadRequest, context: AdapterContext): Promise<MemorySnapshot> {
    const documents = await this.prisma.memoryDocument.findMany({
      where: {
        workspaceId: context.workspaceId,
        userId: context.userId,
        scope: request.scope,
        ...(request.botId ? { botId: request.botId } : {}),
        ...(request.path ? { path: request.path } : {}),
      },
      orderBy: [{ updatedAt: "desc" }, { path: "asc" }],
    });
    return {
      documents: documents.map((doc) => ({
        id: doc.id,
        path: doc.path,
        content: doc.content,
        revision: doc.revision,
        updatedAt: doc.updatedAt.toISOString(),
      })),
    };
  }

  async search(
    request: MemorySearchRequest,
    context: AdapterContext,
  ): Promise<MemorySearchResult[]> {
    const documents = await this.prisma.memoryDocument.findMany({
      where: {
        workspaceId: context.workspaceId,
        userId: context.userId,
        ...(request.scope === "all" ? {} : { scope: request.scope }),
        ...(request.botId ? { botId: request.botId } : {}),
      },
    });
    const q = request.query.toLowerCase();
    return documents
      .filter((doc) => doc.content.toLowerCase().includes(q) || doc.path.toLowerCase().includes(q))
      .map((doc) => ({
        path: doc.path,
        snippet: snippet(doc.content, q),
        score: 1,
      }));
  }

  async commit(request: MemoryCommitRequest, context: AdapterContext): Promise<MemoryRevision> {
    // Normalise before the lookup: an unnormalised path such as "bot: history/digest.md"
    // matches no document and would otherwise fork a second copy of a real document.
    const path = requireMemoryPath(request.path);
    const existing = await this.prisma.memoryDocument.findFirst({
      where: {
        workspaceId: context.workspaceId,
        userId: context.userId,
        scope: request.scope,
        botId: request.botId ?? null,
        path,
      },
    });
    const content =
      existing && request.mode === "append"
        ? appendMemoryContent(existing.content, request.content)
        : request.content;
    const doc = existing
      ? await this.prisma.memoryDocument.update({
          where: { id: existing.id },
          data: { content, revision: existing.revision + 1 },
        })
      : await this.prisma.memoryDocument.create({
          data: {
            workspaceId: context.workspaceId,
            userId: context.userId,
            botId: request.botId,
            scope: request.scope,
            path,
            content,
          },
        });
    await this.prisma.memoryRevision.create({
      data: {
        documentId: doc.id,
        revision: doc.revision,
        content,
        sourceRunId: request.sourceRunId,
        sourceThreadId: request.sourceThreadId,
      },
    });
    return { id: doc.id, path: doc.path, revision: doc.revision, content: doc.content };
  }

  async *exportMarkdown(
    request: MemoryExportRequest,
    context: AdapterContext,
  ): AsyncIterable<PortableFile> {
    const snapshot = await this.read(
      { scope: request.scope === "all" ? "user" : request.scope, botId: request.botId },
      context,
    );
    for (const doc of snapshot.documents) {
      yield { path: doc.path, content: new TextEncoder().encode(doc.content) };
    }
  }

  async importMarkdown(
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ): Promise<MemoryRevision> {
    let last: MemoryRevision | undefined;
    for await (const file of files) {
      last = await this.commit(
        {
          scope: "user",
          path: file.path,
          content: new TextDecoder().decode(file.content),
        },
        context,
      );
    }
    if (!last) throw new Error("No memory files to import");
    return last;
  }
}

/**
 * Add a fact to a document without disturbing what is already stored there. An exact
 * repeat of an existing line is dropped so repeated `remember` calls do not accumulate
 * duplicates. Reconciling a fact that contradicts an existing one is a judgment call, not
 * a merge: the caller rewrites the document explicitly with `mode: "replace"`.
 */
export function appendMemoryContent(existing: string, addition: string): string {
  const fact = addition.trim();
  if (fact === "") return existing;
  const lines = existing.split("\n").map((line) => line.trim());
  const factLines = fact.split("\n").map((line) => line.trim());
  if (factLines.every((line) => line === "" || lines.includes(line))) return existing;
  const base = existing.replace(/\s+$/, "");
  return base === "" ? `${fact}\n` : `${base}\n\n${fact}\n`;
}

function snippet(content: string, q: string): string {
  const idx = content.toLowerCase().indexOf(q);
  if (idx < 0) return content.slice(0, 140);
  return content.slice(Math.max(0, idx - 40), idx + q.length + 80);
}
