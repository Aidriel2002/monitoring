-- Durable dashboard payload cache + Telegram report claim.
--
-- Netlify function instances share no memory and have an ephemeral
-- filesystem: without this table every cold start redid the full dashboard
-- rebuild (tens of seconds of sequential Ruijie calls) before the sites
-- appeared, and Telegram outage reports depended on after() surviving the
-- HTTP response.
--
--   payload       last healthy DashboardPayload JSON (projects, offlineSites, …)
--   built_at      when it was built — drives the 100-minute freshness window
--   notified_hash fingerprint of the down-set last reported via Telegram, so
--                 a report is delivered once per sync cycle across instances
CREATE TABLE IF NOT EXISTS dashboard_cache (
  user_id        TEXT PRIMARY KEY,
  payload        JSONB NOT NULL DEFAULT '{}'::jsonb,
  built_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  notified_hash  TEXT
);
