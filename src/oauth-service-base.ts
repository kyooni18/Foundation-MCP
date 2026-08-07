import type { Config } from "./config.js";
import type { Database } from "./db.js";
import { normalizeNamespacePatterns, sha256 } from "./utils.js";
import {
  OAUTH_SCOPES,
  isAllowedRedirectURI,
  normalizeScopes,
  randomToken,
  type AuthorizationRequest,
  type OAuthClientRow,
  type OAuthScope
} from "./oauth-core.js";

export class OAuthServiceBase {
  readonly issuer: string;
  readonly resource: string;
  readonly protectedResourceMetadataURL: string;

  constructor(readonly config: Config, readonly database: Database) {
    if (!config.publicBaseURL) throw new Error("OAuth requires PUBLIC_BASE_URL");
    this.issuer = config.publicBaseURL;
    this.resource = `${config.publicBaseURL}${config.mcpPath}`;
    this.protectedResourceMetadataURL = `${config.publicBaseURL}/.well-known/oauth-protected-resource`;
  }

  authorizationServerMetadata(): Record<string, unknown> {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/authorize`,
      token_endpoint: `${this.issuer}/token`,
      registration_endpoint: this.config.oauthAllowRegistration ? `${this.issuer}/register` : undefined,
      revocation_endpoint: `${this.issuer}/revoke`,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: [...OAUTH_SCOPES]
    };
  }

  protectedResourceMetadata(): Record<string, unknown> {
    return {
      resource: this.resource,
      authorization_servers: [this.issuer],
      scopes_supported: [...OAUTH_SCOPES],
      bearer_methods_supported: ["header"]
    };
  }

  async registerClient(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.config.oauthAllowRegistration) throw new Error("Dynamic client registration is disabled");
    const redirectURIs = Array.isArray(body.redirect_uris)
      ? [...new Set(body.redirect_uris.filter((value): value is string => typeof value === "string"))]
      : [];
    if (redirectURIs.length < 1 || redirectURIs.length > 10 || redirectURIs.some(uri => uri.length > 2_048 || !isAllowedRedirectURI(uri))) {
      throw new Error("redirect_uris must contain 1-10 valid HTTPS or loopback HTTP URIs");
    }
    const grantTypes = Array.isArray(body.grant_types) ? body.grant_types : ["authorization_code", "refresh_token"];
    const responseTypes = Array.isArray(body.response_types) ? body.response_types : ["code"];
    const authMethod = typeof body.token_endpoint_auth_method === "string" ? body.token_endpoint_auth_method : "none";
    if (!grantTypes.every(value => value === "authorization_code" || value === "refresh_token")) throw new Error("Unsupported grant type");
    if (!responseTypes.every(value => value === "code")) throw new Error("Unsupported response type");
    if (authMethod !== "none") throw new Error("Only public clients with token_endpoint_auth_method=none are supported");

    const clientID = `foundation-${randomToken(18)}`;
    const clientName = typeof body.client_name === "string" && body.client_name.trim()
      ? body.client_name.trim().slice(0, 200)
      : "MCP client";
    const allowedNamespaces = normalizeNamespacePatterns(this.config.oauthDefaultNamespaces);
    await this.database.query(
      `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, grant_types, response_types, token_endpoint_auth_method, allowed_namespaces)
       VALUES ($1, $2, $3, $4, $5, 'none', $6)`,
      [clientID, clientName, redirectURIs, grantTypes, responseTypes, allowedNamespaces]
    );
    return {
      client_id: clientID,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: clientName,
      redirect_uris: redirectURIs,
      grant_types: grantTypes,
      response_types: responseTypes,
      token_endpoint_auth_method: "none"
    };
  }

  async validateAuthorizationRequest(input: AuthorizationRequest): Promise<{ client: OAuthClientRow; scopes: OAuthScope[] }> {
    if (input.responseType !== "code") throw new Error("response_type must be code");
    if (!input.clientID || !input.redirectURI || !input.codeChallenge) throw new Error("Missing required authorization parameter");
    if (input.codeChallengeMethod !== "S256") throw new Error("code_challenge_method must be S256");
    if (input.resource !== this.resource) throw new Error("Invalid resource parameter");
    const result = await this.database.query<OAuthClientRow>(
      "SELECT client_id, client_name, redirect_uris, allowed_namespaces FROM oauth_clients WHERE client_id = $1",
      [input.clientID]
    );
    const client = result.rows[0];
    if (!client) throw new Error("Unknown OAuth client");
    if (!client.redirect_uris.includes(input.redirectURI)) throw new Error("redirect_uri is not registered");
    return { client, scopes: normalizeScopes(input.scope) };
  }

  async issueAuthorizationCode(input: AuthorizationRequest, scopes: OAuthScope[]): Promise<string> {
    const code = randomToken(32);
    const client = await this.database.query<{ allowed_namespaces: string[] }>(
      "SELECT allowed_namespaces FROM oauth_clients WHERE client_id=$1",
      [input.clientID]
    );
    const allowedNamespaces = client.rows[0]?.allowed_namespaces ?? this.config.oauthDefaultNamespaces;
    await this.database.query(
      `INSERT INTO oauth_authorization_codes
       (code_hash, client_id, redirect_uri, code_challenge, scopes, resource, expires_at, allowed_namespaces)
       VALUES ($1, $2, $3, $4, $5, $6, NOW() + INTERVAL '5 minutes', $7)`,
      [sha256(code), input.clientID, input.redirectURI, input.codeChallenge, scopes, input.resource, allowedNamespaces]
    );
    return code;
  }
}
