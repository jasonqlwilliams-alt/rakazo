import { createHash } from "node:crypto";
import path from "node:path";
import { MAX_DESKTOP_DISPLAY, screenPorts } from "@rakazo/core/node/desktop-runtime";
import type Docker from "dockerode";

export const COMPUTER_IMAGE = process.env.RAKAZO_COMPUTER_IMAGE ?? "rakazo/computer:local";
export const COMPUTER_UID = 1000;
export const COMPUTER_GID = 1000;
export const COMPUTER_USER = `${COMPUTER_UID}:${COMPUTER_GID}`;

export { screenPorts };
export const COMPUTER_CONTROL_PORT = 7070;
export const SCREEN_HOST = process.env.SANDBOX_SCREEN_HOST ?? "127.0.0.1";
export type ScreenNetworkMode = "published" | "internal" | "isolated";

export function resolveTeamScreenLimit(value = process.env.SANDBOX_TEAM_SCREEN_LIMIT): number {
  if (value === undefined || value.trim() === "" || isUnlimited(value)) return MAX_DESKTOP_DISPLAY;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error(
      "SANDBOX_TEAM_SCREEN_LIMIT must be a positive integer, or 0 for no configured cap",
    );
  }
  return Math.min(limit, MAX_DESKTOP_DISPLAY);
}

export function resolveSpaceComputerLimit(
  value = process.env.SANDBOX_MAX_COMPUTERS_PER_SPACE,
): number {
  if (value === undefined || value.trim() === "" || isUnlimited(value)) return 0;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error(
      "SANDBOX_MAX_COMPUTERS_PER_SPACE must be a positive integer, or 0 for no configured cap",
    );
  }
  return limit;
}

/**
 * Resource ceilings for a bot computer.
 *
 * A computer runs Xvfb, a window manager and a full Chromium on behalf of an
 * agent that decides for itself what to open. #343 gave these containers a
 * pids ceiling, but Memory and NanoCpus are still unset, so one runaway page is
 * a host-wide memory and CPU event that takes every other bot and the Rakazo
 * services down with it. Every service in docker-compose.prod.yml already
 * carries mem_limit; this applies the same discipline to the containers that
 * actually run untrusted page content.
 *
 * Defaults are a starting point for the Docker computer topology: generous enough
 * for real browsing, small enough that one computer cannot starve the host or
 * sibling bots. The pids default is #343's existing 2048, unchanged. Set any of
 * these to "0", "none" or "unlimited" to opt out.
 */
const DEFAULT_COMPUTER_MEMORY = "2g";
const DEFAULT_COMPUTER_CPUS = "2";
const DEFAULT_COMPUTER_PIDS_LIMIT = "2048";
/** The daemon refuses HostConfig.Memory below this at container creation. */
const MIN_DOCKER_MEMORY_BYTES = 6 * 1024 ** 2;

const MEMORY_UNITS: Record<string, number> = {
  b: 1,
  k: 1024,
  m: 1024 ** 2,
  g: 1024 ** 3,
};

function isUnlimited(raw: string): boolean {
  const value = raw.trim().toLowerCase();
  return value === "0" || value === "unlimited" || value === "none";
}

/** Bytes from a docker-style size string ("2g", "1536m", "1073741824"). */
export function parseMemoryBytes(name: string, raw: string): number {
  if (isUnlimited(raw)) return 0;
  const match = /^(\d+(?:\.\d+)?)\s*([bkmg])?b?$/i.exec(raw.trim());
  if (!match) {
    throw new Error(`${name} must be a size like "2g", "1536m" or a byte count, received "${raw}"`);
  }
  const scale = MEMORY_UNITS[(match[2] ?? "b").toLowerCase()] ?? 1;
  const bytes = Math.floor(Number(match[1]) * scale);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new Error(`${name} must resolve to a positive byte count, received "${raw}"`);
  }
  // The daemon rejects a limit under 6 MiB at container creation. Catching it here turns a
  // per-bot 500 at the first `POST /computers` into a startup failure that names the variable.
  if (bytes < MIN_DOCKER_MEMORY_BYTES) {
    throw new Error(`${name} must be at least 6m, Docker's minimum, received "${raw}"`);
  }
  return bytes;
}

