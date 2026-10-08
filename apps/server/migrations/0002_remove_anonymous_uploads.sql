DELETE FROM upload_events
WHERE draft_id IN (SELECT id FROM drafts WHERE account_id = 'acct_public_upload');

DELETE FROM draft_versions
WHERE draft_id IN (SELECT id FROM drafts WHERE account_id = 'acct_public_upload');

DELETE FROM drafts WHERE account_id = 'acct_public_upload';
DELETE FROM identities WHERE account_id = 'acct_public_upload';
DELETE FROM api_keys WHERE account_id = 'acct_public_upload';
DELETE FROM accounts WHERE id = 'acct_public_upload';
DELETE FROM rate_limits WHERE bucket_key = 'upload-key:key_public_upload';
