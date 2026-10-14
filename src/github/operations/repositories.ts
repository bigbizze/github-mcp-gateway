import { z } from "zod";
import { invalidArguments } from "../../errors";
import type { TokenScope } from "../../security/reference-token";
import { booleanValue, type JsonRecord, nested, numberValue, optionalNested, record, records, stringValue } from "../json";
import { validateSearchQuery } from "../repository";
import { collection, exactNextRequest } from "../result";
import { hasNextPage } from "../session";
import { type OperationContext, type OperationHandlers, pagedCollection, requireSameArguments, SCAN_TTL_SECONDS } from "./context";

const cursorSchema = z.strictObject({
  installation_offset: z.number().int().min(0),
  installation_page: z.number().int().min(1),
  repository_offset: z.number().int().min(0),
  repository_page: z.number().int().min(1),
});

type ScanCursor = z.infer<typeof cursorSchema>;

const repositoryScanSchema = z.strictObject({
  cursor: cursorSchema,
  request: z.strictObject({ page_size: z.number().int(), query: z.string().nullable() }),
});

function repositorySummary(item: JsonRecord) {
  return {
    default_branch: stringValue(item.default_branch),
    full_name: stringValue(item.full_name),
    private: booleanValue(item.private),
    url: stringValue(item.html_url),
  };
}

/** Reserve for one installation token and one repository page, so the scan never stops mid-step. */
const REQUESTS_PER_INSTALLATION_STEP = 2;

/**
 * Scans the repositories of every installation in a fixed order and returns at most
 * `page_size` matches. The cursor names the next repository to examine.
 */
async function scanRepositories(
  context: OperationContext,
  operation: "list_repositories" | "search_repositories",
  input: { continuation_token?: string | undefined; page_size: number },
  query: string | null,
) {
  const scope: TokenScope = { operation, purpose: "repository_scan" };
  const request = { page_size: input.page_size, query };
  let cursor: ScanCursor = { installation_offset: 0, installation_page: 1, repository_offset: 0, repository_page: 1 };
  if (input.continuation_token) {
    const scan = await context.open(input.continuation_token, scope, repositoryScanSchema);
    requireSameArguments(scan.request, request);
    cursor = scan.cursor;
  }
  const app = await context.session.appClient();
  const selected: ReturnType<typeof repositorySummary>[] = [];
  let complete = false;

  scan: while (context.session.remainingRequests > REQUESTS_PER_INSTALLATION_STEP) {
    const installationsResponse = await app.request("GET /app/installations", {
      page: cursor.installation_page,
      per_page: 100,
    });
    const installations = records(installationsResponse.data);
    while (cursor.installation_offset < installations.length) {
      if (context.session.remainingRequests < REQUESTS_PER_INSTALLATION_STEP) break scan;
      const installationId = numberValue(installations[cursor.installation_offset]?.id);
      if (installationId === null) {
        cursor = { ...cursor, installation_offset: cursor.installation_offset + 1, repository_offset: 0, repository_page: 1 };
        continue;
      }
      const { client } = await context.session.installationClient(installationId);
      while (true) {
        const response = await client.request("GET /installation/repositories", {
          page: cursor.repository_page,
          per_page: 100,
        });
        const repositories = records(record(response.data).repositories);
        while (cursor.repository_offset < repositories.length) {
          const summary = repositorySummary(repositories[cursor.repository_offset] ?? {});
          cursor = { ...cursor, repository_offset: cursor.repository_offset + 1 };
          if (!query || summary.full_name?.toLowerCase().includes(query)) selected.push(summary);
          if (selected.length >= input.page_size) break scan;
        }
        if (!hasNextPage(response)) break;
        cursor = { ...cursor, repository_offset: 0, repository_page: cursor.repository_page + 1 };
        if (context.session.remainingRequests < 1) break scan;
      }
      cursor = { ...cursor, installation_offset: cursor.installation_offset + 1, repository_offset: 0, repository_page: 1 };
    }
    if (!hasNextPage(installationsResponse)) {
      complete = true;
      break;
    }
    cursor = { installation_offset: 0, installation_page: cursor.installation_page + 1, repository_offset: 0, repository_page: 1 };
  }

  const nextRequest = complete
    ? undefined
    : exactNextRequest(operation, {
        page_size: input.page_size,
        ...(query ? { query } : {}),
        continuation_token: await context.seal(scope, SCAN_TTL_SECONDS, { cursor, request }),
      });
  const state = complete ? "complete" : selected.length === 0 ? "seeking" : "partial";
  return { data: collection({ state }, "repositories", selected, nextRequest) };
}