/** Docker NanoCpus (1e9 per core) from a CPU count like "1.5". */
export function parseNanoCpus(name: string, raw: string): number {
  if (isUnlimited(raw)) return 0;
  const value = Number(raw.trim());
  // Tiny positives floor to 0 nanocpus (Docker reads as unlimited). Huge values leave the
  // safe-integer range or become Infinity. Validate the converted number either way.
  const nanoCpus = Math.floor(value * 1e9);
  if (!Number.isSafeInteger(nanoCpus) || nanoCpus <= 0) {
    throw new Error(`${name} must be a positive number of CPUs, received "${raw}"`);
  }
  return nanoCpus;
}

function parsePidsLimit(name: string, raw: string): number {
  if (isUnlimited(raw)) return 0;
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, received "${raw}"`);
  }
  return value;
}

/** The host resource ceilings applied to every bot computer. */
export function computerResourceLimits() {
  const memoryBytes = parseMemoryBytes(
    "RAKAZO_COMPUTER_MEMORY",
    process.env.RAKAZO_COMPUTER_MEMORY ?? DEFAULT_COMPUTER_MEMORY,
  );
  const nanoCpus = parseNanoCpus(
    "RAKAZO_COMPUTER_CPUS",
    process.env.RAKAZO_COMPUTER_CPUS ?? DEFAULT_COMPUTER_CPUS,
  );
  const pidsLimit = parsePidsLimit(
    "RAKAZO_COMPUTER_PIDS_LIMIT",
    process.env.RAKAZO_COMPUTER_PIDS_LIMIT ?? DEFAULT_COMPUTER_PIDS_LIMIT,
  );
  return {
    // Memory and MemorySwap are set together: leaving MemorySwap unset lets the
    // container swap to twice Memory, so the ceiling would not hold.
    Memory: memoryBytes,
    MemorySwap: memoryBytes,
    NanoCpus: nanoCpus,
    PidsLimit: pidsLimit,
  };
}

export function resolveScreenNetworkMode(value: string | undefined): ScreenNetworkMode {
  if (!value || value === "published") return "published";
  if (value === "internal" || value === "isolated") return value;
  throw new Error(`Unsupported SANDBOX_SCREEN_NETWORK value: ${value}`);
}

export function hostComputerUser(uid = process.getuid?.(), gid = process.getgid?.()): string {
  if (uid === undefined || gid === undefined || uid === 0) return COMPUTER_USER;
  return `${uid}:${gid}`;
}

export function computerPortBindings(publishControlPort = false) {
  const ExposedPorts: Record<string, object> = {};
  const PortBindings: Record<string, Array<{ HostIp: string; HostPort: string }>> = {};
  const port = `${screenPorts(0).viewPort}/tcp`;
  ExposedPorts[port] = {};
  PortBindings[port] = [{ HostIp: "127.0.0.1", HostPort: "0" }];
  // Host-run Docker Desktop supervisors need an opt-in loopback mapping.
  // Otherwise control stays unpublished on the container network.
  if (publishControlPort) {
    ExposedPorts[`${COMPUTER_CONTROL_PORT}/tcp`] = {};
    PortBindings[`${COMPUTER_CONTROL_PORT}/tcp`] = [{ HostIp: "127.0.0.1", HostPort: "0" }];
  }
  return { ExposedPorts, PortBindings };
}

export function computerHomeStorage(
  serviceHomePath: string,
  dataDir: string,
  info: Docker.ContainerInspectInfo | undefined,
): { homePath: string; homeVolume?: { name: string; subpath: string } } {
  const relative = path.relative(dataDir, serviceHomePath);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("computer home must be inside the data directory");
  }
  const mount = info?.Mounts.find((entry) => entry.Destination === dataDir);
  if (mount?.Type === "volume") {
    if (!mount.Name) throw new Error("computer data volume has no name");
    return { homePath: serviceHomePath, homeVolume: { name: mount.Name, subpath: relative } };
  }
  return { homePath: mount?.Source ? path.join(mount.Source, relative) : serviceHomePath };
}

export function assertVolumeSubpathSupport(apiVersion: string) {
  const match = /^(\d+)\.(\d+)$/.exec(apiVersion);
  if (!match || Number(match[1]) < 1 || (Number(match[1]) === 1 && Number(match[2]) < 45)) {
    throw new Error("Docker Engine 26+ (API 1.45+) is required for bot home volume subpaths");
  }
}

export function homeVolumeMatches(
  mounts: Docker.ContainerInspectInfo["HostConfig"]["Mounts"],
  volume: { name: string; subpath: string },
) {
  return (
    mounts?.some(
      (mount) =>
        mount.Target === "/home/rakazo" &&
        mount.Type === "volume" &&
        mount.Source === volume.name &&
        mount.VolumeOptions?.Subpath === volume.subpath &&
        !mount.ReadOnly,
    ) ?? false
  );
}

/** A host folder or file mounted into a bot computer beside its home. */
export interface ComputerBind {
  source: string;
  target: string;
  readOnly: boolean;
}

/** One `SANDBOX_COMPUTER_BINDS` entry: a bind plus the home keys of the computers that get it. */
export interface ComputerBindRule extends ComputerBind {
  homeKeys: string[];
}

/** Every bind source is a path Compose mounted on the supervisor under this prefix. */
export const COMPUTER_BIND_SOURCE_PREFIX = "/host/";
/** Every bind target lives here, outside the home so the home store never sees host folders. */
export const COMPUTER_BIND_TARGET_PREFIX = "/continuum/";

function containedPath(value: string, prefix: string, what: string, entry: string): string {
  const normalized = path.posix.normalize(value.trim()).replace(/\/+$/, "");
  if (
    !path.posix.isAbsolute(normalized) ||
    !normalized.startsWith(prefix) ||
    normalized.length === prefix.length
  ) {
    throw new Error(
      `SANDBOX_COMPUTER_BINDS ${what} must be a path under ${prefix}, received "${entry}"`,
    );
  }
  return normalized;
}

/**
 * Parse `SANDBOX_COMPUTER_BINDS`: entries separated by `;` or newlines, each
 * `<supervisor mount path>:<target under /continuum/>[:<ro|rw>]@<homeKey>[,<homeKey>...]`.
 * The mode defaults to read-only. Targets may not repeat or nest within one computer,
 * because a nested bind shadows part of the other.
 */
export function parseComputerBinds(value = process.env.SANDBOX_COMPUTER_BINDS): ComputerBindRule[] {
  const rules: ComputerBindRule[] = [];
  const targetsByHome = new Map<string, string[]>();
  for (const raw of (value ?? "").split(/[;\n]/)) {
    const entry = raw.trim();
    if (!entry) continue;
    const at = entry.lastIndexOf("@");
    const parts = at < 0 ? [] : entry.slice(0, at).split(":");
    if (parts.length < 2 || parts.length > 3) {
      throw new Error(
        `SANDBOX_COMPUTER_BINDS entries look like "<source>:<target>[:<ro|rw>]@<homeKey>[,...]", received "${entry}"`,
      );
    }
    const [rawSource, rawTarget, rawMode = "ro"] = parts as [string, string, string?];
    const source = containedPath(rawSource, COMPUTER_BIND_SOURCE_PREFIX, "source", entry);
    const target = containedPath(rawTarget, COMPUTER_BIND_TARGET_PREFIX, "target", entry);
    const mode = rawMode.trim();
    if (mode !== "ro" && mode !== "rw") {
      throw new Error(`SANDBOX_COMPUTER_BINDS mode must be "ro" or "rw", received "${entry}"`);
    }
    const homeKeys = entry
      .slice(at + 1)
      .split(",")
      .map((key) => key.trim());
    if (homeKeys.some((key) => !key)) {
      throw new Error(`SANDBOX_COMPUTER_BINDS needs at least one home key, received "${entry}"`);
    }
    for (const homeKey of homeKeys) {
      const targets = targetsByHome.get(homeKey) ?? [];
      const clash = targets.find(
        (other) =>
          other === target || other.startsWith(`${target}/`) || target.startsWith(`${other}/`),
      );
      if (clash) {
        throw new Error(
          `SANDBOX_COMPUTER_BINDS target ${target} repeats or nests ${clash} for ${homeKey}`,
        );
      }
      targets.push(target);
      targetsByHome.set(homeKey, targets);
    }
    rules.push({ source, target, readOnly: mode === "ro", homeKeys });
  }
  return rules;
}

/**
 * Translate each bind source into the path the Docker daemon binds. Inside Compose that
 * is the supervisor's own mount of the source (the same translation computerHomeStorage
 * applies to the data directory); a host-run supervisor shares the daemon's filesystem.
 */
export function resolveComputerBinds(
  rules: ComputerBind[],
  info: Docker.ContainerInspectInfo | undefined,
): ComputerBind[] {
  return rules.map(({ source, target, readOnly }) => {
    if (!info) return { source, target, readOnly };
    const mount = info.Mounts.filter(
      (entry) =>
        entry.Type === "bind" &&
        (entry.Destination === source || source.startsWith(`${entry.Destination}/`)),
    ).sort((a, b) => b.Destination.length - a.Destination.length)[0];
    if (!mount?.Source) {
      throw new Error(`computer bind source ${source} is not mounted on the supervisor`);
    }
    return {
      source: path.posix.join(mount.Source, path.posix.relative(mount.Destination, source)),
      target,
      readOnly,
    };
  });
}

function bindSpec(bind: ComputerBind) {
  return `${bind.source}:${bind.target}:${bind.readOnly ? "ro" : "rw"}`;
}

/**
 * Whether an existing computer carries exactly the configured binds. Docker keeps
 * HostConfig.Binds verbatim from creation, so the home entry is set aside and the rest
 * compared as a set: a changed bind list means the computer must be recreated.
 */
export function computerBindsMatch(
  existing: string[] | null | undefined,
  desired: ComputerBind[],
): boolean {
  const current = (existing ?? []).filter((bind) => bind.split(":")[1] !== "/home/rakazo").sort();
  const wanted = desired.map(bindSpec).sort();
  return current.length === wanted.length && current.every((bind, i) => bind === wanted[i]);
}

export interface ComputerCreateInput {
  name: string;
  image: string;
  botId: string;
  spaceId: string;
  homePath: string;
  homeVolume?: { name: string; subpath: string };
  binds?: ComputerBind[];
  user?: string;
  controlToken?: string;
  networkMode?: string;
  publishControlPort?: boolean;
}

interface PointerInput {
  kind: "pointer";
  x: number;
  y: number;
  button?: "left" | "right";
  type: "move" | "down" | "up" | "click";
}

export type SandboxInput =
  | { kind: "key"; key: string; modifiers?: string[] }
  | PointerInput
  | { kind: "clipboard"; text: string };

export function containerCreateOptions(input: ComputerCreateInput) {
  const ports = computerPortBindings(input.publishControlPort);
  const binds = (input.binds ?? []).map(bindSpec);
  return {
    Image: input.image,
    name: input.name,
    User: input.user ?? COMPUTER_USER,
    Tty: true,
    Env: [
      "DISPLAY=:1",
      "HOME=/home/rakazo",
      "PATH=/home/rakazo/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      "NPM_CONFIG_PREFIX=/home/rakazo/.local",
      "PIP_USER=1",
      ...(input.controlToken ? [`RAKAZO_COMPUTER_CONTROL_TOKEN=${input.controlToken}`] : []),
    ],
    Labels: {
      "rakazo.managed": "true",
      "rakazo.botId": input.botId,
      "rakazo.spaceId": input.spaceId,
    },
    ExposedPorts: ports.ExposedPorts,
    HostConfig: {
      ...(input.homeVolume
        ? {
            Binds: binds.length ? binds : undefined,
            Mounts: [
              {
                Type: "volume" as const,
                Source: input.homeVolume.name,
                Target: "/home/rakazo",
                // Docker makes Labels and DriverConfig optional; dockerode's types do not.
                VolumeOptions: {
                  NoCopy: true,
                  Subpath: input.homeVolume.subpath,
                } as Docker.MountSettings["VolumeOptions"],
              },
            ],
          }
        : { Binds: [`${input.homePath}:/home/rakazo`, ...binds], Mounts: undefined }),
      PortBindings: ports.PortBindings,
      ShmSize: 256 * 1024 * 1024,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      ...computerResourceLimits(),
      ReadonlyPaths: ["/usr/share/novnc"],
      AutoRemove: false,
      NetworkMode: input.networkMode ?? "bridge",
    },
    WorkingDir: "/home/rakazo",
  };
}

export function sanitizeIdentifier(botId: string) {
  const safe = botId.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 40);
  return safe || "box";
}

export function containerNameFor(botId: string) {
  return `rakazo-bot-${sanitizeIdentifier(botId)}`;
}

export function computerNetworkNameFor(botId: string) {
  // Keep distinct botIds on distinct networks even when sanitization collapses
  // characters (e.g. "a/b" and "ab"). Do not change containerNameFor — that
  // name must stay stable so an existing computer can resume.
  const hash = createHash("sha256").update(botId).digest("hex").slice(0, 32);
  return `rakazo-computer-${sanitizeIdentifier(botId).slice(0, 32)}-${hash}`;
}

/** Current and prior network names used by this PR, for delete cleanup. */
export function computerNetworkNamesForCleanup(botId: string) {
  const safe = sanitizeIdentifier(botId);
  const digest = createHash("sha256").update(botId).digest("hex");
  return [
    computerNetworkNameFor(botId),
    `rakazo-computer-${safe}`,
    `rakazo-computer-${safe.slice(0, 32)}-${digest.slice(0, 8)}`,
  ];
}

/**
 * Legacy unsalted network names can collide across botIds. Only remove such a
 * network when no other bot's container is still attached.
 */
export function legacyNetworkOwnedSolelyBy(
  botId: string,
  attachedBotIds: Array<string | undefined>,
): boolean {
  return attachedBotIds.every((owner) => owner === botId);
}

export function screenUrlFor(hostPort: string, host = SCREEN_HOST) {
  return `http://${host}:${hostPort}/embed.html`;
}

