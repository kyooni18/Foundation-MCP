import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isAllowedRedirectURI, normalizeScopes, verifyPKCE } from "../src/oauth.js";

function challenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

describe("OAuth helpers", () => {
  it("accepts HTTPS and loopback redirect URIs only", () => {
    expect(isAllowedRedirectURI("https://chatgpt.com/oauth/callback")).toBe(true);
    expect(isAllowedRedirectURI("http://127.0.0.1:9911/callback")).toBe(true);
    expect(isAllowedRedirectURI("http://localhost:9911/callback")).toBe(true);
    expect(isAllowedRedirectURI("http://example.com/callback")).toBe(false);
    expect(isAllowedRedirectURI("javascript:alert(1)")).toBe(false);
  });

  it("adds read scope when write is requested", () => {
    expect(normalizeScopes("atom:write offline_access")).toEqual(["atom:read", "atom:write", "offline_access"]);
  });

  it("verifies S256 PKCE", () => {
    const verifier = "a".repeat(43);
    expect(verifyPKCE(verifier, challenge(verifier))).toBe(true);
    expect(verifyPKCE("b".repeat(43), challenge(verifier))).toBe(false);
  });
});
