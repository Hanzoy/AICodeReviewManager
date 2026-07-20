import Fastify from "fastify";
import cors from "@fastify/cors";
import { z } from "zod";
import type { NodeHeartbeatInput, NodeRegistrationInput } from "../../shared/contracts.js";
import { HEARTBEAT_TIMEOUT_MS, ManagerFileStore } from "./store.js";

const host = process.env.MANAGER_HOST ?? "127.0.0.1";
const port = Number(process.env.MANAGER_PORT ?? 7000);
const publicUrl = process.env.MANAGER_PUBLIC_URL ?? `http://${host}:${port}`;
const dataDir = process.env.MANAGER_DATA_DIR ?? "./data/manager";
const startedAt = new Date().toISOString();

const app = Fastify({ logger: true, bodyLimit: 2 * 1024 * 1024 });
await app.register(cors, { origin: true });

const store = new ManagerFileStore(dataDir, publicUrl);
await store.init();

async function callGroupNode(
  groupId: string,
  nodePath: string,
  init?: { method?: string; body?: unknown; headers?: Record<string, string | undefined> }
) {
  const group = await store.getGroup(groupId);
  if (!group.node || group.node.status !== "online") throw new Error("GROUP_NODE_OFFLINE");
  let response: Response;
  try {
    response = await fetch(`${group.node.baseUrl}${nodePath}`, {
      method: init?.method ?? "GET",
      headers: {
        ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
        ...Object.fromEntries(
          Object.entries(init?.headers ?? {}).filter((entry): entry is [string, string] => Boolean(entry[1]))
        )
      },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(10_000)
    });
  } catch {
    throw new Error("GROUP_NODE_UNAVAILABLE");
  }
  const text = await response.text();
  const body = text ? (JSON.parse(text) as unknown) : undefined;
  if (!response.ok) {
    const nodeError = body as { error?: string } | undefined;
    if (response.status === 404 && nodeError?.error === "Not Found") {
      throw new Error("GROUP_NODE_UPGRADE_REQUIRED");
    }
    throw new Error(nodeError?.error ?? `GROUP_NODE_REQUEST_FAILED_${response.status}`);
  }
  return body;
}

const createGroupSchema = z.object({
  name: z.string().trim().min(2).max(80),
  key: z
    .string()
    .trim()
    .min(2)
    .max(50)
    .regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/),
  description: z.string().trim().max(300).optional()
});

const registrationSchema = z.object({
  groupId: z.string().uuid(),
  instanceId: z.string().min(8).max(100),
  name: z.string().min(1).max(100),
  host: z.string().min(1).max(200),
  port: z.number().int().min(1).max(65535),
  baseUrl: z.string().url(),
  version: z.string().min(1).max(40),
  capabilities: z.array(z.string().max(80)).max(30),
  startedAt: z.string().datetime()
});

const heartbeatSchema = z.object({
  groupId: z.string().uuid(),
  instanceId: z.string().min(8).max(100),
  activeReviewCount: z.number().int().min(0),
  repositoryStatus: z.enum(["unknown", "healthy", "error"]),
  startedAt: z.string().datetime()
});

function bearerToken(authorization?: string) {
  const [scheme, token] = authorization?.split(" ") ?? [];
  if (scheme?.toLowerCase() !== "bearer" || !token) throw new Error("MISSING_BEARER_TOKEN");
  return token;
}

function headerValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

app.setErrorHandler((error, _request, reply) => {
  const caught = error as Error;
  const statusCode = error instanceof z.ZodError
    ? 400
    : caught.message.includes("NOT_FOUND")
      ? 404
      : caught.message === "INVALID_WEBHOOK_SECRET"
        ? 401
      : caught.message === "WEBHOOK_PROJECT_MISMATCH"
        ? 403
      : caught.message.startsWith("GROUP_NODE_")
        ? 503
        : 400;
  reply.status(statusCode).send({
    error: caught.message,
    details: error instanceof z.ZodError ? error.issues : undefined
  });
});

app.get("/api/health", async () => ({ status: "ok", startedAt }));

app.get("/api/runtime", async () => ({
  name: "Code Review Control Center",
  version: "0.1.0",
  host,
  port,
  publicUrl,
  registrationUrl: `${publicUrl}/api/nodes/register`,
  heartbeatTimeoutSeconds: HEARTBEAT_TIMEOUT_MS / 1000,
  startedAt
}));

app.get("/api/groups", async () => ({ items: await store.listGroups() }));

app.get<{ Params: { groupId: string } }>("/api/groups/:groupId", async (request) => ({
  item: await store.getGroup(request.params.groupId)
}));

app.get<{ Params: { groupId: string } }>(
  "/api/groups/:groupId/workspace",
  async (request) => callGroupNode(request.params.groupId, "/api/dashboard")
);

app.put<{ Params: { groupId: string } }>(
  "/api/groups/:groupId/config",
  async (request) =>
    callGroupNode(request.params.groupId, "/api/config", { method: "PUT", body: request.body })
);

app.get<{ Params: { groupId: string } }>(
  "/api/groups/:groupId/projects",
  async (request) => callGroupNode(request.params.groupId, "/api/projects")
);

app.get<{ Params: { groupId: string; projectId: string } }>(
  "/api/groups/:groupId/projects/:projectId",
  async (request) => callGroupNode(request.params.groupId, `/api/projects/${request.params.projectId}`)
);

