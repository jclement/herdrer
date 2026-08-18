import { useEffect, useRef, useState } from "react";
import { MessageSquarePlus, MonitorSmartphone, MoreHorizontal, Send, Star } from "lucide-react";
import type { ReviewItem } from "../../lib/types";
import { keyboardAnchoredStyle, useVisualViewport } from "../../lib/viewport";
import { answerOptions, isFreeText, optionLabel, sendableValue } from "./answer";
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
 *
 * The options are **stacked full-width rows, never a horizontal scroller.** The
 * scroller they replace gave the option strip ~160px of a 375px screen for
 * ~314px of buttons and then hid the scrollbar, so the recommended option
 * rendered as `Dep` underneath Send while Send sat there enabled. A control you
 * can operate without being able to read it is not a layout problem, it is a
 * correctness problem — see `sendableValue` in ./answer.ts, which is the
 * invariant that keeps Send pointed at something the bar is actually showing.
 *
 * `Park it` is a first-class control for the same reason. "I can't decide this
 * on a phone" used to be a menu item that staged a note reading *"don't guess"*
 * — which could not be sent at all on a `choice` (Send needed a selection), and
 * which, if you selected something to get it sent, reached the agent as *"do B"*
 * and *"don't guess"* together. It sends nothing now. It is a defer, and it
 * says so.
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
  onPark,
  onHeight,
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
  /** Put it down without answering. Sends nothing — not a decision. */
  onPark?: () => void;
  /**
   * The bar's measured height, for the page that has to reserve room under the
   * document for it. The bar is not a fixed size: it grows by an option row per
   * option and by ~60px when the note opens, and the page used to reserve a
   * hardcoded 10rem — which was already wrong and is wronger now that the
   * options are stacked. The tail of the document is not a thing to hide.
   */
  onHeight?: (px: number) => void;
  /** False inside the sheet, whose own container already tracks the keyboard. */
  anchored?: boolean;
  /** Briefly true after an auto-raise, so an in-flight thumb cannot answer. */
  disabled?: boolean;
}) {
  const vv = useVisualViewport();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteFocused, setNoteFocused] = useState(false);
  const noteRef = useRef<HTMLTextAreaElement | null>(null);

  const options = answerOptions(item);
  const freeText = isFreeText(item);
  // With the keyboard up there is room for the note or the options, not both.
  // The summary line below is what keeps the pending answer legible meanwhile.
  const collapsed = noteFocused && !freeText;
  const sendable = sendableValue(item, selected, note);

  useEffect(() => {
    const el = rootRef.current;
    if (!el || !onHeight) return;
    onHeight(el.offsetHeight);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => onHeight(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [onHeight]);

  return (
    <div
      ref={rootRef}
      style={anchored ? { ...keyboardAnchoredStyle(vv), zIndex: 30 } : undefined}
      className="shrink-0 border-t border-border bg-surface-2/95 backdrop-blur-sm"
    >
      <div
        className="mx-auto w-full max-w-3xl px-2 py-2"
        style={{
          // The home indicator eats the bottom of the sheet too — `anchored`
          // says who tracks the keyboard, not whether there is a notch.
          paddingBottom: vv.keyboardOpen
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

        {collapsed && (
          <div className="mb-2 flex min-h-9 items-center rounded-md border border-border bg-surface px-2 text-xs text-muted">
            <span className="truncate">
              {selected ? `Sending: ${optionLabel(item, selected)}` : "Nothing selected yet"}
            </span>
          </div>
        )}

        {!freeText && !collapsed && options.length > 0 && (
          /*
           * `flex-wrap` with `basis-full` below `sm`, so every option is its own
           * full-width row in the thumb arc and nothing is ever clipped. Above
           * `sm` they sit side by side and wrap when they must. Labels wrap
           * inside the button rather than truncating: an option you can only
           * half read is the bug this replaced.
           */
          <div
            role="radiogroup"
            aria-label="Answer"
            data-testid="answer-options"
            className="mb-2 flex flex-wrap items-stretch gap-2"
          >
            {options.map((opt) => {
              const isRec = item.recommend === opt.key;
              const isSel = selected === opt.key;
              return (
                <button
                  key={opt.key}
                  onClick={() => onSelect(opt.key)}
                  disabled={disabled}
                  role="radio"
                  aria-checked={isSel}
                  className={cx(
                    "flex min-h-11 basis-full items-center gap-1.5 rounded-md border px-3 py-2",
                    "text-left text-sm font-medium sm:flex-1 sm:basis-auto",
                    "transition-[background-color,border-color,color] duration-150 active:scale-[0.99]",
                    isSel
                      ? "border-accent bg-accent text-accent-fg shadow-sm"
                      : isRec
                        ? "border-accent/60 bg-accent-weak text-accent"
                        : "border-border bg-surface text-heading hover:bg-hover",
                  )}
                >
                  {isRec && (
                    <Star
                      className={cx("w-3.5 h-3.5 shrink-0", isSel ? "" : "text-accent")}
                      aria-hidden
                    />
                  )}
                  <span className="min-w-0 flex-1">{opt.label}</span>
                </button>
              );
            })}
          </div>
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

          {onPark && (
            <button
              onClick={onPark}
              title="Keeps it open and tells the agent nothing. Answer it at a keyboard."
              className="flex h-11 min-w-0 shrink items-center gap-1.5 rounded-md border border-border px-2.5 text-xs text-muted transition-colors hover:bg-hover hover:text-heading"
            >
              <MonitorSmartphone className="w-4 h-4 shrink-0" aria-hidden />
              <span className="truncate">Park it</span>
            </button>
          )}

          <div className="min-w-0 flex-1" aria-hidden />

          <Button
            variant="primary"
            size="lg"
            className="shrink-0"
            disabled={sendable === null || disabled}
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
