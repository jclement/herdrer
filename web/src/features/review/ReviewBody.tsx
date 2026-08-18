import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  GitBranch,
  Hourglass,
  Maximize2,
  Star,
} from "lucide-react";
import type { ReviewItem } from "../../lib/types";
import { absoluteTime, shortAge, secondsUntil, shortDuration } from "../../lib/format";
import { evidenceSections, jumpLabel } from "../../lib/attachments";
import { Chip, SectionHeader, cx } from "../../components/ui";
import { DocumentFrame, renderURL } from "./DocumentFrame";
import { FullscreenDocument, AttachmentList } from "./Attachments";
import { OptionCards } from "./OptionCards";
import {
  answerOptions,
  isAnswerable,
  optionLabel,
  recommendedKey,
  unanswerableReason,
} from "./answer";

/**
 * The document itself: the question, the evidence, and the options.
 *
 * One component, two shells. `/r/$id` wraps it in a page whose action bar is
 * anchored to the visual viewport; the overlay wraps it in a sheet whose action
 * bar is simply the last row of a flex column. Nothing in here knows which, and
 * that is the point — the whole redesign rests on the claim that the sheet and
 * the page show the *same* document, so there must be exactly one of it.
 *
 * The rendered detail is the server's sanitized HTML inside an iframe sandboxed
 * with `allow-scripts` and deliberately no `allow-same-origin`. That is what
 * stops a prompt-injected agent reaching a session cookie, and it is unchanged
 * by being inside a sheet.
 *
 * The visual order is an argument about attention. The question is the loudest
 * thing on the screen — larger and heavier than anything below it, including
 * the recommendation — because everything else here exists to answer it. Then
 * the facts that qualify it, then the opinion, then the options, then the
 * evidence. Anything that inverts that order is asking the reader to decide
 * before they have read the question.
 */
