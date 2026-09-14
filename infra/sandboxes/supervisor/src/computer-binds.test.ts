import type * as NodeFsPromises from "node:fs/promises";
import path from "node:path";
import { resolveSupervisorToken } from "@rakazo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  docker: {
    version: vi.fn(),
    getImage: vi.fn(),
    getContainer: vi.fn(),
    listContainers: vi.fn(),
    createContainer: vi.fn(),
    createNetwork: vi.fn(),
  },
  fs: { stat: vi.fn(), opendir: vi.fn() },
}));
vi.mock("dockerode", () => ({
  default: class {
    version = mocks.docker.version;
    getImage = mocks.docker.getImage;
    getContainer = mocks.docker.getContainer;
    listContainers = mocks.docker.listContainers;
    createContainer = mocks.docker.createContainer;
    createNetwork = mocks.docker.createNetwork;
  },
}));
vi.mock("./home-ownership.js", () => ({ assertComputerHomeWritable: vi.fn() }));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFsPromises>()),
  mkdir: vi.fn(),
  stat: mocks.fs.stat,
  opendir: mocks.fs.opendir,
}));

const DATA_DIR = "/data";
const DAILY_SOURCE = "/run/desktop/mnt/host/c/Vault/Daily";
const HOWTO_SOURCE = "/run/desktop/mnt/host/c/Vault/router/HOWTO.md";
const DAILY_BIND = `${DAILY_SOURCE}:/continuum/daily:rw`;
const HOWTO_BIND = `${HOWTO_SOURCE}:/continuum/packet-router/docs/HOWTO.md:ro`;
const BINDS = `/host/daily:/continuum/daily:rw@team-space
/host/HOWTO.md:/continuum/packet-router/docs/HOWTO.md:ro@team-space,bot-1
`;

/** The supervisor's own container, with Compose mounts for the data directory and two host paths. */
const supervisor = { inspect: vi.fn() };
const supervisorMounts = [
  { Type: "bind", Source: "/srv/rakazo/data", Destination: DATA_DIR },
  { Type: "bind", Source: DAILY_SOURCE, Destination: "/host/daily" },
  { Type: "bind", Source: HOWTO_SOURCE, Destination: "/host/HOWTO.md" },
];

/** The daily source is a folder holding `entries`; the HOWTO source is a regular file. */
function hostFoldersPresent(entries = ["2026-09-14.md"]) {
  mocks.fs.stat.mockImplementation(async (target: string) => ({
    isDirectory: () => target === "/host/daily",
  }));
  mocks.fs.opendir.mockImplementation(async () => {
    const pending = entries.map((name) => ({ name }));
    return { read: async () => pending.shift() ?? null, close: vi.fn(async () => undefined) };
  });
}

function existingComputer(binds: string[] | undefined, botId = "team-space") {
  const home = path.join(DATA_DIR, "homes", botId);
  const existing = {
    id: "existing",
    inspect: vi.fn().mockResolvedValue({
      Id: "existing",
      Image: "image",
      Config: {
        User: "1000:1000",
        Labels: { "rakazo.managed": "true", "rakazo.botId": botId, "rakazo.spaceId": "space" },
      },
      HostConfig: {
        NetworkMode: "shared",
        PortBindings: {},
        Binds: binds && [`/srv/rakazo/data/homes/${botId}:/home/rakazo`, ...binds],
      },
      State: { Running: false },
      NetworkSettings: {},
    }),
    start: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  };
  mocks.docker.listContainers.mockResolvedValue([{ Id: existing.id }]);
  mocks.docker.getContainer.mockImplementation((id: string) =>
    id === "supervisor" ? supervisor : existing,
  );
  return { existing, home };
}

