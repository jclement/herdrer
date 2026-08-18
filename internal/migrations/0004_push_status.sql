-- Delivery outcome per push subscription.
--
-- The send path logged only failures, so "delivered fine", "the push service
-- rejected it" and "nothing ever tried" were indistinguishable from the
-- outside — which is exactly the state you are in when someone says
-- "notifications don't work" and you have nothing to look at.

ALTER TABLE push_subs ADD COLUMN last_status INTEGER;
ALTER TABLE push_subs ADD COLUMN last_error TEXT;
ALTER TABLE push_subs ADD COLUMN last_sent_at INTEGER;
ALTER TABLE push_subs ADD COLUMN sent_count INTEGER NOT NULL DEFAULT 0;
