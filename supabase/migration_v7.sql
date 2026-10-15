-- Migration v7 — Telegram chat-id persistence (Netlify/serverless cold starts)
--
-- The phone→chat id link was learned from the bot's inbox and stored only in
-- the on-disk cache (.cache/). Serverless hosts (Netlify) have no writable
-- disk, and getUpdates messages are acked once processed — so the link would
-- be lost on every cold start and reports could never resolve again.
--
-- Store the resolved chat id on the contact instead. Best-effort in code:
-- until this migration runs, persist attempts just log a warning and the
-- old disk-backed behavior continues to work.

ALTER TABLE contact_incharges
  ADD COLUMN IF NOT EXISTS resolved_chat_id TEXT;

COMMENT ON COLUMN contact_incharges.resolved_chat_id IS
  'Telegram chat id resolved from the contact''s number after they message the bot (NULL until linked)';
