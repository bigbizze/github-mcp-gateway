# GitHub MCP Gateway

A read-only GitHub [MCP](https://modelcontextprotocol.io) server that you deploy to your own Cloudflare account. It can read only the repositories where you install your GitHub App, and only the GitHub accounts you list can connect to it.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/bigbizze/github-mcp-gateway)

- One MCP tool, `github`, with 32 read operations covering repositories, branches, files, code search, commits, pull requests, reviews, issues, comments, Actions runs and artifacts, and organization members.
- No write operations. The GitHub App gets read permissions only.
- Every response has a fixed size limit. Long files and lists come back in pages, each with the exact request for the next page.
- Works with MCP clients that support remote servers with OAuth sign-in, such as Claude, Claude Code, Cursor, and VS Code.
- Runs on the Cloudflare Workers Free plan.

## Setup

You need a Cloudflare account and a GitHub account. Steps 1 to 3 collect the values that the deploy form in step 4 asks for. To deploy from your own machine with Wrangler instead of the deploy button, follow [docs/setup.md](docs/setup.md).

### 1. Work out the Worker's address

The Worker is named `github-mcp` by default, so its address is:

```text
https://github-mcp.<your-subdomain>.workers.dev
```

Your `workers.dev` subdomain is shown on the **Workers & Pages** page of the Cloudflare dashboard. If you give the Worker a different name in step 4, use that name here.

### 2. Create a GitHub App

The links below create a private app. A private app can be installed only on the account that owns it, so create it under the account whose repositories the server should read. If other people will sign in, create it under an organization they belong to: only members of the owning organization can sign in to an organization's private app.

Open the GitHub App form with this project's settings filled in:

- [For your personal account](https://github.com/settings/apps/new?description=Read-only%20MCP%20server%20for%20GitHub&url=https%3A%2F%2Fgithub.com%2Fbigbizze%2Fgithub-mcp-gateway&callback_urls%5B%5D=https%3A%2F%2Fgithub-mcp.YOUR-SUBDOMAIN.workers.dev%2Fcallback&public=false&request_oauth_on_install=false&webhook_active=false&actions=read&contents=read&issues=read&metadata=read&pull_requests=read&statuses=read&members=read)
- [For an organization](https://github.com/organizations/YOUR-ORG/settings/apps/new?description=Read-only%20MCP%20server%20for%20GitHub&url=https%3A%2F%2Fgithub.com%2Fbigbizze%2Fgithub-mcp-gateway&callback_urls%5B%5D=https%3A%2F%2Fgithub-mcp.YOUR-SUBDOMAIN.workers.dev%2Fcallback&public=false&request_oauth_on_install=false&webhook_active=false&actions=read&contents=read&issues=read&metadata=read&pull_requests=read&statuses=read&members=read): replace `YOUR-ORG` in the address bar with the organization's name.

On the form:

1. Enter a **GitHub App name**. It must not already be in use on GitHub.
2. In **Callback URL**, replace `YOUR-SUBDOMAIN` with your subdomain from step 1. If you chose a different Worker name, replace `github-mcp` as well.
3. Leave **Expire user authorization tokens** checked and **Request user authorization (OAuth) during installation** unchecked.
4. Check that webhooks are off and that every permission is read-only: Actions, Commit statuses, Contents, Issues, Metadata, and Pull requests under **Repository permissions**, and Members under **Organization permissions**.
5. Click **Create GitHub App**.

On the new app's settings page:

1. Copy the **App ID** and the **Client ID**.
2. Under **Client secrets**, click **Generate a new client secret** and copy it.
3. Under **Private keys**, click **Generate a private key**. Your browser downloads a `.pem` file.
4. Click **Install App** and choose the repositories this server may read. The installation is the server's only repository access list.

### 3. Generate two random keys

Run this twice and keep both results:

```sh
openssl rand -hex 32
```

If you don't have a terminal, paste this into your browser's developer console instead, once for each key:

```js
crypto.getRandomValues(new Uint8Array(32)).reduce((hex, byte) => hex + byte.toString(16).padStart(2, "0"), "")
```

### 4. Deploy

Click **Deploy to Cloudflare** at the top of this page. Cloudflare copies this repository into your GitHub account, creates the KV namespace that stores OAuth grants, and asks for these secrets:

| Secret | Value |
| --- | --- |
| `AUTHORIZED_GITHUB_LOGINS` | Your GitHub username. Separate several usernames with commas. |
| `GITHUB_APP_ID` | The App ID from step 2 |
| `GITHUB_CLIENT_ID` | The Client ID from step 2 |
| `GITHUB_CLIENT_SECRET` | The client secret from step 2 |
| `GITHUB_APP_PRIVATE_KEY` | The whole `.pem` file from step 2, including the `BEGIN` and `END` lines |
| `COOKIE_ENCRYPTION_KEY` | The first key from step 3 |
| `REFERENCE_TOKEN_KEY` | The second key from step 3 |

Paste the private key exactly as GitHub provides it. If the form removes the line breaks, the Worker restores them, and it converts GitHub's PKCS#1 key format to the PKCS#8 format that its signing library requires on Workers. Delete the downloaded `.pem` file after the deploy; you can generate a new key in the app's settings if you need one later.

Deployment stops if any of the seven secrets is missing, and the build log lists which ones. If that happens, add them under **Settings → Variables and Secrets** on the Worker's page in the Cloudflare dashboard, then retry the build.

### 5. Connect a client

The MCP endpoint is:

```text
https://github-mcp.<your-subdomain>.workers.dev/mcp
```

The first connection opens an approval page on the Worker. It shows the client's name and the address that will receive the access token. After you approve, you sign in with GitHub, and the Worker checks your username against `AUTHORIZED_GITHUB_LOGINS`. The browser remembers the approval for 30 days for that client and address.

- **Claude** (web, desktop, and mobile): go to **Customize → Connectors**, click **+ Add → Add custom connector**, and enter a name and the endpoint. On Team and Enterprise plans, an owner adds the connector under **Organization settings → Connectors** first.
- **Claude Code**: run `claude mcp add --transport http github https://github-mcp.<your-subdomain>.workers.dev/mcp`, then run `/mcp` inside Claude Code to sign in.
- **Other clients**: add the endpoint as a remote (HTTP) MCP server. A client that can only start local commands can use [`mcp-remote`](https://www.npmjs.com/package/mcp-remote): `npx mcp-remote https://github-mcp.<your-subdomain>.workers.dev/mcp`.

To check that the Worker is running, open `/health` on the Worker's address. It returns `{"status":"ok"}`. If connecting fails, see [Troubleshooting](docs/setup.md#troubleshooting).

## How access works

Three separate checks decide what a client can read:

1. **Which client gets a token.** MCP clients register themselves, so the Worker asks you to approve each client and redirect address before it starts a sign-in. Without this step, a page that a signed-in user visits could start a sign-in for a client that the attacker controls. GitHub skips its own prompt after the first approval, so it does not give this protection.
2. **Who can connect.** Sign-in uses GitHub's user authorization for your GitHub App. The Worker uses the resulting user token once, to look up the GitHub username, and then discards it. Only usernames in `AUTHORIZED_GITHUB_LOGINS` receive an MCP access token, and the Worker checks the list again on every request.
3. **What can be read.** Every GitHub read uses a short-lived installation token for your GitHub App, so the server can read exactly the repositories in the app's installation. The Worker keeps no second repository list.

Continuation tokens are bound to the GitHub user ID of the person who signed in. The server has no write operations.

To change access later:

- Add or remove repositories in the GitHub App's installation settings.
- Change who can connect by updating the `AUTHORIZED_GITHUB_LOGINS` secret. A removed username is refused on its next request, even if its client still holds a token.
- Remove all repository access by uninstalling the GitHub App.
- Rotate the app's private key and client secret in its settings, then update the matching Worker secrets.

## Using the `github` tool

The tool takes one of three actions. Agents should call `execute` directly when they know the operation and its arguments:

```json
{"action":"execute","operation":"list_pull_request_comments","arguments":{"repository_full_name":"owner/repo","pr_number":42}}
```

`search` finds operations by keyword. It returns 8 concise signatures by default and at most 20:

```json
{"action":"search","query":"pull request comments"}
```

`describe` returns the full input and result schemas for one operation. Use it only when a signature is not enough:

```json
{"action":"describe","operation":"list_pull_request_comments"}
```

The server never requires `search` or `describe` before `execute`. Operation names, arguments, and results use `snake_case`. A successful call returns:

```json
{"ok":true,"operation":"fetch_file","data":{}}
```

A failed call sets MCP `isError` and returns a JSON error object with a `code` such as `not_found`, `forbidden`, `invalid_arguments`, `rate_limited`, or `range_too_large`, a `message`, a `request_id`, and a `retryable` flag. When a GitHub request fails, the message is a fixed description of the failure, not GitHub's response text.

## Limits and paging

- A complete result is at most 20,000 UTF-8 bytes, and inline text is at most 16,000 bytes. The server never substitutes a truncated preview.
- A file read without an end line returns `state: "partial"` and an exact `next_request` when more text remains. A line range that is too large returns `range_too_large`, and a single line over 16,000 bytes returns `line_too_large`.
- Long text (issue and pull request bodies, comments, review bodies, commit messages, and patches) is read with the `read_text` operation and a `reference_token`. Comment and review lists return metadata and tokens instead of every body.
- Standard lists return at most 20 items per page, comment and review lists at most 10, and directory listings at most 50 entries.
- The server stops a tool call after 20 GitHub requests. The GitHub client library can repeat a request after a server error or a rate-limit response, and those repeats are not counted. File reads scan at most 64 KiB at a time.
- Files of 1 MiB or less are read through the GitHub Contents API. Larger files, and small files whose inline content GitHub omits, are read in byte ranges from GitHub's signed download URL. Files over 100 MiB return metadata only, with `content_available: false`. Those range requests use a direct TLS connection to `raw.githubusercontent.com`, because a Worker's `fetch` asks GitHub for a compressed response even when told not to, and compression breaks byte ranges. The installation token is never sent to the download URL.
- Workflow job logs are not supported.

### Reading by URL

The `fetch` operation maps a GitHub URL to one of the read operations above. It accepts these HTTPS URL forms:

- `github.com`: a repository, its issue list, an issue, a pull request, a commit, a branch (`/tree/<branch>`, for branch names without a slash), a file (`/blob/<ref>/<path>`), or a workflow run
- `api.github.com/repos/<owner>/<repo>`: the repository, `contents` (the root directory) or `contents/<path>` (a file), `issues` or `issues/<number>`, `pulls/<number>`, `commits/<sha>`, `branches/<branch>`, or `actions/runs/<id>`
- `raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>`: a file

For other directories, call `list_directory`. `fetch` rejects user information, custom ports, URL fragments, path traversal, encoded separators, and unsupported query parameters. Query values, such as `per_page` on an issue list, must meet the same limits as a direct call.

`fetch` is the only operation that can fall back to an unauthenticated read of a public resource outside the installation. Only the first page of such a read is available, because each `next_request` uses the GitHub App's installation. GitHub allows 60 unauthenticated requests per hour per source IP, and that limit is shared by every request from the same IP.

### Workflow artifacts

`download_workflow_artifact` returns metadata and an MCP `resource_link` to the complete ZIP file. Not every MCP client fetches resource links automatically.

The link expires after five minutes. Until then, anyone who has the link can download the artifact without signing in, so keep it out of logs, tickets, chat messages, and analytics. The artifact route accepts only `GET` and `HEAD`, and it responds with `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, and `X-Content-Type-Options: nosniff`. Cloudflare invocation logs are turned off in `wrangler.jsonc` because artifact request URLs contain the link token. The Worker's own logs record only the operation, status, request ID, and error category.

Continuation tokens and artifact links are encrypted with AES-256-GCM under `REFERENCE_TOKEN_KEY`. Each token's purpose and operation are bound as additional authenticated data, so a token issued for one operation cannot be used with another. Changing the key invalidates all outstanding tokens and links.

## GitHub App permissions

The app needs these read-only permissions and no webhooks:

- Repository: Actions, Commit statuses, Contents, Issues, Metadata, Pull requests
- Organization: Members

Every REST request specifies GitHub API version `2026-03-10`.

## Development

Requirements: Node 22 or newer and Yarn 1.22.

```sh
yarn install
yarn type-check
yarn lint
yarn test
yarn build
```

Tests use fake identities and mocked GitHub services. To run the Worker on your machine, see [Local development](docs/setup.md#local-development). [docs/future-patch-reconstruction.md](docs/future-patch-reconstruction.md) describes a possible design for rebuilding the patches that GitHub omits from commit and pull request responses.

## Security

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
