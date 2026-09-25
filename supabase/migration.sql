CREATE TABLE projects (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'RUIJIE_RECEIVED',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'pending')),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE alarms (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  device_name TEXT NOT NULL,
  device_ip TEXT NOT NULL,
  alarm_type TEXT NOT NULL CHECK (alarm_type IN ('offline', 'online', 'warning')),
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX idx_alarms_alarm_type ON alarms(alarm_type);
CREATE INDEX idx_alarms_resolved_at ON alarms(resolved_at);
CREATE INDEX idx_alarms_project_id ON alarms(project_id);
CREATE INDEX idx_projects_source ON projects(source);

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE alarms ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow anonymous read access" ON projects FOR SELECT USING (true);
CREATE POLICY "Allow anonymous read access" ON alarms FOR SELECT USING (true);
CREATE POLICY "Allow authenticated update" ON alarms FOR UPDATE USING (auth.role() = 'authenticated');
CREATE POLICY "Allow authenticated insert" ON alarms FOR INSERT WITH CHECK (auth.role() = 'authenticated');

ALTER PUBLICATION supabase_realtime ADD TABLE alarms;
