import { requireBinding } from "./config.js";

export async function putHtmlObject(bucket, key, html) {
  await requireBinding("DRAFTS", bucket).put(key, html, {
    httpMetadata: {
      contentType: "text/html; charset=utf-8",
      cacheControl: "no-store"
    }
  });
}

export function getHtmlObject(bucket, key) {
  return requireBinding("DRAFTS", bucket).get(key);
}

export function deleteHtmlObject(bucket, key) {
  return requireBinding("DRAFTS", bucket).delete(key);
}
