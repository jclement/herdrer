import { useRef, useState } from "react";
import { MessageSquarePlus, MoreHorizontal, Send } from "lucide-react";
import type { ReviewItem } from "../../lib/types";
import { keyboardAnchoredStyle, useVisualViewport } from "../../lib/viewport";
import { answerOptions, isFreeText, optionLabel } from "./answer";
import { Button, cx, inputClass } from "../../components/ui";

/**
 * A persistent sticky bar, not a bottom sheet: a sheet has to be summoned (a tap
 * paid on every single item) and occludes the evidence you are reading it
 * against. The bar is the point of the page.
 *
 * It is positioned against `visualViewport` rather than `position: fixed;
 * bottom: 0`, because iOS Safari does not resize the layout viewport when the
 * keyboard opens — see lib/viewport.ts. When the note has focus the bar becomes
 * the note plus Send: bar + keyboard + option row is more than a phone has.
 *
 * Inside the overlay sheet it does not anchor itself at all (`anchored={false}`):
 * the sheet is already sized to the visual viewport, so the bar is just the last
 * row of a flex column. Two elements independently chasing `visualViewport`
 * fight during the keyboard animation, and the loser is whichever one the thumb
 * was aiming at.
 */
export function ActionBar({
  item,
  selected,
  onSelect,
  note,
  onNoteChange,
  onSubmit,
  submitting,
  onMore,
  anchored = true,
  disabled = false,
}: {
  item: ReviewItem;
  selected: string | null;
  onSelect: (key: string) => void;
  note: string;
  onNoteChange: (note: string) => void;
  onSubmit: () => void;
  submitting: boolean;
  onMore: () => void;
  /** False inside the sheet, whose own container already tracks the keyboard. */
  anchored?: boolean;
  /** Briefly true after an auto-raise, so an in-flight thumb cannot answer. */
  disabled?: boolean;
}) {
  const vv = useVisualViewport();
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteFocused, setNoteFocused] = useState(false);
  const noteRef = useRef<HTMLTextAreaElement | null>(null);

  const options = answerOptions(item);
  const freeText = isFreeText(item);
  const collapsed = noteFocused && !freeText;
  const canSend = freeText ? note.trim() !== "" : selected !== null;

  return (
    <div
      style={anchored ? { ...keyboardAnchoredStyle(vv), zIndex: 30 } : undefined}
      className="shrink-0 border-t border-border bg-surface-2/95 backdrop-blur-sm"
    >
      <div
        className="mx-auto w-full max-w-3xl px-2 py-2"
        style={{
          paddingBottom:
            vv.keyboardOpen || !anchored
              ? "0.5rem"
              : "calc(env(safe-area-inset-bottom, 0px) + 0.5rem)",
        }}
      >
        {(noteOpen || freeText) && (
          <textarea
            ref={noteRef}
            value={note}
            onChange={(e) => onNoteChange(e.target.value)}
            onFocus={() => setNoteFocused(true)}
            onBlur={() => setNoteFocused(false)}
            rows={collapsed ? 3 : 2}
            placeholder={
              freeText ? "Your answer…" : "A note. This outranks the button — say what you mean."
            }
            className={cx(inputClass, "mb-2 resize-none text-sm leading-relaxed")}
            autoCapitalize="sentences"
            spellCheck
          />
        )}

        <div className="flex items-center gap-2">
          {!freeText && (
            <button
              aria-label={noteOpen ? "Hide note" : "Add a note"}
              onClick={() => {
                setNoteOpen((v) => !v);
                window.setTimeout(() => noteRef.current?.focus(), 30);
              }}
              className={cx(
                "flex h-11 w-11 shrink-0 items-center justify-center rounded-md border transition-colors",
                note.trim()
                  ? "border-accent/50 bg-accent-weak text-accent"
                  : "border-border text-muted hover:bg-hover",
              )}
            >
              <MessageSquarePlus className="w-4 h-4" />
            </button>
          )}

          {collapsed ? (
            <div className="flex min-h-11 min-w-0 flex-1 items-center truncate rounded-md border border-border bg-surface px-2 text-xs text-muted">
              {selected ? `Selected: ${optionLabel(item, selected)}` : "Nothing selected yet"}
            </div>
          ) : freeText ? (
            <div className="min-w-0 flex-1 text-xs leading-snug text-muted">
              Free text. The agent reads this.
            </div>
          ) : (
            <div className="scroll-x no-scrollbar flex min-w-0 flex-1 items-center gap-2">
              {options.map((opt) => {
                const isRec = item.recommend === opt.key;
                const isSel = selected === opt.key;
                return (
                  <button
                    key={opt.key}
                    onClick={() => onSelect(opt.key)}
                    disabled={disabled}
                    aria-pressed={isSel}
                    className={cx(
                      "h-11 shrink-0 whitespace-nowrap rounded-md border px-3 text-sm font-medium",
                      "transition-[background-color,border-color,color] duration-150 active:scale-[0.98]",
                      isSel
                        ? "border-accent bg-accent text-accent-fg shadow-sm"
                        : isRec
                          ? "border-accent/60 bg-accent-weak text-accent"
                          : "border-border bg-surface text-heading hover:bg-hover",
                    )}
                  >
                    {isRec && !isSel && (
                      <span
                        aria-hidden
                        className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-accent align-middle"
                      />
                    )}
                    {opt.label}
                  </button>
                );
              })}
            </div>
          )}

          <Button
            variant="primary"
            size="lg"
            className="shrink-0"
            disabled={!canSend || disabled}
            loading={submitting}
            onClick={onSubmit}
          >
            <Send className="w-4 h-4" />
            Send
          </Button>

          <button
            aria-label="More actions"
            onClick={onMore}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-heading"
          >
            <MoreHorizontal className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
