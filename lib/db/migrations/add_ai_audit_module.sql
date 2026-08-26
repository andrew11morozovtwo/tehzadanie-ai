CREATE TABLE IF NOT EXISTS audit_reports (
  id SERIAL PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES requirement_sessions(id) ON DELETE CASCADE,
  project_document_id INTEGER NOT NULL REFERENCES project_documents(id) ON DELETE CASCADE,
  source_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  audit_json JSONB,
  audit_markdown TEXT,
  overall_score INTEGER,
  email_sent_at TIMESTAMPTZ,
  retry_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS audit_reports_session_source_hash_unique
  ON audit_reports (session_id, source_hash);
CREATE INDEX IF NOT EXISTS audit_reports_session_id_index
  ON audit_reports (session_id);
CREATE INDEX IF NOT EXISTS audit_reports_project_document_id_index
  ON audit_reports (project_document_id);
CREATE INDEX IF NOT EXISTS audit_reports_status_index
  ON audit_reports (status);
CREATE INDEX IF NOT EXISTS audit_reports_created_at_index
  ON audit_reports (created_at);