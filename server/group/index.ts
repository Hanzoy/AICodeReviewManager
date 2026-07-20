import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import Fastify from "fastify";
import { z } from "zod";
import type {
  CreateReviewProjectInput,
  CreateManualReviewInput,
  GroupNodeConfig,
  GroupNodeConfigUpdate,
  GroupNodeRuntimeStatus,
  NodeRegistrationInput,
  NodeRegistrationResult,
  UpdateReviewProjectInput
} from "../../shared/contracts.js";
import { GroupConfigStore } from "./config-store.js";
import { sendMergeRequestTriggeredNotification } from "./feishu-notifier.js";
import { GroupIdentityStore } from "./identity-store.js";
import { GitRepositoryService } from "./git-repository.js";
import { ProjectStore, type GitLabMergeRequestPayload } from "./project-store.js";
import { ReviewWorker } from "./review-worker.js";

function argument(name: string) {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function flag(name: string) {
  return process.argv.slice(2).includes(`--${name}`);
}

function headerValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

async function requestJson<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`${response.status} ${await response.text()}`);
  }
  return (await response.json()) as T;
}

const host = argument("host") ?? process.env.GROUP_HOST ?? "127.0.0.1";
const requestedPort = Number(argument("port") ?? process.env.GROUP_PORT ?? 0);
const managerUrlArg = argument("manager-url") ?? process.env.MANAGER_URL;
const groupIdArg = argument("group-id") ?? process.env.GROUP_ID;
const enrollmentToken = argument("enroll-token") ?? process.env.ENROLL_TOKEN;
const groupName = argument("name") ?? process.env.GROUP_NAME ?? "项目组节点";
const dataDir = argument("data-dir") ?? process.env.GROUP_DATA_DIR ?? "./data/group-node";
const version = "0.1.0";
const startedAt = new Date().toISOString();
const instanceId = randomUUID();
const capabilities = ["gitlab-review", "file-storage", "feishu-notification"];
const identityStore = new GroupIdentityStore(dataDir);
if (flag("reset-identity")) await identityStore.clear();
const savedIdentity = await identityStore.load();
const managerUrl = managerUrlArg ?? savedIdentity?.managerUrl;
const groupId = groupIdArg ?? savedIdentity?.groupId;

if (!managerUrl || !groupId) {
  throw new Error("首次启动必须提供 --manager-url、--group-id 和 --enroll-token");
}

const urlOrEmpty = z.union([z.string().url(), z.literal("")]);
const configUpdateSchema = z.object({
  general: z
    .object({
      displayName: z.string().trim().min(2).max(80),
      description: z.string().trim().max(500),
      timezone: z.string().trim().min(1).max(80),
      reviewLanguage: z.enum(["zh-CN", "en-US"])
    })
    .partial()
    .optional(),
  repository: z
    .object({
      rootPath: z.string().trim().min(1).max(500),
      cloneDepth: z.number().int().min(0).max(10000),
      maxDiskGigabytes: z.number().int().min(1).max(100000)
    })
    .partial()
    .optional(),
  gitlab: z
    .object({
      baseUrl: urlOrEmpty,
      apiUrl: urlOrEmpty,
      sslVerification: z.boolean(),
      requestTimeoutSeconds: z.number().int().min(1).max(300),
      token: z.string().max(4096)
    })
    .partial()
    .optional(),
  ai: z
    .object({
      provider: z.literal("deepseek"),
      baseUrl: z.string().url(),
      model: z.string().trim().max(200),
      fastModel: z.string().trim().max(200),
      subagentModel: z.string().trim().max(200),
      reasoningEffort: z.enum(["low", "medium", "high", "xhigh", "max"]),
      requestTimeoutSeconds: z.number().int().min(1).max(1800),
      maxConcurrency: z.number().int().min(1).max(100),
      maxOutputTokens: z.number().int().min(256).max(1000000),
      reviewPrompt: z.string().trim().min(20).max(20000),
      apiKey: z.string().max(4096)
    })
    .partial()
    .optional(),
  feishu: z
    .object({
      enabled: z.boolean(),
      name: z.string().trim().max(100),
      notifyOnMergeRequestTriggered: z.boolean(),
      notifyOnManualReviewCompleted: z.boolean(),
      notifyOnReviewCompleted: z.boolean(),
      notifyOnReviewFailed: z.boolean(),
      notifyOnCriticalFinding: z.boolean(),
      webhookUrl: z.union([z.string().url(), z.literal("")]),
      signingSecret: z.string().max(4096)
    })
    .partial()
    .optional()
});

