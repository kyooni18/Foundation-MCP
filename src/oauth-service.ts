import { sha256 } from "./utils.js";
import {
  formValue,
  normalizeScopes,
  randomToken,
  verifyPKCE,
  type AuthorizationCodeRow,
  type OAuthPrincipal,
  type OAuthScope,
  type TokenRow
} from "./oauth-core.js";
import { OAuthServiceBase } from "./oauth-service-base.js";

export class OAuthService extends OAuthServiceBase {
  async exchangeAuthorizationCode(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const code = formValue(body.code);
    const clientID = formValue(body.client_id);
    const redirectURI = formValue(body.redirect_uri);
    const verifier = formValue(body.code_verifier);
    const resource = formValue(body.resource);
    if (!code || !clientID || !redirectURI || !verifier || !resource) throw new Error("Missing token request parameter");
    if (resource !== this.resource) throw new Error("Invalid resource parameter");

    return this.database.transaction(async client => {
      const result = await client.query<AuthorizationCodeRow>(
        `SELECT client_id, redirect_uri, code_challenge, scopes, resource, expires_at, used_at, allowed_namespaces
         FROM oauth_authorization_codes WHERE code_hash = $1 FOR UPDATE`,
        [sha256(code)]
      );
      const row = result.rows[0];
      if (!row || row.used_at || row.expires_at <= new Date()) throw new Error("Invalid or expired authorization code");
      if (row.client_id !== clientID || row.redirect_uri !== redirectURI || row.resource !== resource) throw new Error("Authorization code binding mismatch");
      if (!verifyPKCE(verifier, row.code_challenge)) throw new Error("PKCE verification failed");
      await client.query("UPDATE oauth_authorization_codes SET used_at = NOW() WHERE code_hash = $1", [sha256(code)]);
      return this.issueTokens(clientID, row.scopes as OAuthScope[], resource, row.allowed_namespaces, client);
    });
  }

  async refreshTokens(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const refreshToken = formValue(body.refresh_token);
    const clientID = formValue(body.client_id);
    const resource = formValue(body.resource);
    if (!refreshToken || !clientID || !resource) throw new Error("Missing refresh token parameter");
    if (resource !== this.resource) throw new Error("Invalid resource parameter");

    return this.database.transaction(async client => {
      const result = await client.query<TokenRow>(
        `SELECT client_id, scopes, resource, expires_at, revoked_at, allowed_namespaces
         FROM oauth_tokens WHERE token_hash = $1 AND token_type = 'refresh' FOR UPDATE`,
        [sha256(refreshToken)]
      );
      const row = result.rows[0];
      if (!row || row.revoked_at || row.expires_at <= new Date()) throw new Error("Invalid or expired refresh token");
      if (row.client_id !== clientID || row.resource !== resource) throw new Error("Refresh token binding mismatch");
      const requested = body.scope === undefined ? row.scopes as OAuthScope[] : normalizeScopes(formValue(body.scope));
      if (requested.some(scope => !row.scopes.includes(scope))) throw new Error("Requested scope exceeds original grant");
      await client.query("UPDATE oauth_tokens SET revoked_at = NOW() WHERE token_hash = $1", [sha256(refreshToken)]);
      return this.issueTokens(clientID, requested, resource, row.allowed_namespaces, client);
    });
  }

  async validateAccessToken(token: string): Promise<OAuthPrincipal | null> {
    if (!token) return null;
    const result = await this.database.query<TokenRow>(
      `SELECT client_id, scopes, resource, expires_at, revoked_at, allowed_namespaces
       FROM oauth_tokens WHERE token_hash = $1 AND token_type = 'access'`,
      [sha256(token)]
    );
    const row = result.rows[0];
    if (!row || row.revoked_at || row.expires_at <= new Date() || row.resource !== this.resource) return null;
    return { clientID: row.client_id, scopes: new Set(row.scopes), allowedNamespaces: row.allowed_namespaces ?? ["*"] };
  }

  async revoke(token: string): Promise<void> {
    if (!token) return;
    await this.database.query("UPDATE oauth_tokens SET revoked_at = NOW() WHERE token_hash = $1", [sha256(token)]);
  }

  private async issueTokens(
    clientID: string,
    scopes: OAuthScope[],
    resource: string,
    allowedNamespaces: string[],
    client: { query: (text: string, values?: unknown[]) => Promise<unknown> }
  ): Promise<Record<string, unknown>> {
    const accessToken = randomToken(32);
    const refreshToken = scopes.includes("offline_access") ? randomToken(48) : null;
    await client.query(
      `INSERT INTO oauth_tokens (token_hash, token_type, client_id, scopes, resource, expires_at, allowed_namespaces)
       VALUES ($1, 'access', $2, $3, $4, NOW() + ($5 * INTERVAL '1 second'), $6)`,
      [sha256(accessToken), clientID, scopes, resource, this.config.oauthAccessTokenTTLSeconds, allowedNamespaces]
    );
    if (refreshToken) {
      await client.query(
        `INSERT INTO oauth_tokens (token_hash, token_type, client_id, scopes, resource, expires_at, allowed_namespaces)
         VALUES ($1, 'refresh', $2, $3, $4, NOW() + ($5 * INTERVAL '1 second'), $6)`,
        [sha256(refreshToken), clientID, scopes, resource, this.config.oauthRefreshTokenTTLSeconds, allowedNamespaces]
      );
    }
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: this.config.oauthAccessTokenTTLSeconds,
      refresh_token: refreshToken ?? undefined,
      scope: scopes.join(" ")
    };
  }
}