export function screenUrlWithToken(screenUrl: string, token: string) {
  const url = new URL(screenUrl);
  url.searchParams.set("path", `websockify?token=${encodeURIComponent(token)}`);
  return url.toString();
}

/**
 * Decide which host:port clients (and readiness probes) should use.
 *
 * Per-bot NetworkMode isolation must not change this: a container always has a
 * docker-internal IP on its network, but browsers cannot load that 172.x
 * address. Compose modes that attach the supervisor/screen proxy to the bot
 * network may return the container IP; host-run supervisors use the published
 * loopback mapping.
 */
export function resolveScreenPublishTarget(input: {
  screenNetwork: ScreenNetworkMode;
  networkMode: string | null | undefined;
  networks: Record<string, { IPAddress?: string } | undefined> | null | undefined;
  hostPort: string | undefined;
  containerPort: string;
  screenHost?: string;
}): { host: string; port: string } | undefined {
  if (input.screenNetwork === "internal" || input.screenNetwork === "isolated") {
    const address = input.networkMode ? input.networks?.[input.networkMode]?.IPAddress : undefined;
    if (address) return { host: address, port: input.containerPort };
    return undefined;
  }
  if (input.hostPort) return { host: input.screenHost ?? SCREEN_HOST, port: input.hostPort };
  return undefined;
}