const projectKeySchema = z
  .string()
  .trim()
  .min(2)
  .max(80)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const createProjectSchema = z.object({
  key: projectKeySchema,
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(500).optional(),
  enabled: z.boolean().optional(),
  gitlabProjectRef: z.string().trim().min(1).max(300),
  repositoryUrl: z.string().trim().min(1).max(1000),
  defaultBranch: z.string().trim().min(1).max(300)
});
const updateProjectSchema = createProjectSchema.omit({ key: true }).partial();
const manualReviewSelectionSchema = z.object({
  mode: z.enum(["commits", "branch"]),
  commitShas: z.array(z.string().trim().min(7).max(40)).max(50).default([]),
  branch: z.string().trim().min(1).max(300).optional(),
  targetBranch: z.string().trim().min(1).max(300)
});
const createManualReviewSchema = z.object({
  selection: manualReviewSelectionSchema,
  requestedBy: z.string().trim().max(120).optional()
});
const commitQuerySchema = z.object({
  branch: z.string().trim().max(300).optional(),
  search: z.string().trim().max(300).optional(),
  since: z.string().trim().max(40).optional(),
  until: z.string().trim().max(40).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(10).max(200).default(50)
});
const mergeRequestWebhookSchema = z.object({
  object_kind: z.literal("merge_request"),
  user: z
    .object({
      name: z.string().optional(),
      username: z.string().optional()
    })
    .optional(),
  project: z.object({
    id: z.number().int(),
    path_with_namespace: z.string().optional()
  }),
  object_attributes: z.object({
    iid: z.number().int().positive(),
    title: z.string().optional(),
    action: z.string().optional(),
    state: z.string().optional(),
    source_branch: z.string().optional(),
    target_branch: z.string().optional(),
    url: z.string().optional(),
    last_commit: z.object({ id: z.string().optional() }).optional()
  })
});

const configStore = new GroupConfigStore(dataDir, groupName);
await configStore.init();
let groupConfig = await configStore.get();
const projectStore = new ProjectStore(dataDir, managerUrl, groupId);
await projectStore.init();
const gitRepository = new GitRepositoryService();

function integrationStatuses(config: GroupNodeConfig): GroupNodeRuntimeStatus["integrations"] {
  return {
    gitlab: config.gitlab.baseUrl && config.gitlab.tokenConfigured ? "healthy" : "unconfigured",
    ai:
      config.ai.apiKeyConfigured && config.ai.baseUrl && config.ai.model && config.ai.reviewPrompt
        ? "healthy"
        : "unconfigured",
    feishu:
      config.feishu.enabled && config.feishu.webhookConfigured ? "healthy" : "unconfigured"
  };
}

const app = Fastify({ logger: true });
const reviewWorker = new ReviewWorker(dataDir, projectStore, configStore, app.log);

async function notifyMergeRequestTriggered(taskId: string) {
  const task = (await projectStore.listTasks()).find((item) => item.id === taskId);
  if (!task) return;
  const { config, webhookUrl, signingSecret } = await configStore.getFeishuContext();
  if (
    !config.feishu.enabled ||
    !config.feishu.notifyOnMergeRequestTriggered ||
    !webhookUrl
  ) return;
  await sendMergeRequestTriggeredNotification({
    webhookUrl,
    signingSecret,
    groupName: config.general.displayName,
    task
  });
  app.log.info({ taskId }, "Feishu merge request notification sent");
}

let runtimeStatus: GroupNodeRuntimeStatus = {
  groupId,
  nodeId: savedIdentity?.nodeId,
  instanceId,
  name: groupName,
  status: "registering",
  managerUrl,
  host,
  port: requestedPort,
  startedAt,
  integrations: integrationStatuses(groupConfig)
};

app.setErrorHandler((error, _request, reply) => {
  const caught = error as Error;
  const statusCode = error instanceof z.ZodError
    ? 400
    : caught.message.includes("NOT_FOUND")
      ? 404
      : caught.message === "INVALID_WEBHOOK_SECRET"
        ? 401
        : caught.message.includes("EXISTS") || caught.message.includes("ALREADY_CONFIGURED")
          ? 409
          : caught.message === "WEBHOOK_PROJECT_MISMATCH"
            ? 403
            : 500;
  reply.status(statusCode).send({
    error: caught.message,
    details: error instanceof z.ZodError ? error.issues : undefined
  });
});

