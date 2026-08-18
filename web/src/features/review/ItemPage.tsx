import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  GitBranch,
  Hourglass,
  Link2,
  Maximize2,
  Monitor,
  Star,
  Terminal,
  Trash2,
} from "lucide-react";
import { ApiError, describeError } from "../../lib/api";
import { useAnswerReview, useDismissReview, useReview } from "../../lib/queries";
import { absoluteTime, shortAge, secondsUntil, shortDuration } from "../../lib/format";
import { drafts, scrollMemory } from "../../lib/storage";
import { Chip, ErrorState, SectionHeader, SkeletonRows, cx } from "../../components/ui";
import { Sheet } from "../../components/Sheet";
import { useToast } from "../../components/toast";
import { DocumentFrame, renderURL } from "./DocumentFrame";
import { FullscreenDocument, AttachmentList } from "./Attachments";
import { OptionCards } from "./OptionCards";
import { ActionBar } from "./ActionBar";
import {
  answerOptions,
  isAnswerable,
  isFreeText,
  optionLabel,
  recommendedKey,
  unanswerableReason,
} from "./answer";

export function ItemPage() {
  const { id } = useParams({ from: "/r/$id" });
  const search = useSearch({ from: "/r/$id" }) as { a?: string };
  const navigate = useNavigate();
  const toast = useToast();

  const { data: item, isPending, error, refetch } = useReview(id);
  const answer = useAnswerReview(id);
  const dismiss = useDismissReview();

  const [selected, setSelected] = useState<string | null>(null);
  const [note, setNote] = useState(() => drafts.read(id));
  const [moreOpen, setMoreOpen] = useState(false);
  const [docFull, setDocFull] = useState(false);
  const preselected = useRef(false);
  const restored = useRef(false);

  // `?a=recommended` pre-selects; it never sends. A notification cannot answer.
  useEffect(() => {
    if (!item || preselected.current) return;
    preselected.current = true;
    const rec = recommendedKey(item);
    if (search.a === "recommended" && rec) setSelected(rec);
  }, [item, search.a]);

  // Coming back from the diagram viewer or the terminal must not land at the top.
  useEffect(() => {
    if (!item || restored.current) return;
    restored.current = true;
    const y = scrollMemory.read(id);
    if (y > 0) window.scrollTo(0, y);
  }, [item, id]);

  useEffect(() => {
    const onScroll = () => scrollMemory.write(id, window.scrollY);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [id]);

  useEffect(() => drafts.write(id, note), [id, note]);

  const attachments = useMemo(() => item?.attachments ?? [], [item]);
  const diagrams = attachments.filter((a) => a.kind === "mermaid");
  const diffs = attachments.filter((a) => a.kind === "diff");
  const code = attachments.filter((a) => a.kind === "code");

  if (isPending) return <SkeletonRows rows={6} />;
  if (error || !item) {
    return (
      <ErrorState
        title={
          error instanceof ApiError && error.status === 404 ? "No such item" : "Couldn't load it"
        }
        message={error ? describeError(error) : "The server sent nothing back."}
        onRetry={() => void refetch()}
      />
    );
  }

  const answerable = isAnswerable(item);
  const rec = recommendedKey(item);
  const expiresIn = secondsUntil(item.expires_at);
  const options = answerOptions(item);

  const submit = () => {
    const value = isFreeText(item) ? note.trim() : (selected ?? "");
    if (value === "") return;
    answer.mutate(
      { value, note: isFreeText(item) ? undefined : note },
      {
        onSuccess: () => {
          drafts.clear(id);
          setNote("");
          toast.show(
            isFreeText(item)
              ? "Answer sent."
              : `Sent: ${optionLabel(item, value)}${note.trim() ? " (with your note)" : ""}`,
            { tone: "ok" },
          );
        },
        onError: (err) => {
          if (err instanceof ApiError && err.code === "CONFLICT") {
            toast.show("Someone — or something — answered this first. Reloading it.", {
              tone: "danger",
            });
            void refetch();
            return;
          }
          toast.show(describeError(err), { tone: "danger" });
        },
      },
    );
  };

  return (
    <div className="pb-40">
      {/* 1 — the question, one sentence. */}
      <div className="px-3 pt-3">
        <h1 className="text-base font-medium leading-snug text-heading">{item.title}</h1>
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
        <OptionCards
          item={item}
          selected={selected}
          onSelect={setSelected}
          disabled={!answerable}
        />
      )}

      {/* 5–6 — the document: why it's being asked, and the reviewer's take.
          Rendered by the server, shown in an opaque-origin sandbox. */}
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
        <DocumentFrame src={renderURL(item.id)} title={`${item.title} — rendered document`} />
        <FullscreenDocument
          open={docFull}
          onClose={() => setDocFull(false)}
          title={item.title}
          src={renderURL(item.id)}
        />
      </section>

      {/* 7 — diagrams. */}
      {diagrams.length > 0 && (
        <section className="mt-3">
          <SectionHeader title={`Diagrams · ${diagrams.length}`} />
          <div className="mt-2">
            <AttachmentList itemId={item.id} attachments={diagrams} />
          </div>
        </section>
      )}

      {/* 8 — the diff. */}
      {diffs.length > 0 && (
        <section className="mt-3">
          <SectionHeader title={`Diff · ${diffs.length}`} />
          <AttachmentList itemId={item.id} attachments={diffs} />
        </section>
      )}

      {/* 9 — appendix: code listings and links. */}
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

      {answerable && (
        <ActionBar
          item={item}
          selected={selected}
          onSelect={setSelected}
          note={note}
          onNoteChange={setNote}
          onSubmit={submit}
          submitting={answer.isPending}
          onMore={() => setMoreOpen(true)}
        />
      )}

      <Sheet open={moreOpen} title="More" onClose={() => setMoreOpen(false)}>
        <div className="divide-y divide-border">
          <SheetAction
            icon={<Link2 className="w-4 h-4" />}
            label="Copy link to this item"
            onClick={() => {
              void navigator.clipboard
                .writeText(new URL(`/r/${item.id}`, window.location.origin).toString())
                .then(() => toast.show("Link copied."))
                .catch(() => toast.show("Clipboard said no.", { tone: "danger" }));
              setMoreOpen(false);
            }}
          />
          {item.context?.worker && (
            <SheetAction
              icon={<Terminal className="w-4 h-4" />}
              label={`Open ${item.context.worker}'s terminal`}
              onClick={() => {
                setMoreOpen(false);
                void navigate({
                  to: "/agents/$name/term",
                  params: { name: item.context?.worker ?? "" },
                });
              }}
            />
          )}
          <SheetAction
            icon={<Monitor className="w-4 h-4" />}
            label="Needs a real screen"
            detail="Keeps the item open and leaves your note. Nothing is sent."
            onClick={() => {
              setNote((n) =>
                n.trim() === ""
                  ? "Seen on a phone — I'll answer this properly at a keyboard. Park it, don't guess."
                  : n,
              );
              setMoreOpen(false);
              toast.show("Note staged. Send it when you're ready.");
            }}
          />
          <SheetAction
            icon={<Trash2 className="w-4 h-4 text-danger" />}
            label="Dismiss this item"
            detail="Cancels it. The agent is told nothing was decided."
            danger
            onClick={() => {
              if (!window.confirm("Dismiss this item? The agent gets no answer.")) return;
              dismiss.mutate(item.id, {
                onSuccess: () => {
                  toast.show("Dismissed.");
                  setMoreOpen(false);
                  void navigate({ to: "/" });
                },
                onError: (err) => toast.show(describeError(err), { tone: "danger" }),
              });
            }}
          />
        </div>
      </Sheet>
    </div>
  );
}

function SheetAction({
  icon,
  label,
  detail,
  onClick,
  danger,
}: {
  icon: React.ReactNode;
  label: string;
  detail?: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-start gap-3 px-3 py-3 text-left hover:bg-hover"
    >
      <span className="mt-0.5 shrink-0 text-muted">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className={cx("block text-sm", danger ? "text-danger" : "text-heading")}>
          {label}
        </span>
        {detail && <span className="mt-0.5 block text-xs text-muted">{detail}</span>}
      </span>
    </button>
  );
}

function StatusBanner({
  reason,
  item,
}: {
  reason: string;
  item: {
    answer_value?: string | null;
    answer_note?: string | null;
    answered_at?: string | null;
    status: string;
  };
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
      <Link to="/" className="mt-2 inline-block text-xs text-accent underline">
        Back to the inbox
      </Link>
    </div>
  );
}
