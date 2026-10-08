import { sha256 } from "./crypto.js";
import { newInternalId } from "./ids.js";

export const publicUploadAuth = {
  id: "key_public_upload",
  account_id: "acct_public_upload",
  name: "Public Uploads",
  account_name: "Public Uploads"
};

const BOOTSTRAP_ACCOUNT_ID = "acct_bootstrap";
const BOOTSTRAP_KEY_ID = "key_bootstrap";

export async function findApiKeyByToken(db, token, bootstrapApiKey) {
  const keyHash = await sha256(token);
  const result = await db
    .prepare(
      `
        SELECT api_keys.id, api_keys.account_id, api_keys.name, accounts.name AS account_name
        FROM api_keys
        JOIN accounts ON accounts.id = api_keys.account_id
        WHERE api_keys.key_hash = ?
          AND api_keys.id NOT IN (?, ?)
          AND api_keys.revoked_at IS NULL
        LIMIT 1
      `
    )
    .bind(keyHash, publicUploadAuth.id, BOOTSTRAP_KEY_ID)
    .first();

  if (result) {
    await db
      .prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?")
      .bind(isoNow(), result.id)
      .run();
    return result;
  }

  if (!bootstrapApiKey || !(await equalTokens(token, bootstrapApiKey))) return null;
  await ensureBootstrapApiKey(db, keyHash);
  return {
    id: BOOTSTRAP_KEY_ID,
    account_id: BOOTSTRAP_ACCOUNT_ID,
    name: "Bootstrap API Key",
    account_name: "Bootstrap Account"
  };
}

