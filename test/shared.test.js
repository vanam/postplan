import { describe, expect, it } from "vitest";
import { getConfig } from "../src/config.js";
import { validateHtml } from "../src/html-policy.js";
import { getDraftPublicUrl, getDraftRawUrl } from "../src/public-url.js";
import { signToken, verifyToken } from "../src/web-auth.js";

describe("shared Worker modules", () => {
  it("rejects wildcard public base URLs", () => {
    expect(() => getConfig({ POSTPLAN_PUBLIC_BASE_URL: "https://*.example.com" })).toThrow(
      "must not contain a wildcard"
    );
  });

  it("always generates path-style draft URLs", () => {
    const options = {
      draftId: "abc123def456",
      publicBaseUrl: "https://example.com/",
      requestBaseUrl: "https://ignored.test"
    };
    expect(getDraftPublicUrl(options)).toBe("https://example.com/d/abc123def456");
    expect(getDraftRawUrl(options)).toBe("https://example.com/d/abc123def456/raw");
  });

  it("signs, verifies, and expires session tokens with Web Crypto", async () => {
    const token = await signToken({ accountId: "acct_test" }, "test-secret", 60, 100);
    await expect(verifyToken(token, "test-secret", 120)).resolves.toMatchObject({
      accountId: "acct_test",
      exp: 160
    });
    await expect(verifyToken(token, "wrong-secret", 120)).resolves.toBeNull();
    await expect(verifyToken(token, "test-secret", 161)).resolves.toBeNull();
  });

  it("measures HTML limits as UTF-8 bytes", () => {
    const result = validateHtml("<title>é</title>", { maxBytes: 10 });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("17 bytes");
  });
});
