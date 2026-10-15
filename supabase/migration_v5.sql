-- Persisted project inventory per credential.
-- Written only by Settings -> Sync devices; the Projects panel reads it
-- instead of calling the Ruijie API on every open.
-- NULL = never synced (the first Projects open bootstraps it once).
ALTER TABLE api_credentials
  ADD COLUMN projects_cache JSONB DEFAULT NULL;