type ControlPortBindings =
  | Record<string, Array<{ HostIp?: string; HostPort?: string }> | null | undefined>
  | null
  | undefined;

function validHostPort(port: string | undefined): port is string {
  return !!port && /^\d{1,5}$/.test(port) && Number(port) > 0 && Number(port) <= 65535;
}

/** Resolve an assigned runtime port only when every control binding is loopback. */
export function publishedLoopbackControlHostPort(portBindings: ControlPortBindings) {
  const bindings = portBindings?.[`${COMPUTER_CONTROL_PORT}/tcp`];
  if (!bindings?.length || bindings.some((binding) => binding.HostIp !== "127.0.0.1")) {
    return undefined;
  }
  return bindings.find((binding) => validHostPort(binding.HostPort))?.HostPort;
}

/**
 * Reuse only containers whose configured control publication matches the setting.
 * Inspect HostConfig so stopped containers and Docker's automatic port allocation
 * (empty or zero HostPort) work before a runtime port has been assigned.
 */
export function controlPortPublicationMatches(
  portBindings: ControlPortBindings,
  publishControlPort: boolean,
): boolean {
  const bindings = portBindings?.[`${COMPUTER_CONTROL_PORT}/tcp`];
  if (!publishControlPort) return !bindings?.length;
  return (
    !!bindings?.length &&
    bindings.every(
      (binding) =>
        binding.HostIp === "127.0.0.1" &&
        (binding.HostPort === "" || binding.HostPort === "0" || validHostPort(binding.HostPort)),
    )
  );
}

