ALTER TABLE drafts ADD COLUMN slug TEXT;
CREATE UNIQUE INDEX drafts_active_slug_idx ON drafts(slug)
WHERE slug IS NOT NULL AND deleted_at IS NULL;

ALTER TABLE draft_versions ADD COLUMN scripts_allowed INTEGER NOT NULL DEFAULT 0
CHECK (scripts_allowed IN (0, 1));

CREATE TABLE draft_version_pages (
  version_id TEXT NOT NULL REFERENCES draft_versions(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  object_key TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  title TEXT,
  has_inline_script INTEGER NOT NULL CHECK (has_inline_script IN (0, 1)),
  PRIMARY KEY (version_id, path)
) STRICT;

INSERT INTO draft_version_pages
  (version_id, path, object_key, content_hash, file_size, title, has_inline_script)
SELECT v.id, 'index.html', v.object_key, v.content_hash, v.file_size, d.title,
       COALESCE(v.has_inline_script, 0)
FROM draft_versions v JOIN drafts d ON d.id = v.draft_id;
