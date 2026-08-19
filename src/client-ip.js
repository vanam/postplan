export function clientIp(request) {
  return cleanHeader(request, "cf-connecting-ip") || cleanHeader(request, "x-real-ip");
}

export function requestId(request) {
  return cleanHeader(request, "cf-ray") || cleanHeader(request, "x-request-id");
}

function cleanHeader(request, name) {
  const value = request.headers.get(name);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
