import { resolveSupervisorToken } from "@rakazo/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  computerBridgeNameFor,
  computerNetworkNameFor,
  computerNetworkOwnerFor,
} from "./computer-spec.js";

const mock = vi.hoisted(() => ({
  inspect: vi.fn(),
  start: vi.fn(),
  remove: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  build: vi.fn(),
  image: vi.fn(),
  supervisor: vi.fn(),
  network: vi.fn(),
}));
vi.mock("dockerode", () => ({
  default: class {
    getContainer(id: string) {
      return id === "supervisor"
        ? { inspect: mock.supervisor }
        : { inspect: mock.inspect, start: mock.start, remove: mock.remove };
    }
    getNetwork() {
      return { inspect: mock.network };
    }
    listContainers = mock.list;
    createContainer = mock.create;
    buildImage = mock.build;
    getImage() {
      return { inspect: mock.image };
    }
  },
}));
vi.mock("@rakazo/core/node/load-root-env", () => ({ loadRootEnv: vi.fn() }));

const id = "a".repeat(64);
function info() {
  return {
    Id: id,
    Image: "sha256:image",
    State: { Running: true },
    Config: {
      User: "",
      Labels: { "rakazo.managed": "true", "rakazo.botId": "home", "rakazo.workspaceId": "space" },
    },
    HostConfig: {
      NetworkMode: "existing",
      PortBindings: { "6080/tcp": [{ HostIp: "127.0.0.1", HostPort: "0" }] },
    },
    NetworkSettings: {
      Networks: { existing: { NetworkID: "net-service" } } as Record<string, { NetworkID: string }>,
    },
    Mounts: [
      { Type: "bind", Source: "/host/data/homes/home", Destination: "/home/rakazo", RW: true },
    ],
  };
}
beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.spyOn(process, "getuid").mockReturnValue(0);
  vi.stubEnv("HOSTNAME", "supervisor");
  vi.stubEnv("DATA_DIR", "/data");
  vi.stubEnv("SANDBOX_SCREEN_NETWORK", "internal");
  vi.stubEnv("SANDBOX_RETAINED_COMPUTER_ID", id);
  vi.stubEnv("SANDBOX_SUPERVISOR_TOKEN", "deterministic-local-test-token-only");
  mock.supervisor.mockResolvedValue({
    Mounts: [{ Destination: "/data", Source: "/host/data" }],
    NetworkSettings: { Networks: { existing: {} } },
  });
  mock.inspect.mockResolvedValue(info());
  mock.image.mockResolvedValue({ Id: "sha256:image" });
  mock.list.mockResolvedValue([{ Id: id }]);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
