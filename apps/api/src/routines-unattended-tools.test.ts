import { RPCHandler } from "@orpc/server/fetch";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createRouter, type RouterDeps } from "./router.js";

const PACKET_ROUTER_TOOLS = [
  "shell",
  "message_bot",
  "scratchpad_add",
  "scratchpad_update",
  "scratchpad_list",
];

function routineRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "routine-1",
    botId: "bot-1",
    name: "Relay",
    prompt: "Route the packet",
    crons: [],
    timezone: "UTC",
    active: true,
    notify: true,
    webhookEnabled: true,
    githubEnabled: false,
    messageProvider: null,
    unattendedTools: [],
    lastRunAt: null,
    nextRunAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function routinesDeps(prisma: PrismaClient) {
  const actor = {
    spaceId: "workspace-1",
    userId: "user-1",
    email: "owner@rakazo.test",
    isDeploymentOwner: true,
  } satisfies Actor;
  const deps = {
    prisma,
    events: { append: vi.fn(async () => undefined) },
    jobs: { enqueue: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined) },
    env: {
      defaultProvider: "fake",
      defaultModel: "fake-model",
      webOrigin: "http://127.0.0.1:5173",
      screenProxySecret: "fake-test-secret",
      sandboxProvider: "fake",
      agentRuntime: "scripted",
    },
    dataDir: "/tmp/rakazo-routines-test",
  } as unknown as RouterDeps;
  return { actor, handler: new RPCHandler(createRouter(deps)), prisma };
}

async function rpc(handler: RPCHandler<never>, actor: Actor, path: string, body: unknown) {
  const { response } = await handler.handle(
    new Request(`http://127.0.0.1/rpc/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: body }),
    }),
    { prefix: "/rpc", context: { actor } },
  );
  return { status: response.status, body: await response.json() };
}

describe("routine unattended tool allowlist", () => {
  it("lets the owner set known tools and defaults to an empty list", async () => {
    const prisma = {
      bot: {
        findFirst: vi.fn(async () => ({
          id: "bot-1",
          thread: { id: "thread-1" },
          computer: { id: "computer-1" },
        })),
      },
      routine: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) =>
          routineRow({ ...data, id: "routine-1" }),
        ),
      },
      user: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          email: "owner@rakazo.test",
          name: "Owner",
          avatarStyle: "robot",
        }),
      },
      spaceModelPreference: { findFirst: vi.fn().mockResolvedValue(null) },
      deploymentSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;
    const { actor, handler } = routinesDeps(prisma);

    const createdResponse = await rpc(handler, actor, "routines/create", {
      botId: "bot-1",
      name: "Relay",
      prompt: "Route the packet",
      webhookEnabled: true,
      unattendedTools: PACKET_ROUTER_TOOLS,
    });
    expect(createdResponse.status).toBe(200);
    expect(createdResponse.body).toEqual({
      json: expect.objectContaining({
        unattendedTools: PACKET_ROUTER_TOOLS,
        webhookEnabled: true,
      }),
    });
    expect(prisma.routine.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ unattendedTools: PACKET_ROUTER_TOOLS }),
      }),
    );

    const defaulted = await rpc(handler, actor, "routines/create", {
      botId: "bot-1",
      name: "Empty",
      prompt: "Stay parked",
      webhookEnabled: true,
    });
    expect(defaulted.status).toBe(200);
    expect(prisma.routine.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ unattendedTools: [] }),
      }),
    );
  });

  it("rejects unknown tool names", async () => {
    const prisma = {
      bot: {
        findFirst: vi.fn(async () => ({
          id: "bot-1",
          thread: { id: "thread-1" },
          computer: { id: "computer-1" },
        })),
      },
      routine: { create: vi.fn(), update: vi.fn(), findFirst: vi.fn() },
      user: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          email: "owner@rakazo.test",
          name: "Owner",
          avatarStyle: "robot",
        }),
      },
      spaceModelPreference: { findFirst: vi.fn().mockResolvedValue(null) },
      deploymentSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;
    const { actor, handler } = routinesDeps(prisma);

    const created = await rpc(handler, actor, "routines/create", {
      botId: "bot-1",
      name: "Relay",
      prompt: "Route the packet",
      webhookEnabled: true,
      unattendedTools: ["not_a_tool"],
    });
    expect(created.status).toBeGreaterThanOrEqual(400);
    expect(prisma.routine.create).not.toHaveBeenCalled();
  });

  it("does not let a non-owner set the allowlist", async () => {
    const prisma = {
      bot: { findFirst: vi.fn() },
      routine: {
        findFirst: vi.fn(async () => null),
        update: vi.fn(),
      },
      user: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          email: "intruder@rakazo.test",
          name: "Intruder",
          avatarStyle: "robot",
        }),
      },
      spaceModelPreference: { findFirst: vi.fn().mockResolvedValue(null) },
      deploymentSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;
    const { actor, handler } = routinesDeps(prisma);
    const other = { ...actor, userId: "user-2" };

    const updated = await rpc(handler, other, "routines/update", {
      routineId: "routine-1",
      unattendedTools: PACKET_ROUTER_TOOLS,
    });
    expect(updated.status).toBe(404);
    expect(prisma.routine.update).not.toHaveBeenCalled();
  });
});
