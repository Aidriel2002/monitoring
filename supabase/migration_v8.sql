-- Durable geo cache: survives Netlify's ephemeral / read-only filesystem.
-- Stores positive reverse-geocode (province) and forward-geocode (coords)
-- results keyed by the same cache keys used in src/lib/geo.ts.
CREATE TABLE IF NOT EXISTS geo_cache (
  key       TEXT PRIMARY KEY,
  value     JSONB NOT NULL,
  stored_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
