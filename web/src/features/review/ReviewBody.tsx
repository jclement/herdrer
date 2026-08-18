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

  const attachments = item.attachments ?? [];
  const diagrams = attachments.filter((a) => a.kind === "mermaid");
  const diffs = attachments.filter((a) => a.kind === "diff");
  const code = attachments.filter((a) => a.kind === "code");

  const answerable = isAnswerable(item);
  const rec = recommendedKey(item);
  const expiresIn = secondsUntil(item.expires_at);
  const options = answerOptions(item);

  return (
    <div>
      {/* 1 — the question, one sentence. */}
      <div className="px-3 pt-3">
        <h1
          className={cx("font-medium leading-snug text-heading", inSheet ? "text-sm" : "text-base")}
        >
          {item.title}
        </h1>
      </div>

      {/* 2 — the context strip: one line, scrolls, never wraps. */}
      <div className="scroll-x no-scrollbar mt-2 flex items-center gap-1 px-3 pb-2">
        {item.urgency === "blocking" && <Chip tone="danger">blocking</Chip>}
        <Chip>{item.kind}</Chip>
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

      {!answerable && <StatusBanner reason={unanswerableReason(item)} item={item} />}

      {/* 3 — the recommendation, called out. */}
      {answerable && rec && (
        <div className="mx-3 mb-3 flex items-start gap-2 rounded border border-accent/40 bg-selected px-3 py-2">
          <Star className="mt-0.5 w-4 h-4 shrink-0 text-accent" />
          <div className="text-sm text-heading">
            <span className="font-medium">Recommended: {rec}</span>
            {optionLabel(item, rec) !== rec && <> — {optionLabel(item, rec)}</>}
          </div>
        </div>
      )}

      {/* 4 — option cards. Same selection state as the bar. */}
      {options.length > 0 && (
        <OptionCards item={item} selected={selected} onSelect={onSelect} disabled={!answerable} />
      )}

      {/* 5–6 — the document: why it's being asked, and the reviewer's take. */}
      <section className="mt-3">
        <SectionHeader
          title="Detail"
          right={
            <button
              className="flex items-center gap-1 text-[11px] text-accent"
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

      {diagrams.length > 0 && (
        <section className="mt-3">
          <SectionHeader title={`Diagrams · ${diagrams.length}`} />
          <div className="mt-2">
            <AttachmentList itemId={item.id} attachments={diagrams} />
          </div>
        </section>
      )}

      {diffs.length > 0 && (
        <section className="mt-3">
          <SectionHeader title={`Diff · ${diffs.length}`} />
          <AttachmentList itemId={item.id} attachments={diffs} />
        </section>
      )}

      {code.length > 0 && (
        <section className="mt-3">
          <SectionHeader title="Code" />
          <div className="mt-2">
            <AttachmentList itemId={item.id} attachments={code} />
          </div>
        </section>
      )}

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
                  className="flex items-center gap-2 px-3 py-2.5 text-xs text-accent"
                >
                  <ExternalLink className="w-4 h-4 shrink-0" />
                  <span className="truncate">{l.label ?? l.title ?? l.url}</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="px-3 py-4 text-[11px] text-muted">
        <div>id {item.id}</div>
        <div>created {absoluteTime(item.created_at)}</div>
        {item.expires_at && <div>expires {absoluteTime(item.expires_at)}</div>}
      </div>
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
        "mx-3 mb-3 rounded border px-3 py-2",
        answered ? "border-ok/40 bg-ok/5" : "border-warn/40 bg-warn/5",
      )}
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        {answered ? (
          <CheckCircle2 className="w-4 h-4 text-ok" />
        ) : (
          <AlertTriangle className="w-4 h-4 text-warn" />
        )}
        <span className={answered ? "text-ok" : "text-warn"}>{reason}</span>
      </div>
      {answered && (
        <div className="mt-1 text-xs text-body">
          <div>
            You said <span className="font-medium text-heading">{item.answer_value}</span>
            {item.answered_at && <> · {absoluteTime(item.answered_at)}</>}
          </div>
          {item.answer_note && (
            <div className="mt-1 rounded bg-surface-2 px-2 py-1 italic">“{item.answer_note}”</div>
          )}
        </div>
      )}
      {footer}
    </div>
  );
}
