import { invalidArguments } from "../../errors";
import { labelNames, type JsonRecord, numberValue, optionalRecords, record, records, requiredNumber, stringValue, userLogin } from "../json";
import { validateSearchQuery } from "../repository";
import { collection, exactNextRequest } from "../result";
import { type OperationContext, type OperationHandlers, pagedCollection, pagination } from "./context";
import { inlineText, textReference } from "./text-references";

function issueSummary(issue: JsonRecord) {
  return {
    assignees: optionalRecords(issue.assignees).map((assignee) => stringValue(assignee.login)),
    author: userLogin(issue.user),
    created_at: stringValue(issue.created_at),
    issue_number: numberValue(issue.number),
    labels: labelNames(issue.labels),
    state: stringValue(issue.state),
    title: stringValue(issue.title),
    updated_at: stringValue(issue.updated_at),
    url: stringValue(issue.html_url),
  };
}

/** Issue and pull request conversation comments use the same GitHub endpoint. */
export async function listComments(
  context: OperationContext,
  repositoryName: string,
  issueNumber: number,
  paging: { page: number; per_page: number },
) {
  const repository = await context.session.repository(repositoryName);
  const response = await repository.request("GET /repos/{owner}/{repo}/issues/{issue_number}/comments", {
    issue_number: issueNumber,
    page: paging.page,
    per_page: paging.per_page,
  });
  const comments = await Promise.all(records(response.data).map(async (comment) => {
    const commentId = requiredNumber(comment.id);
    return {
      author: userLogin(comment.user),
      body_reference_token: await textReference(
        context,
        { comment_id: commentId, kind: "issue_comment", repository_full_name: repository.fullName },
        stringValue(comment.body) ?? "",
      ),
      comment_id: commentId,
      created_at: stringValue(comment.created_at),
      updated_at: stringValue(comment.updated_at),
      url: stringValue(comment.html_url),
    };
  }));
  return { comments, response };
}

export const issueOperations: OperationHandlers<"search_issues" | "fetch_issue" | "list_issue_comments"> = {
  async search_issues(context, input) {
    const repository = await context.session.repository(input.repository_full_name);
    const paging = { page: input.page, per_page: input.per_page };
    let sourceItems: JsonRecord[];
    let response;
    if (input.query) {
      const labels = input.labels?.split(",").map((label) => label.trim()).filter(Boolean) ?? [];
      const qualifiers = [
        `repo:${repository.fullName}`,
        "is:issue",
        ...(input.state === "all" ? [] : [`is:${input.state}`]),
        ...(input.assignee ? [`assignee:${input.assignee}`] : []),
        ...labels.map((label) => `label:${JSON.stringify(label)}`),
        ...(input.since ? [`updated:>=${input.since}`] : []),
      ];
      response = await repository.api.request("GET /search/issues", {
        ...paging,
        q: `${validateSearchQuery(input.query)} ${qualifiers.join(" ")}`,
      });
      sourceItems = records(record(response.data).items);
    } else {
      response = await repository.request("GET /repos/{owner}/{repo}/issues", {
        ...paging,
        state: input.state,
        ...(input.assignee ? { assignee: input.assignee } : {}),
        ...(input.labels ? { labels: input.labels } : {}),
        ...(input.since ? { since: input.since } : {}),
      });
      sourceItems = records(response.data);
    }
    const issues = sourceItems.filter((issue) => issue.pull_request === undefined).map(issueSummary);
    const page = pagination(input.page, input.per_page, sourceItems.length, response);
    const hasNext = page.has_next;
    const state = !hasNext ? "complete" : issues.length === 0 ? "seeking" : "partial";
    return {
      data: collection(
        { pagination: page, state },
        "issues",
        issues,
        hasNext ? exactNextRequest("search_issues", { ...input, page: input.page + 1 }) : undefined,
      ),
    };
  },

  async fetch_issue(context, input) {
    const repository = await context.session.repository(input.repository_full_name);
    const response = await repository.request("GET /repos/{owner}/{repo}/issues/{issue_number}", {
      issue_number: input.issue_number,
    });
    const issue = record(response.data);
    if (issue.pull_request !== undefined) throw invalidArguments("This number is a pull request. Use get_pr_info");
    return {
      data: {
        ...issueSummary(issue),
        body: await inlineText(
          context,
          { issue_number: input.issue_number, kind: "issue_body", repository_full_name: repository.fullName },
          stringValue(issue.body),
        ),
      },
    };
  },

  async list_issue_comments(context, input) {
    const { comments, response } = await listComments(context, input.repository_full_name, input.issue_number, input);
    return pagedCollection("list_issue_comments", input, response, "comments", comments, { issue_number: input.issue_number });
  },
};
