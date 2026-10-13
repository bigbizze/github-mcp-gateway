# Setup with Wrangler

This guide deploys the Worker from your own machine. The [README](../README.md#setup) covers the deploy button, which needs no local tools.

Requirements: Node 22 or newer, Yarn 1.22, and a Cloudflare account.

## 1. Clone and sign in to Cloudflare

```sh
git clone https://github.com/bigbizze/github-mcp-gateway.git
cd github-mcp-gateway
yarn install
yarn wrangler login
```

## 2. Choose the Worker's address

`name` in `wrangler.jsonc` sets the Worker name. The default is `github-mcp`, which gives this address:

```text
https://github-mcp.<your-subdomain>.workers.dev
```

Your `workers.dev` subdomain is shown on the **Workers & Pages** page of the Cloudflare dashboard.

To serve the Worker from your own domain, add a custom domain to it and use that host everywhere this guide uses the `workers.dev` address. The Worker builds its callback URL from the address it was reached on, so no code change is needed.

## 3. Create the GitHub App

Follow [step 2 of the README](../README.md#2-create-a-github-app). The callback URL is `https://<worker-host>/callback`.

## 4. Set the secrets

Run these in order. Each command asks for the value, except the private key, which is read from the file. If the Worker does not exist yet, the first command offers to create it.

```sh
yarn wrangler secret put AUTHORIZED_GITHUB_LOGINS
yarn wrangler secret put GITHUB_APP_ID
yarn wrangler secret put GITHUB_CLIENT_ID
yarn wrangler secret put GITHUB_CLIENT_SECRET
yarn wrangler secret put GITHUB_APP_PRIVATE_KEY < path/to/your-app.private-key.pem
yarn wrangler secret put COOKIE_ENCRYPTION_KEY
yarn wrangler secret put REFERENCE_TOKEN_KEY
```

| Secret | Rules |
| --- | --- |
| `AUTHORIZED_GITHUB_LOGINS` | Comma-separated GitHub usernames. Case and surrounding spaces are ignored. At least one is required. |
| `GITHUB_APP_ID` | The App ID from the app's settings page. |
| `GITHUB_CLIENT_ID` | The Client ID from the app's settings page. |
| `GITHUB_CLIENT_SECRET` | A client secret generated on the app's settings page. |
| `GITHUB_APP_PRIVATE_KEY` | The PEM private key, including the `BEGIN` and `END` lines. Line breaks can be kept, written as `\n`, or removed; the Worker restores them. GitHub's PKCS#1 key (`BEGIN RSA PRIVATE KEY`) is converted to PKCS#8 when the Worker reads it, so no `openssl` step is needed. |
| `COOKIE_ENCRYPTION_KEY` | At least 32 characters, for example from `openssl rand -hex 32`. It signs the cookie that ties the GitHub sign-in redirect to the browser that started it. Changing it only interrupts sign-ins in progress. |
| `REFERENCE_TOKEN_KEY` | Exactly 64 hexadecimal characters, from `openssl rand -hex 32`. It is the AES-256-GCM key for continuation tokens and artifact links. Changing it invalidates all outstanding tokens and links. |

Delete local copies of the private key once the secret is set.

## 5. Deploy

```sh
yarn deploy
```

On the first deploy, Wrangler creates the `OAUTH_KV` namespace and writes its ID into `wrangler.jsonc`. The deploy stops and lists the missing names if any secret from step 4 is not set.

## 6. Check the deployment

Open `https://<worker-host>/health`. It returns `{"status":"ok"}`.

Then connect the MCP Inspector:

```sh
npx @modelcontextprotocol/inspector@latest
```

Connect it to `https://<worker-host>/mcp` and complete the GitHub sign-in. Then:

1. Confirm that the server lists one tool, `github`.
2. Call `github` with `{"action":"execute","operation":"get_repository","arguments":{"repository_full_name":"owner/repo"}}` for a repository in the app's installation.
3. Read a file with `fetch_file`, and follow one `next_request` if the result includes it.

To connect your usual client, see [step 5 of the README](../README.md#5-connect-a-client).

## Local development

1. In the GitHub App's settings, add `http://localhost:8787/callback` as a second callback URL. A GitHub App can have up to ten.
2. Copy `.dev.vars.example` to `.dev.vars` and fill in the values. `.dev.vars` is gitignored. Only the names listed under `secrets.required` in `wrangler.jsonc` are loaded from it. For the private key, either wrap the whole multi-line key in double quotes or put it on one line with each line break written as `\n`; without quotes, only the first line of a multi-line value is read.
3. Run `yarn dev` and connect a client to `http://localhost:8787/mcp`.

The sign-in cookie is marked `Secure`. Chrome and Firefox accept it on `http://localhost`. If your browser rejects it, run `yarn dev --local-protocol https`, use `https://localhost:8787`, and add `https://localhost:8787/callback` to the app instead.

Run the checks before you push:

```sh
yarn type-check
yarn lint
yarn test
yarn build
```

`yarn build` bundles the Worker into `dist/` without deploying it.

## Troubleshooting

**GitHub says the `redirect_uri` is not associated with the application.** The callback URL in the GitHub App does not match the Worker's address. It must be exactly `https://<worker-host>/callback`.

**GitHub shows an error page instead of asking you to authorize the app.** `GITHUB_CLIENT_ID` is probably wrong. Copy it again from the app's settings page.

**"Unable to begin authorization"** (HTTP 400). Either a secret is missing or fails the rules in the table above (the Worker checks all seven before it starts a sign-in), or the MCP client's registration is unknown to this Worker, for example after the `OAUTH_KV` namespace was replaced. In the second case, remove the server from the client and add it again.

**"GitHub did not provide an authorization code"** (HTTP 400). The sign-in was cancelled on GitHub. Connect again.

**"This GitHub account is not authorized for this connector"** (HTTP 403). The GitHub username is not in `AUTHORIZED_GITHUB_LOGINS`. The Worker checks the list at sign-in and again on every request, so this also appears after a username is removed.

**"Unable to complete authorization"** (HTTP 400). The sign-in could not be finished. The usual causes are a wrong `GITHUB_CLIENT_SECRET`, or a sign-in that took longer than ten minutes or lost its cookie. Check the secret, then connect again.

**Tool calls return `installation_required`.** GitHub rejected the app's credentials. Check `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`.

**Every tool call returns `upstream_error`, but sign-in works.** GitHub may be unavailable; try again later. If the error continues, the private key may be damaged or incomplete. Generate a new key in the app's settings and set `GITHUB_APP_PRIVATE_KEY` again.

**Tool calls return `not_found` or `forbidden` for a repository.** The GitHub App is not installed on that repository, or it lacks the permission for that kind of resource. Add the repository in the app's installation settings.

**A client shows an old tool list after an update.** Disconnect and reconnect the client so it fetches the tool schema again.
