import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type {
  EnrollmentResult,
  GitLabWebhookResult,
  GitLabProjectMetadata,
  GitRepositoryStatus,
  GroupNodeConfig,
  GroupWorkspaceData,
  ProjectGroupSummary,
  ProjectWebhookCredentials,
  ReviewTask
} from "../shared/contracts.js";
import { resolveGitRepositoryAccess } from "../server/group/git-auth.js";

const managerUrl = process.env.MANAGER_PUBLIC_URL ?? "http://127.0.0.1:7000";
const key = `smoke-${randomBytes(4).toString("hex")}`;
let enrollment: EnrollmentResult | undefined;
let groupNode: ChildProcess | undefined;
let groupNodeOutput = "";
let groupDataDir: string | undefined;
let nodeCredential: { nodeId: string; nodeToken: string } | undefined;
let feishuPayload: {
  timestamp?: string;
  sign?: string;
  msg_type?: string;
  content?: { text?: string };
} | undefined;
let feishuServerStarted = false;
let gitlabServerStarted = false;
let gitlabLookupToken: string | undefined;
const feishuServer = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => { body += chunk.toString(); });
  request.on("end", () => {
    feishuPayload = JSON.parse(body) as typeof feishuPayload;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: 0, msg: "success" }));
  });
});
const gitlabServer = createServer((request, response) => {
  gitlabLookupToken = request.headers["private-token"] as string | undefined;
  if (request.url === "/api/v4/projects/smoke%2Fproject") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: 12345,
      name: "Smoke Project",
      path: "project",
      path_with_namespace: "smoke/project",
      default_branch: "develop",
      ssh_url_to_repo: "git@gitlab.example.com:smoke/project.git",
      http_url_to_repo: "https://gitlab.example.com/smoke/project.git",
      web_url: "https://gitlab.example.com/smoke/project"
    }));
    return;
  }
  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ message: "404 Project Not Found" }));
});

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && init.body !== null && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(url, {
    ...init,
    headers
  });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

