import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { ReviewResult } from "../shared/contracts.js";
import { GroupConfigStore } from "../server/group/config-store.js";
import {
  buildCriticalFindingText,
  buildReviewFailedText
} from "../server/group/feishu-notifier.js";
import { ProjectStore } from "../server/group/project-store.js";
import { GitRepositoryService } from "../server/group/git-repository.js";
import { GitOperationCoordinator } from "../server/group/git-operation-coordinator.js";
import {
  ReviewWorker,
  REVIEW_OUTPUT_JSON_SCHEMA,
  buildReviewPrompt,
  resolveReviewRuntimeInvocation,
  reviewMarker
} from "../server/group/review-worker.js";

async function command(program: string, args: string[], cwd: string) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(program, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(`${program} failed: ${stderr}`)));
  });
}

async function waitForResult(store: ProjectStore, taskId?: string) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const tasks = await store.listTasks();
    const task = taskId ? tasks.find((item) => item.id === taskId) : tasks[0];
    if (task?.status === "completed" || task?.status === "failed") return task;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Review worker integration test timed out");
}

const root = path.resolve("runtime", "review-worker-test", randomBytes(5).toString("hex"));
const seedRepository = path.join(root, "seed");
const remoteRepository = path.join(root, "remote.git");
const groupData = path.join(root, "group");
const repositoryRoot = path.join(root, "repositories");
const fakeReviewCli = path.join(root, "fake-review-cli.js");
const originalReviewCommand = process.env.DEEPSEEK_REVIEW_COMMAND;
let postedComment = "";
const feishuMessages: Array<{ timestamp?: string; sign?: string; content?: { text?: string } }> = [];

const gitLabServer = createServer((request, response) => {
  if (request.method === "GET") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("[]");
    return;
  }
  if (request.method === "POST") {
    let body = "";
    request.on("data", (chunk) => { body += chunk.toString(); });
    request.on("end", () => {
      if (request.url === "/feishu") {
        feishuMessages.push(JSON.parse(body) as (typeof feishuMessages)[number]);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ code: 0, msg: "success" }));
        return;
      }
      postedComment = (JSON.parse(body) as { body: string }).body;
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: 9001, body: postedComment }));
    });
    return;
  }
  response.writeHead(404).end();
});

