-- Tasks get their own tables.
--
-- The v0 stub kept tasks as direction='task' rows in review_items, and §4 of
-- DESIGN.md already recorded why that could not last: "the trust rules for
-- items and tasks are exact mirror images, and enforcing two mirrored rules on
-- one table is how you eventually get one wrong." A task now carries a
-- seven-state lifecycle, a claim, a worktree/agent binding, an attempt counter
-- and captured terminal evidence — none of which a review item has, and none of
-- which a review item's scalar status and expiry sweep should grow cases for.
--
-- A task is a REQUEST, never an authorization. Nothing in this table widens
-- what a worker may do: pushing, deploying and touching production keep every
-- gate they had before the task existed.

CREATE TABLE tasks (
    id            TEXT PRIMARY KEY,               -- tk_<16 hex>, server-minted
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title         TEXT NOT NULL,
    body_md       TEXT NOT NULL DEFAULT '',
    kind          TEXT NOT NULL DEFAULT 'change',     -- change | investigate | chore
    repo          TEXT NOT NULL DEFAULT '',           -- relative to HERDRER_REPO_ROOT; '' = unbound
    branch        TEXT NOT NULL DEFAULT '',
    priority      INTEGER NOT NULL DEFAULT 0,
    -- inbox | ready | dispatching | doing | blocked | review | done | failed | cancelled
    status        TEXT NOT NULL DEFAULT 'inbox',
    -- claimed_by is the Herdr AGENT NAME — the durable handle that survives
    -- pane.move — or 'ext:<token_id>' for an external puller (cone).
    claimed_by    TEXT,
    worktree      TEXT NOT NULL DEFAULT '',           -- on-disk path; survives Herdr restarts
    pane_id       TEXT NOT NULL DEFAULT '',           -- advisory only; NOT stable across pane.move
    attempt       INTEGER NOT NULL DEFAULT 0,
    result        TEXT,                               -- REQUIRED to reach done
    -- Captured terminal evidence: the 2am safety net. Replaced, not appended
    -- (Herdr flips agents to done at the end of every turn); capped; shown as
    -- unverified; and NEVER indexed for search — tail is evidence, not a
    -- finding, and must not compete for rank with what a worker concluded.
    tail          TEXT,
    tail_at       INTEGER,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    dispatched_at INTEGER,
    accepted_at   INTEGER,
    finished_at   INTEGER
);
CREATE INDEX idx_tasks_queue   ON tasks(user_id, status, priority DESC, created_at);
CREATE INDEX idx_tasks_claimed ON tasks(claimed_by) WHERE claimed_by IS NOT NULL;

-- The timeline: every transition, note, poke and capture, append-only. The
-- task detail page is a render of this table.
CREATE TABLE task_events (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    at      INTEGER NOT NULL,
    actor   TEXT NOT NULL,      -- user:<id> | token:<id> | worker:<name> | dispatcher | monitor
    kind    TEXT NOT NULL,      -- filed|triaged|dispatched|accepted|note|asked|answered|
                                -- released|nudged|captured|reaped|delivered|approved|
                                -- changes_requested|done|failed|cancelled|error
    detail  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_task_events ON task_events(task_id, at);

-- A review item may belong to a task: its questions and its final review ride
-- the existing inbox, linked back to the task they came from.
ALTER TABLE review_items ADD COLUMN task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL;
CREATE INDEX idx_review_items_task ON review_items(task_id);

-- Port the v0 stub rows, then retire the lane. Open direction='task' items
-- become inbox tasks; the old rows are cancelled so nothing double-serves them.
-- `direction` stays in the schema (migrations are append-only) but nothing
-- writes 'task' again.
INSERT INTO tasks (id, user_id, title, body_md, status, created_at, updated_at)
  SELECT id, user_id, title, body_md, 'inbox', created_at, created_at
  FROM review_items WHERE direction = 'task' AND status = 'open';
UPDATE review_items SET status = 'cancelled', cancelled_at = unixepoch()
  WHERE direction = 'task' AND status = 'open';
