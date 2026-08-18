import { useState } from "react";
import { AlertTriangle, CheckCircle2, ExternalLink, GitBranch, Maximize2 } from "lucide-react";
import type { ReviewItem } from "../../lib/types";
import { absoluteTime } from "../../lib/format";
import { evidenceSections, jumpLabel } from "../../lib/attachments";
import { Chip, SectionHeader, cx } from "../../components/ui";
import { DocumentFrame, renderURL } from "./DocumentFrame";
import { FullscreenDocument, AttachmentList } from "./Attachments";
import { OptionCards } from "./OptionCards";
import { Timing } from "./Timing";
import { answerOptions, isAnswerable, unanswerableReason } from "./answer";

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
 * the agent's own headings inside the rendered document, whose scale is set on
 * the server (internal/review/render.go: h1 16px, h2/h3 15px) and has to stay
 * under this one. Then the facts that qualify it, then the options, then the
 * evidence. Anything that inverts that order is asking the reader to decide
 * before they have read the question.
 *
 * There is no recommendation banner any more. The recommendation was on screen
 * four times — a banner, a pill on the option card, a tinted letter badge, and
 * an accent mark in the action bar — and the banner was the one carrying no
 * information the option card 100px below it did not, verbatim, including the
 * label string. A thing said four times reads as a thing that does not trust
 * itself. The opinion survives as the star on the option it points at.
 *
 * The `choice` / `ack` / `confirm` chip is gone for the same kind of reason:
 * it is the API's vocabulary, not a reader's, and on a screen already showing
 * two labelled options it says nothing at all.
 */
export function ReviewBody({
  item,
  selected,
  onSelect,
}: {
  item: ReviewItem;
  selected: string | null;
  onSelect: (key: string) => void;
}) {
  const [docFull, setDocFull] = useState(false);

  const sections = evidenceSections(item.attachments);

  const answerable = isAnswerable(item);
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
        {/*
          One title size, in the page and in the sheet alike. They show the same
          document; when the same question is 18px in one shell and 15px in the
          other, the difference is read as meaning and there is none.
        */}
        <h1 className="text-xl font-semibold leading-[1.3] tracking-tight text-heading break-words text-pretty">
          {item.title}
        </h1>

        {/*
          2 — the deadline, then the provenance.

          The timing goes first and never scrolls: it is the input to "answer
          this now or put it down", and it used to be the one fact a 375px
          screen clipped off the right-hand edge of a suppressed-scrollbar chip
          strip. The rest wraps rather than scrolling for the same reason —
          `body { overflow-x: hidden }` means anything that escapes a scroller
          is discarded, not reachable.
        */}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
          <Timing createdAt={item.created_at} expiresAt={item.expires_at} />
        </div>

        <div className="mt-1.5 flex flex-wrap items-center gap-1 pb-2.5">
          {item.context?.worker && <Chip title="worker">{item.context.worker}</Chip>}
          {item.context?.repo && (
            <Chip title="repo" className="max-w-full">
              <GitBranch className="w-3 h-3 shrink-0" />
              <span className="min-w-0 truncate">
                {item.context.branch
                  ? `${item.context.repo}@${item.context.branch}`
                  : item.context.repo}
              </span>
            </Chip>
          )}
          {item.source === "herdr" && <Chip tone="warn">unstructured · TUI prompt</Chip>}
        </div>
      </div>

      {!answerable && <StatusBanner reason={unanswerableReason(item)} item={item} />}

      {/* 3 — option cards. Same selection state as the bar. */}
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
              className="-mr-1 flex min-h-11 items-center gap-1 rounded px-1.5 text-[11px] text-accent transition-colors hover:bg-hover"
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
 * One tap to each piece of evidence.
 *
 * Anchors rather than state, so it works identically in the page and in the
 * sheet — `scroll-mt` on each section keeps the target clear of the sticky
 * header without either shell having to know the other exists.
 */
function EvidenceIndex({ sections }: { sections: ReturnType<typeof evidenceSections> }) {
  if (sections.length < 2) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-y border-border bg-surface-2 px-3 py-1.5">
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
          className="flex min-h-11 shrink-0 items-center rounded border border-border bg-surface px-2.5 text-[11px] text-body transition-colors hover:border-accent/50 hover:text-accent"
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
