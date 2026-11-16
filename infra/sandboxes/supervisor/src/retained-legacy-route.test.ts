import { resolveSupervisorToken } from "@rakazo/core";
import type Docker from "dockerode";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { computerNetworkNameFor, computerNetworkOwnerFor } from "./computer-spec.js";

const mock = vi.hoisted(() => ({
  containers: new Map<string, Docker.ContainerInspectInfo>(),
  start: vi.fn(),
  remove: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  build: vi.fn(),
  image: vi.fn(),
  supervisor: vi.fn(),
  network: vi.fn(),
  version: vi.fn(),
}));
vi.mock("dockerode", () => ({
  default: class {
    getContainer(id: string) {
      return id === "supervisor"
        ? { inspect: mock.supervisor }
        : {
            inspect: async () => mock.containers.get(id),
            start: mock.start,
            remove: mock.remove,
          };
    }
    getNetwork() {
      return { inspect: mock.network };
    }
    listContainers = mock.list;
    createContainer = mock.create;
    buildImage = mock.build;
    version = mock.version;
    getImage() {
      return { inspect: mock.image };
    }
  },
}));
vi.mock("@rakazo/core/node/load-root-env", () => ({ loadRootEnv: vi.fn() }));

const id = "a".repeat(64);
const botId = "team-fixture";
const spaceId = "space-fixture";
const networkName = computerNetworkNameFor(botId);
const networkId = "c".repeat(64);
const dataSource = "/var/lib/docker/volumes/fixture_data/_data";

// Synthetic identifiers, same inspect topology as the retained September computer:
// supervisor volume, daemon-side legacy home bind, empty network ownership labels.
function fixture() {
  return {
    info: {
      Id: id,
      Image: "sha256:fixture-computer",
      State: { Running: false, Dead: false, Paused: false, Restarting: false },
      Config: {
        Image: "rakazo/computer:local",
        Labels: { "rakazo.managed": "true", "rakazo.botId": botId, "rakazo.spaceId": spaceId },
      },
      HostConfig: {
        NetworkMode: networkName,
        PortBindings: { "6080/tcp": [{ HostIp: "127.0.0.1", HostPort: "0" }] },
      },
      NetworkSettings: { Networks: { [networkName]: { NetworkID: networkId } } },
      Mounts: [
        {
          Type: "bind",
          Source: `${dataSource}/homes/${botId}`,
          Destination: "/home/rakazo",
          RW: true,
          Propagation: "rslave",
        },
      ],
    } as unknown as Docker.ContainerInspectInfo,
    supervisor: {
      Mounts: [
        {
          Type: "volume",
          Name: "fixture_data",
          Source: dataSource,
          Destination: "/data",
          RW: true,
        },
      ],
      NetworkSettings: { Networks: { service: { NetworkID: "service-network" } } },
    } as unknown as Docker.ContainerInspectInfo,
    network: {
      Id: networkId,
      Name: networkName,
      Labels: {},
      Containers: {},
    } as Docker.NetworkInspectInfo,
  };
}
let f: ReturnType<typeof fixture>;
beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  mock.containers.clear();
  vi.spyOn(process, "getuid").mockReturnValue(0);
  vi.stubEnv("HOSTNAME", "supervisor");
  vi.stubEnv("DATA_DIR", "/data");
  vi.stubEnv("SANDBOX_SCREEN_NETWORK", "published");
  vi.stubEnv("SANDBOX_RETAINED_COMPUTER_ID", id);
  vi.stubEnv("SANDBOX_RETAINED_ALLOW_HOMEKEY", "");
  vi.stubEnv("SANDBOX_SUPERVISOR_TOKEN", "deterministic-local-test-token-only");
  f = fixture();
  mock.containers.set(id, f.info);
  mock.supervisor.mockResolvedValue(f.supervisor);
  mock.network.mockResolvedValue(f.network);
  mock.image.mockResolvedValue({ Id: f.info.Image });
  mock.version.mockResolvedValue({ ApiVersion: "1.45" });
  mock.list.mockImplementation(async () => [...mock.containers.keys()].map((Id) => ({ Id })));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  expect(mock.create).not.toHaveBeenCalled();
  expect(mock.remove).not.toHaveBeenCalled();
  expect(mock.build).not.toHaveBeenCalled();
});
async function provision() {
  const { supervisorApp } = await import("./index.js");
  return supervisorApp.request("/computers", {
    method: "POST",
    headers: {
      authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
      "x-rakazo-bot-id": botId,
      "x-rakazo-space-id": spaceId,
      "content-type": "application/json",
    },
    body: JSON.stringify({ botId, spaceId, homePath: `/data/homes/${botId}` }),
  });
}

