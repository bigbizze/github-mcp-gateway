import { z } from "zod";
import { GatewayError } from "../../errors";
import type { TokenScope } from "../../security/reference-token";
import { booleanValue, type JsonRecord, numberValue, optionalRecords, record, records, stringValue, userLogin } from "../json";
import { collection, exactNextRequest } from "../result";
import { GITHUB_API_VERSION, type GitHubSession } from "../session";
import { ARTIFACT_TTL_SECONDS, type OperationHandlers, pagedCollection } from "./context";

export const ARTIFACT_SCOPE: TokenScope = { operation: "download_workflow_artifact", purpose: "artifact" };

export const artifactLinkSchema = z.strictObject({
  artifact_id: z.number().int().positive(),
  repository_full_name: z.string(),
});

function workflowRunSummary(run: JsonRecord) {
  return {
    attempt: numberValue(run.run_attempt),
    conclusion: stringValue(run.conclusion),
    created_at: stringValue(run.created_at),
    event: stringValue(run.event),
    head_branch: stringValue(run.head_branch),
    head_sha: stringValue(run.head_sha),
    name: stringValue(run.name),
    run_id: numberValue(run.id),
    run_number: numberValue(run.run_number),
    status: stringValue(run.status),
    updated_at: stringValue(run.updated_at),
    url: stringValue(run.html_url),
    workflow_id: numberValue(run.workflow_id),
  };
}

function artifactSummary(artifact: JsonRecord) {
  return {
    artifact_id: numberValue(artifact.id),
    created_at: stringValue(artifact.created_at),
    expired: booleanValue(artifact.expired),
    expires_at: stringValue(artifact.expires_at),
    name: stringValue(artifact.name),
    size_in_bytes: numberValue(artifact.size_in_bytes),
    updated_at: stringValue(artifact.updated_at),
  };
}

/**
 * Asks GitHub for the artifact ZIP's signed storage URL. The installation token goes only to
 * api.github.com. The caller redirects the client to the returned URL.
 */
