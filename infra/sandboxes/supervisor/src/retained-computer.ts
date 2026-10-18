import type Docker from "dockerode";

/** Explicit maintenance pin: reuse one existing computer without changing its runtime identity. */
export function assertRetainedComputer(
  info: Docker.ContainerInspectInfo | undefined,
  pin: string,
  expectedImage: string,
  homePath: string,
  supervisorNetworks: string[],
): asserts info is Docker.ContainerInspectInfo {
  const ports = Object.values(info?.HostConfig.PortBindings ?? {}).flat();
  const valid =
    /^[a-f0-9]{64}$/.test(pin) &&
    info?.Id === pin &&
    info.Image === expectedImage &&
    !info.State.Dead &&
    !info.State.Paused &&
    !info.State.Restarting &&
    supervisorNetworks.includes(info.HostConfig.NetworkMode ?? "") &&
    info.Mounts.some(
      (mount) =>
        mount.Type === "bind" &&
        mount.Source === homePath &&
        mount.Destination === "/home/rakazo" &&
        mount.RW,
    ) &&
    ports.length > 0 &&
    ports.every(
      (port) =>
        typeof port === "object" &&
        port !== null &&
        "HostIp" in port &&
        port.HostIp === "127.0.0.1",
    );
  if (!valid) {
    throw new Error("Pinned computer reuse checks failed; creation or replacement is disabled");
  }
}
