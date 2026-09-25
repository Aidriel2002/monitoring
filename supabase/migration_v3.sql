-- Add selected_group_ids to api_credentials
-- Stores an array of group IDs the user wants to monitor
ALTER TABLE api_credentials 
  ADD COLUMN selected_group_ids JSONB DEFAULT NULL;

-- NULL means "select all" (default behavior)
-- An empty array [] means "select none"
-- A populated array [9585986, 9588688] means "select these specific groups"
