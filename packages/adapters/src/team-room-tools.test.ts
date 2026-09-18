import { describe, expect, it, vi } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";
import {
  buildTeamRoomAllowlist,
  POST_TO_TEAM_ROOM_TOOL,
  postToTeamRoom,
  resolveTeamRoom,
  selectTeamRoomTools,
  TEAM_ROOM_TEXT_MAX_CHARS,
  TEAM_ROOM_TOOL_NAMES,
  teamRoomToolConfig,
  validPostToTeamRoomArgs,
} from "./team-room-tools.js";

const projects = {
  externalKey: "channel-projects",
  displayName: "projects",
  conversationId: "discord:guild-1:channel-projects",
  workspaceId: "guild-1",
};

function createDeps(
  options: { seen?: (typeof projects)[]; envRoomIds?: string[]; provider?: string } = {},
) {
  const outbound: Array<{
    idempotencyKey: string;
    kind: string;
    threadId?: string;
    body: string;
    status: string;
  }> = [];
  const enqueue = vi.fn(async () => undefined);
  const prisma = {
    externalConversation: {
      findMany: vi.fn(async () => options.seen ?? [projects]),
    },
    messagingOutbound: {
      createMany: vi.fn(
        async ({
          data,
          skipDuplicates,
        }: {
          data: Array<{ idempotencyKey: string; kind: string; threadId?: string; body: string }>;
          skipDuplicates?: boolean;
        }) => {
          let count = 0;
          for (const row of data) {
            if (
              skipDuplicates &&
              outbound.some((item) => item.idempotencyKey === row.idempotencyKey)
            ) {
              continue;
            }
            outbound.push({ ...row, status: "pending" });
            count += 1;
          }
          return { count };
        },
      ),
      findUnique: vi.fn(async ({ where }: { where: { idempotencyKey: string } }) => {
        const row = outbound.find((item) => item.idempotencyKey === where.idempotencyKey);
        return row ? { status: row.status } : null;
      }),
    },
  };
  return {
    outbound,
    enqueue,
    createMany: prisma.messagingOutbound.createMany,
    deps: {
      prisma: prisma as never,
      jobs: { enqueue },
      teamRoom: {
        provider: options.provider ?? "discord",
        envRoomIds: options.envRoomIds ?? ["channel-projects"],
      },
    },
  };
}

describe("post_to_team_room selection", () => {
  it("hides the tool when no team platform is enabled", () => {
    const hidden = selectTeamRoomTools(builtinAgentTools, false);
    expect(hidden.some((tool) => TEAM_ROOM_TOOL_NAMES.has(tool.name))).toBe(false);
    expect(hidden.length).toBe(builtinAgentTools.length - TEAM_ROOM_TOOL_NAMES.size);
    expect(selectTeamRoomTools(builtinAgentTools, true)).toBe(builtinAgentTools);
  });

  it("registers a byte-bounded schema with the 2,000-character text cap", () => {
    const tool = builtinAgentTools.find((entry) => entry.name === POST_TO_TEAM_ROOM_TOOL);
    const schema = tool?.inputSchema as {
      properties: { text: { maxLength: number }; room: { maxLength: number } };
      required: string[];
    };
    expect(schema.required).toEqual(["room", "text"]);
    expect(schema.properties.text.maxLength).toBe(TEAM_ROOM_TEXT_MAX_CHARS);
    expect(schema.properties.room.maxLength).toBe(128);
    expect(JSON.stringify(tool?.inputSchema).length).toBeLessThan(2_048);
  });
});

describe("teamRoomToolConfig", () => {
  it("is absent without a team platform and carries Discord channel ids only", () => {
    expect(
      teamRoomToolConfig([{ provider: "sendblue" }], { discordRespondToChannelIds: "c1" }),
    ).toBeUndefined();
    expect(
      teamRoomToolConfig([{ provider: "discord" }], { discordRespondToChannelIds: " c1 , c2 " }),
    ).toEqual({ provider: "discord", envRoomIds: ["c1", "c2"] });
    expect(
      teamRoomToolConfig([{ provider: "slack" }], { discordRespondToChannelIds: "c1" }),
    ).toEqual({ provider: "slack", envRoomIds: [] });
  });
});

describe("team-room allowlist", () => {
  it("accepts env ids, seen names, and rejects DMs", () => {
    const allowlist = buildTeamRoomAllowlist(
      "discord",
      ["channel-projects", "channel-dump"],
      [
        projects,
        {
          externalKey: "dm-1",
          displayName: "Ada",
          conversationId: "discord:@me:dm-1",
          workspaceId: "@me",
        },
      ],
    );
    expect(resolveTeamRoom("projects", allowlist)?.id).toBe("channel-projects");
    expect(resolveTeamRoom("#projects", allowlist)?.id).toBe("channel-projects");
    expect(resolveTeamRoom("channel-dump", allowlist)?.conversationId).toBe(
      "discord:guild-1:channel-dump",
    );
    expect(resolveTeamRoom("dm-1", allowlist)).toBeNull();
    expect(resolveTeamRoom("gates", allowlist)).toBeNull();
  });

  it("drops a seen Discord room that is no longer in the env list", () => {
    const stale = {
      externalKey: "channel-old",
      displayName: "old",
      conversationId: "discord:guild-1:channel-old",
      workspaceId: "guild-1",
    };
    const allowlist = buildTeamRoomAllowlist("discord", ["channel-projects"], [projects, stale]);
    expect(resolveTeamRoom("old", allowlist)).toBeNull();
    expect(resolveTeamRoom("channel-old", allowlist)).toBeNull();
    expect(resolveTeamRoom("projects", allowlist)?.id).toBe("channel-projects");
  });

  it("keeps seen Slack rooms when there is no env list", () => {
    const general = {
      externalKey: "C1",
      displayName: "general",
      conversationId: "slack:C1",
      workspaceId: "T1",
    };
    const allowlist = buildTeamRoomAllowlist("slack", [], [general]);
    expect(resolveTeamRoom("general", allowlist)?.conversationId).toBe("slack:C1");
  });
});

