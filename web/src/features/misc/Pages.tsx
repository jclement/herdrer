import { Link } from "@tanstack/react-router";
import { Compass, Bug } from "lucide-react";
import { taglineForDate } from "../../lib/taglines";
import { Button } from "../../components/ui";

export function NotFound() {
  return (
    <div className="fade flex flex-col items-center gap-3 px-6 py-16 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-full border border-border bg-surface-2 text-muted">
        <Compass className="w-6 h-6" />
      </span>
      <div className="font-mono text-3xl font-semibold tracking-tight text-heading">404</div>
      <p className="max-w-xs text-sm text-body">
        Nothing at this address. Either the item was reaped, or a URL got typed from memory.
      </p>
      <p className="text-xs text-muted">{taglineForDate()}</p>
      {/* Home, whatever home is at this width — the inbox on a phone, the
          terminal on a desktop. */}
      <Link to="/">
        <Button variant="primary">Back to herdrer</Button>
      </Link>
    </div>
  );
}

export function RouteError({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="fade flex flex-col items-center gap-3 px-6 py-16 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-full border border-danger/40 bg-danger-weak text-danger">
        <Bug className="w-6 h-6" />
      </span>
      <div className="font-mono text-3xl font-semibold tracking-tight text-heading">500</div>
      <p className="max-w-xs text-sm text-body">
        The screen fell over. The box is probably fine; this part of the app is not.
      </p>
      <pre className="scroll-x max-w-full rounded-md border border-border bg-surface-2 p-2 text-left font-mono text-[11px] text-muted">
        {message}
      </pre>
      <Button onClick={() => window.location.reload()}>Reload</Button>
    </div>
  );
}