export function ReviewBody({
  item,
  selected,
  onSelect,
  /** Inside a sheet the surrounding container is the scroller, not the window. */
  inSheet = false,
}: {
  item: ReviewItem;
  selected: string | null;
  onSelect: (key: string) => void;
  inSheet?: boolean;
}) {
  const [docFull, setDocFull] = useState(false);

  const sections = evidenceSections(item.attachments);

  const answerable = isAnswerable(item);
  const rec = recommendedKey(item);
  const expiresIn = secondsUntil(item.expires_at);
  const options = answerOptions(item);
  const blocking = item.urgency === "blocking";

  return (
    <div>
      {/*
        1 — the question.
        A blocking item gets an accent rail down its left edge rather than one
        more chip: at arm's length the rail is read before any word is.
      */}
      <div
        className={cx(
          "border-l-2 pb-0 pl-2.5 pr-3 pt-3.5",
          blocking ? "border-l-danger bg-danger-weak/40" : "border-l-transparent",
        )}
      >
        <h1
          className={cx(
            "font-semibold tracking-tight text-heading",
            // `break-words` because agents title things with file paths.
            "leading-[1.3] break-words text-pretty",
            inSheet ? "text-[15px]" : "text-lg",
          )}
        >
          {item.title}
        </h1>

        {/* 2 — the context strip: one line, scrolls, never wraps. */}
        <div className="scroll-x no-scrollbar mt-2 flex items-center gap-1 pb-2.5">
          {blocking && <Chip tone="danger">blocking</Chip>}
          <Chip tone="accent">{item.kind}</Chip>
          {item.context?.worker && <Chip title="worker">{item.context.worker}</Chip>}
          {item.context?.repo && (
            <Chip title="repo">
              <GitBranch className="w-3 h-3" />
              {item.context.branch
                ? `${item.context.repo}@${item.context.branch}`
                : item.context.repo}
            </Chip>
          )}
          <Chip title={absoluteTime(item.created_at)}>{shortAge(item.created_at)} old</Chip>
          {expiresIn !== null && expiresIn > 0 && (
            <Chip tone={expiresIn < 3600 ? "warn" : "default"}>
              <Hourglass className="w-3 h-3" />
              {shortDuration(expiresIn)} left
            </Chip>
          )}
          {item.source === "herdr" && <Chip tone="warn">unstructured · TUI prompt</Chip>}
        </div>
      </div>

      {!answerable && <StatusBanner reason={unanswerableReason(item)} item={item} />}

      {/* 3 — the recommendation, called out. */}
      {answerable && rec && <Recommendation item={item} rec={rec} />}

      {/* 4 — option cards. Same selection state as the bar. */}
      {options.length > 0 && (
        <OptionCards item={item} selected={selected} onSelect={onSelect} disabled={!answerable} />
      )}

      {/*
        The evidence index.
        With `filediff` and `image` landing, a review can carry six attachments
        of four kinds, and scrolling past a diff to find out whether there was a
        screenshot is not reading, it is hunting. One strip, one tap per
        section — and it names kinds it has never heard of rather than dropping
        them (see lib/attachments.ts).
      */}
      {sections.length > 0 && <EvidenceIndex sections={sections} />}

      {/* 5–6 — the document: why it's being asked, and the reviewer's take. */}
      <section className="mt-3">
        <SectionHeader
          title="Detail"
          right={
            <button
              className="-mr-1 flex h-8 items-center gap-1 rounded px-1.5 text-[11px] text-accent transition-colors hover:bg-hover"
              onClick={() => setDocFull(true)}
            >
              <Maximize2 className="w-3.5 h-3.5" />
              full screen
            </button>
          }
        />
        {/*
         * No maxHeight, in a sheet least of all. The frame is sized to the height
         * it posts, which leaves it with nothing to scroll internally — so a drag
         * that starts over the document is handled by the sheet's scroller, which
         * is the only way this reads as one page on a phone. Clamp the height and
         * the iframe grows its own scroll area, the drag is captured by the frame,
         * and the sheet stops scrolling under your thumb.
         */}
        <DocumentFrame src={renderURL(item.id)} title={`${item.title} — rendered document`} />
        <FullscreenDocument
          open={docFull}
          onClose={() => setDocFull(false)}
          title={item.title}
          src={renderURL(item.id)}
        />
      </section>

      {sections.map((section) => (
        <section key={section.group} className="mt-3 scroll-mt-24" id={section.anchor}>
          <SectionHeader title={section.label} />
          <div className={section.group === "changes" ? "" : "mt-2"}>
            <AttachmentList itemId={item.id} attachments={section.items} />
          </div>
        </section>
      ))}

      {(item.context?.links?.length ?? 0) > 0 && (
        <section className="mt-3">
          <SectionHeader title="Links" />
          <ul className="divide-y divide-border">
            {item.context?.links?.map((l, i) => (
              <li key={i}>
                <a
                  href={l.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="flex min-h-11 items-center gap-2 px-3 py-2.5 text-xs text-accent transition-colors hover:bg-hover"
                >
                  <ExternalLink className="w-4 h-4 shrink-0" />
                  <span className="truncate">{l.label ?? l.title ?? l.url}</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="mt-3 space-y-0.5 border-t border-border px-3 py-4 font-mono text-[11px] text-muted">
        <div className="break-all">id {item.id}</div>
        <div>created {absoluteTime(item.created_at)}</div>
        {item.expires_at && <div>expires {absoluteTime(item.expires_at)}</div>}
      </div>
    </div>
  );
}

/**
 * The recommendation.
 *
 * An accent slab rather than an outlined box, because it is the one piece of
 * *opinion* on the page and it has to be distinguishable from the facts above
 * it and the options below it at a glance. The key is set in mono in a filled
 * badge so it matches the letter on the option card it points at — that
 * correspondence is the whole affordance.
 */
function Recommendation({ item, rec }: { item: ReviewItem; rec: string }) {
  const label = optionLabel(item, rec);
  return (
    <div className="mx-3 mb-3 flex items-start gap-2.5 rounded-md border border-accent/40 bg-accent-weak px-3 py-2.5">
      <span className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent font-mono text-[11px] font-semibold text-accent-fg">
        {rec.slice(0, 1).toUpperCase()}
      </span>
      <div className="min-w-0 flex-1 text-sm leading-snug text-heading">
        <span className="inline-flex items-center gap-1 font-semibold">
          <Star className="w-3.5 h-3.5 text-accent" aria-hidden />
          Recommended: {rec}
        </span>
        {label !== rec && <span className="text-body"> — {label}</span>}
      </div>
    </div>
  );
}

/**
 * One tap to each piece of evidence.
 *
 * Anchors rather than state, so it works identically in the page and in the
 * sheet — `scroll-mt` on each section keeps the target clear of the sticky
 * header without either shell having to know the other exists.
 */
function EvidenceIndex({ sections }: { sections: ReturnType<typeof evidenceSections> }) {
  if (sections.length < 2) return null;
  return (
    <div className="scroll-x no-scrollbar flex items-center gap-1.5 border-y border-border bg-surface-2 px-3 py-1.5">
      <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-muted">
        Evidence
      </span>
      {sections.map((s) => (
        <button
          key={s.group}
          onClick={() => {
            document
              .getElementById(s.anchor)
              ?.scrollIntoView({ behavior: "smooth", block: "start" });
          }}
          className="flex h-8 shrink-0 items-center rounded border border-border bg-surface px-2.5 text-[11px] text-body transition-colors hover:border-accent/50 hover:text-accent"
        >
          {jumpLabel(s)}
        </button>
      ))}
    </div>
  );
}

export function StatusBanner({
  reason,
  item,
  footer,
}: {
  reason: string;
  item: Pick<ReviewItem, "answer_value" | "answer_note" | "answered_at" | "status">;
  footer?: React.ReactNode;
}) {
  const answered = item.status === "answered";
  return (
    <div
      className={cx(
        "mx-3 mb-3 rounded-md border px-3 py-2.5",
        answered ? "border-ok/40 bg-ok-weak" : "border-warn/40 bg-warn-weak",
      )}
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        {answered ? (
          <CheckCircle2 className="w-4 h-4 shrink-0 text-ok" />
        ) : (
          <AlertTriangle className="w-4 h-4 shrink-0 text-warn" />
        )}
        <span className={answered ? "text-ok" : "text-warn"}>{reason}</span>
      </div>
      {answered && (
        <div className="mt-1.5 text-xs text-body">
          <div>
            You said <span className="font-medium text-heading">{item.answer_value}</span>
            {item.answered_at && <> · {absoluteTime(item.answered_at)}</>}
          </div>
          {item.answer_note && (
            <div className="mt-1.5 border-l-2 border-border pl-2 italic text-body">
              “{item.answer_note}”
            </div>
          )}
        </div>
      )}
      {footer}
    </div>
  );
}
