import type { Attachment } from "./types";

/**
 * How the evidence on a review is grouped, counted and named.
 *
 * Pure on purpose. The item page and the overlay sheet render the same document
 * (features/review/ReviewBody.tsx), so the grouping has to be one function
 * rather than a chain of `.filter()` calls copied into two components — and the
 * interesting part of it is the *fallback*, which is exactly the sort of thing
 * that only ever gets exercised the day a new attachment kind ships.
 *
 * The rule for a kind this build has never heard of: count it, name it, and
 * point at the document. Everything renders inside the sandboxed iframe
 * already, so an unknown kind is still on screen — it is only this page's own
 * chrome that would otherwise pretend it wasn't there. "unknown kind" as a
 * label is the failure we are avoiding; "1 attachment · in the document" is
 * true, useful, and needs no release to become correct.
 */

/** The sections the page shows, in the order it shows them. */
export type EvidenceGroup = "changes" | "diagrams" | "images" | "code" | "other";

export interface EvidenceSection {
  group: EvidenceGroup;
  /** What the section header says, count included. */
  label: string;
  /** The anchor the jump chips scroll to. */
  anchor: string;
  items: Attachment[];
}

const GROUP_OF: Record<string, EvidenceGroup> = {
  diff: "changes",
  filediff: "changes",
  mermaid: "diagrams",
  image: "images",
  code: "code",
};

/** Order is deliberate: what changed, then what it looks like, then the source. */
const ORDER: EvidenceGroup[] = ["changes", "diagrams", "images", "code", "other"];

const SINGULAR: Record<EvidenceGroup, string> = {
  changes: "Change",
  diagrams: "Diagram",
  images: "Image",
  code: "Code",
  other: "Attachment",
};

const PLURAL: Record<EvidenceGroup, string> = {
  changes: "Changes",
  diagrams: "Diagrams",
  images: "Images",
  code: "Code",
  other: "Attachments",
};

export function groupOf(kind: string): EvidenceGroup | null {
  // Markdown is *already* the document — showing it again out here would mean
  // this app rendering agent markdown itself, which is the one thing the
  // sandbox exists to prevent.
  if (kind === "markdown") return null;
  return GROUP_OF[kind] ?? "other";
}

export function anchorFor(group: EvidenceGroup): string {
  return `evidence-${group}`;
}

/** Group an item's attachments into the sections the page renders. */
export function evidenceSections(attachments: Attachment[] | null | undefined): EvidenceSection[] {
  const buckets = new Map<EvidenceGroup, Attachment[]>();
  for (const a of attachments ?? []) {
    const group = groupOf(a.kind);
    if (!group) continue;
    const list = buckets.get(group);
    if (list) list.push(a);
    else buckets.set(group, [a]);
  }

  return ORDER.filter((g) => buckets.has(g)).map((group) => {
    const items = buckets.get(group)!;
    const noun = items.length === 1 ? SINGULAR[group] : PLURAL[group];
    return { group, label: `${noun} · ${items.length}`, anchor: anchorFor(group), items };
  });
}

/**
 * The short name for a jump chip. "3 changes" reads at a glance where
 * "Changes · 3" reads as a heading, and the strip is a strip, not a table of
 * contents.
 */
export function jumpLabel(section: EvidenceSection): string {
  const noun = section.items.length === 1 ? SINGULAR[section.group] : PLURAL[section.group];
  return `${section.items.length} ${noun.toLowerCase()}`;
}

/**
 * The `+n −n` a change carries.
 *
 * The server computes these for a `filediff` and puts them in the title, so
 * prefer what it sent. Falling back to counting the unified diff's own lines
 * keeps a plain `diff` attachment — where nothing is computed for us —
 * displaying the same stat rather than a blank space.
 */
export function diffStat(a: Attachment): { adds: number; dels: number } | null {
  if (typeof a.adds === "number" && typeof a.dels === "number") {
    return { adds: a.adds, dels: a.dels };
  }
  if (!a.content) return null;
  let adds = 0;
  let dels = 0;
  for (const line of a.content.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) adds++;
    else if (line.startsWith("-") && !line.startsWith("---")) dels++;
  }
  return adds === 0 && dels === 0 ? null : { adds, dels };
}

/**
 * Whether we can draw a change ourselves, or have to point at the document.
 *
 * A `filediff` sent as `before`/`after` with no computed `content` is the
 * server's to render — we are not going to run a diff algorithm on the phone
 * to second-guess the one that already ran on the box.
 */
export function hasUnifiedDiff(a: Attachment): boolean {
  return typeof a.content === "string" && a.content.trim() !== "";
}
