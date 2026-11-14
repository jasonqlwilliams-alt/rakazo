import { PermanentSetupError } from "@rakazo/adapter-kit";
import type Docker from "dockerode";
import { computerNetworkNameFor } from "./computer-spec.js";

const REFUSAL = "Pinned computer reuse checks failed; creation or replacement is disabled";

/** Resolve only this computer's network, owned by this installation, without changing it. */
export function retainedComputerNetwork(
  botId: string,
  owner: string,
  network: Docker.NetworkInspectInfo | undefined,
): string {
  const name = computerNetworkNameFor(botId);
  if (
    network?.Name !== name ||
    network.Labels?.["rakazo.botId"] !== botId ||
    network.Labels?.["rakazo.computerOwner"] !== owner
  ) {
    throw new PermanentSetupError(REFUSAL);
  }
  return name;
}

/** Explicit maintenance pin: reuse one existing computer without changing its runtime identity. */
export function assertRetainedComputer(
  info: Docker.ContainerInspectInfo | undefined,
  pin: string,
  expectedImage: string,
  homePath: string,
  expectedNetwork: string | undefined,
): asserts info is Docker.ContainerInspectInfo {
  const ports = Object.values(info?.HostConfig.PortBindings ?? {}).flat();
  const valid =
    /^[a-f0-9]{64}$/.test(pin) &&
    info?.Id === pin &&
    info.Image === expectedImage &&
    !info.State.Dead &&
    !info.State.Paused &&
    !info.State.Restarting &&
    Boolean(expectedNetwork) &&
    info.HostConfig.NetworkMode === expectedNetwork &&
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
    throw new PermanentSetupError(REFUSAL);
  }
}
