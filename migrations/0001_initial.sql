PRAGMA foreign_keys = ON;

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
) STRICT;

CREATE TABLE drafts (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  title TEXT NOT NULL,
  description TEXT,
  current_version_id TEXT,
  version_seq INTEGER NOT NULL DEFAULT 0,
  repo_org TEXT,
  repo_name TEXT,
  repo_host TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  disabled_at TEXT,
  disabled_reason TEXT
) STRICT;

CREATE TABLE draft_versions (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL REFERENCES drafts(id),
  version_number INTEGER NOT NULL,
  object_key TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  created_by_api_key_id TEXT NOT NULL REFERENCES api_keys(id),
  source_ip TEXT,
  user_agent TEXT,
  cli_version TEXT,
  git_branch TEXT,
  git_commit_sha TEXT,
  git_commit_subject TEXT,
  git_dirty INTEGER CHECK (git_dirty IN (0, 1) OR git_dirty IS NULL),
  original_filename TEXT,
  request_id TEXT,
  has_inline_script INTEGER CHECK (has_inline_script IN (0, 1) OR has_inline_script IS NULL),
  external_image_hosts TEXT,
  ci_run_url TEXT,
  ci_actor TEXT,
  UNIQUE (draft_id, version_number)
) STRICT;

CREATE TABLE upload_events (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL REFERENCES drafts(id),
  draft_version_id TEXT REFERENCES draft_versions(id),
  api_key_id TEXT NOT NULL REFERENCES api_keys(id),
  event_type TEXT NOT NULL,
  source_ip TEXT,
  user_agent TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE identities (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  email TEXT,
  email_verified INTEGER CHECK (email_verified IN (0, 1) OR email_verified IS NULL),
  display_name TEXT,
  picture_url TEXT,
  pii_subject TEXT,
  created_at TEXT NOT NULL,
  last_login_at TEXT,
  UNIQUE (provider, subject)
) STRICT;

CREATE TABLE rate_limits (
  bucket_key TEXT PRIMARY KEY,
  request_count INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
) STRICT;

CREATE INDEX draft_versions_draft_id_idx ON draft_versions(draft_id);
CREATE INDEX upload_events_draft_id_idx ON upload_events(draft_id);
CREATE INDEX drafts_account_id_idx ON drafts(account_id);

INSERT INTO accounts (id, name, created_at, updated_at)
VALUES (
  'acct_public_upload',
  'Public Uploads',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);

INSERT INTO api_keys (id, account_id, name, key_hash, created_at)
VALUES (
  'key_public_upload',
  'acct_public_upload',
  'Public Uploads',
  '284cf204d3658d626f88fb5a587a9b02ee8e17aad15cf5939eb5cb009e394476',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);
