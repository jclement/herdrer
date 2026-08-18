-- Step-up re-authentication, and per-credential terminal permission.
--
-- Deleting the end-to-end crypto envelope that herdr-web carried was the right
-- call — TLS terminating on our own box beats a hand-rolled transport — but it
-- cost one real property: channel binding. A session cookie is now a bearer
-- token, and a stolen one is a stolen session.
--
-- These two columns buy that property back where it matters most. Opening a
-- shell requires a *fresh* authenticator assertion, so possession of the cookie
-- is not sufficient; and a credential can be marked review-only, so a device
-- that lives in a pocket need not be able to reach a shell at all.

-- Whether a passkey may be used to open a terminal. Default 1 so the bootstrap
-- device is usable immediately; a phone can be flipped to 0 in settings.
ALTER TABLE credentials ADD COLUMN can_terminal INTEGER NOT NULL DEFAULT 1;

-- When this session last completed a step-up assertion, and with which
-- credential. NULL means never — which is the state every session starts in.
ALTER TABLE sessions ADD COLUMN stepped_up_at INTEGER;
ALTER TABLE sessions ADD COLUMN stepped_up_cred TEXT;