describe("postToTeamRoom", () => {
  it("posts an allowed room once through the outbound ledger", async () => {
    const { outbound, enqueue, deps } = createDeps();
    await expect(
      postToTeamRoom(deps, {
        room: "projects",
        text: "Daily log",
        deliveryKey: "exec-1",
      }),
    ).resolves.toEqual({ ok: true });
    expect(outbound).toEqual([
      {
        idempotencyKey: "team-room:exec-1",
        kind: "group",
        threadId: "discord:guild-1:channel-projects",
        body: "Daily log",
        status: "pending",
      },
    ]);
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("rejects a disallowed room without writing outbound", async () => {
    const { outbound, enqueue, deps } = createDeps();
    await expect(
      postToTeamRoom(deps, {
        room: "secrets",
        text: "nope",
        deliveryKey: "exec-2",
      }),
    ).resolves.toEqual({ ok: false, error: "That room is not on the team-room allowlist." });
    expect(outbound).toEqual([]);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("does not double-post when the same delivery is retried", async () => {
    const { outbound, enqueue, createMany, deps } = createDeps();
    const input = { room: "channel-projects", text: "Once", deliveryKey: "exec-3" };
    await expect(postToTeamRoom(deps, input)).resolves.toEqual({ ok: true });
    await expect(postToTeamRoom(deps, input)).resolves.toEqual({ ok: true });
    expect(outbound).toHaveLength(1);
    expect(createMany).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it("posts to the Discord room, not the last inbound thread", async () => {
    const { outbound, deps } = createDeps({
      seen: [
        {
          ...projects,
          conversationId: "discord:guild-1:channel-projects:thread-new",
        },
      ],
    });
    await expect(
      postToTeamRoom(deps, { room: "projects", text: "Daily log", deliveryKey: "exec-room" }),
    ).resolves.toEqual({ ok: true });
    expect(outbound[0]?.threadId).toBe("discord:guild-1:channel-projects");
  });

  it("appends a Discord thread onto guild and channel", async () => {
    const { outbound, deps } = createDeps();
    await expect(
      postToTeamRoom(deps, {
        room: "projects",
        text: "In thread",
        thread: "thread-99",
        deliveryKey: "exec-discord-thread",
      }),
    ).resolves.toEqual({ ok: true });
    expect(outbound[0]?.threadId).toBe("discord:guild-1:channel-projects:thread-99");
  });

  it("keeps Slack thread composition as provider:channel:thread", async () => {
    const { outbound, deps } = createDeps({
      provider: "slack",
      envRoomIds: [],
      seen: [
        {
          externalKey: "C1",
          displayName: "general",
          conversationId: "slack:C1",
          workspaceId: "T1",
        },
      ],
    });
    await expect(
      postToTeamRoom(deps, {
        room: "general",
        text: "In thread",
        thread: "100.1",
        deliveryKey: "exec-slack-thread",
      }),
    ).resolves.toEqual({ ok: true });
    expect(outbound[0]?.threadId).toBe("slack:C1:100.1");
  });

  it("rejects a seen Discord room missing from the env list", async () => {
    const { outbound, enqueue, deps } = createDeps({
      seen: [
        projects,
        {
          externalKey: "channel-old",
          displayName: "old",
          conversationId: "discord:guild-1:channel-old",
          workspaceId: "guild-1",
        },
      ],
      envRoomIds: ["channel-projects"],
    });
    await expect(
      postToTeamRoom(deps, { room: "old", text: "nope", deliveryKey: "exec-stale" }),
    ).resolves.toEqual({ ok: false, error: "That room is not on the team-room allowlist." });
    expect(outbound).toEqual([]);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("rejects text over the 2,000-character bound", () => {
    expect(
      validPostToTeamRoomArgs({ room: "projects", text: "a".repeat(TEAM_ROOM_TEXT_MAX_CHARS) }),
    ).toBe(true);
    expect(
      validPostToTeamRoomArgs({
        room: "projects",
        text: "a".repeat(TEAM_ROOM_TEXT_MAX_CHARS + 1),
      }),
    ).toBe(false);
    expect(validPostToTeamRoomArgs({ room: "projects", text: "Daily log", extra: true })).toBe(
      false,
    );
  });
});