export async function createDraftVersion(db, input) {
  const now = isoNow();
  const versionValues = [
    input.versionId,
    input.objectKey,
    input.contentHash,
    input.fileSize,
    input.apiKeyId,
    input.sourceIp,
    input.userAgent,
    input.metadata.cliVersion,
    input.metadata.gitBranch,
    input.metadata.gitCommitSha,
    input.originalFilename,
    input.metadata.gitCommitSubject,
    booleanInteger(input.metadata.gitDirty),
    input.requestId,
    booleanInteger(input.hasInlineScript),
    JSON.stringify(input.externalImageHosts || []),
    input.metadata.ciRunUrl,
    input.metadata.ciActor,
    now
  ];

  if (input.existingDraft) {
    const results = await db.batch([
      db
        .prepare(
          `
            UPDATE drafts
            SET version_seq = version_seq + 1,
                current_version_id = ?,
                title = ?,
                description = COALESCE(?, description),
                repo_org = COALESCE(?, repo_org),
                repo_name = COALESCE(?, repo_name),
                repo_host = COALESCE(?, repo_host),
                updated_at = ?
            WHERE id = ?
              AND account_id = ?
              AND deleted_at IS NULL
            RETURNING version_seq
          `
        )
        .bind(
          input.versionId,
          input.title,
          input.description,
          input.metadata.repoOrg,
          input.metadata.repoName,
          input.metadata.repoHost,
          now,
          input.draftId,
          input.accountId
        ),
      db
        .prepare(
          `
            INSERT INTO draft_versions (
              id, draft_id, version_number, object_key, content_hash, file_size,
              created_by_api_key_id, source_ip, user_agent, cli_version,
              git_branch, git_commit_sha, original_filename, git_commit_subject,
              git_dirty, request_id, has_inline_script, external_image_hosts,
              ci_run_url, ci_actor, created_at
            )
            SELECT ?, d.id, d.version_seq, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            FROM drafts d
            WHERE d.id = ? AND d.account_id = ? AND d.deleted_at IS NULL
          `
        )
        .bind(...versionValues, input.draftId, input.accountId),
      db
        .prepare(
          `
            INSERT INTO upload_events (
              id, draft_id, draft_version_id, api_key_id, event_type,
              source_ip, user_agent, metadata_json, created_at
            )
            SELECT ?, d.id, ?, ?, 'draft.updated', ?, ?, ?, ?
            FROM drafts d
            WHERE d.id = ? AND d.account_id = ? AND d.deleted_at IS NULL
          `
        )
        .bind(
          newEventId(),
          input.versionId,
          input.apiKeyId,
          input.sourceIp,
          input.userAgent,
          JSON.stringify(input.metadata),
          now,
          input.draftId,
          input.accountId
        )
    ]);

    const versionNumber = Number(results[0]?.results?.[0]?.version_seq || 0);
    return versionNumber ? { versionNumber } : null;
  }

  await db.batch([
    db
      .prepare(
        `
          INSERT INTO drafts (
            id, account_id, title, description, current_version_id,
            version_seq, repo_org, repo_name, repo_host, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
        `
      )
      .bind(
        input.draftId,
        input.accountId,
        input.title,
        input.description,
        input.versionId,
        input.metadata.repoOrg,
        input.metadata.repoName,
        input.metadata.repoHost,
        now,
        now
      ),
    db
      .prepare(
        `
          INSERT INTO draft_versions (
            id, draft_id, version_number, object_key, content_hash, file_size,
            created_by_api_key_id, source_ip, user_agent, cli_version,
            git_branch, git_commit_sha, original_filename, git_commit_subject,
            git_dirty, request_id, has_inline_script, external_image_hosts,
            ci_run_url, ci_actor, created_at
          )
          VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .bind(versionValues[0], input.draftId, ...versionValues.slice(1)),
    db
      .prepare(
        `
          INSERT INTO upload_events (
            id, draft_id, draft_version_id, api_key_id, event_type,
            source_ip, user_agent, metadata_json, created_at
          )
          VALUES (?, ?, ?, ?, 'draft.created', ?, ?, ?, ?)
        `
      )
      .bind(
        newEventId(),
        input.draftId,
        input.versionId,
        input.apiKeyId,
        input.sourceIp,
        input.userAgent,
        JSON.stringify(input.metadata),
        now
      )
  ]);

  return { versionNumber: 1 };
}

export async function findOwnedDraft(db, draftId, accountId) {
  return db
    .prepare(
      `
        SELECT * FROM drafts
        WHERE id = ? AND account_id = ? AND deleted_at IS NULL
        LIMIT 1
      `
    )
    .bind(draftId, accountId)
    .first();
}

export async function findPublicDraftVersion(db, draftId, versionNumber) {
  const query = versionNumber
    ? `
        SELECT d.id AS draft_id, v.object_key, v.version_number
        FROM drafts d
        JOIN draft_versions v ON v.draft_id = d.id AND v.version_number = ?
        WHERE d.id = ? AND d.deleted_at IS NULL AND d.disabled_at IS NULL
        LIMIT 1
      `
    : `
        SELECT d.id AS draft_id, v.object_key, v.version_number
        FROM drafts d
        JOIN draft_versions v ON v.id = d.current_version_id
        WHERE d.id = ? AND d.deleted_at IS NULL AND d.disabled_at IS NULL
        LIMIT 1
      `;
  const statement = versionNumber
    ? db.prepare(query).bind(versionNumber, draftId)
    : db.prepare(query).bind(draftId);
  const row = await statement.first();
  if (!row) return { draft: null, version: null };
  return {
    draft: { id: row.draft_id },
    version: { object_key: row.object_key, version_number: row.version_number }
  };
}

export async function findOrCreateAccountForIdentity(db, { provider, subject, profile = {} }) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const existing = await db
      .prepare(
        `
          SELECT identities.account_id, accounts.name AS account_name
          FROM identities
          JOIN accounts ON accounts.id = identities.account_id
          WHERE identities.provider = ? AND identities.subject = ?
          LIMIT 1
        `
      )
      .bind(provider, subject)
      .first();

    const now = isoNow();
    const accountName = profile.displayName || profile.email || `Postplan ${subject.slice(-6)}`;
    if (existing) {
      await db.batch([
        db
          .prepare(
            `
              UPDATE identities
              SET last_login_at = ?, email = ?, email_verified = ?, display_name = ?,
                  picture_url = ?, pii_subject = COALESCE(?, pii_subject)
              WHERE provider = ? AND subject = ?
            `
          )
          .bind(
            now,
            profile.email,
            booleanInteger(profile.emailVerified),
            profile.displayName,
            profile.pictureUrl,
            profile.piiSubject,
            provider,
            subject
          ),
        db
          .prepare("UPDATE accounts SET name = ?, updated_at = ? WHERE id = ?")
          .bind(accountName, now, existing.account_id)
      ]);
      return accountResult(existing.account_id, accountName, profile);
    }

    const accountId = `acct_${newInternalId()}`;
    try {
      await db.batch([
        db
          .prepare("INSERT INTO accounts (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
          .bind(accountId, accountName, now, now),
        db
          .prepare(
            `
              INSERT INTO identities (
                id, account_id, provider, subject, email, email_verified,
                display_name, picture_url, pii_subject, created_at, last_login_at
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `
          )
          .bind(
            newInternalId(),
            accountId,
            provider,
            subject,
            profile.email,
            booleanInteger(profile.emailVerified),
            profile.displayName,
            profile.pictureUrl,
            profile.piiSubject,
            now,
            now
          )
      ]);
      return accountResult(accountId, accountName, profile);
    } catch (error) {
      if (attempt === 1) throw error;
    }
  }

  throw new Error("Could not create identity account.");
}

export function newEventId() {
  return newInternalId();
}

export function isoNow() {
  return new Date().toISOString();
}

async function ensureBootstrapApiKey(db, keyHash) {
  const now = isoNow();
  await db.batch([
    db
      .prepare(
        `
          INSERT INTO accounts (id, name, created_at, updated_at)
          VALUES (?, 'Bootstrap Account', ?, ?)
          ON CONFLICT (id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at
        `
      )
      .bind(BOOTSTRAP_ACCOUNT_ID, now, now),
    db
      .prepare(
        `
          INSERT INTO api_keys (id, account_id, name, key_hash, created_at, last_used_at)
          VALUES (?, ?, 'Bootstrap API Key', ?, ?, ?)
          ON CONFLICT (id) DO UPDATE SET
            key_hash = excluded.key_hash,
            name = excluded.name,
            revoked_at = NULL,
            last_used_at = excluded.last_used_at
        `
      )
      .bind(BOOTSTRAP_KEY_ID, BOOTSTRAP_ACCOUNT_ID, keyHash, now, now)
  ]);
}

async function equalTokens(left, right) {
  const [leftHash, rightHash] = await Promise.all([sha256(left), sha256(right)]);
  let difference = leftHash.length ^ rightHash.length;
  const length = Math.max(leftHash.length, rightHash.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (leftHash.charCodeAt(index) || 0) ^ (rightHash.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function booleanInteger(value) {
  return typeof value === "boolean" ? Number(value) : null;
}

function accountResult(accountId, accountName, profile) {
  return {
    accountId,
    accountName,
    email: profile.email ?? null,
    pictureUrl: profile.pictureUrl ?? null
  };
}
