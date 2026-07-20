import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type {
  ReviewResult,
  GroupNodeConfig,
  ReviewProject,
  ReviewTask
} from "../../shared/contracts.js";
import type { GroupConfigStore } from "./config-store.js";
import {
  sendCriticalFindingNotification,
  sendManualReviewCompletedNotification,
  sendReviewCompletedNotification,
  sendReviewFailedNotification
} from "./feishu-notifier.js";
import type { ProjectStore } from "./project-store.js";

const reviewFindingSchema = z.object({
  severity: z.enum(["critical", "high", "medium", "low"]),
  title: z.string().trim().min(1).max(300),
  file: z.string().trim().min(1).max(1000),
  line: z.number().int().positive().nullable(),
  description: z.string().trim().min(1).max(5000),
  suggestion: z.string().trim().max(5000)
}).strict();

export const reviewResultSchema = z.object({
  verdict: z.enum(["approve", "comment", "request_changes"]),
  riskLevel: z.enum(["critical", "high", "medium", "low"]),
  summary: z.string().trim().min(1).max(10000),
  findings: z.array(reviewFindingSchema).max(100),
  positives: z.array(z.string().trim().min(1).max(1000)).max(20)
}).strict();

export const REVIEW_OUTPUT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "riskLevel", "summary", "findings", "positives"],
  properties: {
    verdict: { type: "string", enum: ["approve", "comment", "request_changes"] },
    riskLevel: { type: "string", enum: ["critical", "high", "medium", "low"] },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "title", "file", "line", "description", "suggestion"],
        properties: {
          severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
          title: { type: "string" },
          file: { type: "string" },
          line: { type: ["integer", "null"], minimum: 1 },
          description: { type: "string" },
          suggestion: { type: "string" }
        }
      }
    },
    positives: { type: "array", items: { type: "string" } }
  }
} as const;

