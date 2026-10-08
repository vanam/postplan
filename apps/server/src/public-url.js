export function getRequestBaseUrl(request) {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

export function getHomeUrl({ publicBaseUrl, requestBaseUrl }) {
  return normalizeUrl(publicBaseUrl) || normalizeUrl(requestBaseUrl);
}

export function getDraftPublicUrl({ draftId, slug, multiPage = false, publicBaseUrl, requestBaseUrl }) {
  const base = getHomeUrl({ publicBaseUrl, requestBaseUrl });
  return slug ? `${base}/s/${slug}/` : `${base}/d/${draftId}${multiPage ? "/" : ""}`;
}

export function getDraftRawUrl({ draftId, publicBaseUrl, requestBaseUrl }) {
  return `${getHomeUrl({ publicBaseUrl, requestBaseUrl })}/d/${draftId}/raw`;
}

function normalizeUrl(value) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\/+$/, "");
}