export async function artifactDownloadUrl(
  session: GitHubSession,
  fetchImpl: typeof fetch,
  link: z.infer<typeof artifactLinkSchema>,
): Promise<string> {
  const repository = await session.repository(link.repository_full_name);
  if (!repository.token) throw new GatewayError("installation_required", "The artifact repository is not installed");
  session.spend();
  const response = await fetchImpl(
    `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/actions/artifacts/${link.artifact_id}/zip`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${repository.token}`,
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
      },
      redirect: "manual",
    },
  );
  const location = response.headers.get("Location");
  await response.body?.cancel();
  if (response.status === 410) throw new GatewayError("not_found", "The workflow artifact expired");
  if (response.status < 300 || response.status >= 400 || !location) {
    throw new GatewayError("upstream_error", "GitHub did not issue an artifact redirect", true);
  }
  const url = new URL(location);
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new GatewayError("upstream_error", "GitHub issued an unsafe artifact redirect");
  }
  return url.href;
}

export const workflowOperations: OperationHandlers<
  | "fetch_commit_workflow_runs"
  | "fetch_workflow_run"
  | "fetch_workflow_run_jobs"
  | "fetch_workflow_job_steps"
  | "fetch_workflow_run_artifacts"
  | "download_workflow_artifact"
> = {
  async fetch_commit_workflow_runs(context, input) {
    const repository = await context.session.repository(input.repository_full_name);
    const response = await repository.request("GET /repos/{owner}/{repo}/actions/runs", {
      head_sha: input.commit_sha,
      page: input.page,
      per_page: input.per_page,
    });
    const data = record(response.data);
    return pagedCollection(
      "fetch_commit_workflow_runs",
      input,
      response,
      "workflow_runs",
      records(data.workflow_runs).map(workflowRunSummary),
      { commit_sha: input.commit_sha, total_count: numberValue(data.total_count) },
    );
  },

  async fetch_workflow_run(context, input) {
    const repository = await context.session.repository(input.repository_full_name);
    const response = await repository.request("GET /repos/{owner}/{repo}/actions/runs/{run_id}", { run_id: input.run_id });
    const run = record(response.data);
    return {
      data: {
        ...workflowRunSummary(run),
        actor: userLogin(run.actor),
        cancel_url: stringValue(run.cancel_url),
        check_suite_id: numberValue(run.check_suite_id),
        jobs_url: stringValue(run.jobs_url),
        logs_url: stringValue(run.logs_url),
        repository_full_name: repository.fullName,
        rerun_url: stringValue(run.rerun_url),
        workflow_url: stringValue(run.workflow_url),
      },
    };
  },

  async fetch_workflow_run_jobs(context, input) {
    const repository = await context.session.repository(input.repository_full_name);
    const response = await repository.request("GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs", {
      filter: input.filter,
      page: input.page,
      per_page: input.per_page,
      run_id: input.run_id,
    });
    const data = record(response.data);
    const jobs = records(data.jobs).map((job) => ({
      completed_at: stringValue(job.completed_at),
      conclusion: stringValue(job.conclusion),
      head_sha: stringValue(job.head_sha),
      job_id: numberValue(job.id),
      name: stringValue(job.name),
      runner_group_name: stringValue(job.runner_group_name),
      runner_name: stringValue(job.runner_name),
      started_at: stringValue(job.started_at),
      status: stringValue(job.status),
      url: stringValue(job.html_url),
    }));
    return pagedCollection("fetch_workflow_run_jobs", input, response, "jobs", jobs, {
      run_id: input.run_id,
      total_count: numberValue(data.total_count),
    });
  },

  async fetch_workflow_job_steps(context, input) {
    const repository = await context.session.repository(input.repository_full_name);
    const response = await repository.request("GET /repos/{owner}/{repo}/actions/jobs/{job_id}", { job_id: input.job_id });
    const all = optionalRecords(record(response.data).steps);
    const steps = all.slice(input.offset, input.offset + input.limit).map((step) => ({
      completed_at: stringValue(step.completed_at),
      conclusion: stringValue(step.conclusion),
      name: stringValue(step.name),
      number: numberValue(step.number),
      started_at: stringValue(step.started_at),
      status: stringValue(step.status),
    }));
    const nextOffset = input.offset + steps.length < all.length ? input.offset + steps.length : null;
    return {
      data: collection(
        { job_id: input.job_id, next_offset: nextOffset, total_steps: all.length },
        "steps",
        steps,
        nextOffset === null ? undefined : exactNextRequest("fetch_workflow_job_steps", { ...input, offset: nextOffset }),
      ),
    };
  },

  async fetch_workflow_run_artifacts(context, input) {
    const repository = await context.session.repository(input.repository_full_name);
    const response = await repository.request("GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts", {
      page: input.page,
      per_page: input.per_page,
      run_id: input.run_id,
      ...(input.name ? { name: input.name } : {}),
    });
    const data = record(response.data);
    return pagedCollection(
      "fetch_workflow_run_artifacts",
      input,
      response,
      "artifacts",
      records(data.artifacts).map(artifactSummary),
      { run_id: input.run_id, total_count: numberValue(data.total_count) },
    );
  },

  async download_workflow_artifact(context, input) {
    const repository = await context.session.repository(input.repository_full_name);
    const response = await repository.request("GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}", {
      artifact_id: input.artifact_id,
    });
    const artifact = record(response.data);
    if (booleanValue(artifact.expired)) throw new GatewayError("not_found", "The workflow artifact expired");
    const link: z.infer<typeof artifactLinkSchema> = {
      artifact_id: input.artifact_id,
      repository_full_name: repository.fullName,
    };
    const token = await context.seal(ARTIFACT_SCOPE, ARTIFACT_TTL_SECONDS, link);
    const uri = `${context.services.artifactBaseUrl}/artifacts/v1/${token}`;
    const size = numberValue(artifact.size_in_bytes);
    return {
      data: { ...artifactSummary(artifact), bearer_credential: true, expires_in_seconds: ARTIFACT_TTL_SECONDS, uri },
      resource_link: {
        description: "Short-lived bearer link for the complete workflow artifact ZIP.",
        mimeType: "application/zip",
        name: `${stringValue(artifact.name) ?? "workflow-artifact"}.zip`,
        ...(size !== null ? { size } : {}),
        uri,
      },
    };
  },
};
