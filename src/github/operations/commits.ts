import { type JsonRecord, nested, numberValue, optionalRecords, optionalNested, record, records, requiredString, stringValue, userLogin } from "../json";
import { validateSearchQuery } from "../repository";
import type { RepositoryClient } from "../session";
import { changedFileSummary, type ChangedFilesPage, findChangedFile, type PinnedCommit, patchResult } from "./changed-files";
import { type OperationContext, type OperationHandlers, pagedCollection } from "./context";
import { inlineText, textReference } from "./text-references";

interface CommitFilesPage extends ChangedFilesPage {
  commit: JsonRecord;
}

async function commitFilesPage(
  repository: RepositoryClient,
  commitSha: string,
  page: number,
  perPage: number,
): Promise<CommitFilesPage> {
  const response = await repository.request("GET /repos/{owner}/{repo}/commits/{ref}", {
    page,
    per_page: perPage,
    ref: commitSha,
  });
  const commit = record(response.data);
  return { commit, files: optionalRecords(commit.files), response };
}

export function findCommitFile(context: OperationContext, repository: RepositoryClient, commitSha: string, path: string) {
  return findChangedFile(
    context,
    path,
    (page) => commitFilesPage(repository, commitSha, page, 20),
    "The path is not in the commit changed-filename list",
  ).then(({ file, page }) => ({ commit: page.commit, file }));
}

function commitAuthor(item: JsonRecord) {
  const author = optionalNested(nested(item, "commit"), "author");
  return { author: userLogin(item.author) ?? stringValue(author?.name), authored_at: stringValue(author?.date) };
}

export const commitOperations: OperationHandlers<
  "search_commits" | "fetch_commit" | "list_commit_changed_filenames" | "fetch_commit_file_patch" | "get_commit_combined_status"
> = {
  async search_commits(context, input) {
    const repository = await context.session.repository(input.repository_full_name);
    const paging = { page: input.page, per_page: input.per_page };
    const response = input.query
      ? await repository.api.request("GET /search/commits", {
          ...paging,
          q: `${validateSearchQuery(input.query)} repo:${repository.fullName}`,
        })
      : await repository.request("GET /repos/{owner}/{repo}/commits", {
          ...paging,
          ...(input.ref ? { sha: input.ref } : {}),
          ...(input.path ? { path: input.path } : {}),
          ...(input.since ? { since: input.since } : {}),
          ...(input.until ? { until: input.until } : {}),
        });
    const items = input.query ? records(record(response.data).items) : records(response.data);
    const commits = await Promise.all(items.map(async (item) => {
      const sha = requiredString(item.sha);
      const message = stringValue(nested(item, "commit").message) ?? "";
      return {
        ...commitAuthor(item),
        commit_sha: sha,
        message_first_line: message.split(/\r?\n/u, 1)[0] ?? "",
        message_reference_token: await textReference(
          context,
          { commit_sha: sha, kind: "commit_message", repository_full_name: repository.fullName },
          message,
        ),
        url: stringValue(item.html_url),
      };
    }));
    return pagedCollection("search_commits", input, response, "commits", commits);
  },

  async fetch_commit(context, input) {
    const repository = await context.session.repository(input.repository_full_name);
    const response = await repository.request("GET /repos/{owner}/{repo}/commits/{ref}", {
      per_page: 1,
      ref: input.commit_sha,
    });
    const data = record(response.data);
    const commit = nested(data, "commit");
    const sha = requiredString(data.sha);
    return {
      data: {
        ...commitAuthor(data),
        commit_sha: sha,
        message: await inlineText(
          context,
          { commit_sha: sha, kind: "commit_message", repository_full_name: repository.fullName },
          stringValue(commit.message),
        ),
        parents: optionalRecords(data.parents).map((parent) => stringValue(parent.sha)),
        repository_full_name: repository.fullName,
        stats: optionalNested(data, "stats"),
        tree_sha: stringValue(optionalNested(commit, "tree")?.sha),
        url: stringValue(data.html_url),
      },
    };
  },

  async list_commit_changed_filenames(context, input) {
    const repository = await context.session.repository(input.repository_full_name);
    const result = await commitFilesPage(repository, input.commit_sha, input.page, input.per_page);
    return pagedCollection(
      "list_commit_changed_filenames",
      input,
      result.response,
      "files",
      result.files.map(changedFileSummary),
      { commit_sha: stringValue(result.commit.sha) },
    );
  },

  async fetch_commit_file_patch(context, input) {
    const repository = await context.session.repository(input.repository_full_name);
    const { commit, file } = await findCommitFile(context, repository, input.commit_sha, input.path);
    const commitSha = requiredString(commit.sha);
    const parent = optionalRecords(commit.parents)[0];
    const base: PinnedCommit = parent === undefined
      ? { type: "empty" }
      : { commit_sha: stringValue(parent.sha), repository_full_name: repository.fullName, type: "commit" };
    const result = await patchResult(
      context,
      repository,
      file,
      input.path,
      base,
      { commit_sha: commitSha, repository_full_name: repository.fullName, type: "commit" },
      { commit_sha: commitSha, kind: "commit_patch", path: input.path, repository_full_name: repository.fullName },
    );
    return { data: { ...result, commit_sha: commitSha } };
  },

  async get_commit_combined_status(context, input) {
    const repository = await context.session.repository(input.repository_full_name);
    const response = await repository.request("GET /repos/{owner}/{repo}/commits/{ref}/status", {
      page: input.page,
      per_page: input.per_page,
      ref: input.ref,
    });
    const data = record(response.data);
    const statuses = records(data.statuses).map((status) => ({
      context: stringValue(status.context),
      created_at: stringValue(status.created_at),
      creator: userLogin(status.creator),
      description: stringValue(status.description),
      state: stringValue(status.state),
      target_url: stringValue(status.target_url),
      updated_at: stringValue(status.updated_at),
    }));
    return pagedCollection("get_commit_combined_status", input, response, "statuses", statuses, {
      commit_sha: stringValue(data.sha),
      repository_full_name: repository.fullName,
      state: stringValue(data.state),
      total_count: numberValue(data.total_count),
    });
  },
};
