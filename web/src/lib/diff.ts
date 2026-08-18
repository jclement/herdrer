/**
 * A unified-diff parser, about a hundred lines of it.
 *
 * We own this rather than taking diff2html: the library wants to own the DOM and
 * ships CSS that fights Tailwind, and every mobile treatment we care about —
 * per-hunk collapse, per-hunk horizontal scroll, wrap with a hanging indent,
 * capped hunk height — needs a hook it does not give us.
 *
 * Diff text is agent-authored and therefore hostile. Nothing here produces HTML;
 * the output is data that React renders as text.
 */

export type DiffLineKind = "add" | "del" | "ctx" | "meta";

export interface DiffLine {
  kind: DiffLineKind;
  /** Line content with the leading +/-/space removed. */
  text: string;
  /** Line number in the old file, when the line exists there. */
  oldNo: number | null;
  /** Line number in the new file, when the line exists there. */
  newNo: number | null;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
  adds: number;
  dels: number;
}

export interface DiffFile {
  /** Best available path: the new path, falling back to the old one. */
  path: string;
  oldPath: string | null;
  newPath: string | null;
  /** "modified" | "added" | "deleted" | "renamed" | "binary" */
  status: string;
  hunks: DiffHunk[];
  adds: number;
  dels: number;
}

const HUNK_RE = /^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function newFile(oldPath: string | null, newPath: string | null): DiffFile {
  return {
    path: newPath ?? oldPath ?? "(unknown)",
    oldPath,
    newPath,
    status: "modified",
    hunks: [],
    adds: 0,
    dels: 0,
  };
}

function stripPrefix(p: string): string {
  if (p === "/dev/null") return p;
  return p.replace(/^[ab]\//, "");
}

/** Split `diff --git a/x b/y`, tolerating paths with spaces by the a//b/ markers. */
function parseGitHeader(line: string): { oldPath: string | null; newPath: string | null } {
  const rest = line.slice("diff --git ".length);
  const m = /^(?:"?a\/)(.*?)(?:"?) (?:"?b\/)(.*?)"?$/.exec(rest);
  if (m) return { oldPath: m[1] ?? null, newPath: m[2] ?? null };
  const parts = rest.split(" ");
  return {
    oldPath: parts[0] ? stripPrefix(parts[0]) : null,
    newPath: parts[1] ? stripPrefix(parts[1]) : null,
  };
}

export function parseDiff(input: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  const push = () => {
    if (file) files.push(file);
  };

  for (const raw of input.split("\n")) {
    const line = raw.replace(/\r$/, "");

    if (line.startsWith("diff --git ")) {
      push();
      const { oldPath, newPath } = parseGitHeader(line);
      file = newFile(oldPath, newPath);
      hunk = null;
      continue;
    }

    if (line.startsWith("--- ")) {
      const p = stripPrefix(line.slice(4).trim());
      if (!file) {
        file = newFile(p === "/dev/null" ? null : p, null);
      } else if (!file.oldPath) {
        file.oldPath = p === "/dev/null" ? null : p;
      }
      if (p === "/dev/null" && file) file.status = "added";
      continue;
    }

    if (line.startsWith("+++ ")) {
      const p = stripPrefix(line.slice(4).trim());
      if (!file) file = newFile(null, p === "/dev/null" ? null : p);
      if (p === "/dev/null") {
        file.status = "deleted";
      } else {
        file.newPath = p;
        file.path = p;
      }
      if (!file.path || file.path === "(unknown)") file.path = file.oldPath ?? p;
      continue;
    }

    if (line.startsWith("rename from ") && file) {
      file.status = "renamed";
      file.oldPath = line.slice("rename from ".length);
      continue;
    }
    if (line.startsWith("rename to ") && file) {
      file.status = "renamed";
      file.newPath = line.slice("rename to ".length);
      file.path = file.newPath;
      continue;
    }
    if (line.startsWith("new file mode") && file) {
      file.status = "added";
      continue;
    }
    if (line.startsWith("deleted file mode") && file) {
      file.status = "deleted";
      continue;
    }
    if (line.startsWith("Binary files") || line.startsWith("GIT binary patch")) {
      if (!file) file = newFile(null, null);
      file.status = "binary";
      continue;
    }

    const hm = HUNK_RE.exec(line);
    if (hm) {
      if (!file) file = newFile(null, null);
      oldNo = Number(hm[1] ?? 0);
      newNo = Number(hm[3] ?? 0);
      hunk = { header: line, lines: [], adds: 0, dels: 0 };
      file.hunks.push(hunk);
      continue;
    }

    if (!hunk) continue; // index/mode/preamble noise between files

    if (line.startsWith("+")) {
      hunk.lines.push({ kind: "add", text: line.slice(1), oldNo: null, newNo });
      hunk.adds++;
      if (file) file.adds++;
      newNo++;
    } else if (line.startsWith("-")) {
      hunk.lines.push({ kind: "del", text: line.slice(1), oldNo, newNo: null });
      hunk.dels++;
      if (file) file.dels++;
      oldNo++;
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file"
      hunk.lines.push({ kind: "meta", text: line, oldNo: null, newNo: null });
    } else if (line.startsWith(" ") || line === "") {
      // A truly empty line inside a hunk is an unchanged blank line.
      hunk.lines.push({ kind: "ctx", text: line.slice(1), oldNo, newNo });
      oldNo++;
      newNo++;
    } else {
      // Anything else ends the hunk (trailing prose, `-- ` signature, etc).
      hunk = null;
    }
  }

  push();
  return files.filter((f) => f.hunks.length > 0 || f.status === "binary");
}

/** Rows a collapsed hunk stands in for: >3 unchanged lines becomes one fold row. */
export interface FoldRow {
  kind: "fold";
  count: number;
  lines: DiffLine[];
}
export type RenderRow = { kind: "line"; line: DiffLine } | FoldRow;

/**
 * Collapse runs of context longer than `context * 2 + 1` into a fold row, so a
 * hunk with 60 lines of untouched code around a two-line change is two screens
 * shorter on a phone.
 */
export function foldContext(lines: DiffLine[], context = 3): RenderRow[] {
  const rows: RenderRow[] = [];
  let run: DiffLine[] = [];

  const flush = (atStart: boolean, atEnd: boolean) => {
    if (run.length === 0) return;
    const keepHead = atStart ? 0 : context;
    const keepTail = atEnd ? 0 : context;
    if (run.length <= keepHead + keepTail + 1) {
      for (const l of run) rows.push({ kind: "line", line: l });
    } else {
      for (const l of run.slice(0, keepHead)) rows.push({ kind: "line", line: l });
      const hidden = run.slice(keepHead, run.length - keepTail);
      rows.push({ kind: "fold", count: hidden.length, lines: hidden });
      for (const l of run.slice(run.length - keepTail)) rows.push({ kind: "line", line: l });
    }
    run = [];
  };

  let seenChange = false;
  for (const line of lines) {
    if (line.kind === "ctx") {
      run.push(line);
      continue;
    }
    flush(!seenChange, false);
    seenChange = true;
    rows.push({ kind: "line", line });
  }
  flush(!seenChange, true);
  return rows;
}

export function diffStat(files: DiffFile[]): { files: number; adds: number; dels: number } {
  return {
    files: files.length,
    adds: files.reduce((n, f) => n + f.adds, 0),
    dels: files.reduce((n, f) => n + f.dels, 0),
  };
}
