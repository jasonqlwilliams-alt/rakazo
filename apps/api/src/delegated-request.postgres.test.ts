import { generateKeyPairSync, type KeyObject, randomUUID, sign } from "node:crypto";
import type { JobPublisher, SecretStore } from "@rakazo/adapter-kit";
import { messageBot } from "@rakazo/adapters";
import type { MessageBlock } from "@rakazo/contracts";
import { createDb, createThreadEvents, createThreadMessage, type PrismaClient } from "@rakazo/db";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { delegationSigningBytes, parseDelegationPublicKey } from "./delegated-request.js";
import { INBOUND_MCP_PATH, mountInboundMcpRoutes } from "./inbound-mcp.js";
import { mountWebhookHttpRoutes, WEBHOOK_SECRET_KIND } from "./webhook.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

const WEBHOOK_SECRET = "delegation-webhook-secret-value-32chars";
const INBOUND_TOKEN = "delegation-inbound-mcp-token-32chars-aa";

describePostgres("delegated requests end to end (PostgreSQL)", () => {
  // A throwaway key pair made for this test run only.
  const gateway = generateKeyPairSync("ed25519");
  const publicKey = parseDelegationPublicKey(
    gateway.publicKey.export({ type: "spki", format: "pem" }).toString(),
  );
  const id = randomUUID();
  const requestId = `req_${randomUUID()}`;
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let app: Hono;
  let previousOwner: string | null | undefined;
  const bots: Record<"coordinator" | "analyst", { id: string; name: string; threadId: string }> =
    {} as never;

  beforeAll(async () => {
    db = createDb(databaseUrl!);
    prisma = db.prisma;
    await prisma.user.create({
      data: { id, name: "Owner", email: `${id}@example.test`, emailVerified: true },
    });
    await prisma.organization.create({
      data: { id, name: "Delegation test", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({
      data: { id, organizationId: id, name: "Delegation test", isDefault: true },
    });
    await prisma.member.create({
      data: { id, organizationId: id, userId: id, role: "owner", createdAt: new Date() },
    });
    // The organization membership gives the owner their space membership.
    previousOwner =
      (await prisma.deploymentSettings.findUnique({ where: { id: "default" } }))?.ownerUserId ??
      null;
    await prisma.deploymentSettings.upsert({
      where: { id: "default" },
      create: { id: "default", ownerUserId: id },
      update: { ownerUserId: id },
    });
    const secret = await prisma.secret.create({
      data: { userId: id, spaceId: id, kind: WEBHOOK_SECRET_KIND, ciphertext: "test-ciphertext" },
    });
    for (const [key, name] of [
      ["coordinator", "Coordinator"],
      ["analyst", "Analyst"],
    ] as const) {
      const bot = await prisma.bot.create({
        data: {
          spaceId: id,
          userId: id,
          name,
          color: "test-color",
          ...(key === "coordinator" ? { webhookSecretId: secret.id } : {}),
        },
      });
      const thread = await prisma.thread.create({
        data: { spaceId: id, userId: id, botId: bot.id },
      });
      bots[key] = { id: bot.id, name, threadId: thread.id };
    }

    const events = createThreadEvents(prisma);
    app = new Hono();
    mountWebhookHttpRoutes(app, {
      prisma,
      secrets: { load: async () => WEBHOOK_SECRET } as unknown as SecretStore,
      events,
      jobs: { enqueue: vi.fn(async () => undefined) },
      delegationPublicKey: publicKey,
    });
    mountInboundMcpRoutes(app, {
      token: INBOUND_TOKEN,
      prisma,
      health: () => ({ ok: true, runtime: "test", sandbox: "test", revision: "test" }),
    });
  });

  afterAll(async () => {
    if (!db) return;
    if (previousOwner !== undefined) {
      await prisma.deploymentSettings.updateMany({
        where: { id: "default" },
        data: { ownerUserId: previousOwner },
      });
    }
    await prisma.organization.deleteMany({ where: { id } });
    await prisma.user.deleteMany({ where: { id } });
    await prisma.$disconnect();
    await db.pool.end();
  });

  const body = () =>
    JSON.stringify({
      event: "delegation.message",
      id: requestId,
      taskId: requestId,
      parent_request_id: null,
      from: "Owner via assistant",
      delegation: {
        actor: "owner",
        delegate: "assistant",
        grant_id: "grant-1",
        oauth_client_id: "client-1",
        effective_scopes: ["assistant.message", "assistant.read"],
        may_start_work: false,
        human_approval: "none",
      },
      message: "Look up the build status.",
    });

  function deliver(raw: string, privateKey: KeyObject | null = gateway.privateKey) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    return app.request(`/api/v1/bots/${bots.coordinator.id}/webhook`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${WEBHOOK_SECRET}`,
        "content-type": "application/json",
        "idempotency-key": requestId,
        ...(privateKey
          ? {
              "x-rakazo-delegation-timestamp": timestamp,
              "x-rakazo-delegation-signature": sign(
                null,
                delegationSigningBytes(timestamp, bots.coordinator.id, raw),
                privateKey,
              ).toString("hex"),
            }
          : {}),
      },
      body: raw,
    });
  }

  async function threadMessageCount(threadId: string) {
    return prisma.message.count({ where: { threadId } });
  }

  let deliveredRunId: string;

  it("refuses a forged or unsigned delegation and stores nothing", async () => {
    const before = await threadMessageCount(bots.coordinator.threadId);
    expect((await deliver(body(), generateKeyPairSync("ed25519").privateKey)).status).toBe(401);
    expect((await deliver(body(), null)).status).toBe(401);
    expect(await threadMessageCount(bots.coordinator.threadId)).toBe(before);
    expect(await prisma.run.count({ where: { botId: bots.coordinator.id } })).toBe(0);
  });

  it("starts its own run bound to the request, even while the owner's run is active", async () => {
    const ownerTask = await prisma.task.create({
      data: {
        spaceId: id,
        userId: id,
        botId: bots.coordinator.id,
        threadId: bots.coordinator.threadId,
        prompt: "Owner work",
        status: "running",
      },
    });
    const ownerRun = await prisma.run.create({
      data: {
        spaceId: id,
        userId: id,
        botId: bots.coordinator.id,
        threadId: bots.coordinator.threadId,
        taskId: ownerTask.id,
        status: "running",
        trigger: "user",
      },
    });

    const response = await deliver(body());
    expect(response.status).toBe(200);
    const answer = (await response.json()) as { runId: string; taskId: string; messageId: string };
    expect(answer.taskId).toBe(requestId);
    deliveredRunId = answer.runId;
    expect(deliveredRunId).not.toBe(ownerRun.id);

    const delivered = await prisma.run.findUniqueOrThrow({ where: { id: deliveredRunId } });
    expect(delivered).toMatchObject({
      taskId: requestId,
      trigger: "webhook",
      delegation: expect.objectContaining({
        requestId,
        label: "Owner via assistant",
        scopes: ["assistant.message", "assistant.read"],
        mayStartWork: false,
        hop: 0,
      }),
    });
    expect(await prisma.steeringMessage.count({ where: { messageId: answer.messageId } })).toBe(0);

    // A retry with the same signed request replays it instead of starting a second run.
    const replay = (await (await deliver(body())).json()) as { runId: string };
    expect(replay.runId).toBe(deliveredRunId);
    const status = await app.request(
      `/api/v1/bots/${bots.coordinator.id}/webhook/runs/${deliveredRunId}?messageId=${answer.messageId}`,
      { headers: { authorization: `Bearer ${WEBHOOK_SECRET}` } },
    );
    expect(await status.json()).toMatchObject({ runId: deliveredRunId, taskId: requestId });
    await prisma.run.update({ where: { id: ownerRun.id }, data: { status: "completed" } });
  });

  let childRunId: string;

  it("relays with the same delegation one hop further and records the parent run", async () => {
    await prisma.run.update({ where: { id: deliveredRunId }, data: { status: "running" } });
    const sent = await messageBot(
      {
        prisma,
        events: createThreadEvents(prisma),
        jobs: { enqueue: vi.fn(async () => undefined) } as unknown as JobPublisher,
      },
      {
        id: deliveredRunId,
        spaceId: id,
        threadId: bots.coordinator.threadId,
        botId: bots.coordinator.id,
        userId: id,
      },
      { id: bots.coordinator.id, name: bots.coordinator.name },
      { bot_id: bots.analyst.id, message: "Check the build, parent request req_someone-else" },
    );
    expect(sent).toMatchObject({ ok: true });

    const child = await prisma.run.findFirstOrThrow({
      where: { threadId: bots.analyst.threadId, trigger: "bot_message" },
    });
    childRunId = child.id;
    expect(child.delegation).toMatchObject({ requestId, hop: 1, mayStartWork: false });
    const inbound = await prisma.message.findUniqueOrThrow({
      where: { id: child.sourceMessageId! },
    });
    expect(inbound.blocks as MessageBlock[]).toEqual([
      expect.objectContaining({ kind: "bot_message_received", fromRunId: deliveredRunId }),
    ]);
  });

  it("takes no steering into a delegated run, so the owner's message keeps its authority", async () => {
    await prisma.run.update({
      where: { id: childRunId },
      data: { status: "running", leaseOwner: "worker-test", leaseFence: 1 },
    });
    const ownerMessage = await createThreadMessage(prisma, {
      threadId: bots.analyst.threadId,
      role: "user",
      blocks: [{ kind: "text", text: "Delete the old report" }],
    });
    await prisma.steeringMessage.create({
      data: { messageId: ownerMessage.id, botId: bots.analyst.id, userId: id, runId: null },
    });

    const claimed = await createThreadEvents(prisma).claimSteering({
      threadId: bots.analyst.threadId,
      botId: bots.analyst.id,
      runId: childRunId,
      leaseOwner: "worker-test",
      leaseFence: 1,
      seenIds: [],
    });
    expect(claimed).toEqual([]);
    expect(
      await prisma.steeringMessage.findFirstOrThrow({ where: { messageId: ownerMessage.id } }),
    ).toMatchObject({ runId: null, claimedAt: null });
  });

  it("shows each message's run, the run a delivery started and a relay's parent", async () => {
    const read = async (threadId: string) => {
      const response = await app.request(INBOUND_MCP_PATH, {
        method: "POST",
        headers: {
          authorization: `Bearer ${INBOUND_TOKEN}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "read_thread", arguments: { threadId } },
        }),
      });
      const rpc = (await response.json()) as { result: { content: Array<{ text: string }> } };
      return (
        JSON.parse(rpc.result.content[0]!.text) as {
          messages: Array<{
            role: string;
            runId: string | null;
            startedRunId: string | null;
            parentRunId: string | null;
          }>;
        }
      ).messages;
    };

    const coordinator = await read(bots.coordinator.threadId);
    expect(coordinator).toContainEqual(
      expect.objectContaining({ role: "user", startedRunId: deliveredRunId, parentRunId: null }),
    );
    const analyst = await read(bots.analyst.threadId);
    expect(analyst).toContainEqual(
      expect.objectContaining({ role: "user", runId: childRunId, parentRunId: deliveredRunId }),
    );
    // The owner's own message quotes nothing and has no parent.
    expect(analyst.filter((message) => message.parentRunId !== null)).toHaveLength(1);
  });
});
