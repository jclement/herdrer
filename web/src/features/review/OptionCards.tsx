import { useState } from "react";
import { ChevronDown, ChevronUp, Star } from "lucide-react";
import type { ReviewItem } from "../../lib/types";
import { answerOptions } from "./answer";
import { cx } from "../../components/ui";

/**
 * Option cards and the action bar are two views of one selection state, not two
 * controls: tapping a card fills the bar, tapping the bar highlights the card.
 */
export function OptionCards({
  item,
  selected,
  onSelect,
  disabled,
}: {
  item: ReviewItem;
  selected: string | null;
  onSelect: (key: string) => void;
  disabled?: boolean;
}) {
  const options = answerOptions(item);
  if (options.length === 0) return null;

  return (
    <div className="divide-y divide-border border-y border-border">
      {options.map((opt) => (
        <OptionCard
          key={opt.key}
          optionKey={opt.key}
          label={opt.label}
          detail={opt.detail}
          recommended={item.recommend === opt.key}
          selected={selected === opt.key}
          onSelect={() => !disabled && onSelect(opt.key)}
          disabled={disabled}
        />
      ))}
    </div>
  );
}

function OptionCard({
  optionKey,
  label,
  detail,
  recommended,
  selected,
  onSelect,
  disabled,
}: {
  optionKey: string;
  label: string;
  detail?: string;
  recommended: boolean;
  selected: boolean;
  onSelect: () => void;
  disabled?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const long = (detail?.length ?? 0) > 90;

  return (
    <div
      className={cx(
        "border-l-2 transition-colors",
        // Selection is a *state*, so it gets a ground and an edge, not a tick
        // hidden at the end of a row. The edge is what survives a glance while
        // the thumb is still on the screen covering the ground.
        selected ? "border-l-accent bg-selected" : "border-l-transparent",
        disabled && "opacity-60",
      )}
    >
      <button
        className={cx(
          "flex w-full items-start gap-2.5 py-3 pl-2.5 pr-3 text-left transition-colors",
          !disabled && !selected && "hover:bg-hover",
        )}
        onClick={onSelect}
        aria-pressed={selected}
        disabled={disabled}
      >
        <span
          className={cx(
            "mt-px flex h-6 w-6 shrink-0 items-center justify-center rounded-full border font-mono text-[11px] font-semibold transition-colors",
            selected
              ? "border-accent bg-accent text-accent-fg"
              : recommended
                ? "border-accent/50 bg-accent-weak text-accent"
                : "border-border text-muted",
          )}
        >
          {optionKey.slice(0, 1).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
            <span className="text-sm font-medium leading-snug text-heading">{label}</span>
            {recommended && (
              <span className="inline-flex items-center gap-0.5 rounded border border-accent/40 bg-accent-weak px-1 text-[10px] font-medium text-accent">
                <Star className="w-3 h-3" />
                recommended
              </span>
            )}
          </span>
          {detail && (
            <span
              className={cx(
                "mt-1 block text-xs leading-relaxed text-muted",
                long && !expanded && "line-clamp-1",
              )}
            >
              {detail}
            </span>
          )}
        </span>
      </button>
      {long && (
        <button
          className="flex min-h-9 w-full items-center gap-1 px-3 pb-2 text-[11px] text-accent"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? (
            <ChevronUp className="w-3.5 h-3.5" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5" />
          )}
          {expanded ? "less" : "more"}
        </button>
      )}
    </div>
  );
}
