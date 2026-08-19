import type { DesktopPickedFile } from "@rakazo/contracts";

export function messageWithPhotoPaths(draft: string, files: DesktopPickedFile[]): string {
  const parts = [
    draft.trim(),
    ...files.map((file) => `Photo (${singleLine(file.name)}): ${file.path}`),
  ].filter(Boolean);
  return parts.join("\n");
}

export function mergePickedFiles(
  current: DesktopPickedFile[],
  added: DesktopPickedFile[],
): DesktopPickedFile[] {
  const byPath = new Map(current.map((file) => [file.path, file]));
  for (const file of added) byPath.set(file.path, file);
  return [...byPath.values()];
}

export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export async function copyBrowserImages(
  botId: string,
  files: File[],
  request: typeof fetch = fetch,
): Promise<DesktopPickedFile[]> {
  const form = new FormData();
  form.set("botId", botId);
  for (const file of files) form.append("files", file, file.name);
  const response = await request("/api/desktop-files", {
    method: "POST",
    credentials: "include",
    body: form,
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error: unknown }).error)
        : "Could not attach photos";
    throw new Error(message);
  }
  return pickedFiles(payload);
}

function pickedFiles(value: unknown): DesktopPickedFile[] {
  if (!value || typeof value !== "object" || !("files" in value)) {
    throw new Error("The photo copy returned an invalid response");
  }
  const files = (value as { files: unknown }).files;
  if (!Array.isArray(files)) throw new Error("The photo copy returned an invalid response");
  return files.map((file) => {
    if (
      !file ||
      typeof file !== "object" ||
      typeof (file as { name?: unknown }).name !== "string" ||
      typeof (file as { path?: unknown }).path !== "string" ||
      typeof (file as { size?: unknown }).size !== "number" ||
      typeof (file as { mimeType?: unknown }).mimeType !== "string"
    ) {
      throw new Error("The photo copy returned an invalid response");
    }
    return file as DesktopPickedFile;
  });
}

function singleLine(value: string) {
  return value.replace(/[\r\n]+/g, " ").trim() || "photo";
}
