import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface AuthProps extends Record<string, unknown> {
  githubLogin: string;
  githubUserId: number;
}

export interface WorkerEnv {
  AUTHORIZED_GITHUB_LOGINS: string;
  COOKIE_ENCRYPTION_KEY: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  REFERENCE_TOKEN_KEY: string;
}

export interface GitHubAppConfig {
  appId: string;
  privateKey: string;
}
