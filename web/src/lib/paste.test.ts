import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import {
  MAX_PASTE_BYTES,
  humanBytes,
  imageFromTransfer,
  sendImage,
  type PasteResult,
} from "./paste";

/** A DataTransfer stand-in: jsdom's is not constructible with contents. */
function transfer(
  items: { kind: string; type: string; file?: File }[],
  files: File[] = [],
): DataTransfer {
  const itemList: Record<string, unknown> = {};
  items.forEach((it, i) => {
    itemList[i] = { kind: it.kind, type: it.type, getAsFile: () => it.file ?? null };
  });
  itemList.length = items.length;

  const fileList: Record<string, unknown> = {};
  files.forEach((f, i) => {
    fileList[i] = f;
  });
  fileList.length = files.length;

  return { items: itemList, files: fileList } as unknown as DataTransfer;
}

const png = () => new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" });

describe("finding an image on a clipboard or a drop", () => {
  it("finds one in items", () => {
    const file = png();
    expect(imageFromTransfer(transfer([{ kind: "file", type: "image/png", file }]))).toBe(file);
  });

  it("finds one in files, which is all a Finder drag gives you", () => {
    const file = png();
    expect(imageFromTransfer(transfer([], [file]))).toBe(file);
  });

  it("returns null for a plain text paste, so the terminal handles it itself", () => {
    expect(imageFromTransfer(transfer([{ kind: "string", type: "text/plain" }]))).toBeNull();
  });

  it("ignores a non-image file — a dropped tarball is not a paste", () => {
    const tar = new File(["x"], "a.tgz", { type: "application/gzip" });
    expect(
      imageFromTransfer(transfer([{ kind: "file", type: "application/gzip", file: tar }])),
    ).toBeNull();
    expect(imageFromTransfer(transfer([], [tar]))).toBeNull();
  });

  it("is null-safe: a paste event can carry no clipboardData at all", () => {
    expect(imageFromTransfer(null)).toBeNull();
    expect(imageFromTransfer(undefined)).toBeNull();
  });
});

describe("sendImage", () => {
  const ok: PasteResult = {
    path: "/var/lib/herdrer/pastes/9f2a1c.png",
    content_type: "image/png",
    bytes: 3,
  };

  it("types the path with a trailing space, once the upload has landed", async () => {
    const write = vi.fn();
    const sent = await sendImage(png(), {
      upload: () => Promise.resolve(ok),
      write,
      onError: vi.fn(),
    });
    expect(sent).toBe(true);
    expect(write).toHaveBeenCalledWith(`${ok.path} `);
  });

  it("writes nothing to the socket when the upload fails", async () => {
    const write = vi.fn();
    const onError = vi.fn();
    const sent = await sendImage(png(), {
      upload: () => Promise.reject(new ApiError("Can't reach the box.", "NETWORK", 0)),
      write,
      onError,
    });
    expect(sent).toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("shows the server's own words when it refuses the bytes", async () => {
    const onError = vi.fn();
    await sendImage(png(), {
      upload: () =>
        Promise.reject(
          new ApiError("that does not look like a PNG, JPEG, GIF or WebP", "VALIDATION_ERROR", 400),
        ),
      write: vi.fn(),
      onError,
    });
    expect(onError.mock.calls[0]![0]).toMatch(/does not look like a PNG/);
  });

  it("writes nothing when the box saves it but names no path", async () => {
    const write = vi.fn();
    await sendImage(png(), {
      upload: () => Promise.resolve({ path: "", content_type: "image/png", bytes: 3 }),
      write,
      onError: vi.fn(),
    });
    expect(write).not.toHaveBeenCalled();
  });

  it("refuses an oversized file locally rather than burning the upload", async () => {
    const upload = vi.fn();
    const onError = vi.fn();
    const big = { size: MAX_PASTE_BYTES + 1, type: "image/png" } as Blob;
    expect(await sendImage(big, { upload, write: vi.fn(), onError })).toBe(false);
    expect(upload).not.toHaveBeenCalled();
    expect(onError.mock.calls[0]![0]).toMatch(/limit is/);
  });

  it("refuses something that is not an image before it goes anywhere", async () => {
    const upload = vi.fn();
    const notAnImage = new File(["x"], "a.tgz", { type: "application/gzip" });
    expect(await sendImage(notAnImage, { upload, write: vi.fn(), onError: vi.fn() })).toBe(false);
    expect(upload).not.toHaveBeenCalled();
  });
});

describe("humanBytes", () => {
  it("reads like a size, not like a number", () => {
    expect(humanBytes(512)).toBe("512 B");
    expect(humanBytes(2048)).toBe("2 kB");
    expect(humanBytes(3.4 * 1024 * 1024)).toBe("3.4 MB");
  });
});
