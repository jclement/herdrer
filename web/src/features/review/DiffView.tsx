import { useMemo, useState } from "react";
import { Check, ChevronDown, ChevronRight, Copy, WrapText } from "lucide-react";
import {
  foldContext,
  parseDiff,
  type DiffFile,
  type DiffHunk,
  type RenderRow,
} from "../../lib/diff";
import { flags } from "../../lib/storage";
import { cx } from "../../components/ui";

/**
 * Diffs are rendered here as *text*, escaped by JSX — never as HTML. That is the
 * safe path for agent-authored content and it is also what gives us per-hunk
 * control: each hunk is its own `overflow-x` container, so a long line scrolls
 * under a thumb while the page stays put.
 */
const HUNK_LINE_CAP = 40;
const HUNK_LINE_PEEK = 20;
const LARGE_DIFF_LINES = 400;

export function DiffView({ content, title }: { content: string; title: string }) {
  const files = useMemo(() => parseDiff(content), [content]);
  const totalLines = useMemo(
    () => files.reduce((n, f) => n + f.hunks.reduce((m, h) => m + h.lines.length, 0), 0),
    [files],
  );
  const [wrap, setWrap] = useState(() => {
    const stored = flags.read("diff-wrap");
    if (stored === "1") return true;
    if (stored === "0") return false;
    // Horizontal scrolling inside a code block on a phone loses your vertical
    // place every time. Wrap by default below md:, scroll above it.
    return typeof window !== "undefined" ? window.innerWidth < 768 : true;
  });

  if (files.length === 0) {
    return (
      <pre className="scroll-x m-3 rounded border border-border bg-surface-2 p-2 font-mono text-[11px] leading-5 text-body">
        {content}
      </pre>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <div className="min-w-0 truncate text-xs text-muted">
          {title} · {files.length} file{files.length === 1 ? "" : "s"}
        </div>
        <button
          className={cx(
            "flex h-8 items-center gap-1 rounded border border-border px-2 text-[11px]",
            wrap ? "text-accent" : "text-muted",
          )}
          onClick={() => {
            setWrap((w) => {
              flags.write("diff-wrap", w ? "0" : "1");
              return !w;
            });
          }}
          aria-pressed={wrap}
        >
          <WrapText className="w-3.5 h-3.5" />
          {wrap ? "wrap" : "scroll"}
        </button>
      </div>

      <div className="space-y-2 px-3">
        {files.map((file, i) => (
          <FileBlock
            key={`${file.path}-${i}`}
            file={file}
            wrap={wrap}
            // For a big diff, open the first file only; the rest stays folded.
            defaultOpen={i === 0 && totalLines <= LARGE_DIFF_LINES * 4}
          />
        ))}
      </div>
    </div>
  );
}

function FileBlock({
  file,
  wrap,
  defaultOpen,
}: {
  file: DiffFile;
  wrap: boolean;
  defaultOpen: boolean;
}) {
  const lines = file.hunks.reduce((n, h) => n + h.lines.length, 0);
  const [open, setOpen] = useState(defaultOpen && lines <= LARGE_DIFF_LINES);

  return (
    <div className="overflow-hidden rounded border border-border">
      <button
        className="flex w-full items-center gap-2 bg-surface-2 px-2 py-2 text-left"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="w-4 h-4 shrink-0 text-muted" />
        ) : (
          <ChevronRight className="w-4 h-4 shrink-0 text-muted" />
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-heading" dir="rtl">
          {file.path}
        </span>
        {file.status !== "modified" && (
          <span className="shrink-0 text-[10px] uppercase text-muted">{file.status}</span>
        )}
        <span className="shrink-0 font-mono text-[11px] tabular-nums">
          <span className="text-ok">+{file.adds}</span>{" "}
          <span className="text-danger">−{file.dels}</span>
        </span>
      </button>

      {open &&
        (file.status === "binary" ? (
          <div className="px-2 py-3 text-xs text-muted">Binary file — nothing to show.</div>
        ) : (
          file.hunks.map((hunk, i) => <HunkBlock key={i} hunk={hunk} wrap={wrap} index={i} />)
        ))}
    </div>
  );
}

function HunkBlock({ hunk, wrap, index }: { hunk: DiffHunk; wrap: boolean; index: number }) {
  // The author gets no say in the API contract, so: expand the first hunk only.
  const [open, setOpen] = useState(index === 0);
  const [full, setFull] = useState(false);
  const [copied, setCopied] = useState(false);
  const rows = useMemo(() => foldContext(hunk.lines), [hunk.lines]);

  const capped = !full && hunk.lines.length > HUNK_LINE_CAP;
  const shown = capped ? rows.slice(0, HUNK_LINE_PEEK) : rows;

  const copy = async () => {
    const text = hunk.lines
      .map((l) => (l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ") + l.text)
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard denied — the text is on screen either way */
    }
  };

  return (
    <div className="border-t border-border">
      <div className="flex items-center gap-1 bg-diff-meta px-2 py-1">
        <button
          className="flex min-w-0 flex-1 items-center gap-1 text-left"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          {open ? (
            <ChevronDown className="w-3.5 h-3.5 shrink-0 text-muted" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 shrink-0 text-muted" />
          )}
          <span className="truncate font-mono text-[10px] text-muted">{hunk.header}</span>
        </button>
        <button onClick={() => void copy()} aria-label="Copy hunk" className="p-1 text-muted">
          {copied ? <Check className="w-3.5 h-3.5 text-ok" /> : <Copy className="w-3.5 h-3.5" />}
        </button>
      </div>

      {open && (
        <>
          <div
            className={cx(
              "font-mono text-[11px] leading-5",
              wrap ? "overflow-x-hidden" : "scroll-x",
            )}
            style={{ maxHeight: "60vh", overflowY: "auto" }}
          >
            {shown.map((row, i) => (
              <Row key={i} row={row} wrap={wrap} />
            ))}
          </div>
          {capped && (
            <button
              className="w-full border-t border-border bg-surface-2 py-1.5 text-[11px] text-accent"
              onClick={() => setFull(true)}
            >
              show all {hunk.lines.length} lines
            </button>
          )}
        </>
      )}
    </div>
  );
}

function Row({ row, wrap }: { row: RenderRow; wrap: boolean }) {
  const [expanded, setExpanded] = useState(false);

  if (row.kind === "fold") {
    if (!expanded) {
      return (
        <button
          className="block w-full bg-surface-2 px-2 py-1 text-left text-[11px] text-muted hover:bg-hover"
          onClick={() => setExpanded(true)}
        >
          ⋯ {row.count} unchanged line{row.count === 1 ? "" : "s"}
        </button>
      );
    }
    return (
      <>
        {row.lines.map((line, i) => (
          <LineRow key={i} kind="ctx" text={line.text} no={line.newNo} wrap={wrap} />
        ))}
      </>
    );
  }

  const { line } = row;
  return (
    <LineRow
      kind={line.kind}
      text={line.text}
      no={line.kind === "del" ? line.oldNo : line.newNo}
      wrap={wrap}
    />
  );
}

function LineRow({
  kind,
  text,
  no,
  wrap,
}: {
  kind: "add" | "del" | "ctx" | "meta";
  text: string;
  no: number | null;
  wrap: boolean;
}) {
  // Whole-row tint, because a 2px glyph is invisible at arm's length — but the
  // glyph and the aria-label stay, because colour alone is not a signal.
  const tone =
    kind === "add"
      ? "bg-diff-add text-diff-add-fg"
      : kind === "del"
        ? "bg-diff-del text-diff-del-fg"
        : kind === "meta"
          ? "text-muted"
          : "text-body";
  const sign = kind === "add" ? "+" : kind === "del" ? "−" : " ";

  return (
    <div className={cx("flex items-start gap-2 px-2", tone)}>
      <span className="hidden w-10 shrink-0 select-none text-right tabular-nums opacity-50 sm:inline">
        {no ?? ""}
      </span>
      <span
        aria-label={kind === "add" ? "added line" : kind === "del" ? "removed line" : undefined}
        className={cx("min-w-0 flex-1", wrap ? "diff-wrap" : "whitespace-pre")}
      >
        <span className="select-none opacity-70">{sign}</span>
        {text === "" ? " " : text}
      </span>
    </div>
  );
}
