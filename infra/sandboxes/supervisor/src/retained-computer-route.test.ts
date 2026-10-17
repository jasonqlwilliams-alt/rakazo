import { resolveSupervisorToken } from "@rakazo/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  inspect: vi.fn(),
  start: vi.fn(),
  remove: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  build: vi.fn(),
  image: vi.fn(),
  supervisor: vi.fn(),
}));
vi.mock("dockerode", () => ({
  default: class {
    getContainer(id: string) {
      return id === "supervisor"
        ? { inspect: mock.supervisor }
        : { inspect: mock.inspect, start: mock.start, remove: mock.remove };
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
  vi.stubEnv("SANDBOX_SCREEN_NETWORK", "isolated");
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
  expect((await provision()).status).toBe(500);
  expect(mock.start).not.toHaveBeenCalled();
  expect(mock.create).not.toHaveBeenCalled();
  expect(mock.remove).not.toHaveBeenCalled();
});
it("does not build a missing computer image or replace a missing pinned computer", async () => {
  mock.image.mockRejectedValue(new Error("image missing"));
  expect((await provision()).status).toBe(500);
  expect(mock.build).not.toHaveBeenCalled();
  expect(mock.create).not.toHaveBeenCalled();
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
