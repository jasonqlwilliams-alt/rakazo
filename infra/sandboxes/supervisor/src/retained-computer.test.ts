import type Docker from "dockerode";
import { describe, expect, it } from "vitest";
import { assertRetainedComputer } from "./retained-computer.js";

const id = "a".repeat(64);
function fixture() {
  return {
    Id: id,
    Image: "sha256:image",
    State: { Running: true },
    Config: { User: "" },
    HostConfig: {
      NetworkMode: "existing",
      PortBindings: { "6080/tcp": [{ HostIp: "127.0.0.1", HostPort: "32768" }] },
    },
    Mounts: [{ Type: "bind", Source: "/data/home", Destination: "/home/rakazo", RW: true }],
  } as Docker.ContainerInspectInfo;
}
function check(info: Docker.ContainerInspectInfo | undefined, pin = id) {
  return assertRetainedComputer(info, pin, "sha256:image", "/data/home", ["existing"]);
}
describe("operator-pinned retained computer", () => {
  it("reuses the exact existing legacy runtime without changing its user or network", () => {
    const info = fixture();
    const before = structuredClone(info);
    check(info);
    expect(info).toEqual(before);
  });
  it("refuses missing or other containers instead of allowing replacement", () => {
    expect(() => check(undefined)).toThrow(/replacement is disabled/);
    const info = fixture();
    info.Id = "b".repeat(64);
    expect(() => check(info)).toThrow();
  });
  it("requires a complete immutable container ID", () => {
    expect(() => check(fixture(), id.slice(0, 12))).toThrow();
  });
  it("refuses changed images and unhealthy runtime states", () => {
    const info = fixture();
    info.Image = "sha256:other";
    expect(() => check(info)).toThrow();
    const paused = fixture();
    paused.State.Paused = true;
    expect(() => check(paused)).toThrow();
  });
  it("allows normal wake of the same stopped container without allowing replacement", () => {
    const stopped = fixture();
    stopped.State.Running = false;
    expect(() => check(stopped)).not.toThrow();
  });
  it("refuses a different, read-only, or volume-backed home", () => {
    for (const mutate of [
      (x: Docker.ContainerInspectInfo) => {
        x.Mounts[0]!.Source = "/other";
      },
      (x: Docker.ContainerInspectInfo) => {
        x.Mounts[0]!.RW = false;
      },
      (x: Docker.ContainerInspectInfo) => {
        x.Mounts[0]!.Type = "volume";
      },
    ]) {
      const info = fixture();
      mutate(info);
      expect(() => check(info)).toThrow();
    }
  });
  it("refuses a network outside the supervisor and publicly exposed ports", () => {
    const info = fixture();
    info.HostConfig.NetworkMode = "other";
    expect(() => check(info)).toThrow();
    const publicPort = fixture();
    publicPort.HostConfig.PortBindings["6080/tcp"]![0]!.HostIp = "0.0.0.0";
    expect(() => check(publicPort)).toThrow();
  });
});
