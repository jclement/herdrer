import { Link } from "@tanstack/react-router";
import { Compass, Bug } from "lucide-react";
import { taglineForDate } from "../../lib/taglines";
import { Button } from "../../components/ui";

export function NotFound() {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
      <Compass className="w-6 h-6 text-muted" />
      <div className="font-mono text-2xl text-heading">404</div>
      <p className="max-w-xs text-sm text-body">
        Nothing at this address. Either the item was reaped, or a URL got typed from memory.
      </p>
      <p className="text-xs text-muted">{taglineForDate()}</p>
      <Link to="/">
        <Button variant="primary">Back to the inbox</Button>
      </Link>
    </div>
  );
}

export function RouteError({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
      <Bug className="w-6 h-6 text-danger" />
      <div className="font-mono text-2xl text-heading">500</div>
      <p className="max-w-xs text-sm text-body">
        The screen fell over. The box is probably fine; this part of the app is not.
      </p>
      <pre className="max-w-full overflow-x-auto rounded border border-border bg-surface-2 p-2 text-left font-mono text-[11px] text-muted">
        {message}
      </pre>
      <Button onClick={() => window.location.reload()}>Reload</Button>
    </div>
  );
}
