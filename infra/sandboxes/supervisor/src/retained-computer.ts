import path from "node:path";
import { PermanentSetupError } from "@rakazo/adapter-kit";
import type Docker from "dockerode";
import { computerHomeStorage, computerNetworkNameFor } from "./computer-spec.js";
import { hasComputerIdentity } from "./supervisor-logic.js";

const REFUSAL = "Pinned computer reuse checks failed; creation or replacement is disabled";

/** Legacy binds use the daemon's data root, not the supervisor's volume mountpoint. */
export function retainedComputerHomePath(
  serviceHomePath: string,
  dataDir: string,
  supervisor: Docker.ContainerInspectInfo | undefined,
): string {
  const storage = computerHomeStorage(serviceHomePath, dataDir, supervisor);
  if (!storage.homeVolume) return storage.homePath;
  const mount = supervisor?.Mounts.find((entry) => entry.Destination === dataDir);
  if (!mount?.Source || !path.isAbsolute(mount.Source)) {
    throw new PermanentSetupError(REFUSAL);
  }
  return path.join(mount.Source, storage.homeVolume.subpath);
}

/** All retained identity checks precede the narrow unlabeled-network compatibility case. */
export async function validateRetainedComputer(input: {
  info: Docker.ContainerInspectInfo | undefined;
  pin: string;
  expectedImage: string;
  homePath: string;
  networkMode: string | undefined;
  botId: string;
  spaceId: string;
  owner: string;
  network: Docker.NetworkInspectInfo | undefined;
  inspectOtherContainers: () => Promise<Docker.ContainerInspectInfo[]>;
}): Promise<Docker.ContainerInspectInfo> {
  const { info, pin, expectedImage, homePath, networkMode, botId, spaceId, owner, network } = input;
  const teamNetwork = networkMode === computerNetworkNameFor(botId);
  if (teamNetwork && !network) retainedComputerNetwork(botId, owner, network);
  if (teamNetwork && (!network?.Id || network.Name !== networkMode)) {
    throw new PermanentSetupError(REFUSAL);
  }
  assertRetainedComputer(
    info,
    pin,
    expectedImage,
    homePath,
    networkMode,
    teamNetwork ? network?.Id : undefined,
  );
  if (!hasComputerIdentity(info.Config.Labels, botId, spaceId)) {
    throw new PermanentSetupError(REFUSAL);
  }
  if (teamNetwork && network) {
    const labels = network.Labels ?? {};
    const unlabeled =
      !Object.hasOwn(labels, "rakazo.botId") && !Object.hasOwn(labels, "rakazo.computerOwner");
    if (!unlabeled) {
      retainedComputerNetwork(botId, owner, network);
    } else {
      // Network inspect omits stopped containers. Inspect all configured references;
      // neither a matching name alone nor empty running endpoints proves exclusivity.
      const others = await input.inspectOtherContainers();
      const shared = others.some((other) => {
        const mode = other.HostConfig.NetworkMode;
        const namespace = mode?.startsWith("container:") ? mode.slice("container:".length) : "";
        return (
          mode === network.Name ||
          mode === network.Id ||
          (typeof mode === "string" && /^[a-f0-9]+$/.test(mode) && network.Id.startsWith(mode)) ||
          (namespace !== "" &&
            (namespace === info.Name?.replace(/^\//, "") ||
              (/^[a-f0-9]+$/.test(namespace) && pin.startsWith(namespace)))) ||
          Object.entries(other.NetworkSettings.Networks).some(
            ([name, endpoint]) => name === network.Name || endpoint.NetworkID === network.Id,
          )
        );
      });
      if (shared || Object.keys(network.Containers ?? {}).some((id) => id !== pin)) {
        throw new PermanentSetupError(REFUSAL);
      }
    }
  }
  return info;
}

/** Resolve only this computer's network, owned by this installation, without changing it. */
export function retainedComputerNetwork(
  botId: string,
  owner: string,
  network: Docker.NetworkInspectInfo | undefined,
): string {
  const name = computerNetworkNameFor(botId);
  if (!network) {
    throw new PermanentSetupError(
      "Pinned computer's owned team network is unavailable; creation or replacement is disabled",
    );
  }
  if (
    !network.Id ||
    network.Name !== name ||
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
  expectedNetworkId?: string,
): asserts info is Docker.ContainerInspectInfo {
  const ports = Object.values(info?.HostConfig.PortBindings ?? {}).flat();
  const attachedNetworks = info?.NetworkSettings?.Networks ?? {};
  const valid =
    /^[a-f0-9]{64}$/.test(pin) &&
    info?.Id === pin &&
    info.Image === expectedImage &&
    !info.State.Dead &&
    !info.State.Paused &&
    !info.State.Restarting &&
    typeof expectedNetwork === "string" &&
    expectedNetwork.length > 0 &&
    info.HostConfig.NetworkMode === expectedNetwork &&
    Object.keys(attachedNetworks).length === 1 &&
    Boolean(attachedNetworks[expectedNetwork]) &&
    (!expectedNetworkId || attachedNetworks[expectedNetwork]?.NetworkID === expectedNetworkId) &&
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
