import { invalidArguments } from "../errors";

export interface RepositoryCoordinates {
  fullName: string;
  owner: string;
  repo: string;
}

const REPOSITORY_PATTERN = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/u;
const SCOPE_QUALIFIER = /(?:^|[^A-Za-z0-9_-])-?(?:repo|org|user):/iu;

export function parseRepository(value: string): RepositoryCoordinates {
  const [, owner, repo] = REPOSITORY_PATTERN.exec(value.trim()) ?? [];
  if (!owner || !repo) throw invalidArguments("Repository must use the owner/name format");
  return { fullName: `${owner}/${repo}`, owner, repo };
}

/** Rejects scope qualifiers, so a search stays inside the repository that the connector adds. */
export function validateSearchQuery(query: string): string {
  const normalized = query.trim();
  if (!normalized) throw invalidArguments("Search query cannot be empty");
  if (SCOPE_QUALIFIER.test(normalized)) {
    throw invalidArguments("Repository, organization, and user qualifiers are managed by the connector");
  }
  return normalized;
}
