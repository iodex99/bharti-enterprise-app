-- 003: uploaded photos move from data/uploads/*.webp into the database itself.
--
-- Why: the app now runs entirely inside an Android WebView, where there is no
-- synchronous filesystem for the server code to read/write. SQLite (via its OPFS
-- backing) is the only durable synchronous store available. Keeping photos in the
-- database also makes "all business data is one file" literally true, which is what
-- backup, restore and moving to a new device all depend on.
--
-- image_path columns elsewhere (models, purchases, job_receipts) are unchanged: they
-- still hold '/uploads/<month>/<name>.webp' — only the bytes moved.

CREATE TABLE IF NOT EXISTS upload_files (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  mime TEXT NOT NULL DEFAULT 'image/webp',
  size_bytes INTEGER NOT NULL,
  bytes BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by INTEGER REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_upload_files_created_at ON upload_files (created_at);