it("reuses the same pin with a volume-backed supervisor, legacy bind and unlabeled network", async () => {
  const response = await provision();
  expect(response.status, await response.clone().text()).toBe(200);
  expect(await response.json()).toMatchObject({ id, resumed: true, started: true });
  expect(mock.start).toHaveBeenCalledOnce();
});
it("also derives the daemon home when the network has both correct ownership labels", async () => {
  f.network.Labels = {
    "rakazo.botId": botId,
    "rakazo.computerOwner": computerNetworkOwnerFor("/data", f.supervisor),
  };
  const response = await provision();
  expect(response.status, await response.clone().text()).toBe(200);
  expect(mock.start).toHaveBeenCalledOnce();
});

it.each([
  ["changed pin", () => vi.stubEnv("SANDBOX_RETAINED_COMPUTER_ID", "b".repeat(64))],
  ["short pin", () => vi.stubEnv("SANDBOX_RETAINED_COMPUTER_ID", id.slice(0, 12))],
  [
    "changed image",
    () => {
      f.info.Image = "sha256:other";
    },
  ],
  [
    "changed space",
    () => {
      f.info.Config.Labels["rakazo.spaceId"] = "other";
    },
  ],
  [
    "changed bot",
    () => {
      f.info.Config.Labels["rakazo.botId"] = "other";
    },
  ],
  [
    "changed home",
    () => {
      f.info.Mounts[0]!.Source = `${dataSource}/homes/other`;
    },
  ],
  [
    "same suffix under another root",
    () => {
      f.info.Mounts[0]!.Source = `/other/homes/${botId}`;
    },
  ],
  [
    "service path instead of daemon home",
    () => {
      f.info.Mounts[0]!.Source = `/data/homes/${botId}`;
    },
  ],
  [
    "read-only home",
    () => {
      f.info.Mounts[0]!.RW = false;
    },
  ],
  [
    "wrong home target",
    () => {
      f.info.Mounts[0]!.Destination = "/other";
    },
  ],
  [
    "volume home instead of legacy bind",
    () => {
      f.info.Mounts[0]!.Type = "volume";
    },
  ],
  [
    "different trusted root",
    () => {
      f.supervisor.Mounts[0]!.Source = "/different/data";
    },
  ],
  [
    "missing trusted source",
    () => {
      f.supervisor.Mounts[0]!.Source = "";
    },
  ],
  [
    "relative trusted source",
    () => {
      f.supervisor.Mounts[0]!.Source = "relative/data";
    },
  ],
  [
    "wrong network name",
    () => {
      f.network.Name = computerNetworkNameFor("other");
    },
  ],
  [
    "missing network ID",
    () => {
      f.network.Id = "";
    },
  ],
  [
    "changed network ID",
    () => {
      f.network.Id = "d".repeat(64);
    },
  ],
  [
    "wrong effective network",
    () => {
      f.info.HostConfig.NetworkMode = computerNetworkNameFor("other");
    },
  ],
  [
    "missing attachment",
    () => {
      f.info.NetworkSettings.Networks = {};
    },
  ],
  [
    "wrong-team attachment",
    () => {
      f.info.NetworkSettings.Networks = { other: f.info.NetworkSettings.Networks[networkName]! };
    },
  ],
  [
    "extra attachment",
    () => {
      f.info.NetworkSettings.Networks.other = {
        ...f.info.NetworkSettings.Networks[networkName]!,
        NetworkID: "other",
      };
    },
  ],
  [
    "public binding",
    () => {
      f.info.HostConfig.PortBindings["6080/tcp"]![0]!.HostIp = "0.0.0.0";
    },
  ],
  [
    "paused state",
    () => {
      f.info.State.Paused = true;
    },
  ],
  [
    "dead state",
    () => {
      f.info.State.Dead = true;
    },
  ],
  [
    "restarting state",
    () => {
      f.info.State.Restarting = true;
    },
  ],
] as const)(
  "refuses the unlabeled legacy fixture with %s before starting",
  async (_name, mutate) => {
    mutate();
    const response = await provision();
    expect(response.status, await response.clone().text()).toBe(409);
    expect(await response.json()).toMatchObject({ code: "PERMANENT_SETUP_FAILURE" });
    expect(mock.start).not.toHaveBeenCalled();
    expect(mock.list).not.toHaveBeenCalledWith({ all: true });
  },
);

