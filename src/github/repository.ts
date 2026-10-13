export interface RepositoryCoordinates {
  fullName: string;
  owner: string;
  repo: string;
}

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

export function parseRepository(value: string): RepositoryCoordinates {
  const normalized = value.trim();
  if (!REPOSITORY_PATTERN.test(normalized)) {
    throw new ConnectorInputError("Repository must use the owner/name format");
  }
  const [owner, repo] = normalized.split("/");
  if (!owner || !repo) throw new ConnectorInputError("Repository must use the owner/name format");
  return { fullName: `${owner}/${repo}`, owner, repo };
}

export function validateCodeSearchQuery(query: string): string {
  const normalized = query.trim();
  if (!normalized) throw new ConnectorInputError("Search query cannot be empty");
  if (/(?:^|\s)(?:repo|org|user):/iu.test(normalized)) {
    throw new ConnectorInputError(
      "Repository, organization, and user qualifiers are managed by the connector",
    );
  }
  return normalized;
}
import { ConnectorInputError } from "./errors";
