import { getDraftPublicUrl, getDraftRawUrl } from "./public-url.js";

export async function listAccountDrafts(db, accountId, { publicBaseUrl, requestBaseUrl }) {
  const result = await db
    .prepare(
      `
        SELECT
          d.id, d.title, d.description, d.repo_org, d.repo_name, d.repo_host,
          d.created_at, d.updated_at, d.disabled_at,
          cv.version_number AS latest_version_number,
          cv.created_at AS latest_version_at,
          COALESCE(vc.version_count, 0) AS version_count
        FROM drafts d
        LEFT JOIN draft_versions cv ON cv.id = d.current_version_id
        LEFT JOIN (
          SELECT draft_id, COUNT(*) AS version_count
          FROM draft_versions
          GROUP BY draft_id
        ) vc ON vc.draft_id = d.id
        WHERE d.account_id = ? AND d.deleted_at IS NULL
        ORDER BY d.updated_at DESC
      `
    )
    .bind(accountId)
    .all();

  return result.results.map((row) => ({
    draftId: row.id,
    title: row.title,
    description: row.description,
    repoOrg: row.repo_org,
    repoName: row.repo_name,
    repoHost: row.repo_host,
    latestVersionNumber:
      row.latest_version_number === null ? null : Number(row.latest_version_number),
    versionCount: Number(row.version_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    latestVersionAt: row.latest_version_at,
    disabled: Boolean(row.disabled_at),
    publicUrl: getDraftPublicUrl({
      draftId: row.id,
      publicBaseUrl,
      requestBaseUrl
    }),
    rawUrl: getDraftRawUrl({
      draftId: row.id,
      publicBaseUrl,
      requestBaseUrl
    })
  }));
}

export async function getAccountDraftWithVersions(
  db,
  accountId,
  draftId,
  { publicBaseUrl, requestBaseUrl }
) {
  const draft = await db
    .prepare(
      `
        SELECT * FROM drafts
        WHERE id = ? AND account_id = ? AND deleted_at IS NULL
        LIMIT 1
      `
    )
    .bind(draftId, accountId)
    .first();
  if (!draft) return null;

  const versionsResult = await db
    .prepare(
      `
        SELECT id, version_number, created_at, git_branch, git_commit_sha,
               git_commit_subject, git_dirty, file_size
        FROM draft_versions
        WHERE draft_id = ?
        ORDER BY version_number DESC
      `
    )
    .bind(draftId)
    .all();

  return {
    draft: {
      draftId: draft.id,
      title: draft.title,
      description: draft.description,
      publicUrl: getDraftPublicUrl({
        draftId: draft.id,
        publicBaseUrl,
        requestBaseUrl
      })
    },
    versions: versionsResult.results.map((version) => ({
      ...version,
      git_dirty: version.git_dirty === null ? null : Boolean(version.git_dirty)
    }))
  };
}
