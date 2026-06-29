CREATE TABLE IF NOT EXISTS objects (
  key TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  content_type TEXT,
  size INTEGER,
  uploaded_at INTEGER NOT NULL,
  thumb_key TEXT,
  document_id TEXT,
  page_number INTEGER,
  original_key TEXT
);

CREATE TABLE IF NOT EXISTS object_tags (
  key TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (key, tag)
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  page_count INTEGER NOT NULL DEFAULT 1,
  uploaded_at INTEGER NOT NULL,
  thumb_key TEXT,
  pdf_key TEXT,
  correction_settings TEXT
);

CREATE TABLE IF NOT EXISTS document_tags (
  document_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (document_id, tag)
);

CREATE TABLE IF NOT EXISTS usage_cache (
  date TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_objects_uploaded ON objects(uploaded_at);
CREATE INDEX IF NOT EXISTS idx_tags_tag ON object_tags(tag);
CREATE INDEX IF NOT EXISTS idx_tags_key ON object_tags(key);
CREATE INDEX IF NOT EXISTS idx_objects_document ON objects(document_id);
CREATE INDEX IF NOT EXISTS idx_documents_uploaded ON documents(uploaded_at);
CREATE INDEX IF NOT EXISTS idx_document_tags_tag ON document_tags(tag);
CREATE INDEX IF NOT EXISTS idx_document_tags_doc ON document_tags(document_id);
