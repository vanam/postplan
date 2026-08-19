export function getRequestBaseUrl(request) {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

export function getHomeUrl({ publicBaseUrl, requestBaseUrl }) {
  return normalizeUrl(publicBaseUrl) || normalizeUrl(requestBaseUrl);
}

export function getDraftPublicUrl({ draftId, publicBaseUrl, requestBaseUrl }) {
  return `${getHomeUrl({ publicBaseUrl, requestBaseUrl })}/d/${draftId}`;
}

export function getDraftRawUrl({ draftId, publicBaseUrl, requestBaseUrl }) {
  return `${getDraftPublicUrl({ draftId, publicBaseUrl, requestBaseUrl })}/raw`;
}

function normalizeUrl(value) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\/+$/, "");
}
