-- Add selected_received_group_ids to api_credentials
-- Stores an array of received/shared group IDs the user wants to monitor
ALTER TABLE api_credentials
  ADD COLUMN selected_received_group_ids JSONB DEFAULT NULL;

-- NULL means "select all" (default behavior)
-- An empty array [] means "select none"
-- A populated array [9137649, ...] means "select these specific shared groups"