async function provision(botId = "team-space") {
  const { supervisorApp } = await import("./index.js");
  return supervisorApp.request("/computers", {
    method: "POST",
    headers: {
      authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
      "content-type": "application/json",
      "x-rakazo-bot-id": botId,
      "x-rakazo-space-id": "space",
    },
    body: JSON.stringify({
      botId,
      spaceId: "space",
      homePath: path.join(DATA_DIR, "homes", botId),
    }),
  });
}

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubEnv("HOSTNAME", "supervisor");
  vi.stubEnv("DATA_DIR", DATA_DIR);
  vi.stubEnv("SANDBOX_SCREEN_NETWORK", "internal");
  vi.stubEnv("SANDBOX_COMPUTER_BINDS", BINDS);
  supervisor.inspect.mockResolvedValue({
    NetworkSettings: { Networks: { shared: {} } },
    Mounts: supervisorMounts,
  });
  mocks.docker.getImage.mockReturnValue({ inspect: vi.fn().mockResolvedValue({ Id: "image" }) });
  mocks.docker.getContainer.mockReturnValue(supervisor);
  mocks.docker.listContainers.mockResolvedValue([]);
  mocks.docker.createContainer.mockResolvedValue({
    id: "created",
    start: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("host folder binds on bot computers", () => {
  it("forwards the daemon-side source of each configured bind for the computer's home key", async () => {
    hostFoldersPresent();
    const response = await provision();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: "created", resumed: false });
    const [options] = mocks.docker.createContainer.mock.calls[0]!;
    expect(options.HostConfig.Binds).toEqual([
      "/srv/rakazo/data/homes/team-space:/home/rakazo",
      DAILY_BIND,
      HOWTO_BIND,
    ]);
    expect(mocks.fs.stat).toHaveBeenCalledWith("/host/daily");
    expect(mocks.fs.stat).toHaveBeenCalledWith("/host/HOWTO.md");
  });

  it("gives another computer only the binds scoped to its home key", async () => {
    hostFoldersPresent();
    expect((await provision("bot-1")).status).toBe(200);
    const [options] = mocks.docker.createContainer.mock.calls[0]!;
    expect(options.HostConfig.Binds).toEqual([
      "/srv/rakazo/data/homes/bot-1:/home/rakazo",
      HOWTO_BIND,
    ]);
    expect(mocks.fs.stat).not.toHaveBeenCalledWith("/host/daily");
  });

  it("leaves computers with no configured binds exactly as before", async () => {
    hostFoldersPresent();
    expect((await provision("bot-2")).status).toBe(200);
    const [options] = mocks.docker.createContainer.mock.calls[0]!;
    expect(options.HostConfig.Binds).toEqual(["/srv/rakazo/data/homes/bot-2:/home/rakazo"]);
    expect(mocks.fs.stat).not.toHaveBeenCalled();
  });

  it("refuses a source that is missing on the supervisor before touching Docker", async () => {
    mocks.fs.stat.mockRejectedValue(new Error("ENOENT"));
    const response = await provision();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "computer bind source /host/daily is missing on the supervisor",
    });
    expect(mocks.docker.createContainer).not.toHaveBeenCalled();
    expect(mocks.docker.createNetwork).not.toHaveBeenCalled();
  });

  it("refuses an empty source folder, the signature of a wrong Docker Desktop path", async () => {
    hostFoldersPresent([]);
    const response = await provision();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "computer bind source /host/daily is empty on the supervisor",
    });
    expect(mocks.docker.createContainer).not.toHaveBeenCalled();
  });

  it("refuses an empty source folder before recreating a computer, leaving the old one in place", async () => {
    hostFoldersPresent([]);
    const { existing } = existingComputer([DAILY_BIND]);
    const response = await provision();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "computer bind source /host/daily is empty on the supervisor",
    });
    expect(existing.remove).not.toHaveBeenCalled();
    expect(mocks.docker.createContainer).not.toHaveBeenCalled();
  });

  it("resumes a computer that already carries the binds even after a bound folder drains", async () => {
    hostFoldersPresent([]);
    const { existing } = existingComputer([DAILY_BIND, HOWTO_BIND]);
    const response = await provision();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: "existing", resumed: true });
    expect(existing.start).toHaveBeenCalledOnce();
    expect(mocks.fs.opendir).not.toHaveBeenCalled();
  });

  it("refuses a source Compose did not mount on the supervisor", async () => {
    hostFoldersPresent();
    supervisor.inspect.mockResolvedValue({
      NetworkSettings: { Networks: { shared: {} } },
      Mounts: [supervisorMounts[0]],
    });
    const response = await provision();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "computer bind source /host/daily is not mounted on the supervisor",
    });
    expect(mocks.docker.createContainer).not.toHaveBeenCalled();
  });

  it("refuses binds on a supervisor that does not run in a container", async () => {
    hostFoldersPresent();
    supervisor.inspect.mockRejectedValue(new Error("no such container"));
    const response = await provision();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error:
        "SANDBOX_COMPUTER_BINDS needs the supervisor to run in a container that mounts each source",
    });
    expect(mocks.fs.stat).not.toHaveBeenCalled();
    expect(mocks.docker.createContainer).not.toHaveBeenCalled();
  });

  it("resumes an existing computer whose binds equal the configuration", async () => {
    hostFoldersPresent();
    const { existing } = existingComputer([HOWTO_BIND, DAILY_BIND]);
    const response = await provision();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: "existing", resumed: true });
    expect(existing.start).toHaveBeenCalledOnce();
    expect(existing.remove).not.toHaveBeenCalled();
    expect(mocks.docker.createContainer).not.toHaveBeenCalled();
  });

  it.each([
    ["created before any bind existed", undefined],
    ["missing one bind", [DAILY_BIND]],
    ["carrying a bind at a different mode", [DAILY_BIND, HOWTO_BIND.replace(/:ro$/, ":rw")]],
    ["carrying a bind no longer configured", [DAILY_BIND, HOWTO_BIND, "/srv/x:/continuum/x:ro"]],
  ])("recreates an existing computer %s", async (_case, binds) => {
    hostFoldersPresent();
    const { existing } = existingComputer(binds);
    const response = await provision();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: "created", resumed: false });
    expect(existing.remove).toHaveBeenCalledWith({ force: true });
    const [options] = mocks.docker.createContainer.mock.calls[0]!;
    expect(options.HostConfig.Binds).toEqual([
      "/srv/rakazo/data/homes/team-space:/home/rakazo",
      DAILY_BIND,
      HOWTO_BIND,
    ]);
  });

  it("recreates a computer that still carries binds after the configuration is cleared", async () => {
    vi.stubEnv("SANDBOX_COMPUTER_BINDS", "");
    const { existing } = existingComputer([DAILY_BIND]);
    const response = await provision();
    expect(await response.json()).toMatchObject({ id: "created", resumed: false });
    expect(existing.remove).toHaveBeenCalledWith({ force: true });
    const [options] = mocks.docker.createContainer.mock.calls[0]!;
    expect(options.HostConfig.Binds).toEqual(["/srv/rakazo/data/homes/team-space:/home/rakazo"]);
  });

  it.each([
    ["a source outside /host/", "/mnt/c/daily:/continuum/daily:ro@team-space", /source/],
    ["an entry without a mode", "/host/daily:/continuum/daily@team-space", /look like/],
  ])("fails at startup on %s", async (_case, binds, error) => {
    vi.stubEnv("SANDBOX_COMPUTER_BINDS", binds);
    await expect(import("./index.js")).rejects.toThrow(error);
  });
});
