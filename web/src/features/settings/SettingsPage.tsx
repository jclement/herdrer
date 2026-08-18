import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Bell,
  Check,
  Copy,
  KeyRound,
  LogOut,
  Loader2,
  Monitor,
  ScrollText,
  ShieldOff,
  Smartphone,
  Terminal,
  Trash2,
} from "lucide-react";
import { api, describeError } from "../../lib/api";
import {
  qk,
  resetAfterLogout,
  useAudit,
  useBootstrap,
  useCredentials,
  useMintEnrollment,
  useSessions,
  useSetCredentialTerminal,
  useTokens,
} from "../../lib/queries";
import { absoluteTime, shortAge } from "../../lib/format";
import {
  enablePush,
  isIOS,
  isStandalone,
  notificationPermission,
  pushSupported,
} from "../../lib/pwa";
import type { Credential, TokenRow } from "../../lib/types";
import { Button, Chip, Field, SectionHeader, Spinner, cx, inputClass } from "../../components/ui";
import { Sheet } from "../../components/Sheet";
import { useToast } from "../../components/toast";

export function SettingsPage() {
  const boot = useBootstrap();
  const qc = useQueryClient();
  const toast = useToast();

  const logout = async () => {
    try {
      await api.post("/api/v1/auth/logout");
    } catch (err) {
      toast.show(describeError(err), { tone: "danger" });
      return;
    }
    await resetAfterLogout(qc);
  };

  return (
    <div className="pb-8">
      <div className="px-3 py-3">
        <div className="text-sm font-medium text-heading">
          {boot.data?.user.display_name ?? boot.data?.user.handle ?? "Signed in"}
        </div>
        <div className="mt-0.5 text-xs text-muted">
          {boot.data?.user.handle}
          {boot.data?.user.role ? ` · ${boot.data.user.role}` : ""} · v{boot.data?.version ?? "dev"}
        </div>
      </div>

      <NotificationsCard />
      <PasskeysCard />
      <SessionsCard />
      <TokensCard />
      <AuditCard />

      <div className="px-3 py-4">
        <Button variant="danger" className="w-full" onClick={() => void logout()}>
          <LogOut className="w-4 h-4" />
          Sign out
        </Button>
      </div>
    </div>
  );
}

