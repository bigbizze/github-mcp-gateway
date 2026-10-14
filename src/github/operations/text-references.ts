import { z } from "zod";
import { GatewayError } from "../../errors";
import type { TokenScope } from "../../security/reference-token";
import { nested, record, stringValue } from "../json";
import { exactNextRequest, type NextRequest } from "../result";
import { sliceKnownText } from "../text-window";
import { findCommitFile } from "./commits";
import {
  type OperationContext,
  type OperationHandlers,
  rangeTooLarge,
  TEXT_TTL_SECONDS,
  windowFields,
} from "./context";
import { findPullRequestFile, getPullRequestData } from "./pull-requests";

const TEXT_SCOPE: TokenScope = { operation: "read_text", purpose: "text" };

const repositoryName = z.string();
const id = z.number().int();

/** Where a long text lives on GitHub. Each kind has exactly the fields needed to read it again. */
const textSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ issue_number: id, kind: z.literal("issue_body"), repository_full_name: repositoryName }),
  z.strictObject({ kind: z.literal("pr_body"), pr_number: id, repository_full_name: repositoryName }),
  z.strictObject({ comment_id: id, kind: z.literal("issue_comment"), repository_full_name: repositoryName }),
  z.strictObject({ kind: z.literal("pr_review"), pr_number: id, repository_full_name: repositoryName, review_id: id }),
  z.strictObject({ commit_sha: z.string(), kind: z.literal("commit_message"), repository_full_name: repositoryName }),
  z.strictObject({ commit_sha: z.string(), kind: z.literal("commit_patch"), path: z.string(), repository_full_name: repositoryName }),
  z.strictObject({ kind: z.literal("pr_patch"), path: z.string(), pr_number: id, repository_full_name: repositoryName }),
]);

export type TextSource = z.infer<typeof textSourceSchema>;

/** A reference token pins a text source and the hash of its content when the token was made. */
const textTokenSchema = z.strictObject({
  body_hash: z.string(),
  next_line: z.number().int().min(1),
  source: textSourceSchema,
});

type TextToken = z.infer<typeof textTokenSchema>;

async function bodyHash(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sealText(context: OperationContext, token: TextToken): Promise<string> {
  return context.seal(TEXT_SCOPE, TEXT_TTL_SECONDS, token);
}

/** Creates a reference token for the complete text. `read_text` uses it to read any line range. */
export async function textReference(context: OperationContext, source: TextSource, text: string): Promise<string> {
  return sealText(context, { body_hash: await bodyHash(text), next_line: 1, source });
}

/**
 * Returns the first window of a text. If the text does not fit, the result also has a reference
 * token and a `next_request` for the next window.
 */
export async function inlineText(context: OperationContext, source: TextSource, text: string | null) {
  if (text === null) return { content: null, state: "complete" as const, total_lines: 0 };
  const window = sliceKnownText(text);
  if (window.next_line === undefined) return windowFields(window);
  const hash = await bodyHash(text);
  const [referenceToken, continuationToken] = await Promise.all([
    sealText(context, { body_hash: hash, next_line: 1, source }),
    sealText(context, { body_hash: hash, next_line: window.next_line, source }),
  ]);
  return {
    ...windowFields(window),
    next_request: exactNextRequest("read_text", { continuation_token: continuationToken }),
    reference_token: referenceToken,
  };
}

async function currentText(context: OperationContext, source: TextSource): Promise<string> {
  const repository = await context.session.repository(source.repository_full_name);
  switch (source.kind) {
    case "issue_body": {
      const response = await repository.request("GET /repos/{owner}/{repo}/issues/{issue_number}", {
        issue_number: source.issue_number,
      });
      return stringValue(record(response.data).body) ?? "";
    }
    case "pr_body":
      return stringValue((await getPullRequestData(repository, source.pr_number)).body) ?? "";
    case "issue_comment": {
      const response = await repository.request("GET /repos/{owner}/{repo}/issues/comments/{comment_id}", {
        comment_id: source.comment_id,
      });
      return stringValue(record(response.data).body) ?? "";
    }
    case "pr_review": {
      const response = await repository.request("GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}", {
        pull_number: source.pr_number,
        review_id: source.review_id,
      });
      return stringValue(record(response.data).body) ?? "";
    }
    case "commit_message": {
      const response = await repository.request("GET /repos/{owner}/{repo}/commits/{ref}", { ref: source.commit_sha });
      return stringValue(nested(record(response.data), "commit").message) ?? "";
    }
    case "commit_patch":
      return stringValue((await findCommitFile(context, repository, source.commit_sha, source.path)).file.patch) ?? "";
    case "pr_patch":
      return stringValue((await findPullRequestFile(context, repository, source.pr_number, source.path)).patch) ?? "";
  }
}

export const textReferenceOperations: OperationHandlers<"read_text"> = {
  async read_text(context, input) {
    const exactRange = "reference_token" in input;
    const token = exactRange ? input.reference_token : input.continuation_token;
    const pinned = await context.open(token, TEXT_SCOPE, textTokenSchema);
    const text = await currentText(context, pinned.source);
    if (await bodyHash(text) !== pinned.body_hash) {
      throw new GatewayError("stale_reference", "The GitHub text changed after this reference was created");
    }
    const startLine = exactRange ? input.start_line ?? 1 : pinned.next_line;
    const endLine = exactRange ? input.end_line : undefined;
    const window = sliceKnownText(text, startLine, endLine);
    if (window.state === "range_too_large") {
      const largestSafeEnd = window.largest_safe_end_line ?? startLine;
      throw rangeTooLarge(
        largestSafeEnd,
        exactNextRequest("read_text", { end_line: largestSafeEnd, reference_token: token, start_line: startLine }),
      );
    }
    let nextRequest: NextRequest | undefined;
    if (window.next_line !== undefined) {
      const nextToken = await sealText(context, { ...pinned, next_line: window.next_line });
      nextRequest = exactNextRequest("read_text", { continuation_token: nextToken });
    }
    return { data: { ...windowFields(window), ...(nextRequest ? { next_request: nextRequest } : {}) } };
  },
};