export const repositoryOperations: OperationHandlers<
  "list_repositories" | "search_repositories" | "get_repository" | "get_branch" | "search_code" | "list_directory"
> = {
  list_repositories(context, input) {
    return scanRepositories(context, "list_repositories", input, null);
  },

  search_repositories(context, input) {
    const query = input.query.trim().toLowerCase();
    if (!query) throw invalidArguments("query is required");
    return scanRepositories(context, "search_repositories", input, query);
  },

  async get_repository(context, input) {
    const repository = await context.session.repository(input.repository_full_name);
    const data = record((await repository.request("GET /repos/{owner}/{repo}")).data);
    return {
      data: {
        ...repositorySummary(data),
        archived: booleanValue(data.archived),
        created_at: stringValue(data.created_at),
        description: stringValue(data.description),
        fork: booleanValue(data.fork),
        language: stringValue(data.language),
        pushed_at: stringValue(data.pushed_at),
        size_kib: numberValue(data.size),
        updated_at: stringValue(data.updated_at),
        visibility: stringValue(data.visibility),
      },
    };
  },

  async get_branch(context, input) {
    const repository = await context.session.repository(input.repository_full_name);
    const response = await repository.request("GET /repos/{owner}/{repo}/branches/{branch}", { branch: input.branch });
    const data = record(response.data);
    return {
      data: {
        commit_sha: stringValue(nested(data, "commit").sha),
        name: stringValue(data.name),
        protected: booleanValue(data.protected),
        repository_full_name: repository.fullName,
      },
    };
  },

  async search_code(context, input) {
    const repository = await context.session.repository(input.repository_full_name);
    const response = await repository.api.request("GET /search/code", {
      page: input.page,
      per_page: input.per_page,
      q: `${validateSearchQuery(input.query)} repo:${repository.fullName}`,
    });
    const data = record(response.data);
    const items = records(data.items).map((item) => ({
      name: stringValue(item.name),
      path: stringValue(item.path),
      repository_full_name: stringValue(optionalNested(item, "repository")?.full_name),
      sha: stringValue(item.sha),
      url: stringValue(item.html_url),
    }));
    return pagedCollection("search_code", input, response, "items", items, { total_count: numberValue(data.total_count) });
  },

  async list_directory(context, input) {
    const repository = await context.session.repository(input.repository_full_name);
    const response = await repository.request("GET /repos/{owner}/{repo}/contents/{path}", {
      path: input.path,
      ...(input.ref ? { ref: input.ref } : {}),
    });
    if (!Array.isArray(response.data)) throw invalidArguments("The requested path is not a directory");
    const all = records(response.data);
    const entries = all.slice(input.offset, input.offset + input.limit).map((entry) => ({
      name: stringValue(entry.name),
      path: stringValue(entry.path),
      sha: stringValue(entry.sha),
      size: numberValue(entry.size),
      type: stringValue(entry.type),
      url: stringValue(entry.html_url),
    }));
    const nextOffset = input.offset + entries.length < all.length ? input.offset + entries.length : null;
    return {
      data: collection(
        {
          completeness: all.length === 1000 ? "unknown" : "complete",
          next_offset: nextOffset,
          path: input.path,
          repository_full_name: repository.fullName,
          total_entries: all.length,
        },
        "entries",
        entries,
        nextOffset === null ? undefined : exactNextRequest("list_directory", { ...input, offset: nextOffset }),
      ),
    };
  },
};