interface WorkerLogger {
  info: (details: unknown, message?: string) => void;
  warn: (details: unknown, message?: string) => void;
  error: (details: unknown, message?: string) => void;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

class CommandExecutionError extends Error {
  constructor(
    message: string,
    readonly stdout: string,
    readonly stderr: string
  ) {
    super(message);
  }
}

interface GitLabNote {
  id: number;
  body: string;
}

const OUTPUT_LIMIT = 512 * 1024;

function appendLimited(current: string, chunk: Buffer | string) {
  const next = current + chunk.toString();
  return next.length <= OUTPUT_LIMIT ? next : next.slice(next.length - OUTPUT_LIMIT);
}

function errorMessage(error: unknown) {
  if (error instanceof z.ZodError) {
    return `AI Review 结果不符合约定格式：${error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`;
  }
  return error instanceof Error ? error.message : String(error);
}

export async function resolveReviewRuntimeInvocation(configuredCommand: string) {
  const command = configuredCommand.trim().replace(/^"(.*)"$/, "$1");
  if (command.toLowerCase().endsWith(".js")) {
    return { command: process.execPath, argsPrefix: [command] };
  }
  if (process.platform !== "win32") return { command, argsPrefix: [] as string[] };

  const baseName = path.basename(command).toLowerCase();
  if (!["claude", "claude.cmd", "claude.ps1"].includes(baseName)) {
    return { command, argsPrefix: [] as string[] };
  }
  const searchDirectories = path.isAbsolute(command)
    ? [path.dirname(command)]
    : (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const directory of searchDirectories) {
    const npmRoot = directory.replace(/^"|"$/g, "");
    const nativeExecutable = path.join(
      npmRoot,
      "node_modules",
      "@anthropic-ai",
      "claude-code",
      "bin",
      "claude.exe"
    );
    try {
      if ((await stat(nativeExecutable)).isFile()) {
        return { command: nativeExecutable, argsPrefix: [] as string[] };
      }
    } catch {
      // 尝试旧版 Node 入口。
    }
    const nodeEntryPoint = path.join(npmRoot, "node_modules", "@anthropic-ai", "claude-code", "cli.js");
    try {
      if ((await stat(nodeEntryPoint)).isFile()) {
        return { command: process.execPath, argsPrefix: [nodeEntryPoint] };
      }
    } catch {
      // 继续查找 PATH 中的下一处 Claude 安装。
    }
  }
  return { command, argsPrefix: [] as string[] };
}

export function buildReviewPrompt(task: ReviewTask, config: GroupNodeConfig) {
  const language = config.general.reviewLanguage === "en-US" ? "English" : "简体中文";
  if (task.triggerType === "manual" && task.manualSelection) {
    const selection = task.manualSelection;
    const scopeInstruction = selection.mode === "branch"
      ? `使用 Git 计算 \`origin/${selection.targetBranch}\` 与 \`origin/${selection.branch}\` 的 merge-base，并将审查范围严格限定为该 merge-base 到 \`origin/${selection.branch}\` 的差异。`
      : [
          "只审查以下被用户明确选择的 Commit 各自引入的 Patch，不要把未选择的中间 Commit 自动纳入范围：",
          ...selection.commitShas.map((sha) => `- ${sha}`),
          "普通 Commit 相对其第一父节点审查；根 Commit 使用 git show --root；Merge Commit 默认相对第一父节点审查。"
        ].join("\n");
    return [
      config.ai.reviewPrompt,
      "",
      "<review_context>",
      "Trigger: manual",
      `Project: ${task.projectName}`,
      `Requested by: ${task.requestedBy ?? task.authorName}`,
      `Selection mode: ${selection.mode}`,
      `Target branch: ${selection.targetBranch}`,
      ...(selection.branch ? [`Source branch: ${selection.branch}`] : []),
      `Comment language: ${language}`,
      "</review_context>",
      "",
      scopeInstruction,
      "最终响应只允许包含 JSON Schema 要求的对象。"
    ].join("\n");
  }
  return [
    config.ai.reviewPrompt,
    "",
    "<review_context>",
    `MR: !${task.mergeRequestIid} ${task.mergeRequestTitle}`,
    `Author: ${task.authorName}`,
    `Target branch: ${task.targetBranch}`,
    `Source branch: ${task.sourceBranch}`,
    `Head SHA: ${task.headSha}`,
    `Comment language: ${language}`,
    "</review_context>",
    "",
    `使用 Git 检查 \`origin/${task.targetBranch}\` 与当前 HEAD 的 merge-base，并将审查范围严格限定为该 merge-base 到 HEAD 的差异。`,
    "最终响应只允许包含 JSON Schema 要求的对象。"
  ].join("\n");
}

function stripMarkdownFence(value: string) {
  return value
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

export function parseReviewRuntimeOutput(raw: string) {
  const parsed = JSON.parse(raw.replace(/^\uFEFF/, "").trim()) as {
    is_error?: boolean;
    result?: unknown;
    structured_output?: unknown;
  };
  if (parsed.is_error) {
    throw new Error(`DeepSeek Review 执行失败：${typeof parsed.result === "string" ? parsed.result : raw}`);
  }
  let candidate = parsed.structured_output ?? parsed.result ?? parsed;
  if (typeof candidate === "string") {
    candidate = JSON.parse(stripMarkdownFence(candidate));
  }
  return reviewResultSchema.parse(candidate) as ReviewResult;
}

function deepSeekEnvironment(config: GroupNodeConfig, apiKey: string) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  env.ANTHROPIC_BASE_URL = config.ai.baseUrl;
  env.ANTHROPIC_AUTH_TOKEN = apiKey;
  env.ANTHROPIC_MODEL = config.ai.model;
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = config.ai.model;
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = config.ai.model;
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = config.ai.fastModel;
  env.CLAUDE_CODE_SUBAGENT_MODEL = config.ai.subagentModel;
  env.CLAUDE_CODE_EFFORT_LEVEL = config.ai.reasoningEffort;
  return env;
}

const verdictLabels: Record<ReviewResult["verdict"], string> = {
  approve: "建议通过",
  comment: "建议关注",
  request_changes: "建议修改后再合并"
};

const riskLabels: Record<ReviewResult["riskLevel"], string> = {
  critical: "严重",
  high: "高",
  medium: "中",
  low: "低"
};

const severityLabels: Record<ReviewResult["findings"][number]["severity"], string> = {
  critical: "CRITICAL",
  high: "HIGH",
  medium: "MEDIUM",
  low: "LOW"
};

function safeInlineCode(value: string) {
  return value.replaceAll("`", "ˋ");
}

export function reviewMarker(task: ReviewTask) {
  return `<!-- code-review-helper:task=${task.id};sha=${task.headSha} -->`;
}

export function formatGitLabReviewComment(task: ReviewTask, result: ReviewResult) {
  const lines = [
    "## 🤖 DeepSeek 自动 Code Review",
    "",
    `**结论：** ${verdictLabels[result.verdict]}　 **风险：** ${riskLabels[result.riskLevel]}　 **问题数：** ${result.findings.length}`,
    "",
    result.summary
  ];

  if (result.findings.length === 0) {
    lines.push("", "### Review 结果", "", "未发现需要阻止合并的实质问题。");
  } else {
    lines.push("", "### 发现的问题");
    result.findings.forEach((finding, index) => {
      const location = finding.line ? `${finding.file}:${finding.line}` : finding.file;
      lines.push(
        "",
        `#### ${index + 1}. [${severityLabels[finding.severity]}] ${finding.title}`,
        "",
        `位置：\`${safeInlineCode(location)}\``,
        "",
        finding.description
      );
      if (finding.suggestion) lines.push("", `建议：${finding.suggestion}`);
    });
  }

  if (result.positives.length > 0) {
    lines.push("", "### 做得好的地方", "", ...result.positives.map((item) => `- ${item}`));
  }

  lines.push(
    "",
    "---",
    `Review commit: \`${task.headSha.slice(0, 12)}\` · Task: \`${task.id}\``,
    reviewMarker(task)
  );
  return lines.join("\n");
}

export class ReviewWorker {
  private stopped = true;
  private timer?: NodeJS.Timeout;
  private active?: Promise<boolean>;
  private currentChild?: ChildProcess;
  private readonly schemaPath: string;