function headers(space = "space") {
  return {
    authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
    "x-rakazo-bot-id": "home",
    "x-rakazo-space-id": space,
    "content-type": "application/json",
  };
}
async function provision() {
  const { supervisorApp } = await import("./index.js");
  return supervisorApp.request("/computers", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ botId: "home", spaceId: "space", homePath: "/data/homes/home" }),
  });
}
it("returns the exact running legacy container without creating, starting, or removing", async () => {
  const r = await provision();
  expect(r.status, await r.clone().text()).toBe(200);
  expect(await r.json()).toMatchObject({ id, resumed: true });
  expect(mock.start).not.toHaveBeenCalled();
  expect(mock.create).not.toHaveBeenCalled();
  expect(mock.remove).not.toHaveBeenCalled();
  expect(mock.build).not.toHaveBeenCalled();
});
it("wakes the same stopped container without replacement", async () => {
  const stopped = info();
  stopped.State.Running = false;
  mock.inspect.mockResolvedValue(stopped);
  const response = await provision();
  expect(response.status, await response.clone().text()).toBe(200);
  expect(mock.start).toHaveBeenCalledTimes(1);
  expect(mock.create).not.toHaveBeenCalled();
  expect(mock.remove).not.toHaveBeenCalled();
});
it("does not bypass workspace ownership for the pinned ID", async () => {
  const other = info();
  other.Config.Labels["rakazo.workspaceId"] = "other";
  mock.inspect.mockResolvedValue(other);
  expect((await provision()).status).toBe(409);
  expect(mock.start).not.toHaveBeenCalled();
  expect(mock.create).not.toHaveBeenCalled();
  expect(mock.remove).not.toHaveBeenCalled();
});
it("does not build a missing computer image or replace a missing pinned computer", async () => {
  mock.image.mockRejectedValue(
    Object.assign(new Error("private image details"), { statusCode: 404 }),
  );
  const response = await provision();
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    code: "PERMANENT_SETUP_FAILURE",
    error: "Pinned computer image is unavailable; creation or replacement is disabled",
  });
  expect(mock.build).not.toHaveBeenCalled();
  expect(mock.create).not.toHaveBeenCalled();
});
it("keeps transient image inspection failures retryable", async () => {
  mock.image.mockRejectedValue(Object.assign(new Error("daemon unavailable"), { statusCode: 503 }));
  const response = await provision();
  expect(response.status).toBe(500);
  expect(await response.json()).not.toHaveProperty("code", "PERMANENT_SETUP_FAILURE");
});
it("lets SANDBOX_RETAINED_ALLOW_HOMEKEY homeKeys bypass the retained-computer pin", async () => {
  vi.stubEnv("SANDBOX_SCREEN_NETWORK", "internal");
  vi.stubEnv("SANDBOX_RETAINED_ALLOW_HOMEKEY", "other-bot, home");
  const unpinned = {
    ...info(),
    Id: "b".repeat(64),
    Config: { ...info().Config, User: "1000:1000" },
    HostConfig: {
      ...info().HostConfig,
      Binds: ["/host/data/homes/home:/home/rakazo"],
    },
    NetworkSettings: { Networks: { existing: {} } },
  };
  mock.list.mockResolvedValue([{ Id: unpinned.Id }]);
  mock.inspect.mockResolvedValue(unpinned);
  const r = await provision();
  expect(r.status, await r.clone().text()).toBe(200);
  expect(await r.json()).toMatchObject({ resumed: true });
});
it("refuses deletion of the owned pin and rejects a different requesting space", async () => {
  const { supervisorApp } = await import("./index.js");
  expect(
    (await supervisorApp.request(`/computers/${id}`, { method: "DELETE", headers: headers() }))
      .status,
  ).toBe(409);
  expect(
    (
      await supervisorApp.request(`/computers/${id}`, {
        method: "DELETE",
        headers: headers("other"),
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await supervisorApp.request(`/computers/${id.slice(0, 12)}`, {
        method: "DELETE",
        headers: headers(),
      })
    ).status,
  ).toBe(409);
  expect(mock.remove).not.toHaveBeenCalled();
});

// Real retained team topology: the supervisor stays on the service network.
it.each(["published", "isolated"])("wakes its owned team network in %s topology", async (mode) => {
  vi.stubEnv("SANDBOX_SCREEN_NETWORK", mode);
  const team = info();
  team.State.Running = false;
  team.HostConfig.NetworkMode = computerNetworkNameFor("home");
  team.NetworkSettings.Networks = {
    [computerNetworkNameFor("home")]: { NetworkID: "net-owned" },
  };
  mock.inspect.mockResolvedValue(team);
  mock.network.mockResolvedValue({
    Id: "net-owned",
    Name: computerNetworkNameFor("home"),
    Labels: {
      "rakazo.botId": "home",
      "rakazo.computerOwner": computerNetworkOwnerFor("/host/data", undefined),
    },
  });
  const response = await provision();
  expect(response.status, await response.clone().text()).toBe(200);
  expect(mock.start).toHaveBeenCalledOnce();
  expect(mock.create).not.toHaveBeenCalled();
  expect(mock.remove).not.toHaveBeenCalled();
});

it.each(["other-team", "other-owner", "other-name", "missing-labels", "wrong-container-network"])(
  "refuses a team network with %s before starting the pin",
  async (defect) => {
    vi.stubEnv("SANDBOX_SCREEN_NETWORK", "isolated");
    const team = info();
    team.State.Running = false;
    team.HostConfig.NetworkMode = computerNetworkNameFor(
      defect === "wrong-container-network" ? "other" : "home",
    );
    team.NetworkSettings.Networks = {
      [computerNetworkNameFor("home")]: { NetworkID: "net-owned" },
    };
    mock.inspect.mockResolvedValue(team);
    mock.network.mockResolvedValue({
      Id: "net-owned",
      Name: computerNetworkNameFor(defect === "other-name" ? "other" : "home"),
      Labels:
        defect === "missing-labels"
          ? {}
          : {
              "rakazo.botId": defect === "other-team" ? "other" : "home",
              "rakazo.computerOwner":
                defect === "other-owner"
                  ? "other"
                  : computerNetworkOwnerFor("/host/data", undefined),
            },
    });
    const response = await provision();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "PERMANENT_SETUP_FAILURE" });
    expect(mock.start).not.toHaveBeenCalled();
    expect(mock.create).not.toHaveBeenCalled();
    expect(mock.remove).not.toHaveBeenCalled();
  },
);
it.each(["missing", "other-team", "extra", "stale-id"])(
  "refuses a pin with %s actual network attachment",
  async (defect) => {
    vi.stubEnv("SANDBOX_SCREEN_NETWORK", "isolated");
    const team = info();
    team.State.Running = false;
    team.HostConfig.NetworkMode = computerNetworkNameFor("home");
    team.NetworkSettings.Networks =
      defect === "missing"
        ? {}
        : defect === "other-team"
          ? { [computerNetworkNameFor("other")]: { NetworkID: "net-other" } }
          : {
              [computerNetworkNameFor("home")]: {
                NetworkID: defect === "stale-id" ? "net-old" : "net-owned",
              },
              ...(defect === "extra" ? { other: { NetworkID: "net-other" } } : {}),
            };
    mock.inspect.mockResolvedValue(team);
    mock.network.mockResolvedValue({
      Id: "net-owned",
      Name: computerNetworkNameFor("home"),
      Labels: {
        "rakazo.botId": "home",
        "rakazo.computerOwner": computerNetworkOwnerFor("/host/data", undefined),
      },
    });
    const response = await provision();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "PERMANENT_SETUP_FAILURE" });
    expect(mock.start).not.toHaveBeenCalled();
    expect(mock.create).not.toHaveBeenCalled();
    expect(mock.remove).not.toHaveBeenCalled();
  },
);
it("refuses a missing owned team network with a terminal reason", async () => {
  vi.stubEnv("SANDBOX_SCREEN_NETWORK", "isolated");
  const team = info();
  team.HostConfig.NetworkMode = computerNetworkNameFor("home");
  mock.inspect.mockResolvedValue(team);
  mock.network.mockRejectedValue(Object.assign(new Error("no such network"), { statusCode: 404 }));
  const response = await provision();
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    code: "PERMANENT_SETUP_FAILURE",
    error:
      "Pinned computer's owned team network is unavailable; creation or replacement is disabled",
  });
  expect(mock.start).not.toHaveBeenCalled();
  expect(mock.create).not.toHaveBeenCalled();
  expect(mock.remove).not.toHaveBeenCalled();
});
it.each([false, true])("uses only a named restricted bridge: %s", async (namedBridge) => {
  vi.stubEnv("SANDBOX_SCREEN_NETWORK", "isolated");
  vi.stubEnv("SANDBOX_COMPUTER_EGRESS", "restricted");
  const team = info();
  team.State.Running = false;
  team.HostConfig.NetworkMode = computerNetworkNameFor("home");
  team.NetworkSettings.Networks = {
    [computerNetworkNameFor("home")]: { NetworkID: "net-owned" },
  };
  mock.inspect.mockResolvedValue(team);
  mock.network.mockResolvedValue({
    Id: "net-owned",
    Name: computerNetworkNameFor("home"),
    Labels: {
      "rakazo.botId": "home",
      "rakazo.computerOwner": computerNetworkOwnerFor("/host/data", undefined),
    },
    Options: namedBridge ? { "com.docker.network.bridge.name": computerBridgeNameFor("home") } : {},
  });
  const response = await provision();
  expect(response.status).toBe(namedBridge ? 200 : 409);
  if (!namedBridge) {
    expect(await response.json()).toMatchObject({ code: "PERMANENT_SETUP_FAILURE" });
  }
  expect(mock.start).toHaveBeenCalledTimes(namedBridge ? 1 : 0);
  expect(mock.create).not.toHaveBeenCalled();
  expect(mock.remove).not.toHaveBeenCalled();
});
