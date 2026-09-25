-- API Credentials table for storing multiple Ruijie API configs
CREATE TABLE api_credentials (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL,
  app_id TEXT NOT NULL,
  secret TEXT NOT NULL,
  bootstrap_token TEXT NOT NULL DEFAULT 'd63dss0a81e4415a889ac5b78fsc904a',
  base_url TEXT NOT NULL DEFAULT 'https://cloud-as.ruijienetworks.com',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_api_credentials_user_id ON api_credentials(user_id);

ALTER TABLE api_credentials ENABLE ROW LEVEL SECURITY;

-- Users can only see their own credentials
CREATE POLICY "Users can view own credentials" ON api_credentials
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own credentials" ON api_credentials
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own credentials" ON api_credentials
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own credentials" ON api_credentials
  FOR DELETE USING (auth.uid() = user_id);

-- Service role can access all credentials (for API routes)
CREATE POLICY "Service role can manage all credentials" ON api_credentials
  USING (true);

-- Update RLS on existing tables to require auth
DROP POLICY "Allow anonymous read access" ON projects;
DROP POLICY "Allow anonymous read access" ON alarms;

CREATE POLICY "Authenticated users can read projects" ON projects
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "Authenticated users can read alarms" ON alarms
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "Authenticated users can insert alarms" ON alarms
  FOR INSERT WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "Authenticated users can update alarms" ON alarms
  FOR UPDATE USING (auth.role() = 'authenticated');
