import { ORPCError } from "@orpc/server";
import type {
  Actor,
  SpaceResearchSettingsInput,
  SpaceResearchSettingsView,
} from "@rakazo/contracts";
import { SpaceResearchSettingsSchema } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "@rakazo/db";

async function requireSpaceOwner(prisma: PrismaClient, actor: Actor): Promise<void> {
  const member = await prisma.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
    select: { role: true },
  });
  const roles = member?.role.split(",").map((role) => role.trim());
  if (!roles?.includes("owner")) throw new ORPCError("FORBIDDEN");
}

function serialize(row: { settings: unknown; updatedAt: Date }): SpaceResearchSettingsView {
  return {
    ...SpaceResearchSettingsSchema.parse(row.settings),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function loadSpaceResearchSettings(
  prisma: PrismaClient,
  actor: Actor,
): Promise<SpaceResearchSettingsView | null> {
  const row = await prisma.spaceResearchSettings.findUnique({
    where: { spaceId: actor.spaceId },
    select: { settings: true, updatedAt: true },
  });
  return row ? serialize(row) : null;
}

export async function saveSpaceResearchSettings(
  prisma: PrismaClient,
  actor: Actor,
  input: SpaceResearchSettingsInput,
): Promise<SpaceResearchSettingsView> {
  await requireSpaceOwner(prisma, actor);
  const settings = SpaceResearchSettingsSchema.parse(input);
  const stored = settings as Prisma.InputJsonValue;
  const row = await prisma.spaceResearchSettings.upsert({
    where: { spaceId: actor.spaceId },
    create: { spaceId: actor.spaceId, userId: actor.userId, settings: stored },
    update: { settings: stored, userId: actor.userId },
  });
  return serialize(row);
}

export async function disableSpaceResearchSettings(
  prisma: PrismaClient,
  actor: Actor,
): Promise<{ ok: true }> {
  await requireSpaceOwner(prisma, actor);
  await prisma.spaceResearchSettings.deleteMany({ where: { spaceId: actor.spaceId } });
  return { ok: true };
}
