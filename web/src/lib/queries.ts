import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api, ApiError } from "./api";
import type {
  AgentRow,
  AuditRow,
  AuthState,
  Bootstrap,
  Credential,
  EnrollmentPermit,
  HerdrState,
  ReviewItem,
  SessionRow,
  Task,
  TaskDetail,
  TaskTail,
  TokenRow,
} from "./types";

export const qk = {
  authState: ["auth", "state"] as const,
  bootstrap: ["bootstrap"] as const,
  reviews: (status: string) => ["reviews", status] as const,
  review: (id: string) => ["review", id] as const,
  agents: ["agents"] as const,
  herdrState: ["herdr", "state"] as const,
  tasks: ["tasks"] as const,
  task: (id: string) => ["task", id] as const,
  credentials: ["credentials"] as const,
  sessions: ["sessions"] as const,
  tokens: ["tokens"] as const,
  audit: (limit: number) => ["audit", limit] as const,
};

/** Auth failures are terminal: retrying a 401 just burns battery. */
function retryUnlessAuth(count: number, err: Error): boolean {
  if (err instanceof ApiError && (err.isAuth || err.status === 404)) return false;
  return count < 2;
}

export function useAuthState() {
  return useQuery({
    queryKey: qk.authState,
    queryFn: () => api.get<AuthState>("/api/v1/auth/state"),
    retry: retryUnlessAuth,
    staleTime: 30_000,
  });
}

/** One round trip on app open: user, version, counts, push key. */
export function useBootstrap() {
  return useQuery({
    queryKey: qk.bootstrap,
    queryFn: () => api.get<Bootstrap>("/api/v1/bootstrap"),
    retry: retryUnlessAuth,
    staleTime: 15_000,
  });
}

export function useReviews(status: "open" | "answered" | "all" = "all") {
  return useQuery({
    queryKey: qk.reviews(status),
    queryFn: () => api.get<ReviewItem[]>(`/api/v1/review?status=${status}`),
    retry: retryUnlessAuth,
    staleTime: 5_000,
  });
}

export function useReview(id: string) {
  return useQuery({
    queryKey: qk.review(id),
    queryFn: () => api.get<ReviewItem>(`/api/v1/review/${encodeURIComponent(id)}`),
    retry: retryUnlessAuth,
  });
}

export function useAnswerReview(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { value: string; note?: string }) =>
      api.post<ReviewItem>(`/api/v1/review/${encodeURIComponent(id)}/answer`, {
        value: vars.value,
        ...(vars.note && vars.note.trim() !== "" ? { note: vars.note.trim() } : {}),
      }),
    onSuccess: (item) => {
      if (item) qc.setQueryData(qk.review(id), item);
      void qc.invalidateQueries({ queryKey: ["reviews"] });
      void qc.invalidateQueries({ queryKey: qk.bootstrap });
    },
  });
}

