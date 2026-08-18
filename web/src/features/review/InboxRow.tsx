import { Link } from "@tanstack/react-router";
import { CheckCircle2, GitBranch, MessageSquare, Terminal } from "lucide-react";
import type { ReviewItem } from "../../lib/types";
import { markdownPreview, shortAge } from "../../lib/format";
import { isProvisional } from "../../lib/inbox";
import { Chip, cx } from "../../components/ui";
import { Timing } from "./Timing";

/**
 * One row of the list.
 *
 * The leading rail carries urgency: a solid danger edge on anything blocking,
 * a transparent one everywhere else so nothing shifts sideways between rows.
 * That is the whole reason it is a border rather than an extra chip — a chip
 * costs horizontal space on a 375px screen and is read *after* the title, and
 * "is anything on fire" should be answerable before reading a word.
 */
export function InboxRow({ item, now }: { item: ReviewItem; now: number }) {
  const provisional = isProvisional(item);
  const answered = item.status === "answered";
  const preview = markdownPreview(item.body_md, 100);
  const ctx = item.context ?? {};
  const blocking = item.urgency === "blocking" && !answered;

  return (
    <Link
      to="/r/$id"
      params={{ id: item.id }}
      className={cx(
        "flex items-start gap-2.5 border-l-2 pl-2.5 pr-3 transition-colors hover:bg-hover active:bg-selected",
        blocking ? "border-l-danger bg-danger-weak/30" : "border-l-transparent",
        provisional ? "py-2.5 opacity-80" : "py-3",
      )}
    >
      <div className="mt-0.5 shrink-0 text-muted">
        {answered ? (
          <CheckCircle2 className="w-4 h-4 text-ok" />
        ) : provisional ? (
          <Terminal className="w-4 h-4" />
        ) : (
          <MessageSquare className={cx("w-4 h-4", blocking && "text-danger")} />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div
          className={cx(
            "truncate text-sm leading-snug text-heading",
            provisional ? "font-normal" : "font-medium",
            answered && "text-muted line-through decoration-1",
          )}
        >
          {item.title}
        </div>

        {!provisional && preview && (
          <div className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted">{preview}</div>
        )}
        {provisional && (
          <div className="mt-0.5 text-[11px] text-muted">unstructured · TUI prompt</div>
        )}

        {/*
          Wraps; it used to be a suppressed-scrollbar horizontal scroller, which
          on a phone amputated the branch chip mid-word and read as a layout
          fault. The `choice` / `ack` / `confirm` chip is gone — API vocabulary,
          not the reader's — and `blocking` is the left rail, which is read at
          arm's length before any word is.
        */}
        <div className="mt-1.5 flex flex-wrap items-center gap-1 text-muted">
          {ctx.worker && <Chip title="worker">{ctx.worker}</Chip>}
          {ctx.repo && (
            <Chip title="repo" className="max-w-full">
              <GitBranch className="w-3 h-3 shrink-0" />
              <span className="min-w-0 truncate">
                {ctx.branch ? `${ctx.repo}@${ctx.branch}` : ctx.repo}
              </span>
            </Chip>
          )}
          {answered && item.answer_value && <Chip tone="ok">answered · {item.answer_value}</Chip>}
          {/* The same age-and-deadline field the detail head and the desktop
              rail carry. A queue that shows how old something is and not how
              long is left is showing the half that does not decide anything. */}
          {!answered && (
            <Timing createdAt={item.created_at} expiresAt={item.expires_at} now={now} />
          )}
        </div>
      </div>

      {answered && (
        <div className="shrink-0 pt-0.5 font-mono text-[11px] text-muted tabular-nums">
          {shortAge(item.answered_at, now)}
        </div>
      )}
    </Link>
  );
}
