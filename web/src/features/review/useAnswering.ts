import { useEffect, useRef, useState } from "react";
import { ApiError, describeError } from "../../lib/api";
import { useAnswerReview } from "../../lib/queries";
import { drafts } from "../../lib/storage";
import { useToast } from "../../components/toast";
import type { ReviewItem } from "../../lib/types";
import { isFreeText, optionLabel, recommendedKey, sendableValue } from "./answer";

/**
 * The answering half of a review item, shared by the page and the overlay.
 *
 * Both surfaces show the same document and must behave identically when the
 * network is rude — a sheet that swallowed a CONFLICT while the page reported
 * it would be two different products. So the selection, the draft note, and the
 * submit all live here, once.
 *
 * The draft is keyed by item id in localStorage: iOS reclaims a backgrounded
 * web app without warning, and losing a half-typed note to that is the single
 * most enraging thing this app could do.
 */
export interface Answering {
  selected: string | null;
  setSelected: (key: string) => void;
  note: string;
  setNote: (note: string) => void;
  submit: () => void;
  submitting: boolean;
}

export interface AnsweringOptions {
  /** Pre-select the agent's recommendation. It never sends on its own. */
  preselectRecommended?: boolean;
  onAnswered?: () => void;
  /** Someone — or something — answered first. */
  onConflict?: () => void;
}

export function useAnswering(
  id: string,
  item: ReviewItem | undefined,
  options: AnsweringOptions = {},
): Answering {
  const toast = useToast();
  const answer = useAnswerReview(id);
  const [selected, setSelected] = useState<string | null>(null);
  const [note, setNote] = useState(() => drafts.read(id));
  const preselected = useRef(false);

  const { preselectRecommended, onAnswered, onConflict } = options;

  useEffect(() => {
    if (!item || preselected.current) return;
    preselected.current = true;
    const rec = recommendedKey(item);
    if (preselectRecommended && rec) setSelected(rec);
  }, [item, preselectRecommended]);

  useEffect(() => drafts.write(id, note), [id, note]);

  const submit = () => {
    if (!item) return;
    const free = isFreeText(item);
    // The same guard the Send button is disabled by, so a keyboard Enter or a
    // programmatic call cannot send what the bar is not showing.
    const value = sendableValue(item, selected, note);
    if (value === null) return;
    answer.mutate(
      { value, note: free ? undefined : note },
      {
        onSuccess: () => {
          drafts.clear(id);
          setNote("");
          toast.show(
            free
              ? "Answer sent."
              : `Sent: ${optionLabel(item, value)}${note.trim() ? " (with your note)" : ""}`,
            { tone: "ok" },
          );
          onAnswered?.();
        },
        onError: (err) => {
          if (err instanceof ApiError && err.code === "CONFLICT") {
            toast.show("Someone — or something — answered this first. Reloading it.", {
              tone: "danger",
            });
            onConflict?.();
            return;
          }
          toast.show(describeError(err), { tone: "danger" });
        },
      },
    );
  };

  return { selected, setSelected, note, setNote, submit, submitting: answer.isPending };
}