app.get("/health", async () => ({ ...runtimeStatus, health: "ok" }));
app.get("/api/status", async () => runtimeStatus);
app.get("/api/config", async () => groupConfig);
app.put("/api/config", async (request) => {
  const input = configUpdateSchema.parse(request.body) as GroupNodeConfigUpdate;
  groupConfig = await configStore.update(input);
  runtimeStatus = { ...runtimeStatus, name: groupConfig.general.displayName, integrations: integrationStatuses(groupConfig) };
  reviewWorker.wake();
  return groupConfig;
});
app.get("/api/dashboard", async () => ({
  runtime: runtimeStatus,
  config: groupConfig,
  stats: await projectStore.stats(),
  recentReviews: await projectStore.recentReviews()
}));
app.get("/api/projects", async () => ({
  items: await projectStore.list(groupConfig.repository.rootPath)
}));
app.get<{ Params: { projectId: string } }>("/api/projects/:projectId", async (request) =>
  projectStore.getProject(request.params.projectId, groupConfig.repository.rootPath)
);
app.post("/api/projects", async (request, reply) => {
  const input = createProjectSchema.parse(request.body) as CreateReviewProjectInput;
  return reply.status(201).send(await projectStore.create(input, groupConfig.repository.rootPath));
});
app.put<{ Params: { projectId: string } }>("/api/projects/:projectId", async (request) => {
  const input = updateProjectSchema.parse(request.body) as UpdateReviewProjectInput;
  return projectStore.update(request.params.projectId, input, groupConfig.repository.rootPath);
});
app.delete<{ Params: { projectId: string } }>("/api/projects/:projectId", async (request, reply) => {
  await projectStore.delete(request.params.projectId);
  return reply.status(204).send();
});
app.post<{ Params: { projectId: string } }>(
  "/api/projects/:projectId/webhook/rotate",
  async (request) => projectStore.rotateWebhookSecret(request.params.projectId, groupConfig.repository.rootPath)
);
app.get<{ Params: { projectId: string } }>(
  "/api/projects/:projectId/repository/status",
  async (request) => {
    const project = await projectStore.getProject(request.params.projectId, groupConfig.repository.rootPath);
    return gitRepository.status(project);
  }
);
app.get<{ Params: { projectId: string } }>(
  "/api/projects/:projectId/repository/branches",
  async (request) => {
    const project = await projectStore.getProject(request.params.projectId, groupConfig.repository.rootPath);
    return { items: await gitRepository.branches(project) };
  }
);
app.get<{ Params: { projectId: string }; Querystring: Record<string, unknown> }>(
  "/api/projects/:projectId/repository/commits",
  async (request) => {
    const project = await projectStore.getProject(request.params.projectId, groupConfig.repository.rootPath);
    return gitRepository.commits(project, commitQuerySchema.parse(request.query));
  }
);
app.post<{ Params: { projectId: string } }>(
  "/api/projects/:projectId/manual-reviews/preview",
  async (request) => {
    const project = await projectStore.getProject(request.params.projectId, groupConfig.repository.rootPath);
    const input = createManualReviewSchema.parse(request.body) as CreateManualReviewInput;
    return gitRepository.preview(project, input.selection);
  }
);
app.post<{ Params: { projectId: string } }>(
  "/api/projects/:projectId/manual-reviews",
  async (request, reply) => {
    const project = await projectStore.getProject(request.params.projectId, groupConfig.repository.rootPath);
    const input = createManualReviewSchema.parse(request.body) as CreateManualReviewInput;
    const preview = await gitRepository.preview(project, input.selection);
    const task = await projectStore.createManualReview(project, preview, input.requestedBy);
    reviewWorker.wake();
    return reply.status(201).send(task);
  }
);
app.get("/api/reviews", async () => ({ items: await projectStore.listTasks() }));
app.post<{ Params: { taskId: string } }>("/api/reviews/:taskId/retry", async (request) => {
  const task = await projectStore.retryTask(request.params.taskId);
  reviewWorker.wake();
  return task;
});
app.post<{ Params: { hookKey: string } }>("/hooks/gitlab/:hookKey", async (request, reply) => {
  const eventName = request.headers["x-gitlab-event"];
  if (eventName !== "Merge Request Hook") {
    await projectStore.validateWebhookSecret(
      request.params.hookKey,
      headerValue(request.headers["x-gitlab-token"])
    );
    return reply.status(202).send({
      accepted: true,
      queued: false,
      deduplicated: false,
      reason: "unsupported-event"
    });
  }
  const payload = mergeRequestWebhookSchema.parse(request.body) as GitLabMergeRequestPayload;
  const result = await projectStore.receiveWebhook(
    request.params.hookKey,
    headerValue(request.headers["x-gitlab-token"]),
    headerValue(eventName),
    headerValue(request.headers["webhook-id"]) ??
      headerValue(request.headers["idempotency-key"]) ??
      headerValue(request.headers["x-gitlab-webhook-uuid"]),
    payload
  );
  if (result.queued) {
    reviewWorker.wake();
    if (result.taskId) {
      void notifyMergeRequestTriggered(result.taskId).catch((error: unknown) => {
        app.log.warn(
          { taskId: result.taskId, error: error instanceof Error ? error.message : String(error) },
          "Feishu merge request notification failed"
        );
      });
    }
  }
  return reply.status(202).send(result);
});

