import path from "node:path";
import type { DesktopPickedFile } from "@rakazo/contracts";

const imageTypes: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".heic": "image/heic",
  ".heif": "image/heic",
  ".avif": "image/avif",
};

export function imageMimeType(filePath: string): string | undefined {
  return imageTypes[path.extname(filePath).toLowerCase()];
}

export function desktopCookieHeader(cookies: Array<{ name: string; value: string }>): string {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

export function parsePickedFiles(value: unknown): DesktopPickedFile[] {
  if (!value || typeof value !== "object" || !("files" in value)) {
    throw new Error("The desktop file copy returned an invalid response");
  }
  const files = (value as { files: unknown }).files;
  if (!Array.isArray(files)) throw new Error("The desktop file copy returned an invalid response");
  return files.map((file) => {
    if (
      !file ||
      typeof file !== "object" ||
      typeof (file as { name?: unknown }).name !== "string" ||
      typeof (file as { path?: unknown }).path !== "string" ||
      typeof (file as { size?: unknown }).size !== "number" ||
      typeof (file as { mimeType?: unknown }).mimeType !== "string"
    ) {
      throw new Error("The desktop file copy returned an invalid response");
    }
    return file as DesktopPickedFile;
  });
}