export function useDismissReview() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<void>(`/api/v1/review/${encodeURIComponent(id)}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["reviews"] });
      void qc.invalidateQueries({ queryKey: qk.bootstrap });
    },
  });
}

export function useAgents(enabled = true) {
  return useQuery({
    queryKey: qk.agents,
    queryFn: () => api.get<AgentRow[]>("/api/v1/agents"),
    retry: retryUnlessAuth,
    refetchInterval: 15_000,
    enabled,
  });
}

/**
 * The whole herdr session tree — workspace, tab, pane, agent.
 *
 * `running:false` is data, not a failure, so this query has no special error
 * handling beyond the usual: the renderer is what tells the difference between
 * "herdr is not up" and "the box did not answer".
 */
export function useHerdrState(enabled = true) {
  return useQuery({
    queryKey: qk.herdrState,
    queryFn: () => api.get<HerdrState>("/api/v1/herdr/state"),
    retry: retryUnlessAuth,
    refetchInterval: 10_000,
    enabled,
  });
}

export function useTasks() {
  return useQuery({
    queryKey: qk.tasks,
    queryFn: () => api.get<Task[]>("/api/v1/tasks"),
    retry: retryUnlessAuth,
    // The stream invalidates on every transition; the interval is the net
    // under a dropped socket, not the mechanism.
    refetchInterval: 30_000,
  });
}

export function useTask(id: string) {
  return useQuery({
    queryKey: qk.task(id),
    queryFn: () => api.get<TaskDetail>(`/api/v1/tasks/${encodeURIComponent(id)}`),
    retry: retryUnlessAuth,
  });
}

export function useTaskTail(id: string, enabled: boolean) {
  return useQuery({
    queryKey: [...qk.task(id), "tail"] as const,
    queryFn: () => api.get<TaskTail>(`/api/v1/tasks/${encodeURIComponent(id)}/tail`),
    retry: retryUnlessAuth,
    enabled,
  });
}

export function useCreateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      title?: string;
      body_md: string;
      repo?: string;
      kind?: string;
      branch?: string;
      run_now?: boolean;
    }) => api.post<Task>("/api/v1/tasks", vars),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.tasks });
      void qc.invalidateQueries({ queryKey: qk.bootstrap });
    },
  });
}

/** ready / cancel / retry / close — the human's verbs on one task. */
export function useTaskAction(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { action: "ready" | "cancel" | "retry" | "close"; result?: string }) =>
      api.post<Task>(
        `/api/v1/tasks/${encodeURIComponent(id)}/${vars.action}`,
        vars.action === "close" ? { result: vars.result ?? "" } : {},
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.tasks });
      void qc.invalidateQueries({ queryKey: qk.task(id) });
      void qc.invalidateQueries({ queryKey: qk.bootstrap });
    },
  });
}

/** Bring an agent's pane to the foreground before opening the terminal. */
export function useFocusAgent() {
  return useMutation({
    mutationFn: (agent: string) => api.post<void>("/api/v1/herdr/focus", { agent }),
  });
}

export function useCredentials() {
  return useQuery({
    queryKey: qk.credentials,
    queryFn: () => api.get<Credential[]>("/api/v1/credentials"),
    retry: retryUnlessAuth,
  });
}

/**
 * Flips a passkey's terminal permission.
 *
 * The server requires a step-up for this, so the API client may run the passkey
 * ceremony and retry underneath — the mutation just looks slow for a moment.
 */
export function useSetCredentialTerminal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; allowed: boolean }) =>
      api.post<void>(`/api/v1/credentials/${encodeURIComponent(vars.id)}/terminal`, {
        allowed: vars.allowed,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.credentials });
      void qc.invalidateQueries({ queryKey: qk.bootstrap });
    },
  });
}

export function useSessions() {
  return useQuery({
    queryKey: qk.sessions,
    queryFn: () => api.get<SessionRow[]>("/api/v1/sessions"),
    retry: retryUnlessAuth,
  });
}

export function useTokens() {
  return useQuery({
    queryKey: qk.tokens,
    queryFn: () => api.get<TokenRow[]>("/api/v1/tokens"),
    retry: retryUnlessAuth,
  });
}

export function useAudit(limit = 50) {
  return useQuery({
    queryKey: qk.audit(limit),
    queryFn: () => api.get<AuditRow[]>(`/api/v1/audit?limit=${limit}`),
    retry: retryUnlessAuth,
  });
}

export function useMintEnrollment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { label?: string; ttl_minutes?: number }) =>
      api.post<EnrollmentPermit>("/api/v1/credentials/enroll", vars),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.credentials }),
  });
}

/** Everything the session touched is invalid the moment the session ends. */
export async function resetAfterLogout(qc: QueryClient): Promise<void> {
  qc.clear();
  await purgeDeviceCaches();
  await qc.invalidateQueries({ queryKey: qk.authState });
}

/**
 * Remove every trace of the session from the device.
 *
 * Clearing the in-memory query cache is not enough on its own: a service worker
 * that has cached anything holds it on disk, outliving the tab, the session and
 * the logout. herdrer's worker no longer caches API responses at all, but an
 * *already installed* older worker still holds what it cached before the
 * update, and activation is lazy — so logging out has to say so explicitly
 * rather than wait for a reload that may not come.
 *
 * Best effort by design: a failure here must never block the logout itself.
 */
export async function purgeDeviceCaches(): Promise<void> {
  try {
    navigator.serviceWorker?.controller?.postMessage({ type: "herdrer:purge" });
  } catch {
    // No controller, or messaging unavailable. The caches.delete below still runs.
  }
  try {
    if (typeof caches !== "undefined") {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch {
    // Cache Storage unavailable or blocked; nothing more we can do from here.
  }
}
