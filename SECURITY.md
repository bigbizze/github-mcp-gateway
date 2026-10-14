# Security policy

Report security problems privately through GitHub: open this repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue for a security problem.

Include the commit you tested, the steps to reproduce the problem, and what an attacker could do with it.

Problems in scope include:

- Reading a repository that the GitHub App installation does not cover
- Connecting with a GitHub account that is not in `AUTHORIZED_GITHUB_LOGINS`
- Getting an MCP access token for a client that the user did not approve on the consent page
- Forging, replaying, or reusing continuation tokens or artifact links outside their intended scope
- Leaking GitHub App credentials, installation tokens, or OAuth tokens in responses or logs
- Any write to GitHub through this server

Problems in a deployment's own configuration, such as a weak `COOKIE_ENCRYPTION_KEY` or an overly broad installation, are outside the scope of this policy.
