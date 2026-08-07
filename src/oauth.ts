import type { Request, Response, Router } from "express";
import express from "express";
import { secureTokenEqual } from "./utils.js";
import {
  formValue,
  htmlEscape,
  redirectWithError,
  type AuthorizationRequest,
  type OAuthScope
} from "./oauth-core.js";
import { OAuthService } from "./oauth-service.js";

export { OAuthService } from "./oauth-service.js";
export { isAllowedRedirectURI, normalizeScopes, verifyPKCE } from "./oauth-core.js";

function authorizationInput(source: Record<string, unknown>): AuthorizationRequest {
  return {
    responseType: formValue(source.response_type),
    clientID: formValue(source.client_id),
    redirectURI: formValue(source.redirect_uri),
    codeChallenge: formValue(source.code_challenge),
    codeChallengeMethod: formValue(source.code_challenge_method),
    scope: formValue(source.scope),
    state: formValue(source.state),
    resource: formValue(source.resource)
  };
}

function authorizationPage(input: AuthorizationRequest, clientName: string, scopes: OAuthScope[], allowedNamespaces: string[], error = ""): string {
  const hidden = Object.entries({
    response_type: input.responseType,
    client_id: input.clientID,
    redirect_uri: input.redirectURI,
    code_challenge: input.codeChallenge,
    code_challenge_method: input.codeChallengeMethod,
    scope: scopes.join(" "),
    state: input.state,
    resource: input.resource
  }).map(([name, value]) => `<input type="hidden" name="${name}" value="${htmlEscape(value)}">`).join("\n");
  const scopeLabels: Record<OAuthScope, string> = {
    "atom:read": "Search and read Foundation atoms",
    "atom:write": "Create, update, link, merge, archive, and delete atoms",
    "offline_access": "Stay connected using refresh tokens"
  };
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize Foundation</title><style>
body{font-family:ui-sans-serif,system-ui,sans-serif;background:#f5f5f5;color:#171717;margin:0;display:grid;place-items:center;min-height:100vh}.card{background:white;border:1px solid #ddd;border-radius:16px;padding:28px;width:min(440px,calc(100vw - 40px));box-shadow:0 12px 40px #0001}h1{margin:0 0 8px;font-size:24px}p{line-height:1.5}.scopes{padding-left:20px}.error{color:#b42318;background:#fee4e2;padding:10px;border-radius:8px}input[type=password]{width:100%;box-sizing:border-box;padding:12px;border:1px solid #bbb;border-radius:9px;margin:8px 0 16px}.actions{display:flex;gap:10px}.actions button{flex:1;padding:11px;border-radius:9px;border:0;font-weight:650;cursor:pointer}.approve{background:#111;color:#fff}.deny{background:#eee;color:#222}</style></head>
<body><main class="card"><h1>Authorize Foundation</h1><p><strong>${htmlEscape(clientName)}</strong> is requesting access to your private memory server.</p>
${error ? `<p class="error">${htmlEscape(error)}</p>` : ""}<ul class="scopes">${scopes.map(scope => `<li>${htmlEscape(scopeLabels[scope])}</li>`).join("")}</ul>
<p><strong>Namespaces:</strong> ${allowedNamespaces.map(htmlEscape).join(", ")}</p>
<form method="post" action="/authorize">${hidden}<label for="password">Foundation approval password</label><input id="password" name="password" type="password" autocomplete="current-password" required>
<div class="actions"><button class="deny" name="decision" value="deny" formnovalidate>Deny</button><button class="approve" name="decision" value="approve">Approve</button></div></form></main></body></html>`;
}

export function createOAuthRouter(service: OAuthService): Router {
  const router = express.Router();
  const failedApprovals = new Map<string, { count: number; resetAt: number }>();
  router.use(express.urlencoded({ extended: false, limit: "32kb" }));

  const approvalClientKey = (req: Request): string => req.socket.remoteAddress ?? "unknown";
  const secureAuthorizationPage = (res: Response): void => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
  };

  router.get("/.well-known/oauth-protected-resource", (_req: Request, res: Response) => res.json(service.protectedResourceMetadata()));
  router.get(`/.well-known/oauth-protected-resource${service.config.mcpPath}`, (_req: Request, res: Response) => res.json(service.protectedResourceMetadata()));
  router.get("/.well-known/oauth-authorization-server", (_req: Request, res: Response) => res.json(service.authorizationServerMetadata()));

  router.post("/register", async (req: Request, res: Response) => {
    try {
      res.status(201).json(await service.registerClient(req.body as Record<string, unknown>));
    } catch (error) {
      res.status(400).json({ error: "invalid_client_metadata", error_description: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get("/authorize", async (req: Request, res: Response) => {
    const input = authorizationInput(req.query as Record<string, unknown>);
    try {
      const { client, scopes } = await service.validateAuthorizationRequest(input);
      secureAuthorizationPage(res);
      res.type("html").send(authorizationPage(input, client.client_name, scopes, client.allowed_namespaces));
    } catch (error) {
      res.status(400).type("text").send(error instanceof Error ? error.message : String(error));
    }
  });

  router.post("/authorize", async (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;
    const input = authorizationInput(body);
    try {
      const { client, scopes } = await service.validateAuthorizationRequest(input);
      if (formValue(body.decision) !== "approve") {
        res.redirect(redirectWithError(input.redirectURI, "access_denied", "The resource owner denied the request", input.state));
        return;
      }
      const password = formValue(body.password);
      const clientKey = approvalClientKey(req);
      const now = Date.now();
      const attempts = failedApprovals.get(clientKey);
      if (attempts && attempts.resetAt > now && attempts.count >= 10) {
        res.status(429).type("text").send("Too many failed approval attempts; try again later");
        return;
      }
      if (!service.config.oauthLoginPassword || !secureTokenEqual(service.config.oauthLoginPassword, password)) {
        const current = attempts && attempts.resetAt > now ? attempts : { count: 0, resetAt: now + 10 * 60_000 };
        failedApprovals.set(clientKey, { count: current.count + 1, resetAt: current.resetAt });
        secureAuthorizationPage(res);
        res.status(401).type("html").send(authorizationPage(input, client.client_name, scopes, client.allowed_namespaces, "Incorrect approval password"));
        return;
      }
      failedApprovals.delete(clientKey);
      const code = await service.issueAuthorizationCode(input, scopes);
      const target = new URL(input.redirectURI);
      target.searchParams.set("code", code);
      if (input.state) target.searchParams.set("state", input.state);
      res.redirect(target.toString());
    } catch (error) {
      res.status(400).type("text").send(error instanceof Error ? error.message : String(error));
    }
  });

  router.post("/token", async (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;
    try {
      const grantType = formValue(body.grant_type);
      const token = grantType === "authorization_code"
        ? await service.exchangeAuthorizationCode(body)
        : grantType === "refresh_token"
          ? await service.refreshTokens(body)
          : (() => { throw new Error("Unsupported grant_type"); })();
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Pragma", "no-cache");
      res.json(token);
    } catch (error) {
      res.status(400).json({ error: "invalid_grant", error_description: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post("/revoke", async (req: Request, res: Response) => {
    await service.revoke(formValue((req.body as Record<string, unknown>).token));
    res.status(200).end();
  });

  return router;
}
