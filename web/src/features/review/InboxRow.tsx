import { Link } from "@tanstack/react-router";
import { CheckCircle2, GitBranch, Hourglass, MessageSquare, Terminal } from "lucide-react";
import type { ReviewItem } from "../../lib/types";
import { expiringSoon, markdownPreview, shortAge } from "../../lib/format";
import { isProvisional } from "../../lib/inbox";
import { Chip, cx } from "../../components/ui";

const KIND_LABEL: Record<string, string> = {
  confirm: "confirm",
  choice: "choice",
  ack: "ack",
  manual: "manual",
  review: "review",
};

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

        <div className="scroll-x no-scrollbar mt-1.5 flex items-center gap-1 text-muted">
          {blocking && <Chip tone="danger">blocking</Chip>}
          {!provisional && <Chip>{KIND_LABEL[item.kind] ?? item.kind}</Chip>}
          {ctx.worker && <Chip title="worker">{ctx.worker}</Chip>}
          {ctx.repo && (
            <Chip title="repo">
              <GitBranch className="w-3 h-3" />
              {ctx.branch ? `${ctx.repo}@${ctx.branch}` : ctx.repo}
            </Chip>
          )}
          {expiringSoon(item.expires_at, now) && !answered && (
            <Chip tone="warn">
              <Hourglass className="w-3 h-3" />
              expiring
            </Chip>
          )}
          {answered && item.answer_value && <Chip tone="ok">answered · {item.answer_value}</Chip>}
        </div>
      </div>

      <div className="shrink-0 pt-0.5 font-mono text-[11px] text-muted tabular-nums">
        {shortAge(answered ? item.answered_at : item.created_at, now)}
      </div>
    </Link>
  );
}
