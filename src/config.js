const DEFAULT_MAX_HTML_BYTES = 512 * 1024;
const DEFAULT_UPLOAD_BODY_BYTES = 2 * 1024 * 1024;

export function getConfig(env = {}) {
  const publicBaseUrl = normalizeBaseUrl(env.POSTPLAN_PUBLIC_BASE_URL);
  if (publicBaseUrl.includes("*")) {
    throw new Error("POSTPLAN_PUBLIC_BASE_URL must not contain a wildcard.");
  }

  return {
    bootstrapApiKey: cleanString(env.POSTPLAN_BOOTSTRAP_API_KEY),
    publicBaseUrl,
    maxHtmlBytes: positiveNumber(env.MAX_HTML_BYTES, DEFAULT_MAX_HTML_BYTES),
    uploadBodyBytes: parseByteLimit(env.UPLOAD_BODY_LIMIT, DEFAULT_UPLOAD_BODY_BYTES),
    sessionSecret: cleanString(env.POSTPLAN_SESSION_SECRET),
    shooBaseUrl: normalizeBaseUrl(env.SHOO_BASE_URL || "https://shoo.dev"),
    uploadIpRateLimit: {
      windowMs: positiveNumber(env.UPLOAD_IP_RATE_LIMIT_WINDOW_MS, 60_000),
      max: positiveNumber(env.UPLOAD_IP_RATE_LIMIT_MAX, 60)
    },
    uploadKeyRateLimit: {
      windowMs: positiveNumber(env.UPLOAD_RATE_LIMIT_WINDOW_MS, 60_000),
      max: positiveNumber(env.UPLOAD_RATE_LIMIT_MAX, 30)
    },
    keyMintRateLimit: {
      windowMs: positiveNumber(env.KEY_MINT_RATE_LIMIT_WINDOW_MS, 3_600_000),
      max: positiveNumber(env.KEY_MINT_RATE_LIMIT_MAX, 10)
    }
  };
}

export function requireBinding(name, value) {
  if (!value) {
    throw new Error(`Missing required Worker binding: ${name}`);
  }
  return value;
}

function normalizeBaseUrl(value) {
  return cleanString(value)?.replace(/\/+$/, "") || "";
}

function cleanString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function positiveNumber(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseByteLimit(value, fallback) {
  if (typeof value === "number") return positiveNumber(value, fallback);
  if (typeof value !== "string" || !value.trim()) return fallback;

  const match = value.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb)?$/);
  if (!match) return fallback;
  const multiplier = match[2] === "mb" ? 1024 * 1024 : match[2] === "kb" ? 1024 : 1;
  return Math.floor(Number(match[1]) * multiplier);
}
