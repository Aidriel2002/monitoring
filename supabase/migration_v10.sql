-- Durable device inventory store (per credential).
--
-- The fleet device store (serial → identity + online/offline) previously
-- lived only in process memory and the .cache/ directory. On Netlify the
-- filesystem is read-only/ephemeral, so a cold instance had an EMPTY store:
-- getFleetDevices(mode "status") returned [], every owned project got
-- totalCount 0, and all owned sites disappeared from the dashboard after a
-- refresh / instance recycle. This table makes the inventory survive cold
-- starts the same way migration_v9 keeps the dashboard payload alive.
CREATE TABLE IF NOT EXISTS device_stores (
  key        TEXT PRIMARY KEY,
  store      JSONB NOT NULL,
  stored_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
