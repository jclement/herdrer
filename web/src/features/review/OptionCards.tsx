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
    <div className={cx(selected && "bg-selected", disabled && "opacity-60")}>
      <button
        className="flex w-full items-start gap-2 px-3 py-3 text-left"
        onClick={onSelect}
        aria-pressed={selected}
        disabled={disabled}
      >
        <span
          className={cx(
            "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border font-mono text-[11px]",
            selected ? "border-accent bg-accent text-accent-fg" : "border-border text-muted",
          )}
        >
          {optionKey.slice(0, 1).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="text-sm font-medium text-heading">{label}</span>
            {recommended && (
              <span className="inline-flex items-center gap-0.5 rounded border border-accent/40 px-1 text-[10px] text-accent">
                <Star className="w-3 h-3" />
                recommended
              </span>
            )}
          </span>
          {detail && (
            <span
              className={cx("mt-0.5 block text-xs text-muted", long && !expanded && "line-clamp-1")}
            >
              {detail}
            </span>
          )}
        </span>
      </button>
      {long && (
        <button
          className="flex w-full items-center gap-1 px-3 pb-2 text-[11px] text-accent"
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