  constructor(
    private readonly dataDir: string,
    private readonly projectStore: ProjectStore,
    private readonly configStore: GroupConfigStore,
    private readonly logger: WorkerLogger
  ) {
    this.schemaPath = path.resolve(dataDir, "review-output-schema.json");
  }

  async start() {
    await mkdir(this.dataDir, { recursive: true });
    await writeFile(this.schemaPath, `${JSON.stringify(REVIEW_OUTPUT_JSON_SCHEMA, null, 2)}\n`, "utf8");
    const recovered = await this.projectStore.recoverInterruptedTasks();
    this.stopped = false;
    if (recovered > 0) this.logger.warn({ recovered }, "Recovered interrupted Review tasks");
    this.schedule(0);
  }

  wake() {
    this.schedule(0);
  }

  private schedule(delayMs: number) {
    if (this.stopped || this.active || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.stopped || this.active) return;
      this.active = this.runNextOnce().catch((error) => {
        this.logger.error({ error: errorMessage(error) }, "Review worker loop failed");
        return false;
      });
      void this.active.finally(() => {
        this.active = undefined;
        this.schedule(1000);
      });
    }, delayMs);
    this.timer.unref();
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.currentChild?.kill("SIGTERM");
    await this.active?.catch(() => undefined);
  }

  async runNextOnce() {
    const execution = await this.configStore.getExecutionContext();
    const { config, gitlabToken, aiApiKey } = execution;
    if (
      !gitlabToken ||
      !aiApiKey ||
      !config.ai.baseUrl ||
      (!config.gitlab.apiUrl && !config.gitlab.baseUrl)
    ) return false;

    const task = await this.projectStore.claimNextTask();
    if (!task) return false;
    this.logger.info({ taskId: task.id, mr: task.mergeRequestIid }, "Review task started");

    try {
      const project = await this.projectStore.getProject(task.projectId, config.repository.rootPath);
      if (!project.enabled) throw new Error("项目已停用，无法执行 Review");
      const repositoryPath = await this.prepareRepository(project, task, config, gitlabToken);
      const result = await this.runDeepSeekReview(repositoryPath, task, config, aiApiKey);
      if (!(await this.projectStore.canPublishTask(task.id))) {
        this.logger.info({ taskId: task.id }, "Review result skipped because a newer MR version exists");
        return true;
      }
      let noteId: number | undefined;
      let noteUrl: string | undefined;
      if (task.triggerType === "merge_request") {
        const note = await this.publishGitLabNote(project, task, result, config, gitlabToken);
        noteId = note.id;
        noteUrl = task.mergeRequestUrl ? `${task.mergeRequestUrl}#note_${note.id}` : undefined;
      }
      await this.projectStore.completeTask(task.id, result, noteId, noteUrl);
      this.logger.info({ taskId: task.id, noteId }, "Review task completed");
      await this.notifyReviewOutcome(task, result, noteUrl);
    } catch (error) {
      const message = errorMessage(error);
      await this.projectStore.failTask(task.id, message);
      this.logger.error({ taskId: task.id, error: message }, "Review task failed");
      await this.notifyReviewFailed(task, message);
    }
    return true;
  }

  private async notifyReviewOutcome(task: ReviewTask, result: ReviewResult, noteUrl?: string) {
    try {
      const { config, webhookUrl, signingSecret } = await this.configStore.getFeishuContext();
      if (!config.feishu.enabled || !webhookUrl) return;
      const hasCriticalFinding = result.findings.some((finding) => finding.severity === "critical");
      if (hasCriticalFinding && config.feishu.notifyOnCriticalFinding) {
        await sendCriticalFindingNotification({
          webhookUrl,
          signingSecret,
          groupName: config.general.displayName,
          task,
          result,
          noteUrl
        });
        this.logger.info({ taskId: task.id }, "Feishu critical finding notification sent");
        return;
      }
      if (task.triggerType === "manual") {
        if (!config.feishu.notifyOnManualReviewCompleted) return;
        await sendManualReviewCompletedNotification({
          webhookUrl,
          signingSecret,
          groupName: config.general.displayName,
          task,
          result
        });
        this.logger.info({ taskId: task.id }, "Feishu manual Review completed notification sent");
        return;
      }
      if (!config.feishu.notifyOnReviewCompleted) return;
      await sendReviewCompletedNotification({
        webhookUrl,
        signingSecret,
        groupName: config.general.displayName,
        task,
        result,
        noteUrl
      });
      this.logger.info({ taskId: task.id }, "Feishu Review completed notification sent");
    } catch (error) {
      this.logger.warn(
        { taskId: task.id, error: errorMessage(error) },
        "Feishu Review outcome notification failed"
      );
    }
  }

  private async notifyReviewFailed(task: ReviewTask, message: string) {
    try {
      const { config, webhookUrl, signingSecret } = await this.configStore.getFeishuContext();
      if (!config.feishu.enabled || !config.feishu.notifyOnReviewFailed || !webhookUrl) return;
      await sendReviewFailedNotification({
        webhookUrl,
        signingSecret,
        groupName: config.general.displayName,
        task,
        error: message
      });
      this.logger.info({ taskId: task.id }, "Feishu Review failed notification sent");
    } catch (error) {
      this.logger.warn(
        { taskId: task.id, error: errorMessage(error) },
        "Feishu Review failed notification failed"
      );
    }
  }

  private async prepareRepository(
    project: ReviewProject,
    task: ReviewTask,
    config: GroupNodeConfig,
    gitlabToken: string
  ) {
    const repositoryPath = project.localRepositoryPath;
    const gitDirectory = path.join(repositoryPath, ".git");
    const gitEnvironment = await this.gitEnvironment(project.repositoryUrl, gitlabToken);
    let repositoryExists = false;
    try {
      repositoryExists = (await stat(gitDirectory)).isDirectory();
    } catch {
      repositoryExists = false;
    }

    if (!repositoryExists) {
      try {
        await stat(repositoryPath);
        throw new Error(`仓库目录已存在但不是 Git 仓库：${repositoryPath}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await mkdir(path.dirname(repositoryPath), { recursive: true });
      const cloneArgs = ["clone", "--origin", "origin"];
      if (config.repository.cloneDepth > 0) {
        cloneArgs.push("--depth", String(config.repository.cloneDepth));
      }
      cloneArgs.push(project.repositoryUrl, repositoryPath);
      await this.runCommand("git", cloneArgs, {
        cwd: path.dirname(repositoryPath),
        env: gitEnvironment,
        timeoutMs: config.gitlab.requestTimeoutSeconds * 1000 * 10
      });
    }

    const status = await this.runCommand("git", ["status", "--porcelain"], {
      cwd: repositoryPath,
      env: gitEnvironment,
      timeoutMs: 30_000
    });
    if (status.stdout.trim()) {
      throw new Error(`仓库存在未提交修改，已停止自动切换分支：${repositoryPath}`);
    }

    await this.runCommand("git", ["remote", "set-url", "origin", project.repositoryUrl], {
      cwd: repositoryPath,
      env: gitEnvironment,
      timeoutMs: 30_000
    });
    const fetchArgs = ["fetch", "--prune", "origin"];
    if (config.repository.cloneDepth > 0) {
      fetchArgs.push("--depth", String(config.repository.cloneDepth));
    }
    fetchArgs.push(`+refs/heads/${task.targetBranch}:refs/remotes/origin/${task.targetBranch}`);
    if (task.triggerType === "manual" && task.manualSelection?.mode === "branch") {
      fetchArgs.push(
        `+refs/heads/${task.manualSelection.branch}:refs/remotes/origin/${task.manualSelection.branch}`
      );
    } else if (task.triggerType === "merge_request") {
      fetchArgs.push(
        `+refs/merge-requests/${task.mergeRequestIid}/head:refs/remotes/origin/merge-requests/${task.mergeRequestIid}/head`
      );
    }
    await this.runCommand("git", fetchArgs, {
      cwd: repositoryPath,
      env: gitEnvironment,
      timeoutMs: config.gitlab.requestTimeoutSeconds * 1000 * 10
    });

    if (task.triggerType === "manual" && task.manualSelection) {
      const checkoutRef = task.manualSelection.mode === "branch"
        ? `refs/remotes/origin/${task.manualSelection.branch}`
        : task.manualSelection.commitShas.at(-1);
      if (!checkoutRef) throw new Error("手动 Review 没有可用的 Checkout 目标");
      for (const sha of task.manualSelection.commitShas) {
        await this.runCommand("git", ["rev-parse", "--verify", `${sha}^{commit}`], {
          cwd: repositoryPath,
          env: gitEnvironment,
          timeoutMs: 30_000
        });
      }
      await this.runCommand("git", ["checkout", "--detach", checkoutRef], {
        cwd: repositoryPath,
        env: gitEnvironment,
        timeoutMs: 120_000
      });
      return repositoryPath;
    }

    const mrRef = `refs/remotes/origin/merge-requests/${task.mergeRequestIid}/head`;
    const fetchedHead = await this.runCommand("git", ["rev-parse", mrRef], {
      cwd: repositoryPath,
      env: gitEnvironment,
      timeoutMs: 30_000
    });
    if (fetchedHead.stdout.trim().toLowerCase() !== task.headSha.toLowerCase()) {
      throw new Error(`MR HEAD 已变化：Webhook=${task.headSha}，GitLab=${fetchedHead.stdout.trim()}`);
    }
    await this.runCommand("git", ["checkout", "--detach", mrRef], {
      cwd: repositoryPath,
      env: gitEnvironment,
      timeoutMs: 120_000
    });
    return repositoryPath;
  }

  private async gitEnvironment(repositoryUrl: string, gitlabToken: string) {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never"
    };
    if (!/^https?:\/\//i.test(repositoryUrl)) return env;

    const askPassPath = path.resolve(this.dataDir, process.platform === "win32" ? "git-askpass.cmd" : "git-askpass.sh");
    const script = process.platform === "win32"
      ? "@echo off\r\necho %~1 | findstr /I \"Username\" >nul\r\nif %errorlevel%==0 (echo oauth2) else (echo %CODE_REVIEW_GITLAB_TOKEN%)\r\n"
      : "#!/bin/sh\ncase \"$1\" in *Username*) printf '%s\\n' oauth2 ;; *) printf '%s\\n' \"$CODE_REVIEW_GITLAB_TOKEN\" ;; esac\n";
    await writeFile(askPassPath, script, { encoding: "utf8", mode: 0o700 });
    if (process.platform !== "win32") await chmod(askPassPath, 0o700);
    env.GIT_ASKPASS = askPassPath;
    env.CODE_REVIEW_GITLAB_TOKEN = gitlabToken;
    return env;
  }

  private async runDeepSeekReview(
    repositoryPath: string,
    task: ReviewTask,
    config: GroupNodeConfig,
    apiKey: string
  ) {
    const artifactDirectory = path.resolve(this.dataDir, "review-artifacts", task.id);
    await mkdir(artifactDirectory, { recursive: true });

    const args = [
      "--print",
      "--input-format", "text",
      "--output-format", "json",
      "--json-schema", JSON.stringify(REVIEW_OUTPUT_JSON_SCHEMA),
      "--permission-mode", "dontAsk",
      "--no-session-persistence",
      "--safe-mode",
      "--tools", "Read,Glob,Grep,Bash,Agent",
      "--allowedTools", [
        "Read",
        "Glob",
        "Grep",
        "Agent",
        "Bash(git status:*)",
        "Bash(git diff:*)",
        "Bash(git show:*)",
        "Bash(git log:*)",
        "Bash(git merge-base:*)",
        "Bash(git rev-parse:*)",
        "Bash(git ls-files:*)",
        "Bash(git blame:*)"
      ].join(","),
      "--disallowedTools", "Edit,Write,NotebookEdit,WebFetch,WebSearch",
      "--effort", config.ai.reasoningEffort
    ];
    if (config.ai.model.trim()) args.push("--model", config.ai.model.trim());

    const runtimeCommand = process.env.DEEPSEEK_REVIEW_COMMAND?.trim() || "claude";
    const invocation = await resolveReviewRuntimeInvocation(runtimeCommand);
    let commandResult: CommandResult;
    try {
      commandResult = await this.runCommand(invocation.command, [...invocation.argsPrefix, ...args], {
        cwd: repositoryPath,
        env: deepSeekEnvironment(config, apiKey),
        input: buildReviewPrompt(task, config),
        timeoutMs: config.ai.requestTimeoutSeconds * 1000
      });
    } catch (error) {
      if (error instanceof CommandExecutionError) {
        await Promise.all([
          writeFile(path.join(artifactDirectory, "deepseek.stdout.log"), error.stdout, "utf8"),
          writeFile(path.join(artifactDirectory, "deepseek.stderr.log"), error.stderr, "utf8")
        ]);
      }
      throw new Error(
        errorMessage(error)
          .replaceAll(invocation.command, "DeepSeek Review 执行器")
          .replace(/claude/gi, "DeepSeek")
      );
    }
    await Promise.all([
      writeFile(path.join(artifactDirectory, "deepseek.stdout.json"), commandResult.stdout, "utf8"),
      writeFile(path.join(artifactDirectory, "deepseek.stderr.log"), commandResult.stderr, "utf8")
    ]);
    const result = parseReviewRuntimeOutput(commandResult.stdout);
    await writeFile(path.join(artifactDirectory, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
    return result;
  }

  private async publishGitLabNote(
    project: ReviewProject,
    task: ReviewTask,
    result: ReviewResult,
    config: GroupNodeConfig,
    gitlabToken: string
  ) {
    const apiBase = (config.gitlab.apiUrl || `${config.gitlab.baseUrl.replace(/\/$/, "")}/api/v4`).replace(/\/$/, "");
    const projectRef = encodeURIComponent(project.gitlabProjectRef);
    const notesUrl = `${apiBase}/projects/${projectRef}/merge_requests/${task.mergeRequestIid}/notes`;
    const headers = { "PRIVATE-TOKEN": gitlabToken, "content-type": "application/json" };
    const marker = reviewMarker(task);
    const listResponse = await fetch(`${notesUrl}?sort=desc&order_by=updated_at&per_page=100`, {
      headers: { "PRIVATE-TOKEN": gitlabToken },
      signal: AbortSignal.timeout(config.gitlab.requestTimeoutSeconds * 1000)
    });
    if (!listResponse.ok) {
      throw new Error(`读取 GitLab MR 评论失败：${listResponse.status} ${await listResponse.text()}`);
    }
    const existing = ((await listResponse.json()) as GitLabNote[]).find((note) => note.body.includes(marker));
    if (existing) return existing;

    const response = await fetch(notesUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ body: formatGitLabReviewComment(task, result) }),
      signal: AbortSignal.timeout(config.gitlab.requestTimeoutSeconds * 1000)
    });
    if (!response.ok) {
      throw new Error(`发布 GitLab MR 评论失败：${response.status} ${await response.text()}`);
    }
    return (await response.json()) as GitLabNote;
  }

  private runCommand(
    command: string,
    args: string[],
    options: { cwd: string; env?: NodeJS.ProcessEnv; input?: string; timeoutMs: number }
  ) {
    return new Promise<CommandResult>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false
      });
      this.currentChild = child;
      child.stdout.on("data", (chunk: Buffer) => { stdout = appendLimited(stdout, chunk); });
      child.stderr.on("data", (chunk: Buffer) => { stderr = appendLimited(stderr, chunk); });
      child.once("error", (error) => {
        this.currentChild = undefined;
        reject(new Error(`无法启动命令 ${command}：${error.message}`));
      });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, options.timeoutMs);
      timer.unref();
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        this.currentChild = undefined;
        const detail = (stderr.trim() || stdout.trim()).slice(-4000);
        if (timedOut) {
          reject(new CommandExecutionError(
            `命令执行超时（${options.timeoutMs / 1000} 秒）：${command}${detail ? `：${detail}` : ""}`,
            stdout,
            stderr
          ));
        } else if (code !== 0) {
          reject(new CommandExecutionError(
            `命令执行失败 ${command}（exit=${code}, signal=${signal ?? "none"}）：${detail}`,
            stdout,
            stderr
          ));
        } else {
          resolve({ stdout, stderr });
        }
      });
      child.stdin.end(options.input);
    });
  }
}
