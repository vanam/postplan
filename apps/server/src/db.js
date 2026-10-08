import { sha256 } from "./crypto.js";
import { newInternalId } from "./ids.js";

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
          AND api_keys.id != ?
          AND api_keys.revoked_at IS NULL
        LIMIT 1
      `
    )
    .bind(keyHash, BOOTSTRAP_KEY_ID)
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
