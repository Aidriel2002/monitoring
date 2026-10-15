-- Contact incharges who receive Telegram outage reports after each sync cycle.
-- provinces: JSONB array of province name strings (match against geocoded site province).
-- project_ids: JSONB array of Ruijie group IDs.
-- Both default to [] — a contact with neither assignment receives no reports.
-- telegram_chat_id: @username or numeric Telegram user ID. The contact must
-- have started a conversation with the bot before the first report is sent.
CREATE TABLE contact_incharges (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL,
  telegram_chat_id TEXT NOT NULL,
  provinces JSONB DEFAULT '[]'::jsonb,
  project_ids JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_contact_incharges_user_id ON contact_incharges(user_id);

ALTER TABLE contact_incharges ENABLE ROW LEVEL SECURITY;

-- Users can only see their own contacts
CREATE POLICY "Users can view own contacts" ON contact_incharges
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own contacts" ON contact_incharges
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own contacts" ON contact_incharges
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own contacts" ON contact_incharges
  FOR DELETE USING (auth.uid() = user_id);

-- Service role can access all contacts (for API routes)
CREATE POLICY "Service role can manage all contacts" ON contact_incharges
  USING (true);