/**
 * Resolve the computer control service. Prefer a published loopback HostPort
 * when provided; otherwise use the Docker network IP. When requirePublishedHostPort
 * is set, never fall back to the container IP (unreachable from Docker Desktop hosts).
 */
export function resolveComputerControlEndpoint(input: {
  token: string | undefined;
  networkMode: string | null | undefined;
  networks: Record<string, { IPAddress?: string } | undefined> | null | undefined;
  publishedHostPort?: string;
  requirePublishedHostPort?: boolean;
}): { url: string; token: string } | undefined {
  if (!input.token) return undefined;
  if (validHostPort(input.publishedHostPort)) {
    return {
      url: `http://127.0.0.1:${input.publishedHostPort}/v1/desktop`,
      token: input.token,
    };
  }
  if (input.requirePublishedHostPort) return undefined;
  const address =
    (input.networkMode ? input.networks?.[input.networkMode]?.IPAddress : undefined) ||
    Object.values(input.networks ?? {}).find((network) => network?.IPAddress)?.IPAddress;
  if (!address) return undefined;
  return { url: `http://${address}:${COMPUTER_CONTROL_PORT}/v1/desktop`, token: input.token };
}

export function xdotoolCommand(input: SandboxInput): string[] {
  if (input.kind === "key") {
    const key = mapKey(input.key);
    const mods = (input.modifiers ?? []).map(mapKey);
    const combo = [...mods, key].join("+");
    return ["xdotool", "key", "--clearmodifiers", combo];
  }
  if (input.kind === "pointer") {
    const btn = input.button === "right" ? "3" : "1";
    if (input.type === "move")
      return ["xdotool", "mousemove", "--", String(input.x), String(input.y)];
    if (input.type === "down") {
      return ["xdotool", "mousemove", "--", String(input.x), String(input.y), "mousedown", btn];
    }
    if (input.type === "up") return ["xdotool", "mouseup", btn];
    return ["xdotool", "mousemove", "--", String(input.x), String(input.y), "click", btn];
  }
  return ["xdotool", "type", "--clearmodifiers", "--", input.text];
}

function mapKey(key: string) {
  const lower = key.toLowerCase();
  if (lower === "enter" || lower === "return") return "Return";
  if (lower === "esc" || lower === "escape") return "Escape";
  if (lower === "space") return "space";
  if (lower === "tab") return "Tab";
  if (lower === "backspace") return "BackSpace";
  if (lower === "ctrl" || lower === "control") return "ctrl";
  if (lower === "alt") return "alt";
  if (lower === "shift") return "shift";
  if (lower === "meta" || lower === "cmd" || lower === "super") return "super";
  return key;
}