await app.listen({ host, port: requestedPort });
const actualPort = (app.server.address() as AddressInfo).port;
const callbackHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
const baseUrl = `http://${callbackHost}:${actualPort}`;
runtimeStatus = { ...runtimeStatus, port: actualPort };

const registration: NodeRegistrationInput = {
  groupId,
  instanceId,
  name: groupName,
  host: callbackHost,
  port: actualPort,
  baseUrl,
  version,
  capabilities,
  startedAt
};

let identity = savedIdentity;
let heartbeatIntervalSeconds = 15;

try {
  if (identity) {
    const result = await requestJson<{ heartbeatIntervalSeconds: number }>(
      `${managerUrl}/api/nodes/reconnect`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${identity.nodeToken}`
        },
        body: JSON.stringify(registration)
      }
    );
    heartbeatIntervalSeconds = result.heartbeatIntervalSeconds;
  } else {
    if (!enrollmentToken) throw new Error("首次启动缺少 --enroll-token");
    const result = await requestJson<NodeRegistrationResult>(`${managerUrl}/api/nodes/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${enrollmentToken}`
      },
      body: JSON.stringify(registration)
    });
    heartbeatIntervalSeconds = result.heartbeatIntervalSeconds;
    identity = {
      groupId,
      nodeId: result.nodeId,
      nodeToken: result.nodeToken,
      managerUrl,
      registeredAt: new Date().toISOString()
    };
    await identityStore.save(identity);
  }
  runtimeStatus = { ...runtimeStatus, nodeId: identity.nodeId, status: "online" };
  app.log.info(`Group node registered at ${managerUrl}; local endpoint ${baseUrl}`);
} catch (error) {
  runtimeStatus = { ...runtimeStatus, status: "error" };
  app.log.error(error, "Unable to register group node");
  await app.close();
  throw error;
}

const sendHeartbeat = async () => {
  if (!identity) return;
  try {
    const tasks = await projectStore.listTasks();
    await requestJson(`${managerUrl}/api/nodes/${identity.nodeId}/heartbeat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${identity.nodeToken}`
      },
      body: JSON.stringify({
        groupId,
        instanceId,
        activeReviewCount: tasks.filter((task) => task.status === "running").length,
        repositoryStatus: "unknown",
        startedAt
      })
    });
    runtimeStatus = {
      ...runtimeStatus,
      status: "online",
      lastHeartbeatAt: new Date().toISOString()
    };
  } catch (error) {
    runtimeStatus = { ...runtimeStatus, status: "offline" };
    app.log.warn(error, "Heartbeat failed");
  }
};

await sendHeartbeat();
await reviewWorker.start();
const heartbeatTimer = setInterval(sendHeartbeat, heartbeatIntervalSeconds * 1000);
heartbeatTimer.unref();

async function shutdown(signal: string) {
  clearInterval(heartbeatTimer);
  await reviewWorker.stop();
  runtimeStatus = { ...runtimeStatus, status: "offline" };
  if (identity) {
    try {
      await fetch(`${managerUrl}/api/nodes/${identity.nodeId}/deregister`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${identity.nodeToken}`
        },
        body: JSON.stringify({ groupId })
      });
    } catch {
      // 管理端可能已经退出，节点仍然需要正常结束。
    }
  }
  app.log.info(`${signal} received, group node is stopping`);
  await app.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
