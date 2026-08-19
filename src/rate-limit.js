export async function consumeRateLimit(db, { keyPrefix, identity, windowMs, max, now = Date.now() }) {
  const bucketKey = `${keyPrefix}:${identity || "anonymous"}`;
  const resetAt = now + windowMs;
  const result = await db
    .prepare(
      `
        INSERT INTO rate_limits (bucket_key, request_count, reset_at)
        VALUES (?, 1, ?)
        ON CONFLICT (bucket_key) DO UPDATE SET
          request_count = CASE
            WHEN rate_limits.reset_at <= ? THEN 1
            ELSE rate_limits.request_count + 1
          END,
          reset_at = CASE
            WHEN rate_limits.reset_at <= ? THEN excluded.reset_at
            ELSE rate_limits.reset_at
          END
        RETURNING request_count, reset_at
      `
    )
    .bind(bucketKey, resetAt, now, now)
    .first();

  const count = Number(result?.request_count || 0);
  const actualResetAt = Number(result?.reset_at || resetAt);
  return {
    allowed: count <= max,
    retryAfter: Math.max(1, Math.ceil((actualResetAt - now) / 1000))
  };
}

export function deleteExpiredRateLimits(db, now = Date.now()) {
  return db.prepare("DELETE FROM rate_limits WHERE reset_at <= ?").bind(now).run();
}
