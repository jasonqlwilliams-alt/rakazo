import { describe, expect, it } from "vitest";
import { desktopCookieHeader, imageMimeType, parsePickedFiles } from "./file-picker.js";

describe("desktop photo picker support", () => {
  it("accepts common photo extensions without exposing local source paths", () => {
    expect(imageMimeType("C:\\Users\\Jason\\photo.PNG")).toBe("image/png");
    expect(imageMimeType("/tmp/photo.heic")).toBe("image/heic");
    expect(imageMimeType("/tmp/notes.txt")).toBeUndefined();
  });

  it("serializes the existing renderer session for the local copy request", () => {
    expect(
      desktopCookieHeader([
        { name: "better-auth.session_token", value: "token.signature" },
        { name: "theme", value: "dark" },
      ]),
    ).toBe("better-auth.session_token=token.signature; theme=dark");
  });

  it("returns only server-provided bot-relative paths", () => {
    expect(
      parsePickedFiles({
        files: [
          {
            name: "photo.png",
            path: "inbox/id-photo.png",
            size: 42,
            mimeType: "image/png",
          },
        ],
      }),
    ).toEqual([
      {
        name: "photo.png",
        path: "inbox/id-photo.png",
        size: 42,
        mimeType: "image/png",
      },
    ]);
  });
});