app.post<{ Params: { groupId: string } }>(
  "/api/groups/:groupId/projects",
  async (request, reply) =>
    reply.status(201).send(
      await callGroupNode(request.params.groupId, "/api/projects", {
        method: "POST",
        body: request.body
      })
    )
);

app.put<{ Params: { groupId: string; projectId: string } }>(
  "/api/groups/:groupId/projects/:projectId",
  async (request) =>
    callGroupNode(request.params.groupId, `/api/projects/${request.params.projectId}`, {
      method: "PUT",
      body: request.body
    })
);

app.delete<{ Params: { groupId: string; projectId: string } }>(
  "/api/groups/:groupId/projects/:projectId",
  async (request, reply) => {
    await callGroupNode(request.params.groupId, `/api/projects/${request.params.projectId}`, {
      method: "DELETE"
    });
    return reply.status(204).send();
  }
);

app.post<{ Params: { groupId: string; projectId: string } }>(
  "/api/groups/:groupId/projects/:projectId/webhook/rotate",
  async (request) =>
    callGroupNode(
      request.params.groupId,
      `/api/projects/${request.params.projectId}/webhook/rotate`,
      { method: "POST" }
    )
);

for (const repositoryResource of ["status", "branches", "commits"] as const) {
  app.get<{
    Params: { groupId: string; projectId: string };
    Querystring: Record<string, string | undefined>;
  }>(
    `/api/groups/:groupId/projects/:projectId/repository/${repositoryResource}`,
    async (request) => {
      const search = new URLSearchParams(
        Object.entries(request.query ?? {}).filter((entry): entry is [string, string] => Boolean(entry[1]))
      ).toString();
      return callGroupNode(
        request.params.groupId,
        `/api/projects/${request.params.projectId}/repository/${repositoryResource}${search ? `?${search}` : ""}`
      );
    }
  );
}

app.post<{ Params: { groupId: string; projectId: string } }>(
  "/api/groups/:groupId/projects/:projectId/manual-reviews/preview",
  async (request) => callGroupNode(
    request.params.groupId,
    `/api/projects/${request.params.projectId}/manual-reviews/preview`,
    { method: "POST", body: request.body }
  )
);

app.post<{ Params: { groupId: string; projectId: string } }>(
  "/api/groups/:groupId/projects/:projectId/manual-reviews",
  async (request, reply) => reply.status(201).send(await callGroupNode(
    request.params.groupId,
    `/api/projects/${request.params.projectId}/manual-reviews`,
    { method: "POST", body: request.body }
  ))
);

app.get<{ Params: { groupId: string } }>(
  "/api/groups/:groupId/reviews",
  async (request) => callGroupNode(request.params.groupId, "/api/reviews")
);

app.post<{ Params: { groupId: string; taskId: string } }>(
  "/api/groups/:groupId/reviews/:taskId/retry",
  async (request) =>
    callGroupNode(request.params.groupId, `/api/reviews/${request.params.taskId}/retry`, {
      method: "POST"
    })
);

app.post("/api/groups", async (request, reply) => {
  const input = createGroupSchema.parse(request.body);
  const result = await store.createGroup(input);
  return reply.status(201).send(result);
});

app.post<{ Params: { groupId: string } }>(
  "/api/groups/:groupId/enrollment",
  async (request) => store.rotateEnrollment(request.params.groupId)
);

app.delete<{ Params: { groupId: string } }>("/api/groups/:groupId", async (request, reply) => {
  await store.deleteGroup(request.params.groupId);
  return reply.status(204).send();
});

app.post("/api/nodes/register", async (request, reply) => {
  const input = registrationSchema.parse(request.body) as NodeRegistrationInput;
  const token = bearerToken(request.headers.authorization);
  return reply.status(201).send(await store.registerNode(token, input));
});

app.post("/api/nodes/reconnect", async (request) => {
  const input = registrationSchema.parse(request.body) as NodeRegistrationInput;
  const token = bearerToken(request.headers.authorization);
  return store.reconnectNode(token, input);
});

app.post<{ Params: { nodeId: string } }>(
  "/api/nodes/:nodeId/heartbeat",
  async (request) => {
    const input = heartbeatSchema.parse(request.body) as NodeHeartbeatInput;
    const token = bearerToken(request.headers.authorization);
    return store.heartbeat(request.params.nodeId, token, input);
  }
);

app.post<{ Params: { nodeId: string }; Body: { groupId: string } }>(
  "/api/nodes/:nodeId/deregister",
  async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    const groupId = z.string().uuid().parse(request.body?.groupId);
    await store.deregister(request.params.nodeId, token, groupId);
    return reply.status(204).send();
  }
);

app.post<{ Params: { groupId: string; hookKey: string } }>(
  "/hooks/gitlab/:groupId/:hookKey",
  async (request, reply) => {
    const result = await callGroupNode(request.params.groupId, `/hooks/gitlab/${request.params.hookKey}`, {
      method: "POST",
      body: request.body,
      headers: {
        "x-gitlab-token": headerValue(request.headers["x-gitlab-token"]),
        "x-gitlab-event": headerValue(request.headers["x-gitlab-event"]),
        "webhook-id": headerValue(request.headers["webhook-id"]),
        "idempotency-key": headerValue(request.headers["idempotency-key"]),
        "x-gitlab-webhook-uuid": headerValue(request.headers["x-gitlab-webhook-uuid"])
      }
    });
    return reply.status(202).send(result);
  }
);

await app.listen({ host, port });
app.log.info(`Manager API is available at ${publicUrl}`);