it.each<Record<string, string>>([
  { "rakazo.botId": botId },
  { "rakazo.computerOwner": computerNetworkOwnerFor("/data", fixture().supervisor) },
  { "rakazo.botId": "" },
  { "rakazo.computerOwner": "" },
  { "rakazo.botId": "other", "rakazo.computerOwner": "owner" },
  { "rakazo.botId": botId, "rakazo.computerOwner": "other" },
])("refuses partial or conflicting labels %j", async (labels) => {
  f.network.Labels = labels;
  const response = await provision();
  expect(response.status).toBe(409);
  expect(mock.start).not.toHaveBeenCalled();
  expect(mock.list).not.toHaveBeenCalledWith({ all: true });
});

it.each(["name", "ID", "short ID", "attachment name", "attachment ID"])(
  "refuses a foreign stopped container referencing the network by %s",
  async (reference) => {
    const foreign = structuredClone(f.info);
    foreign.Id = "b".repeat(64);
    foreign.Config.Labels = { "rakazo.botId": "other", "rakazo.spaceId": spaceId };
    foreign.HostConfig.NetworkMode =
      reference === "name"
        ? networkName
        : reference === "ID"
          ? networkId
          : reference === "short ID"
            ? networkId.slice(0, 12)
            : "none";
    foreign.NetworkSettings.Networks =
      reference === "attachment name"
        ? {
            [networkName]: { ...f.info.NetworkSettings.Networks[networkName]!, NetworkID: "stale" },
          }
        : reference === "attachment ID"
          ? { alias: f.info.NetworkSettings.Networks[networkName]! }
          : {};
    mock.containers.set(foreign.Id, foreign);
    const response = await provision();
    expect(response.status).toBe(409);
    expect(mock.list).toHaveBeenCalledWith({ all: true });
    expect(mock.start).not.toHaveBeenCalled();
  },
);
it("refuses a foreign running endpoint even if the container listing omits it", async () => {
  f.network.Containers = { ["b".repeat(64)]: {} } as Docker.NetworkInspectInfo["Containers"];
  expect((await provision()).status).toBe(409);
  expect(mock.start).not.toHaveBeenCalled();
});
it("permits unrelated stopped containers on other networks", async () => {
  const other = structuredClone(f.info);
  other.Id = "b".repeat(64);
  other.HostConfig.NetworkMode = "other";
  other.NetworkSettings.Networks = {};
  mock.containers.set(other.Id, other);
  expect((await provision()).status).toBe(200);
  expect(mock.start).toHaveBeenCalledOnce();
});
it("returns the already running exact legacy pin without starting it", async () => {
  f.info.State.Running = true;
  const response = await provision();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ id, resumed: true, started: false });
  expect(mock.start).not.toHaveBeenCalled();
});
it("does not start if the all-container ownership inspection fails", async () => {
  mock.list.mockImplementation(async (options) => {
    if (!options.filters) throw new Error("daemon inspection unavailable");
    return [{ Id: id }];
  });
  expect((await provision()).status).toBe(500);
  expect(mock.start).not.toHaveBeenCalled();
});
it("refuses a second container on the legacy network even with matching bot labels", async () => {
  const other = structuredClone(f.info);
  other.Id = "b".repeat(64);
  mock.containers.set(other.Id, other);
  expect((await provision()).status).toBe(409);
  expect(mock.start).not.toHaveBeenCalled();
});
it("waits for every configured-network inspection before starting", async () => {
  let release!: () => void;
  const checked = new Promise<void>((resolve) => {
    release = resolve;
  });
  mock.list.mockImplementation(async (options) => {
    if (!options.filters) await checked;
    return [{ Id: id }];
  });
  const pending = provision();
  await vi.waitFor(() => expect(mock.list).toHaveBeenCalledWith({ all: true }));
  expect(mock.start).not.toHaveBeenCalled();
  release();
  expect((await pending).status).toBe(200);
  expect(mock.start).toHaveBeenCalledOnce();
});
it.each([id, id.slice(0, 12), "retained-fixture"])(
  "refuses a foreign stopped container sharing the pinned network namespace by %s",
  async (target) => {
    f.info.Name = "/retained-fixture";
    const foreign = structuredClone(f.info);
    foreign.Id = "b".repeat(64);
    foreign.HostConfig.NetworkMode = `container:${target}`;
    foreign.NetworkSettings.Networks = {};
    mock.containers.set(foreign.Id, foreign);
    expect((await provision()).status).toBe(409);
    expect(mock.start).not.toHaveBeenCalled();
  },
);
