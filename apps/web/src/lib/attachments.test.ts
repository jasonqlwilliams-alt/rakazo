import type { DesktopPickedFile } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  copyBrowserImages,
  formatAttachmentSize,
  mergePickedFiles,
  messageWithPhotoPaths,
} from "./attachments.js";

const photo: DesktopPickedFile = {
  name: "sample.png",
  path: "inbox/id-sample.png",
  size: 1536,
  mimeType: "image/png",
};

describe("composer photo attachments", () => {
  it("keeps thread sends text-only with one bot-relative path line per photo", () => {
    expect(
      messageWithPhotoPaths("Please inspect these", [
        photo,
        { ...photo, name: "two.jpg", path: "inbox/id-two.jpg" },
      ]),
    ).toBe(
      "Please inspect these\nPhoto (sample.png): inbox/id-sample.png\nPhoto (two.jpg): inbox/id-two.jpg",
    );
    expect(messageWithPhotoPaths("", [photo])).toBe("Photo (sample.png): inbox/id-sample.png");
  });

  it("deduplicates chips by the returned local path and formats their sizes", () => {
    expect(mergePickedFiles([photo], [photo, { ...photo, path: "inbox/other.png" }])).toHaveLength(
      2,
    );
    expect(formatAttachmentSize(photo.size)).toBe("2 KB");
  });

  it("shows no copied file until the authenticated local copy succeeds", async () => {
    const request = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "copy failed" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
    );
    const file = new File([Uint8Array.from([1, 2, 3])], "sample.png", { type: "image/png" });

    await expect(copyBrowserImages("bot-1", [file], request)).rejects.toThrow("copy failed");
  });
});
