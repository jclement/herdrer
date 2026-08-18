import { useState } from "react";
import { Share, X } from "lucide-react";
import { isIOS, isStandalone } from "../../lib/pwa";
import { flags } from "../../lib/storage";

const FLAG = "install-nudge-dismissed";

/**
 * iOS has no `beforeinstallprompt` and no programmatic install, and web push
 * does not exist in a Safari tab at all — only in a Home Screen web app. So the
 * gesture has to be taught. Not a modal on load: a dismissible banner at the
 * bottom of the inbox, and the gesture is the part people miss, not the reason.
 */
export function InstallNudge() {
  const [dismissed, setDismissed] = useState(() => flags.read(FLAG) === "1");

  if (dismissed || isStandalone() || !isIOS()) return null;

  return (
    <div className="flex items-start gap-2 border-b border-border bg-surface-2 px-3 py-2">
      <Share className="mt-0.5 w-4 h-4 shrink-0 text-accent" />
      <div className="flex-1 text-xs text-body">
        <span className="font-medium text-heading">
          Notifications need this on your Home Screen.
        </span>{" "}
        Tap Share, then <span className="font-medium">Add to Home Screen</span>. Safari tabs cannot
        receive push — that is an iOS rule, not a setting.
      </div>
      <button
        aria-label="Dismiss"
        className="p-1 text-muted"
        onClick={() => {
          flags.write(FLAG, "1");
          setDismissed(true);
        }}
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
