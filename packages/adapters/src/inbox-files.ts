import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  AdapterContext,
  AgentHomeStore,
  ComputerRef,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import type { ComputerMode, DesktopPickedFile } from "@rakazo/contracts";
import { resolveBotWorkspacePath } from "./computer-support.js";

export const MAX_INBOX_IMAGE_COUNT = 12;
export const MAX_INBOX_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_INBOX_IMAGE_TOTAL_BYTES = 100 * 1024 * 1024;

export interface InboxImage {
  name: string;
  bytes: Uint8Array;
}

export async function storeBotInboxImages(
  deps: { home: AgentHomeStore; sandbox: SandboxProvider },
  input: {
    botId: string;
    homeKey: string;
    mode: ComputerMode;
    computer: ComputerRef;
    files: InboxImage[];
    createId?: () => string;
  },
  context: AdapterContext,
): Promise<DesktopPickedFile[]> {
  validateImageBatch(input.files);
  const createId = input.createId ?? randomUUID;
  const stored: DesktopPickedFile[] = [];

  for (const file of input.files) {
    const detected = detectImage(file.bytes);
    if (!detected) throw new Error(`${displayName(file.name)} is not a supported image`);
    const name = displayName(file.name);
    const storedName = `${createId().slice(0, 12)}-${safeStem(name)}.${detected.extension}`;
    const relativePath = path.posix.join("inbox", storedName);
    const workspacePath = resolveBotWorkspacePath(input.mode, input.botId, relativePath);

    // The active sandbox is what open_path sees now; the home store makes the file durable
    // across a later stop/restore. Do not show a chip unless both copies succeeded.
    await deps.sandbox.writeFile(
      input.computer,
      { path: workspacePath, content: file.bytes },
      context,
    );
    await deps.home.writeFile(input.homeKey, workspacePath, file.bytes, context);
    stored.push({
      name,
      path: relativePath,
      size: file.bytes.byteLength,
      mimeType: detected.mimeType,
    });
  }

  return stored;
}

function validateImageBatch(files: InboxImage[]) {
  if (files.length === 0) throw new Error("Choose at least one image");
  if (files.length > MAX_INBOX_IMAGE_COUNT) {
    throw new Error(`Choose no more than ${MAX_INBOX_IMAGE_COUNT} images at once`);
  }
  let total = 0;
  for (const file of files) {
    if (file.bytes.byteLength > MAX_INBOX_IMAGE_BYTES) {
      throw new Error(`${displayName(file.name)} is larger than 25 MB`);
    }
    total += file.bytes.byteLength;
  }
  if (total > MAX_INBOX_IMAGE_TOTAL_BYTES) {
    throw new Error("The selected images are larger than 100 MB together");
  }
}

function displayName(value: string) {
  const name = [...path.basename(value.replace(/\\/g, "/"))]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? " " : character;
    })
    .join("")
    .trim();
  return name || "photo";
}

function safeStem(value: string) {
  const stem = path
    .parse(value)
    .name.normalize("NFKC")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 80);
  return stem || "photo";
}

function detectImage(bytes: Uint8Array): { mimeType: string; extension: string } | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mimeType: "image/png", extension: "png" };
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return { mimeType: "image/jpeg", extension: "jpg" };
  }
  const ascii = (start: number, end: number) =>
    new TextDecoder("ascii").decode(bytes.subarray(start, end));
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") {
    return { mimeType: "image/gif", extension: "gif" };
  }
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") {
    return { mimeType: "image/webp", extension: "webp" };
  }
  if (startsWith(bytes, [0x42, 0x4d])) {
    return { mimeType: "image/bmp", extension: "bmp" };
  }
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) {
    return { mimeType: "image/tiff", extension: "tiff" };
  }
  if (ascii(4, 8) === "ftyp") {
    const brand = ascii(8, 12);
    if (["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(brand)) {
      return { mimeType: "image/heic", extension: "heic" };
    }
    if (brand === "avif") return { mimeType: "image/avif", extension: "avif" };
  }
  return undefined;
}

function startsWith(bytes: Uint8Array, prefix: number[]) {
  return prefix.every((value, index) => bytes[index] === value);
}
