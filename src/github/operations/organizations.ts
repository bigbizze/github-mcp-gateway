import { z } from "zod";
import type { TokenScope } from "../../security/reference-token";
import { type JsonRecord, optionalNested, record, records, stringValue, userLogin } from "../json";
import { collection, exactNextRequest } from "../result";
import { hasNextPage } from "../session";
import { type OperationHandlers, pagedCollection, requireSameArguments, SCAN_TTL_SECONDS } from "./context";

const MEMBER_SCAN_SCOPE: TokenScope = { operation: "search_organization_members", purpose: "organization_scan" };

const memberScanSchema = z.strictObject({
  cursor: z.strictObject({ offset: z.number().int().min(0), page: z.number().int().min(1) }),
  request: z.strictObject({ organization: z.string(), page_size: z.number().int(), query: z.string() }),
});

function memberSummary(member: JsonRecord) {
  return {
    avatar_url: stringValue(member.avatar_url),
    type: stringValue(member.type),
    url: stringValue(member.html_url),
    username: stringValue(member.login),
  };
}

export const organizationOperations: OperationHandlers<
  "list_organization_members" | "search_organization_members" | "get_organization_membership"
> = {
  async list_organization_members(context, input) {
    const client = await context.session.organization(input.organization);
    const response = await client.request("GET /orgs/{org}/members", {
      org: input.organization,
      page: input.page,
      per_page: input.per_page,
    });
    const members = records(response.data).map(memberSummary);
    return pagedCollection("list_organization_members", input, response, "members", members, {
      organization: input.organization,
    });
  },

  async search_organization_members(context, input) {
    const request = { organization: input.organization, page_size: input.page_size, query: input.query.trim().toLowerCase() };
    let cursor = { offset: 0, page: 1 };
    if (input.continuation_token) {
      const scan = await context.open(input.continuation_token, MEMBER_SCAN_SCOPE, memberScanSchema);
      requireSameArguments(scan.request, request);
      cursor = scan.cursor;
    }
    const client = await context.session.organization(input.organization);
    const selected: ReturnType<typeof memberSummary>[] = [];
    let complete = false;
    while (selected.length < request.page_size && context.session.remainingRequests > 0) {
      const response = await client.request("GET /orgs/{org}/members", {
        org: input.organization,
        page: cursor.page,
        per_page: 100,
      });
      const members = records(response.data);
      for (let index = cursor.offset; index < members.length && selected.length < request.page_size; index += 1) {
        cursor = { offset: index + 1, page: cursor.page };
        const member = memberSummary(members[index] ?? {});
        if (member.username?.toLowerCase().includes(request.query)) selected.push(member);
      }
      if (cursor.offset < members.length) break;
      if (!hasNextPage(response)) {
        complete = true;
        break;
      }
      cursor = { offset: 0, page: cursor.page + 1 };
    }
    const nextRequest = complete
      ? undefined
      : exactNextRequest("search_organization_members", {
          ...request,
          continuation_token: await context.seal(MEMBER_SCAN_SCOPE, SCAN_TTL_SECONDS, { cursor, request }),
        });
    const state = complete ? "complete" : selected.length === 0 ? "seeking" : "partial";
    return { data: collection({ organization: input.organization, state }, "members", selected, nextRequest) };
  },

  async get_organization_membership(context, input) {
    const client = await context.session.organization(input.organization);
    const response = await client.request("GET /orgs/{org}/memberships/{username}", {
      org: input.organization,
      username: input.username,
    });
    const membership = record(response.data);
    return {
      data: {
        organization: input.organization,
        organization_url: stringValue(optionalNested(membership, "organization")?.html_url),
        role: stringValue(membership.role),
        state: stringValue(membership.state),
        username: userLogin(membership.user) ?? input.username,
      },
    };
  },
};