function NotificationsCard() {
  const boot = useBootstrap();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const standalone = isStandalone();
  const permission = notificationPermission();
  const key = boot.data?.vapid_public_key ?? null;

  const turnOn = async () => {
    if (!key) {
      toast.show("The box has no VAPID key configured, so push can't be enabled.", {
        tone: "danger",
      });
      return;
    }
    setBusy(true);
    try {
      const health = await enablePush(key);
      setEndpoint(health.endpoint);
      toast.show("Push is on. Send yourself a test.", { tone: "ok" });
    } catch (err) {
      toast.show(describeError(err), { tone: "danger" });
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    try {
      await api.post("/api/v1/push/test");
      toast.show("Test push sent. If nothing arrives, the subscription has rotted.");
    } catch (err) {
      toast.show(describeError(err), { tone: "danger" });
    }
  };

  return (
    <section>
      <SectionHeader title="Notifications" />
      <div className="space-y-2 px-3 py-3 text-xs">
        <HealthRow
          label="Home Screen app"
          ok={standalone}
          value={standalone ? "yes" : "no — Safari tab"}
        />
        <HealthRow
          label="Push API"
          ok={pushSupported()}
          value={pushSupported() ? "available" : "not in this context"}
        />
        <HealthRow label="Permission" ok={permission === "granted"} value={permission} />
        <HealthRow
          label="Subscription"
          ok={!!endpoint}
          value={endpoint ? new URL(endpoint).host : "none yet"}
        />

        {!standalone && isIOS() && (
          <div className="flex items-start gap-2 rounded-md border border-warn/40 bg-warn-weak p-2 text-warn">
            <Smartphone className="mt-0.5 w-4 h-4 shrink-0" />
            <span>
              iOS only delivers web push to a Home Screen web app. Share → Add to Home Screen, then
              sign in again in there — the installed app is a separate storage context, which is
              expected rather than broken.
            </span>
          </div>
        )}

        <div className="flex gap-2 pt-1">
          <Button variant="primary" loading={busy} onClick={() => void turnOn()} disabled={!key}>
            <Bell className="w-4 h-4" />
            Turn on notifications
          </Button>
          <Button onClick={() => void test()}>Send a test</Button>
        </div>
      </div>
    </section>
  );
}

function HealthRow({ label, ok, value }: { label: string; ok: boolean; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted">{label}</span>
      <span className={cx("font-mono", ok ? "text-ok" : "text-warn")}>{value}</span>
    </div>
  );
}

function PasskeysCard() {
  const { data, isPending, error } = useCredentials();
  const mint = useMintEnrollment();
  const qc = useQueryClient();
  const toast = useToast();
  const [permit, setPermit] = useState<{ code: string; expires_at: string } | null>(null);

  const remove = async (id: string, name: string) => {
    if (!window.confirm(`Remove the passkey "${name}"? You cannot undo this.`)) return;
    try {
      await api.del(`/api/v1/credentials/${encodeURIComponent(id)}`);
      await qc.invalidateQueries({ queryKey: qk.credentials });
      toast.show("Passkey removed.");
    } catch (err) {
      toast.show(describeError(err), { tone: "danger" });
    }
  };

  return (
    <section>
      <SectionHeader
        title="Passkeys"
        right={
          <button
            className="-my-1.5 flex min-h-9 items-center rounded px-1 text-[11px] text-accent transition-colors hover:bg-hover"
            onClick={() =>
              mint.mutate(
                { ttl_minutes: 15 },
                {
                  onSuccess: (p) => setPermit(p),
                  onError: (err) => toast.show(describeError(err), { tone: "danger" }),
                },
              )
            }
          >
            + enrollment code
          </button>
        }
      />
      {isPending && <Spinner />}
      {error && <div className="px-3 py-2 text-xs text-danger">{describeError(error)}</div>}
      <p className="px-3 pb-2 text-[11px] text-muted">
        A passkey marked <span className="text-heading">review-only</span> can answer reviews but
        can never open a shell — so a stolen phone with a live session still cannot reach a PTY.
        Opening a terminal, and changing this flag, both ask for a fresh passkey check.
      </p>
      <ul className="divide-y divide-border">
        {(data ?? []).map((c) => (
          <li key={c.id} className="flex items-center gap-2 px-3 py-2.5">
            <KeyRound className="w-4 h-4 shrink-0 text-muted" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm text-heading">{c.name || c.id}</div>
              <div className="text-[11px] text-muted">
                added {absoluteTime(c.created_at)}
                {c.last_used_at ? ` · used ${shortAge(c.last_used_at)} ago` : " · never used"}
              </div>
              <TerminalPermission credential={c} />
            </div>
            {c.backup_state && <Chip>{c.backup_state}</Chip>}
            <button
              aria-label="Remove passkey"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-danger transition-colors hover:bg-danger-weak"
              onClick={() => void remove(c.id, c.name)}
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </li>
        ))}
        {data?.length === 0 && (
          <li className="px-3 py-3 text-xs text-muted">
            No passkeys. That should be impossible while you are signed in.
          </li>
        )}
      </ul>

      <Sheet open={!!permit} title="Enrollment code" onClose={() => setPermit(null)}>
        <div className="space-y-3 p-3 text-xs">
          <p className="text-body">
            Enter this on the device you want to enroll. It expires{" "}
            {absoluteTime(permit?.expires_at)}.
          </p>
          <CopyableSecret value={permit?.code ?? ""} />
        </div>
      </Sheet>
    </section>
  );
}

/**
 * The per-passkey terminal permission, as a switch you can read.
 *
 * Flipping it needs a step-up of its own, which the API client runs and retries
 * underneath — so the only thing this has to do is say what the two states mean
 * and stay honest about failure. An unlabelled toggle would be a switch; this is
 * meant to read as a security boundary.
 */
function TerminalPermission({ credential }: { credential: Credential }) {
  const setTerminal = useSetCredentialTerminal();
  const toast = useToast();
  const allowed = credential.can_terminal === true;

  const flip = () => {
    setTerminal.mutate(
      { id: credential.id, allowed: !allowed },
      {
        onSuccess: () =>
          toast.show(
            allowed
              ? `"${credential.name || credential.id}" is review-only now.`
              : `"${credential.name || credential.id}" may open terminals.`,
            { tone: "ok" },
          ),
        onError: (err) => toast.show(describeError(err), { tone: "danger" }),
      },
    );
  };

  return (
    <button
      onClick={flip}
      disabled={setTerminal.isPending}
      aria-pressed={allowed}
      className={cx(
        "mt-1.5 inline-flex min-h-7 items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] leading-4 transition-colors",
        allowed ? "border-ok/40 bg-ok-weak text-ok" : "border-border bg-surface-2 text-muted",
        setTerminal.isPending && "opacity-60",
      )}
    >
      {setTerminal.isPending ? (
        <Loader2 className="w-3 h-3 animate-spin" aria-hidden />
      ) : allowed ? (
        <Terminal className="w-3 h-3" aria-hidden />
      ) : (
        <ShieldOff className="w-3 h-3" aria-hidden />
      )}
      {allowed ? "may open terminals" : "review-only"}
    </button>
  );
}

function SessionsCard() {
  const { data, isPending } = useSessions();
  const qc = useQueryClient();
  const toast = useToast();

  const revoke = async (id: string) => {
    try {
      await api.del(`/api/v1/sessions/${encodeURIComponent(id)}`);
      await qc.invalidateQueries({ queryKey: qk.sessions });
    } catch (err) {
      toast.show(describeError(err), { tone: "danger" });
    }
  };

  const revokeAll = async () => {
    if (!window.confirm("Sign out every session, including this one?")) return;
    try {
      await api.post("/api/v1/sessions/revoke-all");
      await qc.invalidateQueries();
    } catch (err) {
      toast.show(describeError(err), { tone: "danger" });
    }
  };

  return (
    <section>
      <SectionHeader
        title="Sessions"
        right={
          <button
            className="-my-1.5 flex min-h-9 items-center rounded px-1 text-[11px] text-danger transition-colors hover:bg-danger-weak"
            onClick={() => void revokeAll()}
          >
            revoke all
          </button>
        }
      />
      {isPending && <Spinner />}
      <ul className="divide-y divide-border">
        {(data ?? []).map((s) => (
          <li key={s.id} className="flex items-center gap-2 px-3 py-2.5">
            <Monitor className="w-4 h-4 shrink-0 text-muted" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs text-heading">
                {s.user_agent || "unknown device"}
              </div>
              <div className="text-[11px] text-muted">
                {s.ip} · seen {shortAge(s.last_seen_at)} ago
              </div>
            </div>
            {s.current && <Chip tone="ok">this device</Chip>}
            {!s.current && (
              <button
                aria-label="Revoke session"
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-danger transition-colors hover:bg-danger-weak"
                onClick={() => void revoke(s.id)}
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function TokensCard() {
  const { data, isPending } = useTokens();
  const qc = useQueryClient();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState("review:write");
  const [ttl, setTtl] = useState("");
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    try {
      const res = await api.post<{ token: TokenRow; secret: string }>("/api/v1/tokens", {
        name: name.trim(),
        scopes: scopes
          .split(/[,\s]+/)
          .map((s) => s.trim())
          .filter(Boolean),
        ...(ttl.trim() ? { ttl_days: Number(ttl) } : {}),
      });
      await qc.invalidateQueries({ queryKey: qk.tokens });
      setSecret(res.secret);
      setCreating(false);
      setName("");
    } catch (err) {
      toast.show(describeError(err), { tone: "danger" });
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string, label: string) => {
    if (!window.confirm(`Revoke "${label}"? Anything using it stops working immediately.`)) return;
    try {
      await api.del(`/api/v1/tokens/${encodeURIComponent(id)}`);
      await qc.invalidateQueries({ queryKey: qk.tokens });
    } catch (err) {
      toast.show(describeError(err), { tone: "danger" });
    }
  };

  return (
    <section>
      <SectionHeader
        title="Agent tokens"
        right={
          <button
            className="-my-1.5 flex min-h-9 items-center rounded px-1 text-[11px] text-accent transition-colors hover:bg-hover"
            onClick={() => setCreating(true)}
          >
            + token
          </button>
        }
      />
      {isPending && <Spinner />}
      <ul className="divide-y divide-border">
        {(data ?? []).map((t) => (
          <li key={t.id} className="flex items-center gap-2 px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm text-heading">{t.name}</div>
              <div className="truncate font-mono text-[11px] text-muted">
                {t.token_prefix}… · {t.scopes?.join(" ") || "no scopes"}
              </div>
              <div className="text-[11px] text-muted">
                {t.last_used_at ? `used ${shortAge(t.last_used_at)} ago` : "never used"}
              </div>
            </div>
            {t.revoked_at ? (
              <Chip tone="danger">revoked</Chip>
            ) : (
              <button
                aria-label="Revoke token"
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-danger transition-colors hover:bg-danger-weak"
                onClick={() => void revoke(t.id, t.name)}
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
          </li>
        ))}
        {data?.length === 0 && (
          <li className="px-3 py-3 text-xs text-muted">
            No tokens yet. Agents need one to post review items.
          </li>
        )}
      </ul>

      <Sheet
        open={creating}
        title="New agent token"
        onClose={() => setCreating(false)}
        footer={
          <Button
            variant="primary"
            size="lg"
            className="w-full"
            loading={busy}
            disabled={name.trim() === ""}
            onClick={() => void create()}
          >
            Create it
          </Button>
        }
      >
        <div className="space-y-3 p-3">
          <Field label="Name" hint="What it is for. It shows up in the audit log.">
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Scopes" hint="Space or comma separated.">
            <input
              className={`${inputClass} font-mono`}
              value={scopes}
              onChange={(e) => setScopes(e.target.value)}
              autoCapitalize="off"
              spellCheck={false}
            />
          </Field>
          <Field label="Expires in (days)" hint="Blank means it does not expire.">
            <input
              className={inputClass}
              value={ttl}
              onChange={(e) => setTtl(e.target.value)}
              inputMode="numeric"
            />
          </Field>
        </div>
      </Sheet>

      <Sheet open={!!secret} title="Copy this now" onClose={() => setSecret(null)}>
        <div className="space-y-3 p-3 text-xs">
          <div className="flex items-start gap-2 rounded-md border border-warn/40 bg-warn-weak p-2 text-warn">
            <AlertTriangle className="mt-0.5 w-4 h-4 shrink-0" />
            <span>
              This is the only time this secret is shown. Close this sheet and it is gone — the box
              stores a hash, not the token.
            </span>
          </div>
          <CopyableSecret value={secret ?? ""} />
        </div>
      </Sheet>
    </section>
  );
}

function CopyableSecret({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const toast = useToast();

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.show("Clipboard refused. Select it by hand.", { tone: "danger" });
    }
  };

  return (
    <div className="flex items-stretch gap-2">
      <code className="min-w-0 flex-1 overflow-x-auto rounded border border-border bg-surface-2 px-2 py-2 font-mono text-xs text-heading">
        {value}
      </code>
      <Button onClick={() => void copy()} aria-label="Copy">
        {copied ? <Check className="w-4 h-4 text-ok" /> : <Copy className="w-4 h-4" />}
        {copied ? "copied" : "copy"}
      </Button>
    </div>
  );
}

function AuditCard() {
  const { data, isPending } = useAudit(20);
  return (
    <section>
      <SectionHeader title="Recent activity" />
      {isPending && <Spinner />}
      <ul className="divide-y divide-border">
        {(data ?? []).map((row) => (
          <li key={row.id} className="flex items-start gap-2 px-3 py-2">
            <ScrollText className="mt-0.5 w-4 h-4 shrink-0 text-muted" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs text-heading">
                <span className="font-mono">{row.kind}</span> {row.subject}
              </div>
              <div className="text-[11px] text-muted">
                {row.actor} · {absoluteTime(row.at)}
                {row.ip ? ` · ${row.ip}` : ""}
              </div>
            </div>
          </li>
        ))}
        {data?.length === 0 && (
          <li className="px-3 py-3 text-xs text-muted">Nothing logged yet.</li>
        )}
      </ul>
      <div className="px-3 py-2 text-[11px] text-muted">
        The last 20 events. The filterable table is a desktop job.
      </div>
    </section>
  );
}
