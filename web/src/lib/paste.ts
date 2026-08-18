import { ApiError, describeError, upload } from "./api";

/**
 * Handing an image to an agent that lives in a PTY.
 *
 * A terminal cannot carry an image. xterm gives the page a `File` on paste, but
 * the far end is a byte stream, and the image escape sequences that exist
 * (kitty, iTerm2) are for *display* — they hand a picture to the emulator, not a
 * file to the program running inside it. Claude Code and Codex will both read an
 * image when given a path, so the picture goes out of band over HTTP and what
 * goes down the PTY is text: the path the server wrote it to.
 *
 * The path is safe to inject by construction rather than by escaping — fixed
 * directory, server-generated hex basename, extension sniffed from the bytes —
 * so there is nothing here to quote. See docs/API.md.
 */

/** What the server will accept; anything else is refused by sniffing, not by header. */
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

/** The server's cap. Checked here too, so a doomed 20 MiB upload never starts. */
export const MAX_PASTE_BYTES = 12 * 1024 * 1024;

export interface PasteResult {
  path: string;
  content_type: string;
  bytes: number;
}

function looksLikeImage(type: string | undefined): boolean {
  return typeof type === "string" && type.startsWith("image/");
}

/**
 * The image on a clipboard or a drop, if there is one.
 *
 * Both `items` and `files` are consulted because browsers disagree: Safari
 * populates `items` for a screenshot copied from Preview, Chrome on Android
 * populates `files`, and a drag-and-drop from Finder populates `files` only.
 *
 * Returns null for a plain text paste, which is the important case: the caller
 * must then do nothing at all and let the terminal's own paste handling run.
 */
export function imageFromTransfer(data: DataTransfer | null | undefined): File | null {
  if (!data) return null;

  const items = data.items;
  if (items) {
    for (let i = 0; i < items.length; i++) {
      const entry = items[i];
      if (!entry || entry.kind !== "file" || !looksLikeImage(entry.type)) continue;
      const file = entry.getAsFile();
      if (file) return file;
    }
  }

  const files = data.files;
  if (files) {
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file && looksLikeImage(file.type)) return file;
    }
  }

  return null;
}

/** Human bytes for a progress line: "3.4 MB". */
export function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} kB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export interface SendImageDeps {
  /** Uploads and resolves with where the server put it. */
  upload: (
    blob: Blob,
    onProgress?: (loaded: number, total: number) => void,
  ) => Promise<PasteResult>;
  /** Writes text to the PTY — lane 0x00, exactly as if it had been typed. */
  write: (text: string) => void;
  onProgress?: (loaded: number, total: number) => void;
  onError: (message: string) => void;
  onDone?: (result: PasteResult) => void;
}

/**
 * Upload, then type the path.
 *
 * The ordering is the whole safety property: **nothing is written to the socket
 * unless the upload succeeded.** A half-typed path, or a path to a file that
 * does not exist, is worse than a visible failure — the agent would read it,
 * fail, and report something confusing about a missing file.
 *
 * The trailing space is deliberate. The next thing the human types is almost
 * always a sentence about the picture, and on a phone every keystroke saved is
 * worth having.
 */
export async function sendImage(file: Blob, deps: SendImageDeps): Promise<boolean> {
  if (!looksLikeImage(file.type) && file.type !== "") {
    deps.onError("That isn't an image — herdrer takes PNG, JPEG, GIF or WebP.");
    return false;
  }
  if (file.size > MAX_PASTE_BYTES) {
    deps.onError(`That's ${humanBytes(file.size)}. The limit is ${humanBytes(MAX_PASTE_BYTES)}.`);
    return false;
  }
  if (file.size === 0) {
    deps.onError("That file is empty.");
    return false;
  }

  let result: PasteResult;
  try {
    result = await deps.upload(file, deps.onProgress);
  } catch (err) {
    deps.onError(
      err instanceof ApiError && err.code === "VALIDATION_ERROR" ? err.message : describeError(err),
    );
    return false;
  }

  if (!result?.path) {
    deps.onError("The box saved it but didn't say where.");
    return false;
  }

  deps.write(`${result.path} `);
  deps.onDone?.(result);
  return true;
}

/** The real upload, wired to the API. */
export function uploadPaste(
  blob: Blob,
  onProgress?: (loaded: number, total: number) => void,
): Promise<PasteResult> {
  return upload<PasteResult>("/api/v1/paste", blob, onProgress);
}
