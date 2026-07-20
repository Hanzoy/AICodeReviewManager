import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  CreateReviewProjectInput,
  GitLabWebhookResult,
  ManualReviewPreview,
  ProjectWebhookCredentials,
  ReviewProject,
  ReviewTask,
  UpdateReviewProjectInput
} from "../../shared/contracts.js";

interface StoredReviewProject {
  id: string;
  key: string;
  name: string;
  description: string;
  enabled: boolean;
  gitlabProjectRef: string;
  repositoryUrl: string;
  defaultBranch: string;
  webhookKey: string;
  webhookSecretHash: string;
  webhookState: "waiting" | "active";
  webhookLastEventAt?: string;
  webhookLastEventName?: string;
  createdAt: string;
  updatedAt: string;
}

interface GitLabMergeRequestPayload {
  object_kind: "merge_request";
  user?: { name?: string; username?: string };
  project: {
    id: number;
    path_with_namespace?: string;
  };
  object_attributes: {
    iid: number;
    title?: string;
    action?: string;
    state?: string;
    source_branch?: string;
    target_branch?: string;
    url?: string;
    last_commit?: { id?: string };
  };
}

function hashSecret(secret: string) {
  return createHash("sha256").update(secret).digest("hex");
}

function secretMatches(secret: string, expectedHash: string) {
  const actual = Buffer.from(hashSecret(secret), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export class ProjectStore {
  private readonly projectsFile: string;
  private readonly tasksFile: string;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(
    dataDir: string,
    private readonly managerUrl: string,
    private readonly groupId: string
  ) {
    this.projectsFile = path.join(dataDir, "projects.json");
    this.tasksFile = path.join(dataDir, "review-queue.json");
  }

  async init() {
    await mkdir(path.dirname(this.projectsFile), { recursive: true });
    await this.ensureFile(this.projectsFile, []);
    await this.ensureFile(this.tasksFile, []);
  }

  private async ensureFile(filePath: string, initialValue: unknown) {
    try {
      await readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.atomicWrite(filePath, initialValue);
    }
  }

  private async atomicWrite(filePath: string, value: unknown) {
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    try {
      await rename(tempPath, filePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "EPERM") throw error;
      await rm(filePath, { force: true });
      await rename(tempPath, filePath);
    }
  }

  private withWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.catch(() => undefined);
    return result;
  }

  private async readProjects() {
    return JSON.parse(await readFile(this.projectsFile, "utf8")) as StoredReviewProject[];
  }

  private async readTasks() {
    const tasks = JSON.parse(await readFile(this.tasksFile, "utf8")) as Array<ReviewTask & {
      triggerType?: ReviewTask["triggerType"];
    }>;
    return tasks.map((task) => ({ ...task, triggerType: task.triggerType ?? "merge_request" }));
  }

  private webhookUrl(hookKey: string) {
    return `${this.managerUrl.replace(/\/$/, "")}/hooks/gitlab/${this.groupId}/${hookKey}`;
  }

  private toPublic(project: StoredReviewProject, repositoryRoot: string): ReviewProject {
    return {
      id: project.id,
      key: project.key,
      name: project.name,
      description: project.description,
      enabled: project.enabled,
      gitlabProjectRef: project.gitlabProjectRef,
      repositoryUrl: project.repositoryUrl,
      defaultBranch: project.defaultBranch,
      localRepositoryPath: path.resolve(repositoryRoot, project.key),
      webhook: {
        url: this.webhookUrl(project.webhookKey),
        secretConfigured: Boolean(project.webhookSecretHash),
        state: project.webhookState,
        lastEventAt: project.webhookLastEventAt,
        lastEventName: project.webhookLastEventName
      },
      createdAt: project.createdAt,
      updatedAt: project.updatedAt
    };
  }

  async list(repositoryRoot: string) {
    return (await this.readProjects()).map((project) => this.toPublic(project, repositoryRoot));
  }

  async getProject(projectId: string, repositoryRoot: string) {
    const project = (await this.readProjects()).find((item) => item.id === projectId);
    if (!project) throw new Error("REVIEW_PROJECT_NOT_FOUND");
    return this.toPublic(project, repositoryRoot);
  }

  async create(input: CreateReviewProjectInput, repositoryRoot: string): Promise<ProjectWebhookCredentials> {
    return this.withWrite(async () => {
      const projects = await this.readProjects();
      if (projects.some((project) => project.key.toLowerCase() === input.key.toLowerCase())) {
        throw new Error("REVIEW_PROJECT_KEY_EXISTS");
      }
      if (
        projects.some(
          (project) => project.gitlabProjectRef.toLowerCase() === input.gitlabProjectRef.toLowerCase()
        )
      ) {
        throw new Error("GITLAB_PROJECT_ALREADY_CONFIGURED");
      }
      const now = new Date().toISOString();
      const secret = `glwh_${randomBytes(32).toString("base64url")}`;
      const project: StoredReviewProject = {
        id: randomUUID(),
        key: input.key,
        name: input.name,
        description: input.description ?? "",
        enabled: input.enabled ?? true,
        gitlabProjectRef: input.gitlabProjectRef,
        repositoryUrl: input.repositoryUrl,
        defaultBranch: input.defaultBranch,
        webhookKey: randomBytes(18).toString("base64url"),
        webhookSecretHash: hashSecret(secret),
        webhookState: "waiting",
        createdAt: now,
        updatedAt: now
      };
      projects.push(project);
      await this.atomicWrite(this.projectsFile, projects);
      return { project: this.toPublic(project, repositoryRoot), secret };
    });
  }

  async update(projectId: string, input: UpdateReviewProjectInput, repositoryRoot: string) {
    return this.withWrite(async () => {
      const projects = await this.readProjects();
      const project = projects.find((item) => item.id === projectId);
      if (!project) throw new Error("REVIEW_PROJECT_NOT_FOUND");
      if (
        input.gitlabProjectRef &&
        projects.some(
          (item) =>
            item.id !== projectId &&
            item.gitlabProjectRef.toLowerCase() === input.gitlabProjectRef?.toLowerCase()
        )
      ) {
        throw new Error("GITLAB_PROJECT_ALREADY_CONFIGURED");
      }
      Object.assign(project, input, { updatedAt: new Date().toISOString() });
      await this.atomicWrite(this.projectsFile, projects);
      return this.toPublic(project, repositoryRoot);
    });
  }

  async delete(projectId: string) {
    return this.withWrite(async () => {
      const projects = await this.readProjects();
      const project = projects.find((item) => item.id === projectId);
      if (!project) throw new Error("REVIEW_PROJECT_NOT_FOUND");
      const tasks = await this.readTasks();
      const now = new Date().toISOString();
      for (const task of tasks) {
        if (task.projectId === projectId && (task.status === "queued" || task.status === "running")) {
          task.status = "cancelled";
          task.updatedAt = now;
        }
      }
      await this.atomicWrite(this.tasksFile, tasks);
      await this.atomicWrite(this.projectsFile, projects.filter((item) => item.id !== projectId));
    });
  }

  async rotateWebhookSecret(projectId: string, repositoryRoot: string): Promise<ProjectWebhookCredentials> {
    return this.withWrite(async () => {
      const projects = await this.readProjects();
      const project = projects.find((item) => item.id === projectId);
      if (!project) throw new Error("REVIEW_PROJECT_NOT_FOUND");
      const secret = `glwh_${randomBytes(32).toString("base64url")}`;
      project.webhookSecretHash = hashSecret(secret);
      project.webhookState = "waiting";
      project.webhookLastEventAt = undefined;
      project.webhookLastEventName = undefined;
      project.updatedAt = new Date().toISOString();
      await this.atomicWrite(this.projectsFile, projects);
      return { project: this.toPublic(project, repositoryRoot), secret };
    });
  }

  async listTasks() {
    return (await this.readTasks()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async recoverInterruptedTasks() {
    return this.withWrite(async () => {
      const tasks = await this.readTasks();
      const now = new Date().toISOString();
      let recovered = 0;
      for (const task of tasks) {
        if (task.status !== "running") continue;
        task.status = "queued";
        task.retryCount += 1;
        task.startedAt = undefined;
        task.updatedAt = now;
        task.error = "项目组节点在 Review 执行期间停止，任务已重新排队";
        recovered += 1;
      }
      if (recovered > 0) await this.atomicWrite(this.tasksFile, tasks);
      return recovered;
    });
  }

  async claimNextTask() {
    return this.withWrite(async () => {
      const tasks = await this.readTasks();
      const task = tasks.find((item) => item.status === "queued");
      if (!task) return undefined;
      const now = new Date().toISOString();
      task.status = "running";
      task.startedAt = now;
      task.updatedAt = now;
      task.error = undefined;
      await this.atomicWrite(this.tasksFile, tasks);
      return { ...task };
    });
  }

  async canPublishTask(taskId: string) {
    return this.withWrite(async () => {
      const tasks = await this.readTasks();
      const task = tasks.find((item) => item.id === taskId);
      if (!task || task.status !== "running") return false;
      if (task.triggerType === "manual") return true;
      const hasNewerVersion = tasks.some(
        (item) =>
          item.id !== task.id &&
          item.projectId === task.projectId &&
          item.mergeRequestIid === task.mergeRequestIid &&
          item.createdAt > task.createdAt &&
          ["queued", "running", "completed"].includes(item.status)
      );
      if (!hasNewerVersion) return true;
      task.status = "superseded";
      task.updatedAt = new Date().toISOString();
      await this.atomicWrite(this.tasksFile, tasks);
      return false;
    });
  }

  async completeTask(
    taskId: string,
    result: NonNullable<ReviewTask["result"]>,
    gitlabNoteId?: number,
    gitlabNoteUrl?: string
  ) {
    return this.withWrite(async () => {
      const tasks = await this.readTasks();
      const task = tasks.find((item) => item.id === taskId);
      if (!task || task.status !== "running") return false;
      const now = new Date().toISOString();
      task.status = "completed";
      task.result = result;
      task.gitlabNoteId = gitlabNoteId;
      task.gitlabNoteUrl = gitlabNoteUrl;
      task.completedAt = now;
      task.updatedAt = now;
      task.error = undefined;
      await this.atomicWrite(this.tasksFile, tasks);
      return true;
    });
  }

  async failTask(taskId: string, error: string) {
    return this.withWrite(async () => {
      const tasks = await this.readTasks();
      const task = tasks.find((item) => item.id === taskId);
      if (!task || task.status !== "running") return false;
      const now = new Date().toISOString();
      task.status = "failed";
      task.error = error.slice(0, 4000);
      task.completedAt = now;
      task.updatedAt = now;
      await this.atomicWrite(this.tasksFile, tasks);
      return true;
    });
  }

  async retryTask(taskId: string) {
    return this.withWrite(async () => {
      const tasks = await this.readTasks();
      const task = tasks.find((item) => item.id === taskId);
      if (!task) throw new Error("REVIEW_TASK_NOT_FOUND");
      if (task.status !== "failed") throw new Error("REVIEW_TASK_NOT_RETRYABLE");
      const now = new Date().toISOString();
      task.status = "queued";
      task.retryCount += 1;
      task.startedAt = undefined;
      task.completedAt = undefined;
      task.updatedAt = now;
      task.error = undefined;
      task.result = undefined;
      task.gitlabNoteId = undefined;
      task.gitlabNoteUrl = undefined;
      await this.atomicWrite(this.tasksFile, tasks);
      return { ...task };
    });
  }

  async createManualReview(project: ReviewProject, preview: ManualReviewPreview, requestedBy?: string) {
    return this.withWrite(async () => {
      if (!project.enabled) throw new Error("REVIEW_PROJECT_DISABLED");
      const tasks = await this.readTasks();
      const now = new Date().toISOString();
      const selection = preview.selection;
      const task: ReviewTask = {
        id: randomUUID(),
        triggerType: "manual",
        projectId: project.id,
        projectName: project.name,
        mergeRequestIid: 0,
        mergeRequestTitle: selection.mode === "branch"
          ? `手动分支 Review · ${selection.branch} → ${selection.targetBranch}`
          : `手动 Commit Review · ${selection.commitShas.length} 个 Commit`,
        sourceBranch: selection.branch ?? "selected-commits",
        targetBranch: selection.targetBranch,
        headSha: selection.commitShas.at(-1) ?? "",
        authorName: requestedBy?.trim() || "手动发起",
        requestedBy: requestedBy?.trim() || "手动发起",
        action: "manual",
        status: "queued",
        manualSelection: selection,
        manualPreview: preview,
        retryCount: 0,
        createdAt: now,
        updatedAt: now
      };
      tasks.push(task);
      await this.atomicWrite(this.tasksFile, tasks);
      return task;
    });
  }

  async stats() {
    const [projects, tasks] = await Promise.all([this.readProjects(), this.readTasks()]);
    return {
      projectCount: projects.length,
      queuedReviewCount: tasks.filter((task) => task.status === "queued").length,
      completedReviewCount: tasks.filter((task) => task.status === "completed").length,
      findingCount: tasks.reduce((count, task) => count + (task.result?.findings.length ?? 0), 0)
    };
  }

  async recentReviews() {
    return (await this.listTasks()).slice(0, 8).map((task) => ({
      id: task.id,
      projectName: task.projectName,
      mergeRequest: task.triggerType === "manual"
        ? task.mergeRequestTitle
        : `!${task.mergeRequestIid} ${task.mergeRequestTitle}`,
      status: task.status,
      completedAt: task.completedAt
    }));
  }

  async validateWebhookSecret(hookKey: string, secret: string | undefined) {
    const project = (await this.readProjects()).find((item) => item.webhookKey === hookKey);
    if (!project) throw new Error("WEBHOOK_NOT_FOUND");
    if (!secret || !secretMatches(secret, project.webhookSecretHash)) {
      throw new Error("INVALID_WEBHOOK_SECRET");
    }
  }

  async receiveWebhook(
    hookKey: string,
    secret: string | undefined,
    eventName: string | undefined,
    deliveryId: string | undefined,
    payload: GitLabMergeRequestPayload
  ): Promise<GitLabWebhookResult> {
    return this.withWrite(async () => {
      const projects = await this.readProjects();
      const project = projects.find((item) => item.webhookKey === hookKey);
      if (!project) throw new Error("WEBHOOK_NOT_FOUND");
      if (!secret || !secretMatches(secret, project.webhookSecretHash)) {
        throw new Error("INVALID_WEBHOOK_SECRET");
      }

      const configuredRef = project.gitlabProjectRef.toLowerCase();
      const payloadRefs = [String(payload.project.id), payload.project.path_with_namespace]
        .filter((value): value is string => Boolean(value))
        .map((value) => value.toLowerCase());
      if (!payloadRefs.includes(configuredRef)) throw new Error("WEBHOOK_PROJECT_MISMATCH");

      const now = new Date().toISOString();
      project.webhookState = "active";
      project.webhookLastEventAt = now;
      project.webhookLastEventName = eventName ?? "Unknown Hook";
      project.updatedAt = now;
      await this.atomicWrite(this.projectsFile, projects);

      if (eventName !== "Merge Request Hook" || payload.object_kind !== "merge_request") {
        return { accepted: true, queued: false, deduplicated: false, reason: "unsupported-event" };
      }
      if (!project.enabled) {
        return { accepted: true, queued: false, deduplicated: false, reason: "project-disabled" };
      }

      const tasks = await this.readTasks();
      if (deliveryId && tasks.some((task) => task.deliveryId === deliveryId)) {
        return { accepted: true, queued: false, deduplicated: true, reason: "duplicate-delivery" };
      }

      const attributes = payload.object_attributes;
      const action = attributes.action ?? "update";
      if (action === "close" || action === "merge" || attributes.state === "closed" || attributes.state === "merged") {
        for (const task of tasks) {
          if (
            task.projectId === project.id &&
            task.mergeRequestIid === attributes.iid &&
            (task.status === "queued" || task.status === "running")
          ) {
            task.status = "cancelled";
            task.updatedAt = now;
          }
        }
        await this.atomicWrite(this.tasksFile, tasks);
        return { accepted: true, queued: false, deduplicated: false, reason: `merge-request-${action}` };
      }

      const headSha = attributes.last_commit?.id;
      if (!headSha) {
        return { accepted: true, queued: false, deduplicated: false, reason: "missing-head-sha" };
      }
      const duplicate = tasks.find(
        (task) =>
          task.projectId === project.id &&
          task.mergeRequestIid === attributes.iid &&
          task.headSha === headSha &&
          ["queued", "running", "completed"].includes(task.status)
      );
      if (duplicate) {
        return {
          accepted: true,
          queued: false,
          deduplicated: true,
          reason: "same-merge-request-version",
          taskId: duplicate.id
        };
      }

      for (const task of tasks) {
        if (
          task.projectId === project.id &&
          task.mergeRequestIid === attributes.iid &&
          task.status === "queued"
        ) {
          task.status = "superseded";
          task.updatedAt = now;
        }
      }

      const task: ReviewTask = {
        id: randomUUID(),
        triggerType: "merge_request",
        projectId: project.id,
        projectName: project.name,
        mergeRequestIid: attributes.iid,
        mergeRequestTitle: attributes.title ?? "Untitled merge request",
        mergeRequestUrl: attributes.url,
        sourceBranch: attributes.source_branch ?? "",
        targetBranch: attributes.target_branch ?? project.defaultBranch,
        headSha,
        authorName: payload.user?.name ?? payload.user?.username ?? "Unknown",
        action,
        status: "queued",
        deliveryId,
        retryCount: 0,
        createdAt: now,
        updatedAt: now
      };
      tasks.push(task);
      await this.atomicWrite(this.tasksFile, tasks);
      return { accepted: true, queued: true, deduplicated: false, taskId: task.id };
    });
  }
}

export type { GitLabMergeRequestPayload };
