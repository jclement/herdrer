import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { describeError } from "../../lib/api";
import { useCreateTask } from "../../lib/queries";
import { flags } from "../../lib/storage";
import { Button, Field, inputClass } from "../../components/ui";
import { Sheet } from "../../components/Sheet";
import { useToast } from "../../components/toast";

const LAST_REPO_KEY = "last-task-repo";

/**
 * The filing surface: one textarea, a repo, a switch. Open → type → file must
 * stay under ten seconds on a phone, so everything else (kind, branch,
 * priority) lives on the detail page's edit, not here.
 *
 * The first line of the text becomes the title; the rest is the body the
 * worker reads. The repo is remembered across filings because on this box the
 * next task is usually for the same repo as the last one.
 */
export function NewTaskSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [body, setBody] = useState("");
  const [repo, setRepo] = useState(() => flags.read(LAST_REPO_KEY) ?? "");
  const [runNow, setRunNow] = useState(true);
  const create = useCreateTask();
  const toast = useToast();
  const navigate = useNavigate();

  const submit = () => {
    const trimmedRepo = repo.trim().replace(/^\/+|\/+$/g, "");
    create.mutate(
      {
        body_md: body.trim(),
        ...(trimmedRepo !== "" ? { repo: trimmedRepo } : {}),
        run_now: runNow,
      },
      {
        onSuccess: (task) => {
          flags.write(LAST_REPO_KEY, trimmedRepo);
          toast.show(
            runNow
              ? "Filed. The dispatcher will start a worker."
              : "Filed to the inbox — mark it ready when it should run.",
            { tone: "ok" },
          );
          setBody("");
          onClose();
          if (task?.id) void navigate({ to: "/tasks/$id", params: { id: task.id } });
        },
        onError: (err) => toast.show(describeError(err), { tone: "danger" }),
      },
    );
  };

  return (
    <Sheet
      open={open}
      title="New task"
      onClose={onClose}
      footer={
        <Button
          variant="primary"
          size="lg"
          className="w-full"
          loading={create.isPending}
          disabled={body.trim() === ""}
          onClick={submit}
        >
          {runNow ? "File and run" : "File to inbox"}
        </Button>
      }
    >
      <div className="space-y-3 p-3">
        <Field
          label="What needs doing?"
          hint="The first line becomes the title. The rest is the brief the worker reads."
        >
          <textarea
            className={`${inputClass} min-h-32 font-sans`}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            autoFocus
            placeholder={"Fix the flaky retry test\n\nIt fails roughly one run in five since the timeout change…"}
          />
        </Field>
        <Field
          label="Repo"
          hint="Under the repo root. Leave empty to park it for an external agent instead."
        >
          <input
            className={inputClass}
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="herdrer"
          />
        </Field>
        <label className="flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-md border border-border bg-surface-2 px-3 py-2">
          <span className="text-sm">
            <span className="font-medium text-heading">Run now</span>
            <span className="block text-xs text-muted">
              Skip the inbox — dispatch as soon as a worker slot is free.
            </span>
          </span>
          <input
            type="checkbox"
            checked={runNow}
            onChange={(e) => setRunNow(e.target.checked)}
            className="h-5 w-5 accent-[var(--color-accent)]"
          />
        </label>
      </div>
    </Sheet>
  );
}
