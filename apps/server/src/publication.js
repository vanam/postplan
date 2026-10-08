import { isoNow, newEventId } from "./db.js";

export function findDraftBySlug(db, slug) {
  return db.prepare("SELECT * FROM drafts WHERE slug = ? AND deleted_at IS NULL")
    .bind(slug).first();
}

export function currentVersion(db, versionId) {
  return db.prepare("SELECT * FROM draft_versions WHERE id = ?").bind(versionId).first();
}

export async function versionPages(db, versionId) {
  const result = await db.prepare(`SELECT path, object_key, content_hash, file_size,
    title, has_inline_script FROM draft_version_pages WHERE version_id = ? ORDER BY path`)
    .bind(versionId).all();
  return result.results;
}

// Every dependent statement is guarded by the new current version ID. A lost
// optimistic update inserts nothing, and the caller can retry against fresh state.
export async function commitPublication(db, input) {
  const now = isoNow();
  const draftValues = [input.title, input.description, input.slug,
    input.metadata.repoOrg, input.metadata.repoName, input.metadata.repoHost, now];
  const draftStatement = input.existingDraft
    ? db.prepare(`UPDATE drafts SET version_seq = version_seq + 1,
        current_version_id = ?, title = ?, description = COALESCE(?, description), slug = ?,
        repo_org = COALESCE(?, repo_org), repo_name = COALESCE(?, repo_name),
        repo_host = COALESCE(?, repo_host), updated_at = ?
        WHERE id = ? AND account_id = ? AND deleted_at IS NULL AND disabled_at IS NULL
          AND current_version_id = ? AND slug IS ?
        RETURNING version_seq`)
      .bind(input.versionId, ...draftValues, input.draftId, input.accountId,
        input.existingDraft.current_version_id, input.existingDraft.slug)
    : db.prepare(`INSERT INTO drafts (id, account_id, current_version_id, title,
        description, slug, repo_org, repo_name, repo_host, updated_at, created_at, version_seq)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1) RETURNING version_seq`)
      .bind(input.draftId, input.accountId, input.versionId, ...draftValues, now);

  const statements = [draftStatement, db.prepare(`INSERT INTO draft_versions (
      id, draft_id, version_number, object_key, content_hash, file_size,
      created_by_api_key_id, source_ip, user_agent, cli_version,
      git_branch, git_commit_sha, original_filename, git_commit_subject,
      git_dirty, request_id, has_inline_script, external_image_hosts,
      ci_run_url, ci_actor, created_at, scripts_allowed)
    SELECT ?, d.id, d.version_seq, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    FROM drafts d WHERE d.id = ? AND d.account_id = ? AND d.current_version_id = ?
      AND d.deleted_at IS NULL`)
    .bind(input.versionId, input.objectKey, input.contentHash, input.fileSize,
      input.apiKeyId, input.sourceIp, input.userAgent, input.metadata.cliVersion,
      input.metadata.gitBranch, input.metadata.gitCommitSha, input.originalFilename,
      input.metadata.gitCommitSubject, input.metadata.gitDirty === null ? null : Number(input.metadata.gitDirty),
      input.requestId, Number(input.hasInlineScript), JSON.stringify(input.externalImageHosts),
      input.metadata.ciRunUrl, input.metadata.ciActor, now, Number(input.scriptsAllowed),
      input.draftId, input.accountId, input.versionId)];

  for (const page of input.pages) {
    statements.push(db.prepare(`INSERT INTO draft_version_pages
      (version_id, path, object_key, content_hash, file_size, title, has_inline_script)
      SELECT id, ?, ?, ?, ?, ?, ? FROM draft_versions WHERE id = ?`)
      .bind(page.path, page.objectKey, page.contentHash, page.bytes, page.title,
        Number(page.hasScripts), input.versionId));
  }
  statements.push(db.prepare(`INSERT INTO upload_events
    (id, draft_id, draft_version_id, api_key_id, event_type, source_ip,
     user_agent, metadata_json, created_at)
    SELECT ?, draft_id, id, ?, ?, ?, ?, ?, ? FROM draft_versions WHERE id = ?`)
    .bind(newEventId(), input.apiKeyId, input.existingDraft ? "draft.updated" : "draft.created",
      input.sourceIp, input.userAgent, JSON.stringify(input.metadata), now, input.versionId));
  const results = await db.batch(statements);
  const versionNumber = results[0].results[0]?.version_seq;
  return versionNumber ? Number(versionNumber) : null;
}

// Metadata-only changes still compare the current pointer, so they cannot rename
// a draft or log an event using a version that changed during the request.
export async function updateUnchangedDraft(db, input) {
  const now = isoNow();
  const results = await db.batch([
    db.prepare(`INSERT INTO upload_events (id, draft_id, draft_version_id, api_key_id,
      event_type, source_ip, user_agent, metadata_json, created_at)
      SELECT ?, id, current_version_id, ?, 'draft.metadata-updated', ?, ?, ?, ?
      FROM drafts WHERE id = ? AND account_id = ? AND current_version_id = ?
        AND slug IS ? AND deleted_at IS NULL AND disabled_at IS NULL`)
      .bind(newEventId(), input.apiKeyId, input.sourceIp, input.userAgent,
        JSON.stringify({ description: input.description, slug: input.slug }), now,
        input.draftId, input.accountId, input.versionId, input.previousSlug),
    db.prepare(`UPDATE drafts SET description = COALESCE(?, description), slug = ?, updated_at = ?
      WHERE id = ? AND account_id = ? AND current_version_id = ? AND slug IS ?
        AND deleted_at IS NULL AND disabled_at IS NULL RETURNING id`)
      .bind(input.description, input.slug, now, input.draftId, input.accountId, input.versionId, input.previousSlug)
  ]);
  return results[1].results.length > 0;
}