async function waitForOnline(groupId: string) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const response = await json<{ item: ProjectGroupSummary }>(`${managerUrl}/api/groups/${groupId}`);
    if (response.item.node?.status === "online") return response.item;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Group node did not become online in time${groupNodeOutput ? `\n${groupNodeOutput}` : ""}`);
}

try {
  await json(`${managerUrl}/api/health`);
  enrollment = await json<EnrollmentResult>(`${managerUrl}/api/groups`, {
    method: "POST",
    body: JSON.stringify({ name: "Smoke Test Group", key, description: "Temporary integration test" })
  });

  const groupId = enrollment.group.id;
  const dataDir = path.resolve("runtime", "smoke", groupId);
  groupDataDir = dataDir;
  groupNode = spawn(
    process.execPath,
    [
      path.resolve("node_modules", "tsx", "dist", "cli.mjs"),
      path.resolve("server", "group", "index.ts"),
      `--manager-url=${managerUrl}`,
      `--group-id=${groupId}`,
      `--enroll-token=${enrollment.enrollmentToken}`,
      "--name=Smoke Test Group",
      `--data-dir=${dataDir}`
    ],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
  );
  const captureGroupNodeOutput = (chunk: Buffer) => {
    groupNodeOutput = `${groupNodeOutput}${chunk.toString()}`.slice(-32_768);
  };
  groupNode.stdout?.on("data", captureGroupNodeOutput);
  groupNode.stderr?.on("data", captureGroupNodeOutput);

  const onlineGroup = await waitForOnline(groupId);
  if (!onlineGroup.node || onlineGroup.node.port <= 0) {
    throw new Error("Registered node did not report a valid dynamic port");
  }
  nodeCredential = JSON.parse(await readFile(path.join(dataDir, "identity.json"), "utf8")) as {
    nodeId: string;
    nodeToken: string;
  };

  const workspace = await json<GroupWorkspaceData>(
    `${managerUrl}/api/groups/${groupId}/workspace`
  );
  if (workspace.config.revision !== 1) throw new Error("Unexpected initial config revision");

  await new Promise<void>((resolve) => feishuServer.listen(0, "127.0.0.1", resolve));
  feishuServerStarted = true;
  const feishuPort = (feishuServer.address() as AddressInfo).port;
  await new Promise<void>((resolve) => gitlabServer.listen(0, "127.0.0.1", resolve));
  gitlabServerStarted = true;
  const gitlabPort = (gitlabServer.address() as AddressInfo).port;

  const updatedConfig = await json<GroupNodeConfig>(
    `${managerUrl}/api/groups/${groupId}/config`,
    {
      method: "PUT",
      body: JSON.stringify({
        general: { displayName: "Smoke Test Workspace" },
        gitlab: {
          baseUrl: `http://127.0.0.1:${gitlabPort}`,
          apiUrl: "",
          token: "smoke-gitlab-token"
        },
        ai: { model: "smoke-model", apiKey: "temporary-smoke-key" },
        feishu: {
          enabled: true,
          notifyOnMergeRequestTriggered: true,
          webhookUrl: `http://127.0.0.1:${feishuPort}/hook`,
          signingSecret: "smoke-feishu-signing-secret"
        }
      })
    }
  );
  if (updatedConfig.revision !== 2 || !updatedConfig.ai.apiKeyConfigured) {
    throw new Error("Group node config update did not persist encrypted secrets");
  }
  if (updatedConfig.ai.provider !== "deepseek" || "reviewCommand" in updatedConfig.ai) {
    throw new Error("Group node exposed an unexpected AI runtime implementation detail");
  }

  const resolvedProject = await json<GitLabProjectMetadata>(
    `${managerUrl}/api/groups/${groupId}/gitlab/projects/resolve?ref=${encodeURIComponent("smoke/project")}`
  );
  if (
    resolvedProject.id !== 12345 ||
    resolvedProject.defaultBranch !== "develop" ||
    resolvedProject.suggestedRepositoryUrl !== "https://gitlab.example.com/smoke/project.git" ||
    gitlabLookupToken !== "smoke-gitlab-token"
  ) {
    throw new Error("GitLab project metadata was not resolved through the group node");
  }
  const repositoryAccess = await resolveGitRepositoryAccess({
    dataDir,
    configuredRepositoryUrl: "git@gitlab.example.com:smoke/project.git",
    gitlabProjectRef: "smoke/project",
    gitlabConfig: updatedConfig.gitlab,
    gitlabToken: "smoke-gitlab-token"
  });
  if (
    repositoryAccess.repositoryUrl !== "https://gitlab.example.com/smoke/project.git" ||
    repositoryAccess.authentication !== "gitlab-token" ||
    repositoryAccess.environment.CODE_REVIEW_GITLAB_TOKEN !== "smoke-gitlab-token" ||
    repositoryAccess.environment.GIT_CONFIG_KEY_0 !== "credential.helper" ||
    repositoryAccess.environment.GIT_CONFIG_VALUE_0 !== ""
  ) {
    throw new Error("SSH repository URL was not converted to project-group Access Token authentication");
  }

  const projectCredentials = await json<ProjectWebhookCredentials>(
    `${managerUrl}/api/groups/${groupId}/projects`,
    {
      method: "POST",
      body: JSON.stringify({
        key: "smoke_project",
        name: "Smoke Review Project",
        description: "Webhook integration test",
        enabled: true,
        gitlabProjectRef: "12345",
        repositoryUrl: resolvedProject.suggestedRepositoryUrl,
        defaultBranch: "main"
      })
    }
  );
  if (!projectCredentials.secret || !projectCredentials.project.webhook.url) {
    throw new Error("Project creation did not return one-time webhook credentials");
  }
  const repositoryStatus = await json<GitRepositoryStatus>(
    `${managerUrl}/api/groups/${groupId}/projects/${projectCredentials.project.id}/repository/status`
  );
  if (repositoryStatus.exists || repositoryStatus.valid) {
    throw new Error("New project unexpectedly reported an existing local repository");
  }

  const webhookPayload = {
    object_kind: "merge_request",
    user: { name: "Smoke User", username: "smoke" },
    project: { id: 12345, path_with_namespace: "smoke/project" },
    object_attributes: {
      iid: 17,
      title: "Smoke MR",
      action: "open",
      state: "opened",
      source_branch: "feature/smoke",
      target_branch: "main",
      url: "https://gitlab.example.com/smoke/project/-/merge_requests/17",
      last_commit: { id: "1234567890abcdef1234567890abcdef12345678" }
    }
  };
  const webhookHeaders = {
    "x-gitlab-token": projectCredentials.secret,
    "x-gitlab-event": "Merge Request Hook",
    "webhook-id": "smoke-delivery-1"
  };
  const webhookResult = await json<GitLabWebhookResult>(projectCredentials.project.webhook.url, {
    method: "POST",
    headers: webhookHeaders,
    body: JSON.stringify(webhookPayload)
  });
  if (!webhookResult.queued || webhookResult.deduplicated) {
    throw new Error("Valid GitLab merge request webhook was not queued");
  }
  const feishuDeadline = Date.now() + 3_000;
  while (!feishuPayload && Date.now() < feishuDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (
    feishuPayload?.msg_type !== "text" ||
    !feishuPayload.content?.text?.includes("Smoke MR") ||
    !feishuPayload.content.text.includes("已进入串行 Review 队列") ||
    !feishuPayload.timestamp ||
    !feishuPayload.sign
  ) {
    throw new Error("MR trigger did not send the expected signed Feishu notification");
  }

  const duplicateResult = await json<GitLabWebhookResult>(projectCredentials.project.webhook.url, {
    method: "POST",
    headers: webhookHeaders,
    body: JSON.stringify(webhookPayload)
  });
  if (!duplicateResult.deduplicated || duplicateResult.queued) {
    throw new Error("Duplicate GitLab webhook delivery was not deduplicated");
  }

  const invalidSecretResponse = await fetch(projectCredentials.project.webhook.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-gitlab-token": "invalid-secret",
      "x-gitlab-event": "Merge Request Hook"
    },
    body: JSON.stringify(webhookPayload)
  });
  if (invalidSecretResponse.status !== 401) {
    throw new Error(`Invalid webhook secret returned ${invalidSecretResponse.status} instead of 401`);
  }

  const reviewTasks = await json<{ items: ReviewTask[] }>(
    `${managerUrl}/api/groups/${groupId}/reviews`
  );
  if (reviewTasks.items.length !== 1 || reviewTasks.items[0].status !== "queued") {
    throw new Error("Review queue did not persist the webhook task");
  }
  const workspaceAfterWebhook = await json<GroupWorkspaceData>(
    `${managerUrl}/api/groups/${groupId}/workspace`
  );
  if (workspaceAfterWebhook.stats.projectCount !== 1 || workspaceAfterWebhook.stats.queuedReviewCount !== 1) {
    throw new Error("Dashboard statistics did not reflect project and review queue state");
  }

  const deleteProjectResponse = await fetch(
    `${managerUrl}/api/groups/${groupId}/projects/${projectCredentials.project.id}`,
    { method: "DELETE" }
  );
  if (deleteProjectResponse.status !== 204) {
    throw new Error(`Project deletion returned ${deleteProjectResponse.status} instead of 204`);
  }
  const projectsAfterDelete = await json<{ items: unknown[] }>(
    `${managerUrl}/api/groups/${groupId}/projects`
  );
  if (projectsAfterDelete.items.length !== 0) {
    throw new Error("Deleted project still exists in project storage");
  }
  process.stdout.write(`Smoke test passed: ${onlineGroup.node.host}:${onlineGroup.node.port}\n`);
} finally {
  if (feishuServerStarted) {
    await new Promise<void>((resolve) => feishuServer.close(() => resolve()));
  }
  if (gitlabServerStarted) {
    await new Promise<void>((resolve) => gitlabServer.close(() => resolve()));
  }
  if (enrollment && nodeCredential) {
    await fetch(`${managerUrl}/api/nodes/${nodeCredential.nodeId}/deregister`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${nodeCredential.nodeToken}`
      },
      body: JSON.stringify({ groupId: enrollment.group.id })
    });
  }
  if (groupNode && !groupNode.killed) {
    groupNode.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
  if (enrollment) {
    const deleteResponse = await fetch(`${managerUrl}/api/groups/${enrollment.group.id}`, {
      method: "DELETE"
    });
    if (!deleteResponse.ok && deleteResponse.status !== 404) {
      process.stderr.write(`Smoke group cleanup failed: ${deleteResponse.status}\n`);
    }
    await rm(groupDataDir ?? path.resolve("runtime", "smoke", enrollment.group.id), {
      recursive: true,
      force: true
    });
  }
}