try {
  if ("$schema" in REVIEW_OUTPUT_JSON_SCHEMA) {
    throw new Error("Review runtime schema must not reference an unavailable JSON meta-schema");
  }
  const runtimeInvocation = await resolveReviewRuntimeInvocation("claude");
  if (
    process.platform === "win32" &&
    !runtimeInvocation.command.endsWith("claude.exe") &&
    !runtimeInvocation.argsPrefix[0]?.endsWith("cli.js")
  ) {
    throw new Error("Windows Review runtime shim was not resolved to a runnable entry point");
  }
  await mkdir(seedRepository, { recursive: true });
  await command("git", ["init", "--initial-branch=main"], seedRepository);
  await command("git", ["config", "user.email", "review-worker@example.com"], seedRepository);
  await command("git", ["config", "user.name", "Review Worker Test"], seedRepository);
  await writeFile(path.join(seedRepository, "sample.ts"), "export const value = 1;\n", "utf8");
  await command("git", ["add", "sample.ts"], seedRepository);
  await command("git", ["commit", "-m", "base"], seedRepository);
  await command("git", ["init", "--bare", remoteRepository], root);
  await command("git", ["remote", "add", "origin", remoteRepository], seedRepository);
  await command("git", ["push", "origin", "main"], seedRepository);
  await writeFile(path.join(seedRepository, "sample.ts"), "export const value = 2;\n", "utf8");
  await command("git", ["add", "sample.ts"], seedRepository);
  await command("git", ["commit", "-m", "feature"], seedRepository);
  const headSha = await command("git", ["rev-parse", "HEAD"], seedRepository);
  await command("git", ["push", "origin", "HEAD:refs/merge-requests/1/head"], seedRepository);

  await new Promise<void>((resolve) => gitLabServer.listen(0, "127.0.0.1", resolve));
  const gitLabPort = (gitLabServer.address() as AddressInfo).port;

  await writeFile(
    fakeReviewCli,
    [
      "if (process.argv.includes('--json-schema')) {",
      "  const { readFileSync } = await import('node:fs');",
      "  const prompt = readFileSync(0, 'utf8');",
      "  const allowedTools = process.argv[process.argv.indexOf('--allowedTools') + 1] || '';",
      "  const expected = { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', ANTHROPIC_AUTH_TOKEN: 'deepseek-integration-test-key', ANTHROPIC_MODEL: 'deepseek-test-model', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash', CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-v4-flash' };",
      "  for (const [name, value] of Object.entries(expected)) { if (process.env[name] !== value) { console.error(`invalid ${name}`); process.exit(3); } }",
      "  if (!process.argv.includes('--safe-mode') || !process.argv.includes('--no-session-persistence')) { console.error('Review safety flags are missing'); process.exit(4); }",
      "  if (!process.argv.includes('--add-dir') || !prompt.includes('<prepared_diff>')) { console.error('Prepared diff was not exposed to the Review runtime'); process.exit(5); }",
      "  if (allowedTools.includes(':*') || allowedTools.includes('git status') || !allowedTools.includes('Bash(git --no-pager show *)')) { console.error('Read-only Git tool patterns are invalid'); process.exit(6); }",
      "  const result = { verdict: 'comment', riskLevel: 'medium', summary: '发现一个可验证的问题。', findings: [{ severity: 'medium', title: '示例问题', file: 'sample.ts', line: 1, description: '测试 Review Worker 的结构化结果。', suggestion: '修正示例实现。' }], positives: ['输出格式正确'] };",
      "  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: result }));",
      "  process.exit(0);",
      "}"
    ].join("\n"),
    "utf8"
  );
  process.env.DEEPSEEK_REVIEW_COMMAND = fakeReviewCli;

  const configStore = new GroupConfigStore(groupData, "Review Worker Test");
  await configStore.init();
  await configStore.update({
    repository: { rootPath: repositoryRoot },
    gitlab: {
      baseUrl: `http://127.0.0.1:${gitLabPort}`,
      apiUrl: `http://127.0.0.1:${gitLabPort}/api/v4`,
      token: "integration-test-token"
    },
    ai: {
      baseUrl: "https://api.deepseek.com/anthropic",
      apiKey: "deepseek-integration-test-key",
      reviewPrompt: "请严格审查当前 Merge Request，并返回结构化结果。",
      requestTimeoutSeconds: 30,
      model: "deepseek-test-model"
    },
    feishu: {
      enabled: true,
      notifyOnMergeRequestTriggered: false,
      notifyOnReviewCompleted: true,
      notifyOnReviewFailed: true,
      notifyOnCriticalFinding: true,
      webhookUrl: `http://127.0.0.1:${gitLabPort}/feishu`,
      signingSecret: "review-worker-feishu-secret"
    }
  });

  const projectStore = new ProjectStore(groupData, "http://127.0.0.1:7000", "test-group");
  await projectStore.init();
  const credentials = await projectStore.create({
    key: "worker_test",
    name: "Worker Test",
    gitlabProjectRef: "123",
    repositoryUrl: remoteRepository,
    defaultBranch: "main"
  }, repositoryRoot);
  const webhookResult = await projectStore.receiveWebhook(
    credentials.project.webhook.url.split("/").at(-1)!,
    credentials.secret,
    "Merge Request Hook",
    "worker-test-delivery",
    {
      object_kind: "merge_request",
      user: { name: "Test User" },
      project: { id: 123, path_with_namespace: "test/worker" },
      object_attributes: {
        iid: 1,
        title: "Worker integration",
        action: "open",
        state: "opened",
        source_branch: "feature",
        target_branch: "main",
        url: "http://gitlab.example/test/worker/-/merge_requests/1",
        last_commit: { id: headSha }
      }
    }
  );
  if (!webhookResult.queued) throw new Error("Integration Review task was not queued");

  const queuedTask = (await projectStore.listTasks())[0];
  const workerConfig = (await configStore.getExecutionContext()).config;
  const queuedPrompt = buildReviewPrompt(queuedTask, workerConfig, {
    filePath: "review-input.patch",
    byteLength: 1,
    truncated: false
  });
  if (
    !queuedPrompt.includes("origin/main") ||
    !queuedPrompt.includes("refs/remotes/origin/merge-requests/1/head") ||
    !queuedPrompt.includes("共享工作树不保证指向审查目标")
  ) {
    throw new Error("Review prompt did not include the target branch diff boundary");
  }

  const worker = new ReviewWorker(groupData, projectStore, configStore, {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  });
  await worker.start();
  const task = await waitForResult(projectStore, webhookResult.taskId);
  await worker.stop();

  if (task.status !== "completed") throw new Error(`Review task failed: ${task.error}`);
  if (task.result?.findings.length !== 1 || task.gitlabNoteId !== 9001) {
    throw new Error("Review result or GitLab note metadata was not persisted");
  }
  if (!postedComment.includes(reviewMarker(task)) || !postedComment.includes("sample.ts:1")) {
    throw new Error("GitLab comment did not contain the expected Review marker and finding");
  }
  const preparedDiff = await readFile(
    path.join(groupData, "review-artifacts", task.id, "review-input.patch"),
    "utf8"
  );
  if (!preparedDiff.includes("sample.ts") || !preparedDiff.includes("export const value = 2")) {
    throw new Error("Review Worker did not prepare the actual Git diff before invoking AI");
  }
  const repositoryHead = await command("git", ["rev-parse", "HEAD"], credentials.project.localRepositoryPath);
  if (repositoryHead === headSha) {
    throw new Error("Review Worker unexpectedly checked out the MR head in the shared worktree");
  }
  if (!postedComment.includes("DeepSeek 自动 Code Review") || /claude/i.test(postedComment)) {
    throw new Error("GitLab comment exposed an unexpected Review runtime implementation detail");
  }
  if (
    feishuMessages.length !== 1 ||
    !feishuMessages[0].timestamp ||
    !feishuMessages[0].sign ||
    !feishuMessages[0].content?.text?.includes("自动 Review 已完成") ||
    !feishuMessages[0].content.text.includes("发现问题：1（中 1）")
  ) {
    throw new Error("Completed Review did not send the expected signed Feishu notification");
  }
  const criticalResult: ReviewResult = {
    verdict: "request_changes",
    riskLevel: "critical",
    summary: "发现必须阻止合并的问题。",
    findings: [{
      severity: "critical",
      title: "可能导致数据永久丢失",
      file: "sample.ts",
      line: 1,
      description: "测试严重问题通知。",
      suggestion: "修复后再合并。"
    }],
    positives: []
  };
  const criticalText = buildCriticalFindingText("Review Worker Test", task, criticalResult, task.gitlabNoteUrl);
  const failedText = buildReviewFailedText("Review Worker Test", task, "DeepSeek Review 执行超时");
  if (!criticalText.includes("自动 Review 发现严重问题") || !criticalText.includes("sample.ts:1")) {
    throw new Error("Critical finding notification content is incomplete");
  }
  if (!failedText.includes("自动 Review 执行失败") || !failedText.includes("DeepSeek Review 执行超时")) {
    throw new Error("Failed Review notification content is incomplete");
  }

  const gitRepository = new GitRepositoryService(path.join(root, "commit-cache"));
  const repositoryStatus = await gitRepository.status(credentials.project);
  const branches = await gitRepository.branches(credentials.project);
  const commits = await gitRepository.commits(credentials.project, { page: 1, pageSize: 20 });
  if (!repositoryStatus.valid || !branches.some((branch) => branch.name === "main") || commits.items.length < 1) {
    throw new Error("Manual Review repository browsing did not return the expected Git data");
  }
  await command("git", ["push", "origin", "HEAD:refs/heads/sync-test"], seedRepository);
  const syncResult = await gitRepository.sync(credentials.project, {
    cloneDepth: 0,
    requestTimeoutSeconds: 30,
    gitlabToken: "integration-test-token",
    gitlabConfig: workerConfig.gitlab
  });
  const commitsAfterSync = await gitRepository.commits(credentials.project, { page: 1, pageSize: 20 });
  if (!syncResult.changed || !commitsAfterSync.cache.syncedAt || commitsAfterSync.cache.commitCount < commits.items.length) {
    throw new Error("Repository sync did not fetch remote branches and warm the Commit cache");
  }
  const projectCacheFile = path.join(root, "commit-cache", `${credentials.project.id}.json`);
  const cacheModifiedBeforeNoopSync = (await stat(projectCacheFile)).mtimeMs;
  await new Promise((resolve) => setTimeout(resolve, 20));
  const noopSyncResult = await gitRepository.sync(credentials.project, {
    cloneDepth: 0,
    requestTimeoutSeconds: 30,
    gitlabToken: "integration-test-token",
    gitlabConfig: workerConfig.gitlab
  });
  const cacheModifiedAfterNoopSync = (await stat(projectCacheFile)).mtimeMs;
  if (noopSyncResult.changed || cacheModifiedAfterNoopSync !== cacheModifiedBeforeNoopSync) {
    throw new Error("No-op Repository sync rewrote the large Commit cache");
  }

  const coordinator = new GitOperationCoordinator();
  const operationOrder: string[] = [];
  const firstOperation = coordinator.run("shared-project", async () => {
    operationOrder.push("first-start");
    await new Promise((resolve) => setTimeout(resolve, 30));
    operationOrder.push("first-end");
  });
  const secondOperation = coordinator.run("shared-project", async () => {
    operationOrder.push("second-start");
    operationOrder.push("second-end");
  });
  await Promise.all([firstOperation, secondOperation]);
  if (operationOrder.join(",") !== "first-start,first-end,second-start,second-end") {
    throw new Error("Git operations for the same project were not serialized");
  }

  const graphRepositoryPath = path.join(root, "graph-repository");
  await mkdir(graphRepositoryPath, { recursive: true });
  await command("git", ["init", "--initial-branch=main"], graphRepositoryPath);
  await command("git", ["config", "user.name", "Main Author"], graphRepositoryPath);
  await command("git", ["config", "user.email", "main@example.com"], graphRepositoryPath);
  await writeFile(path.join(graphRepositoryPath, "base.txt"), "base\n", "utf8");
  await command("git", ["add", "."], graphRepositoryPath);
  await command("git", ["commit", "-m", "graph base"], graphRepositoryPath);
  await command("git", ["checkout", "-b", "feature/cache"], graphRepositoryPath);
  await command("git", ["config", "user.name", "Branch Author"], graphRepositoryPath);
  await command("git", ["config", "user.email", "branch@example.com"], graphRepositoryPath);
  await writeFile(path.join(graphRepositoryPath, "feature.txt"), "feature\n", "utf8");
  await command("git", ["add", "."], graphRepositoryPath);
  await command("git", ["commit", "-m", "feature branch commit"], graphRepositoryPath);
  await command("git", ["checkout", "main"], graphRepositoryPath);
  await command("git", ["config", "user.name", "Main Author"], graphRepositoryPath);
  await command("git", ["config", "user.email", "main@example.com"], graphRepositoryPath);
  await writeFile(path.join(graphRepositoryPath, "main.txt"), "main\n", "utf8");
  await command("git", ["add", "."], graphRepositoryPath);
  await command("git", ["commit", "-m", "main branch commit"], graphRepositoryPath);
  await command("git", ["merge", "--no-ff", "feature/cache", "-m", "merge feature cache"], graphRepositoryPath);
  const graphHeadBeforeIncrementalRefresh = await command("git", ["rev-parse", "HEAD"], graphRepositoryPath);
  await command("git", ["tag", "cache-marker"], graphRepositoryPath);

  const graphProject = {
    ...credentials.project,
    id: "graph-project",
    key: "graph_project",
    name: "Graph Project",
    repositoryUrl: graphRepositoryPath,
    localRepositoryPath: graphRepositoryPath
  };
  const graphCommits = await gitRepository.commits(graphProject, { page: 1, pageSize: 20 });
  const cachedGraphCommits = await gitRepository.commits(graphProject, { page: 1, pageSize: 20 });
  const authorCommits = await gitRepository.commits(graphProject, {
    author: "Branch Author <branch@example.com>",
    page: 1,
    pageSize: 20
  });
  if (
    !graphCommits.cache.refreshed ||
    cachedGraphCommits.cache.refreshed ||
    !graphCommits.items.some((commit) => commit.parentShas.length > 1 && commit.graph.laneCount > 1) ||
    authorCommits.total !== 1 ||
    authorCommits.items[0]?.authorName !== "Branch Author"
  ) {
    throw new Error("Commit graph cache, branch topology, or author filtering is incorrect");
  }
  await writeFile(path.join(graphRepositoryPath, "incremental.txt"), "incremental\n", "utf8");
  await command("git", ["add", "."], graphRepositoryPath);
  await command("git", ["commit", "-m", "incremental cache commit"], graphRepositoryPath);
  await command("git", ["tag", "-f", "cache-marker"], graphRepositoryPath);
  const incrementallyRefreshedCommits = await gitRepository.commits(graphProject, { page: 1, pageSize: 20 });
  const persistedGraphCache = JSON.parse(await readFile(
    path.join(root, "commit-cache", "graph-project.json"),
    "utf8"
  )) as {
    refreshMode?: string;
    addedCommitCount?: number;
  };
  if (
    !incrementallyRefreshedCommits.cache.refreshed ||
    incrementallyRefreshedCommits.items[0]?.subject !== "incremental cache commit" ||
    !incrementallyRefreshedCommits.items[0]?.refs.includes("cache-marker") ||
    incrementallyRefreshedCommits.items.find((commit) => commit.sha === graphHeadBeforeIncrementalRefresh)?.refs.includes("cache-marker") ||
    persistedGraphCache.refreshMode !== "incremental" ||
    persistedGraphCache.addedCommitCount !== 1
  ) {
    throw new Error("Incremental Commit cache refresh did not add metadata or rebuild moved refs correctly");
  }
  const manualPreview = await gitRepository.preview(credentials.project, {
    mode: "commits",
    commitShas: [headSha],
    targetBranch: "main"
  });
  if (manualPreview.commitCount !== 1 || manualPreview.fileCount !== 1) {
    throw new Error("Manual Review preview did not calculate the selected Commit patch");
  }
  const manualTask = await projectStore.createManualReview(
    credentials.project,
    manualPreview,
    "Manual Tester"
  );
  const manualWorker = new ReviewWorker(groupData, projectStore, configStore, {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  });
  await manualWorker.start();
  const completedManualTask = await waitForResult(projectStore, manualTask.id);
  await manualWorker.stop();
  if (completedManualTask.status !== "completed" || completedManualTask.gitlabNoteId) {
    throw new Error(`Manual Review did not complete without a GitLab MR comment: ${completedManualTask.error}`);
  }
  if (
    feishuMessages.length !== 2 ||
    !feishuMessages[1].content?.text?.includes("手动 Code Review 已完成") ||
    !feishuMessages[1].content.text.includes("Manual Tester")
  ) {
    throw new Error("Manual Review did not send the dedicated Feishu notification");
  }
  process.stdout.write("Review worker integration test passed\n");
} finally {
  process.env.DEEPSEEK_REVIEW_COMMAND = originalReviewCommand;
  await new Promise<void>((resolve) => gitLabServer.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
}
