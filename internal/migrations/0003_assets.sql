-- Images an agent attaches, and before/after file pairs it wants diffed.
--
-- Two capabilities, one motivation: a review document should be able to carry
-- the evidence, not a description of it. A screenshot of the failing UI, and
-- the whole file rather than the three hunks the agent judged interesting.

-- An uploaded binary. Bytes live on disk under <state>/assets/; only the
-- metadata is here, so the database stays small enough to copy around.
CREATE TABLE review_assets (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_id    TEXT REFERENCES api_tokens(id) ON DELETE SET NULL,
    item_id     TEXT REFERENCES review_items(id) ON DELETE CASCADE,
    media_type  TEXT NOT NULL,
    bytes       INTEGER NOT NULL,
    path        TEXT NOT NULL,
    created_at  INTEGER NOT NULL
);
CREATE INDEX idx_review_assets_item ON review_assets(item_id);
CREATE INDEX idx_review_assets_token ON review_assets(token_id);

-- A before/after pair. The unified diff is computed once at submission and
-- stored in review_attachments.content; these keep the originals so the reader
-- can expand to the whole file when the hunks are not enough, which is the
-- entire point of sending them.
ALTER TABLE review_attachments ADD COLUMN before_content TEXT;
ALTER TABLE review_attachments ADD COLUMN after_content TEXT;

-- For kind='image': which asset this attachment renders.
ALTER TABLE review_attachments ADD COLUMN asset_id TEXT;
