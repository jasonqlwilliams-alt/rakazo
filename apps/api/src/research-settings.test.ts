import { ORPCError } from "@orpc/server";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  disableSpaceResearchSettings,
  loadSpaceResearchSettings,
  saveSpaceResearchSettings,
} from "./research-settings.js";

const actor = {
  userId: "user-1",
  spaceId: "ws-1",
  email: "a@b.com",
  isDeploymentOwner: false,
};

function makePrisma(
  overrides: {
    role?: string | null;
    existing?: { settings: unknown; updatedAt: Date } | null;
    upsert?: { settings: unknown; updatedAt: Date };
  } = {},
) {
  const findMember = vi
    .fn()
    .mockResolvedValue(overrides.role === null ? null : { role: overrides.role ?? "owner" });
  const findSettings = vi.fn().mockResolvedValue(overrides.existing ?? null);
  const upsert = vi.fn().mockResolvedValue(
    overrides.upsert ?? {
      settings: { executable: "agy", model: "fixture-model", mode: "accept-edits" },
      updatedAt: new Date("2026-09-13T00:00:00.000Z"),
    },
  );
  const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
  return {
    prisma: {
      spaceMember: { findUnique: findMember },
      spaceResearchSettings: { findUnique: findSettings, upsert, deleteMany },
    } as unknown as PrismaClient,
    findMember,
    findSettings,
    upsert,
    deleteMany,
  };
}

describe("space research settings", () => {
  it("returns null when the space has no row", async () => {
    const { prisma } = makePrisma();
    expect(await loadSpaceResearchSettings(prisma, actor)).toBeNull();
  });

  it("lets any member read stored settings", async () => {
    const { prisma } = makePrisma({
      role: "member",
      existing: {
        settings: { model: "fixture-model", project: "lib" },
        updatedAt: new Date("2026-09-13T00:00:00.000Z"),
      },
    });
    expect(await loadSpaceResearchSettings(prisma, actor)).toEqual({
      executable: "agy",
      model: "fixture-model",
      project: "lib",
      mode: "accept-edits",
      updatedAt: "2026-09-13T00:00:00.000Z",
    });
  });

  it("rejects save and disable from a non-owner", async () => {
    const { prisma, upsert, deleteMany } = makePrisma({ role: "member" });
    await expect(
      saveSpaceResearchSettings(prisma, actor, { model: "fixture-model" }),
    ).rejects.toBeInstanceOf(ORPCError);
    await expect(disableSpaceResearchSettings(prisma, actor)).rejects.toBeInstanceOf(ORPCError);
    expect(upsert).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("stores parsed settings for an owner", async () => {
    const { prisma, upsert } = makePrisma();
    const saved = await saveSpaceResearchSettings(prisma, actor, { model: "fixture-model" });
    expect(saved.model).toBe("fixture-model");
    expect(saved.executable).toBe("agy");
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          spaceId: actor.spaceId,
          userId: actor.userId,
          settings: { executable: "agy", model: "fixture-model", mode: "accept-edits" },
        }),
      }),
    );
  });
});
