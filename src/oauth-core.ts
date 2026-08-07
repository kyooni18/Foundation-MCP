import { createHash, randomBytes } from "node:crypto";
import { secureTokenEqual } from "./utils.js";

export const OAUTH_SCOPES = ["atom:read", "atom:write", "offline_access"] as const;
export type OAuthScope = typeof OAUTH_SCOPES[number];

export interface OAuthClientRow {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  allowed_namespaces: string[];
}

export interface AuthorizationCodeRow {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scopes: string[];
  resource: string;
  expires_at: Date;
  used_at: Date | null;
  allowed_namespaces: string[];
}

export interface TokenRow {
  client_id: string;
  scopes: string[];
  resource: string;
  expires_at: Date;
  revoked_at: Date | null;
  allowed_namespaces: string[];
}

export interface OAuthPrincipal {
  clientID: string;
  scopes: Set<string>;
  allowedNamespaces: string[];
}

export interface AuthorizationRequest {
  responseType: string;
  clientID: string;
  redirectURI: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
  state: string;
  resource: string;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function htmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function formValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function redirectWithError(redirectURI: string, error: string, description: string, state: string): string {
  const url = new URL(redirectURI);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", description);
  if (state) url.searchParams.set("state", state);
  return url.toString();
}

export function isAllowedRedirectURI(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

export function normalizeScopes(value: string | undefined): OAuthScope[] {
  const requested = (value?.trim() || "atom:read offline_access").split(/\s+/).filter(Boolean);
  if (requested.some(scope => !OAUTH_SCOPES.includes(scope as OAuthScope))) {
    throw new Error("Unsupported OAuth scope");
  }
  const scopes = new Set<OAuthScope>(requested as OAuthScope[]);
  if (scopes.has("atom:write")) scopes.add("atom:read");
  return OAUTH_SCOPES.filter(scope => scopes.has(scope));
}

export function verifyPKCE(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const actual = createHash("sha256").update(verifier, "ascii").digest("base64url");
  return secureTokenEqual(challenge, actual);
}

