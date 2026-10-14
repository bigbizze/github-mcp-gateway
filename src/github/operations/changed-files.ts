import { githubStatus, invalidArguments } from "../../errors";
import { type JsonRecord, numberValue, record, stringValue } from "../json";
import { type ApiResponse, hasNextPage, type RepositoryClient } from "../session";
import type { OperationContext } from "./context";
import { inlineText, type TextSource } from "./text-references";

/** One page of GitHub's changed-file list for a commit or a pull request. */
export interface ChangedFilesPage {
  files: JsonRecord[];
  response: ApiResponse;
}

export function changedFileSummary(file: JsonRecord) {
  return {
    additions: numberValue(file.additions),
    blob_sha: stringValue(file.sha),
    changes: numberValue(file.changes),
    deletions: numberValue(file.deletions),
    path: stringValue(file.filename),
    previous_path: stringValue(file.previous_filename),
    status: stringValue(file.status),
    url: stringValue(file.blob_url),
  };
}

/** Walks changed-file pages until it finds `path`, within the request budget. */
export async function findChangedFile<T extends ChangedFilesPage>(
  context: OperationContext,
  path: string,
  loadPage: (page: number) => Promise<T>,
  notFoundMessage: string,
): Promise<{ file: JsonRecord; page: T }> {
  for (let pageNumber = 1; context.session.remainingRequests > 0; pageNumber += 1) {
    const page = await loadPage(pageNumber);
    const file = page.files.find((candidate) => stringValue(candidate.filename) === path);
    if (file) return { file, page };
    if (!hasNextPage(page.response)) break;
  }
  throw invalidArguments(notFoundMessage);
}

async function fileTypeAt(repository: RepositoryClient, ref: string | null, path: string): Promise<string> {
  if (!ref) return "unknown";
  try {
    const response = await repository.request("GET /repos/{owner}/{repo}/contents/{path}", { path, ref });
    if (Array.isArray(response.data)) return "directory";
    const data = record(response.data);
    if (stringValue(data.submodule_git_url)) return "submodule";
    const type = stringValue(data.type);
    return type === "file" || type === "symlink" || type === "submodule" ? type : "unknown";
  } catch (error) {
    if (githubStatus(error) === 404) return "unknown";
    throw error;
  }
}

export type PinnedCommit = { type: "empty" } | { commit_sha: string | null; repository_full_name: string | null; type: "commit" };

/** The patch result shared by commit and pull request patches. */
export async function patchResult(
  context: OperationContext,
  repository: RepositoryClient,
  file: JsonRecord,
  path: string,
  base: PinnedCommit,
  target: PinnedCommit & { type: "commit" },
  textSource: TextSource,
) {
  const status = stringValue(file.status);
  const removed = status === "removed";
  const previousPath = stringValue(file.previous_filename);
  const fileType = await fileTypeAt(
    repository,
    removed ? (base.type === "commit" ? base.commit_sha : null) : target.commit_sha,
    removed ? previousPath ?? path : path,
  );
  const patch = stringValue(file.patch);
  return {
    base,
    blob_sha: stringValue(file.sha),
    completeness: "unverified" as const,
    file_type: fileType,
    path,
    previous_path: previousPath,
    repository_full_name: repository.fullName,
    source: "github" as const,
    status,
    target,
    ...(patch
      ? { patch: await inlineText(context, textSource, patch) }
      : { patch: null, patch_availability: "omitted_by_github" as const }),
  };
}
