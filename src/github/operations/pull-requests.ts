import { booleanValue, type JsonRecord, nested, numberValue, optionalNested, record, records, requiredNumber, stringValue, userLogin } from "../json";
import { validateSearchQuery } from "../repository";
import type { RepositoryClient } from "../session";
import { changedFileSummary, type ChangedFilesPage, findChangedFile, patchResult } from "./changed-files";
import { type OperationContext, type OperationHandlers, pagedCollection } from "./context";
import { listComments } from "./issues";
import { inlineText, textReference } from "./text-references";

export async function getPullRequestData(repository: RepositoryClient, prNumber: number): Promise<JsonRecord> {
  const response = await repository.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { pull_number: prNumber });
  return record(response.data);
}

async function pullRequestFilesPage(
  repository: RepositoryClient,
  prNumber: number,
  page: number,
  perPage: number,
): Promise<ChangedFilesPage> {
  const response = await repository.request("GET /repos/{owner}/{repo}/pulls/{pull_number}/files", {
    page,
    per_page: perPage,
    pull_number: prNumber,
  });
  return { files: records(response.data), response };
}

export async function findPullRequestFile(
  context: OperationContext,
  repository: RepositoryClient,
  prNumber: number,
  path: string,
): Promise<JsonRecord> {
  const { file } = await findChangedFile(
    context,
    path,
    (page) => pullRequestFilesPage(repository, prNumber, page, 20),
    "The path is not in the pull request changed-filename list",
  );
  return file;
}

function refDescriptor(side: JsonRecord) {
  return {
    commit_sha: stringValue(side.sha),
    ref: stringValue(side.ref),
    repository_full_name: stringValue(optionalNested(side, "repo")?.full_name),
  };
}

export const pullRequestOperations: OperationHandlers<
  | "search_prs"
  | "get_pr_info"
  | "list_pr_changed_filenames"
  | "fetch_pr_file_patch"
  | "list_pull_request_reviews"
  | "list_pull_request_comments"
> = {
  async search_prs(context, input) {
    const repository = await context.session.repository(input.repository_full_name);
    const paging = { page: input.page, per_page: input.per_page };
    let items: JsonRecord[];
    let response;
    if (input.query) {
      const qualifiers = [
        `repo:${repository.fullName}`,
        "is:pr",
        ...(input.state === "all" ? [] : [`is:${input.state}`]),
        ...(input.base ? [`base:${input.base}`] : []),
        ...(input.head ? [`head:${input.head}`] : []),
      ];
      response = await repository.api.request("GET /search/issues", {
        ...paging,
        q: `${validateSearchQuery(input.query)} ${qualifiers.join(" ")}`,
      });
      items = records(record(response.data).items);
    } else {
      response = await repository.request("GET /repos/{owner}/{repo}/pulls", {
        ...paging,
        state: input.state,
        ...(input.base ? { base: input.base } : {}),
        ...(input.head ? { head: input.head } : {}),
      });
      items = records(response.data);
    }
    const pullRequests = items.map((item) => ({
      author: userLogin(item.user),
      base: stringValue(optionalNested(item, "base")?.ref),
      created_at: stringValue(item.created_at),
      draft: booleanValue(item.draft),
      head: stringValue(optionalNested(item, "head")?.ref),
      pr_number: numberValue(item.number),
      state: stringValue(item.state),
      title: stringValue(item.title),
      updated_at: stringValue(item.updated_at),
      url: stringValue(item.html_url),
    }));
    return pagedCollection("search_prs", input, response, "pull_requests", pullRequests);
  },

  async get_pr_info(context, input) {
    const repository = await context.session.repository(input.repository_full_name);
    const data = await getPullRequestData(repository, input.pr_number);
    return {
      data: {
        additions: numberValue(data.additions),
        author: userLogin(data.user),
        base: refDescriptor(nested(data, "base")),
        body: await inlineText(
          context,
          { kind: "pr_body", pr_number: input.pr_number, repository_full_name: repository.fullName },
          stringValue(data.body),
        ),
        changed_files: numberValue(data.changed_files),
        commits: numberValue(data.commits),
        created_at: stringValue(data.created_at),
        deletions: numberValue(data.deletions),
        draft: booleanValue(data.draft),
        head: refDescriptor(nested(data, "head")),
        mergeable: typeof data.mergeable === "boolean" ? data.mergeable : null,
        merged: booleanValue(data.merged),
        pr_number: numberValue(data.number),
        state: stringValue(data.state),
        title: stringValue(data.title),
        updated_at: stringValue(data.updated_at),
        url: stringValue(data.html_url),
      },
    };
  },

  async list_pr_changed_filenames(context, input) {
    const repository = await context.session.repository(input.repository_full_name);
    const result = await pullRequestFilesPage(repository, input.pr_number, input.page, input.per_page);
    return pagedCollection(
      "list_pr_changed_filenames",
      input,
      result.response,
      "files",
      result.files.map(changedFileSummary),
      { pr_number: input.pr_number },
    );
  },

  async fetch_pr_file_patch(context, input) {
    const repository = await context.session.repository(input.repository_full_name);
    const [pullRequest, file] = await Promise.all([
      getPullRequestData(repository, input.pr_number),
      findPullRequestFile(context, repository, input.pr_number, input.path),
    ]);
    const side = (key: string) => {
      const { commit_sha, repository_full_name } = refDescriptor(nested(pullRequest, key));
      return { commit_sha, repository_full_name, type: "commit" as const };
    };
    const result = await patchResult(
      context,
      repository,
      file,
      input.path,
      side("base"),
      side("head"),
      { kind: "pr_patch", path: input.path, pr_number: input.pr_number, repository_full_name: repository.fullName },
    );
    return { data: { ...result, pr_number: input.pr_number } };
  },

  async list_pull_request_reviews(context, input) {
    const repository = await context.session.repository(input.repository_full_name);
    const response = await repository.request("GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
      page: input.page,
      per_page: input.per_page,
      pull_number: input.pr_number,
    });
    const reviews = await Promise.all(records(response.data).map(async (review) => {
      const reviewId = requiredNumber(review.id);
      return {
        author: userLogin(review.user),
        body_reference_token: await textReference(
          context,
          { kind: "pr_review", pr_number: input.pr_number, repository_full_name: repository.fullName, review_id: reviewId },
          stringValue(review.body) ?? "",
        ),
        commit_sha: stringValue(review.commit_id),
        review_id: reviewId,
        state: stringValue(review.state),
        submitted_at: stringValue(review.submitted_at),
        url: stringValue(review.html_url),
      };
    }));
    return pagedCollection("list_pull_request_reviews", input, response, "reviews", reviews, { pr_number: input.pr_number });
  },

  async list_pull_request_comments(context, input) {
    const { comments, response } = await listComments(context, input.repository_full_name, input.pr_number, input);
    return pagedCollection("list_pull_request_comments", input, response, "comments", comments, { pr_number: input.pr_number });
  },
};
