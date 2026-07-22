import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  GitBranchSummary,
  GitCommitGraphSegment,
  GitCommitPage,
  GitCommitSummary,
  GitRepositoryStatus,
  GitRepositorySyncResult,
  GroupNodeConfig,
  ManualReviewPreview,
  ManualReviewSelection,
  ReviewProject
} from "../../shared/contracts.js";
import { resolveGitRepositoryAccess, withGitSafeDirectory } from "./git-auth.js";

const OUTPUT_LIMIT = 8 * 1024 * 1024;
const COMMIT_CACHE_OUTPUT_LIMIT = 512 * 1024 * 1024;
const COMMIT_CACHE_SCHEMA_VERSION = 1;
const REPOSITORY_STATUS_TTL_MS = 5_000;
const BRANCH_CACHE_TTL_MS = 15_000;
const INCREMENTAL_COMMIT_LIMIT = 5_000;
const COMMIT_METADATA_CHUNK_SIZE = 250;
const MAX_DERIVED_BRANCH_SCOPES = 20;
const MAX_MEMORY_COMMIT_CACHES = 3;
const MAX_MEMORY_CACHED_COMMITS = 300_000;
const PRELOAD_CACHE_FILE_BUDGET = 64 * 1024 * 1024;

type CachedGitCommit = Omit<GitCommitSummary, "graph">;

interface CommitCacheFile {
  schemaVersion: number;
  repositoryPath: string;
  fingerprint: string;
  generatedAt: string;
  syncedAt?: string;
  refreshMode?: "full" | "incremental";
  addedCommitCount?: number;
  removedCommitCount?: number;
  commits: CachedGitCommit[];
}

interface DerivedCommitScope {
  commits: CachedGitCommit[];
  authors: GitCommitPage["authors"];
}

interface DerivedCommitCache {
  commitsBySha: Map<string, CachedGitCommit>;
  scopes: Map<string, DerivedCommitScope>;
}

interface GraphLane {
  sha: string;
  colorIndex: number;
}

function normalizeRemote(value: string) {
  const trimmed = value.trim();
  if (/^(?:https?|ssh|git):\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      return `${parsed.hostname}${parsed.pathname}`.replace(/\.git\/?$/i, "").replace(/\/$/, "").toLowerCase();
    } catch {
      // Fall through to local-path normalization.
    }
  }
  const scpStyle = trimmed.match(/^(?:[^@]+@)?([^:]+):(.+)$/);
  if (scpStyle && !/^[A-Za-z]:[\\/]/.test(trimmed)) {
    return `${scpStyle[1]}/${scpStyle[2]}`.replace(/\.git\/?$/i, "").toLowerCase();
  }
  return trimmed.replaceAll("\\", "/").replace(/\.git\/?$/i, "").replace(/\/$/, "").toLowerCase();
}

function sameRepositoryPath(left: string, right: string) {
  const normalize = (value: string) => {
    const resolved = path.resolve(value).replaceAll("\\", "/");
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function parseNumstat(output: string) {
  const files = new Set<string>();
  let additions = 0;
  let deletions = 0;
  for (const line of output.split(/\r?\n/)) {
    const [added, deleted, ...pathParts] = line.split("\t");
    if (!added || !deleted || pathParts.length === 0) continue;
    files.add(pathParts.join("\t"));
    if (added !== "-") additions += Number(added) || 0;
    if (deleted !== "-") deletions += Number(deleted) || 0;
  }
  return { fileCount: files.size, additions, deletions };
}

export class GitRepositoryService {
  private readonly memoryCommitCaches = new Map<string, CommitCacheFile>();
  private readonly pendingCommitCaches = new Map<string, Promise<{ cache: CommitCacheFile; refreshed: boolean }>>();
  private readonly derivedCommitCaches = new WeakMap<CommitCacheFile, DerivedCommitCache>();
  private readonly repositoryStatusCaches = new Map<string, {
    repositoryPath: string;
    repositoryUrl: string;
    expiresAt: number;
    status: GitRepositoryStatus;
  }>();
  private readonly branchCaches = new Map<string, {
    repositoryPath: string;
    expiresAt: number;
    items: GitBranchSummary[];
  }>();
  private readonly repositoryValidations = new Map<string, {
    repositoryPath: string;
    expiresAt: number;
    currentBranch?: string;
  }>();

  constructor(
    private readonly commitCacheRoot: string,
    private readonly authenticationDataDir = path.dirname(path.dirname(commitCacheRoot))
  ) {}

  private async command(
    repositoryPath: string,
    args: string[],
    timeoutMs = 30_000,
    outputLimit = OUTPUT_LIMIT,
    environment: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" }
  ) {
    return new Promise<string>((resolve, reject) => {
      const child = spawn("git", ["-C", repositoryPath, ...args], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: withGitSafeDirectory(environment, repositoryPath)
      });
      let stdout = "";
      let stderr = "";
      let outputLimitExceeded = false;
      const append = (current: string, chunk: Buffer) => {
        if (current.length + chunk.length > outputLimit) {
          outputLimitExceeded = true;
          child.kill("SIGTERM");
          return current;
        }
        const next = current + chunk.toString();
        return next;
      };
      child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
      child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
      const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (outputLimitExceeded) reject(new Error(`Git 命令输出超过 ${Math.ceil(outputLimit / 1024 / 1024)} MB 限制`));
        else if (code === 0) resolve(stdout.trim());
        else reject(new Error(stderr.trim() || `git ${args[0]} 执行失败（${code}）`));
      });
    });
  }

  private async exists(filePath: string) {
    try {
      await stat(filePath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async status(project: ReviewProject): Promise<GitRepositoryStatus> {
    const cached = this.repositoryStatusCaches.get(project.id);
    if (
      cached &&
      cached.expiresAt > Date.now() &&
      cached.repositoryPath === project.localRepositoryPath &&
      cached.repositoryUrl === project.repositoryUrl
    ) {
      return cached.status;
    }
    const checkedAt = new Date().toISOString();
    const repositoryPath = project.localRepositoryPath;
    if (!(await this.exists(repositoryPath))) {
      return {
        exists: false,
        valid: false,
        bare: false,
        locked: false,
        clean: true,
        remoteMatches: false,
        checkedAt,
        error: "本地仓库目录不存在；首次 Review 时会自动 Clone，也可以先完整复制已有仓库。"
      };
    }
    const locked = await this.exists(path.join(repositoryPath, ".git", "index.lock"));
    try {
      const inside = await this.command(repositoryPath, ["rev-parse", "--is-inside-work-tree"]);
      const bare = (await this.command(repositoryPath, ["rev-parse", "--is-bare-repository"])) === "true";
      const [currentBranch, headSha, originUrl] = await Promise.all([
        this.command(repositoryPath, ["branch", "--show-current"]).catch(() => ""),
        this.command(repositoryPath, ["rev-parse", "HEAD"]).catch(() => ""),
        this.command(repositoryPath, ["remote", "get-url", "origin"]).catch(() => "")
      ]);
      const status: GitRepositoryStatus = {
        exists: true,
        valid: inside === "true" && !bare,
        bare,
        locked,
        clean: undefined,
        currentBranch: currentBranch || undefined,
        headSha: headSha || undefined,
        originUrl: originUrl || undefined,
        remoteMatches: Boolean(originUrl) && normalizeRemote(originUrl) === normalizeRemote(project.repositoryUrl),
        checkedAt,
        error: locked
          ? "检测到 .git/index.lock，请确认没有 Git 进程后再删除锁文件。"
          : inside !== "true" || bare
            ? "该目录不是可用的非裸 Git 工作仓库。"
            : undefined
      };
      this.repositoryStatusCaches.set(project.id, {
        repositoryPath,
        repositoryUrl: project.repositoryUrl,
        expiresAt: Date.now() + REPOSITORY_STATUS_TTL_MS,
        status
      });
      if (status.valid && !status.locked) {
        this.repositoryValidations.set(project.id, {
          repositoryPath,
          expiresAt: Date.now() + REPOSITORY_STATUS_TTL_MS,
          currentBranch: status.currentBranch
        });
      }
      return status;
    } catch (error) {
      return {
        exists: true,
        valid: false,
        bare: false,
        locked,
        clean: false,
        remoteMatches: false,
        checkedAt,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private async assertRepository(project: ReviewProject) {
    const repositoryPath = project.localRepositoryPath;
    if (!(await this.exists(repositoryPath))) throw new Error("LOCAL_REPOSITORY_NOT_READY");
    if (await this.exists(path.join(repositoryPath, ".git", "index.lock"))) {
      throw new Error("LOCAL_REPOSITORY_LOCKED");
    }
    const cached = this.repositoryValidations.get(project.id);
    if (
      cached &&
      cached.expiresAt > Date.now() &&
      cached.repositoryPath === repositoryPath
    ) {
      return { currentBranch: cached.currentBranch };
    }
    const [inside, bare, currentBranch] = await Promise.all([
      this.command(repositoryPath, ["rev-parse", "--is-inside-work-tree"]),
      this.command(repositoryPath, ["rev-parse", "--is-bare-repository"]),
      this.command(repositoryPath, ["branch", "--show-current"]).catch(() => "")
    ]);
    if (inside !== "true" || bare === "true") throw new Error("LOCAL_REPOSITORY_NOT_READY");
    this.repositoryValidations.set(project.id, {
      repositoryPath,
      expiresAt: Date.now() + REPOSITORY_STATUS_TTL_MS,
      currentBranch: currentBranch || undefined
    });
    return { currentBranch: currentBranch || undefined };
  }

  private commitCacheFile(project: ReviewProject) {
    const safeProjectId = project.id.replace(/[^A-Za-z0-9_-]/g, "_");
    return path.join(this.commitCacheRoot, `${safeProjectId}.json`);
  }

  private commitCacheMetadataFile(project: ReviewProject) {
    const safeProjectId = project.id.replace(/[^A-Za-z0-9_-]/g, "_");
    return path.join(this.commitCacheRoot, `${safeProjectId}.meta.json`);
  }

  private async commitFingerprint(repositoryPath: string) {
    const [head, refs] = await Promise.all([
      this.command(repositoryPath, ["rev-parse", "HEAD"]),
      this.command(repositoryPath, [
        "for-each-ref",
        "--sort=refname",
        "--format=%(refname)%00%(objectname)",
        "refs/heads",
        "refs/remotes",
        "refs/tags"
      ])
    ]);
    return createHash("sha256").update(`${head}\n${refs}`).digest("hex");
  }

  private validCommitCache(value: unknown): value is CommitCacheFile {
    if (!value || typeof value !== "object") return false;
    const cache = value as Partial<CommitCacheFile>;
    return cache.schemaVersion === COMMIT_CACHE_SCHEMA_VERSION &&
      typeof cache.repositoryPath === "string" &&
      typeof cache.fingerprint === "string" &&
      typeof cache.generatedAt === "string" &&
      Array.isArray(cache.commits) &&
      cache.commits.every((commit) => Boolean(
        commit &&
        typeof commit.sha === "string" &&
        typeof commit.shortSha === "string" &&
        Array.isArray(commit.parentShas) &&
        typeof commit.subject === "string" &&
        typeof commit.authorName === "string" &&
        typeof commit.authorEmail === "string" &&
        typeof commit.authoredAt === "string" &&
        Array.isArray(commit.refs)
      ));
  }

  private parseCommitLog(output: string): CachedGitCommit[] {
    if (!output) return [];
    return output.split(/\r?\n/).filter(Boolean).map((line) => {
      const [sha, shortSha, parents, subject, authorName, authorEmail, authoredAt, refs] = line.split("\0");
      return {
        sha,
        shortSha,
        parentShas: parents ? parents.split(" ").filter(Boolean) : [],
        subject,
        authorName,
        authorEmail,
        authoredAt,
        refs: refs ? refs.split(", ").map((item) => item.trim()).filter(Boolean) : []
      };
    });
  }

  private async readCommitCache(project: ReviewProject) {
    try {
      const cache = JSON.parse(await readFile(this.commitCacheFile(project), "utf8")) as unknown;
      if (!this.validCommitCache(cache) || !sameRepositoryPath(cache.repositoryPath, project.localRepositoryPath)) {
        return undefined;
      }
      try {
        const metadata = JSON.parse(await readFile(this.commitCacheMetadataFile(project), "utf8")) as {
          syncedAt?: unknown;
        };
        if (typeof metadata.syncedAt === "string") cache.syncedAt = metadata.syncedAt;
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== "ENOENT" &&
          (error as Error).name !== "SyntaxError"
        ) throw error;
      }
      return cache;
    } catch (error) {
      if ((["ENOENT", "SyntaxError"] as string[]).includes((error as NodeJS.ErrnoException).code ?? (error as Error).name)) {
        return undefined;
      }
      throw error;
    }
  }

  private rememberCommitCache(projectId: string, cache: CommitCacheFile) {
    this.memoryCommitCaches.delete(projectId);
    this.memoryCommitCaches.set(projectId, cache);
    const cachedCommitCount = () => [...this.memoryCommitCaches.values()]
      .reduce((total, item) => total + item.commits.length, 0);
    while (
      this.memoryCommitCaches.size > 1 &&
      (
        this.memoryCommitCaches.size > MAX_MEMORY_COMMIT_CACHES ||
        cachedCommitCount() > MAX_MEMORY_CACHED_COMMITS
      )
    ) {
      const oldestProjectId = this.memoryCommitCaches.keys().next().value as string | undefined;
      if (!oldestProjectId) break;
      this.memoryCommitCaches.delete(oldestProjectId);
    }
  }

  async preloadCommitCaches(projects: ReviewProject[]) {
    const candidates: Array<{ project: ReviewProject; size: number; modifiedAt: number }> = [];
    for (const project of projects) {
      try {
        const cacheStat = await stat(this.commitCacheFile(project));
        candidates.push({ project, size: cacheStat.size, modifiedAt: cacheStat.mtimeMs });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    candidates.sort((a, b) => b.modifiedAt - a.modifiedAt);
    let remainingBudget = PRELOAD_CACHE_FILE_BUDGET;
    for (const { project, size } of candidates) {
      if (size > remainingBudget) continue;
      if (this.memoryCommitCaches.has(project.id)) continue;
      const cache = await this.readCommitCache(project);
      if (cache && !this.memoryCommitCaches.has(project.id)) {
        this.rememberCommitCache(project.id, cache);
        remainingBudget -= size;
      }
    }
  }

  private async commitOrder(repositoryPath: string) {
    const output = await this.command(
      repositoryPath,
      ["rev-list", "--all", "--topo-order"],
      180_000,
      COMMIT_CACHE_OUTPUT_LIMIT
    );
    return output.split(/\r?\n/).filter(Boolean);
  }

  private async commitRefs(repositoryPath: string) {
    const output = await this.command(repositoryPath, [
      "for-each-ref",
      "--sort=refname",
      "--format=%(objectname)%00%(*objectname)%00%(refname:short)",
      "refs/heads",
      "refs/remotes",
      "refs/tags"
    ], 60_000, COMMIT_CACHE_OUTPUT_LIMIT);
    const refsBySha = new Map<string, string[]>();
    for (const line of output.split(/\r?\n/).filter(Boolean)) {
      const [objectSha, peeledSha, refName] = line.split("\0");
      const sha = peeledSha || objectSha;
      if (!sha || !refName || refName.endsWith("/HEAD")) continue;
      const refs = refsBySha.get(sha);
      if (refs) refs.push(refName);
      else refsBySha.set(sha, [refName]);
    }
    return refsBySha;
  }

  private async loadMissingCommitMetadata(repositoryPath: string, commitShas: string[]) {
    const commits: CachedGitCommit[] = [];
    for (let offset = 0; offset < commitShas.length; offset += COMMIT_METADATA_CHUNK_SIZE) {
      const chunk = commitShas.slice(offset, offset + COMMIT_METADATA_CHUNK_SIZE);
      const output = await this.command(repositoryPath, [
        "log",
        "--no-walk=unsorted",
        "--format=%H%x00%h%x00%P%x00%s%x00%an%x00%ae%x00%aI%x00%D",
        ...chunk
      ], 120_000, COMMIT_CACHE_OUTPUT_LIMIT);
      commits.push(...this.parseCommitLog(output));
    }
    return commits;
  }

  private async rebuildCommitCache(
    project: ReviewProject,
    fingerprint: string,
    baseline?: CommitCacheFile
  ) {
    const repositoryPath = project.localRepositoryPath;
    if (!baseline) {
      const output = await this.command(repositoryPath, [
        "log",
        "--all",
        "--topo-order",
        "--format=%H%x00%h%x00%P%x00%s%x00%an%x00%ae%x00%aI%x00%D"
      ], 300_000, COMMIT_CACHE_OUTPUT_LIMIT);
      const refsBySha = await this.commitRefs(repositoryPath);
      const commits = this.parseCommitLog(output)
        .map((commit) => ({ ...commit, refs: refsBySha.get(commit.sha) ?? [] }));
      return {
        schemaVersion: COMMIT_CACHE_SCHEMA_VERSION,
        repositoryPath,
        fingerprint,
        generatedAt: new Date().toISOString(),
        refreshMode: "full",
        addedCommitCount: commits.length,
        removedCommitCount: 0,
        commits
      } satisfies CommitCacheFile;
    }
    const orderedShas = await this.commitOrder(repositoryPath);
    const existingBySha = new Map(baseline.commits.map((commit) => [commit.sha, commit]));
    const missingShas = orderedShas.filter((sha) => !existingBySha.has(sha));
    const orderedShaSet = new Set(orderedShas);
    const removedCommitCount = baseline.commits
      .reduce((count, commit) => count + (orderedShaSet.has(commit.sha) ? 0 : 1), 0);
    const useIncremental = missingShas.length <= INCREMENTAL_COMMIT_LIMIT;
    let commits: CachedGitCommit[];
    let refreshMode: CommitCacheFile["refreshMode"] = "full";

    if (useIncremental) {
      const additions = await this.loadMissingCommitMetadata(repositoryPath, missingShas);
      additions.forEach((commit) => existingBySha.set(commit.sha, commit));
      const complete = missingShas.every((sha) => existingBySha.has(sha));
      if (complete) {
        commits = orderedShas.map((sha) => existingBySha.get(sha)!);
        refreshMode = "incremental";
      } else {
        commits = [];
      }
    } else {
      commits = [];
    }

    if (commits.length !== orderedShas.length) {
      const output = await this.command(repositoryPath, [
        "log",
        "--all",
        "--topo-order",
        "--format=%H%x00%h%x00%P%x00%s%x00%an%x00%ae%x00%aI%x00%D"
      ], 300_000, COMMIT_CACHE_OUTPUT_LIMIT);
      commits = this.parseCommitLog(output);
      refreshMode = "full";
    }

    const refsBySha = await this.commitRefs(repositoryPath);
    commits = commits.map((commit) => ({ ...commit, refs: refsBySha.get(commit.sha) ?? [] }));
    return {
      schemaVersion: COMMIT_CACHE_SCHEMA_VERSION,
      repositoryPath,
      fingerprint,
      generatedAt: new Date().toISOString(),
      syncedAt: baseline?.syncedAt,
      refreshMode,
      addedCommitCount: missingShas.length,
      removedCommitCount,
      commits
    } satisfies CommitCacheFile;
  }

  private async writeCommitCache(filePath: string, cache: CommitCacheFile) {
    await mkdir(this.commitCacheRoot, { recursive: true });
    const temporaryFile = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryFile, JSON.stringify(cache), "utf8");
    try {
      await rename(temporaryFile, filePath);
    } catch (error) {
      if (!["EEXIST", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      await rm(filePath, { force: true });
      await rename(temporaryFile, filePath);
    }
  }

  private async loadCommitCache(project: ReviewProject) {
    const repositoryPath = project.localRepositoryPath;
    const fingerprint = await this.commitFingerprint(repositoryPath);
    const inMemory = this.memoryCommitCaches.get(project.id);
    if (inMemory) this.rememberCommitCache(project.id, inMemory);
    if (
      inMemory?.fingerprint === fingerprint &&
      sameRepositoryPath(inMemory.repositoryPath, repositoryPath)
    ) {
      return { cache: inMemory, refreshed: false };
    }

    const pendingKey = `${project.id}:${fingerprint}`;
    const pending = this.pendingCommitCaches.get(pendingKey);
    if (pending) return pending;

    const loading = (async () => {
      const filePath = this.commitCacheFile(project);
      const fromDisk = inMemory && sameRepositoryPath(inMemory.repositoryPath, repositoryPath)
        ? inMemory
        : await this.readCommitCache(project);
      if (fromDisk?.fingerprint === fingerprint) {
        this.rememberCommitCache(project.id, fromDisk);
        return { cache: fromDisk, refreshed: false };
      }
      const cache = await this.rebuildCommitCache(project, fingerprint, fromDisk);
      await this.writeCommitCache(filePath, cache);
      this.rememberCommitCache(project.id, cache);
      return { cache, refreshed: true };
    })();

    this.pendingCommitCaches.set(pendingKey, loading);
    try {
      return await loading;
    } finally {
      this.pendingCommitCaches.delete(pendingKey);
    }
  }

  async sync(
    project: ReviewProject,
    options: {
      cloneDepth: number;
      requestTimeoutSeconds: number;
      gitlabToken: string;
      gitlabConfig: GroupNodeConfig["gitlab"];
    }
  ): Promise<GitRepositorySyncResult> {
    await this.assertRepository(project);
    const startedAt = new Date().toISOString();
    const beforeFingerprint = await this.commitFingerprint(project.localRepositoryPath);
    const access = await resolveGitRepositoryAccess({
      dataDir: this.authenticationDataDir,
      configuredRepositoryUrl: project.repositoryUrl,
      gitlabProjectRef: project.gitlabProjectRef,
      gitlabConfig: options.gitlabConfig,
      gitlabToken: options.gitlabToken
    });
    await this.command(
      project.localRepositoryPath,
      ["remote", "set-url", "origin", access.repositoryUrl],
      30_000,
      OUTPUT_LIMIT,
      access.environment
    );
    const fetchArgs = ["fetch", "--prune", "--tags", "--no-recurse-submodules", "--no-write-fetch-head"];
    if (options.cloneDepth > 0) fetchArgs.push("--depth", String(options.cloneDepth));
    fetchArgs.push("origin", "+refs/heads/*:refs/remotes/origin/*");
    await this.command(
      project.localRepositoryPath,
      fetchArgs,
      options.requestTimeoutSeconds * 1000 * 10,
      OUTPUT_LIMIT,
      access.environment
    );
    this.repositoryStatusCaches.delete(project.id);
    this.repositoryValidations.delete(project.id);
    this.branchCaches.delete(project.id);
    const { cache } = await this.loadCommitCache(project);
    const completedAt = new Date().toISOString();
    cache.syncedAt = completedAt;
    await mkdir(this.commitCacheRoot, { recursive: true });
    await writeFile(this.commitCacheMetadataFile(project), JSON.stringify({ syncedAt: completedAt }), "utf8");
    return {
      startedAt,
      completedAt,
      changed: beforeFingerprint !== cache.fingerprint,
      commitCount: cache.commits.length,
      cacheGeneratedAt: cache.generatedAt
    };
  }

  private layoutCommits(commits: CachedGitCommit[]): GitCommitSummary[] {
    let activeLanes: GraphLane[] = [];
    let nextColorIndex = 0;
    return commits.map((commit) => {
      let lane = activeLanes.findIndex((entry) => entry.sha === commit.sha);
      if (lane < 0) {
        lane = activeLanes.length;
        activeLanes = [...activeLanes, { sha: commit.sha, colorIndex: nextColorIndex++ }];
      }
      const topLanes = activeLanes.map((entry) => ({ ...entry }));
      const colorIndex = topLanes[lane].colorIndex;
      const bottomLanes = topLanes.filter((_entry, index) => index !== lane);
      let insertionLane = Math.min(lane, bottomLanes.length);

      commit.parentShas.forEach((parentSha, parentIndex) => {
        const existingLane = bottomLanes.findIndex((entry) => entry.sha === parentSha);
        if (existingLane >= 0) {
          insertionLane = Math.max(insertionLane, existingLane + 1);
          return;
        }
        const parentColor = parentIndex === 0 ? colorIndex : nextColorIndex++;
        bottomLanes.splice(insertionLane, 0, { sha: parentSha, colorIndex: parentColor });
        insertionLane += 1;
      });

      const segments: GitCommitGraphSegment[] = [];
      topLanes.forEach((entry, topLane) => {
        if (topLane === lane) {
          segments.push({
            fromLane: topLane,
            fromPosition: "top",
            toLane: lane,
            toPosition: "node",
            colorIndex
          });
          return;
        }
        const targetLane = bottomLanes.findIndex((candidate) => candidate.sha === entry.sha);
        if (targetLane >= 0) {
          segments.push({
            fromLane: topLane,
            fromPosition: "top",
            toLane: targetLane,
            toPosition: "bottom",
            colorIndex: entry.colorIndex
          });
        }
      });
      commit.parentShas.forEach((parentSha, parentIndex) => {
        const parentLane = bottomLanes.findIndex((entry) => entry.sha === parentSha);
        if (parentLane >= 0) {
          segments.push({
            fromLane: lane,
            fromPosition: "node",
            toLane: parentLane,
            toPosition: "bottom",
            colorIndex: parentIndex === 0 ? colorIndex : bottomLanes[parentLane].colorIndex
          });
        }
      });

      activeLanes = bottomLanes;
      return {
        ...commit,
        graph: {
          lane,
          laneCount: Math.max(1, lane + 1, topLanes.length, bottomLanes.length),
          colorIndex,
          segments
        }
      };
    });
  }

  private reachableCommits(
    commits: CachedGitCommit[],
    headSha: string,
    commitsBySha = new Map(commits.map((commit) => [commit.sha, commit]))
  ) {
    const reachable = new Set<string>();
    const pending = [headSha];
    while (pending.length > 0) {
      const sha = pending.pop()!;
      if (reachable.has(sha)) continue;
      reachable.add(sha);
      commitsBySha.get(sha)?.parentShas.forEach((parentSha) => pending.push(parentSha));
    }
    return commits.filter((commit) => reachable.has(commit.sha));
  }

  private commitAuthors(commits: CachedGitCommit[]) {
    const authorsByIdentity = new Map<string, { name: string; email: string; commitCount: number }>();
    commits.forEach((commit) => {
      const key = `${commit.authorName.trim().toLowerCase()}\0${commit.authorEmail.trim().toLowerCase()}`;
      const author = authorsByIdentity.get(key);
      if (author) author.commitCount += 1;
      else authorsByIdentity.set(key, {
        name: commit.authorName,
        email: commit.authorEmail,
        commitCount: 1
      });
    });
    return [...authorsByIdentity.values()].sort((a, b) =>
      b.commitCount - a.commitCount || a.name.localeCompare(b.name, "zh-CN")
    );
  }

  private commitScope(cache: CommitCacheFile, headSha?: string) {
    let derived = this.derivedCommitCaches.get(cache);
    if (!derived) {
      derived = {
        commitsBySha: new Map(cache.commits.map((commit) => [commit.sha, commit])),
        scopes: new Map()
      };
      this.derivedCommitCaches.set(cache, derived);
    }
    const scopeKey = headSha ?? "*";
    const cachedScope = derived.scopes.get(scopeKey);
    if (cachedScope) return cachedScope;
    const commits = headSha
      ? this.reachableCommits(cache.commits, headSha, derived.commitsBySha)
      : cache.commits;
    const scope = { commits, authors: this.commitAuthors(commits) };
    if (derived.scopes.size >= MAX_DERIVED_BRANCH_SCOPES) {
      const oldestBranchScope = [...derived.scopes.keys()].find((key) => key !== "*");
      if (oldestBranchScope) derived.scopes.delete(oldestBranchScope);
    }
    derived.scopes.set(scopeKey, scope);
    return scope;
  }

  async branches(project: ReviewProject): Promise<GitBranchSummary[]> {
    const status = await this.assertRepository(project);
    const cached = this.branchCaches.get(project.id);
    if (
      cached &&
      cached.expiresAt > Date.now() &&
      cached.repositoryPath === project.localRepositoryPath
    ) {
      return cached.items;
    }
    const output = await this.command(project.localRepositoryPath, [
      "for-each-ref",
      "--sort=-authordate",
      "--format=%(refname)%00%(objectname)%00%(authordate:iso-strict)%00%(subject)",
      "refs/heads",
      "refs/remotes/origin"
    ]);
    const byName = new Map<string, GitBranchSummary>();
    for (const line of output.split(/\r?\n/).filter(Boolean)) {
      const [refName, headSha, authoredAt, subject] = line.split("\0");
      if (!refName || refName === "refs/remotes/origin/HEAD") continue;
      const remote = refName.startsWith("refs/remotes/origin/");
      const name = remote
        ? refName.slice("refs/remotes/origin/".length)
        : refName.slice("refs/heads/".length);
      if (byName.has(name) && remote) continue;
      byName.set(name, {
        name,
        headSha,
        authoredAt,
        subject,
        current: name === status.currentBranch,
        remote
      });
    }
    const items = [...byName.values()].sort((a, b) => b.authoredAt.localeCompare(a.authoredAt));
    this.branchCaches.set(project.id, {
      repositoryPath: project.localRepositoryPath,
      expiresAt: Date.now() + BRANCH_CACHE_TTL_MS,
      items
    });
    return items;
  }

  async commits(project: ReviewProject, query: {
    branch?: string;
    search?: string;
    author?: string;
    since?: string;
    until?: string;
    page: number;
    pageSize: number;
  }): Promise<GitCommitPage> {
    await this.assertRepository(project);
    const { cache, refreshed } = await this.loadCommitCache(project);
    let branchHead: string | undefined;
    if (query.branch) {
      const resolved = await this.resolveBranch(project.localRepositoryPath, query.branch);
      branchHead = await this.command(project.localRepositoryPath, ["rev-parse", resolved]);
    }
    const { commits: scopedCommits, authors } = this.commitScope(cache, branchHead);

    let filteredCommits = scopedCommits;
    if (query.search) {
      const search = query.search.toLowerCase();
      filteredCommits = filteredCommits.filter((commit) =>
        commit.subject.toLowerCase().includes(search) || commit.sha.toLowerCase().startsWith(search)
      );
    }
    if (query.author) {
      const author = query.author.toLowerCase();
      filteredCommits = filteredCommits.filter((commit) => {
        const identity = commit.authorEmail
          ? `${commit.authorName} <${commit.authorEmail}>`
          : commit.authorName;
        return identity.toLowerCase().includes(author);
      });
    }
    if (query.since) {
      const since = Date.parse(query.since);
      if (!Number.isNaN(since)) {
        filteredCommits = filteredCommits.filter((commit) => Date.parse(commit.authoredAt) >= since);
      }
    }
    if (query.until) {
      const untilValue = /^\d{4}-\d{2}-\d{2}$/.test(query.until)
        ? `${query.until}T23:59:59.999`
        : query.until;
      const until = Date.parse(untilValue);
      if (!Number.isNaN(until)) {
        filteredCommits = filteredCommits.filter((commit) => Date.parse(commit.authoredAt) <= until);
      }
    }

    const total = filteredCommits.length;
    const offset = (query.page - 1) * query.pageSize;
    const pageEnd = Math.min(total, offset + query.pageSize);
    // Graph lanes depend on commits before the current page, but never on commits after it.
    // Avoid laying out the entire history when the UI only needs the first page; large
    // repositories can contain hundreds of thousands of commits.
    const items = this.layoutCommits(filteredCommits.slice(0, pageEnd)).slice(offset, pageEnd);
    return {
      items,
      page: query.page,
      pageSize: query.pageSize,
      total,
      hasMore: offset + items.length < total,
      authors,
      cache: {
        generatedAt: cache.generatedAt,
        syncedAt: cache.syncedAt,
        commitCount: cache.commits.length,
        refreshed
      }
    };
  }

  private async resolveBranch(repositoryPath: string, branch: string) {
    if (!branch.trim() || branch.length > 300) throw new Error("INVALID_BRANCH");
    const candidates = [`refs/remotes/origin/${branch}`, `refs/heads/${branch}`, branch];
    for (const candidate of candidates) {
      try {
        await this.command(repositoryPath, ["rev-parse", "--verify", `${candidate}^{commit}`]);
        return candidate;
      } catch {
        // Try the next unambiguous branch form.
      }
    }
    throw new Error(`BRANCH_NOT_FOUND: ${branch}`);
  }

  async preview(project: ReviewProject, selection: ManualReviewSelection): Promise<ManualReviewPreview> {
    await this.assertRepository(project);
    if (selection.mode === "commits") {
      const unique = [...new Set(selection.commitShas.map((sha) => sha.trim().toLowerCase()))];
      if (unique.length === 0 || unique.length > 50) throw new Error("MANUAL_COMMIT_COUNT_INVALID");
      const fullShas: string[] = [];
      for (const sha of unique) {
        if (!/^[0-9a-f]{7,40}$/i.test(sha)) throw new Error(`INVALID_COMMIT_SHA: ${sha}`);
        fullShas.push(await this.command(project.localRepositoryPath, ["rev-parse", "--verify", `${sha}^{commit}`]));
      }
      const numstat = await this.command(project.localRepositoryPath, [
        "show", "--format=", "--numstat", "--find-renames", ...fullShas
      ], 60_000);
      return {
        selection: {
          mode: "commits",
          commitShas: fullShas,
          targetBranch: selection.targetBranch || project.defaultBranch
        },
        commitCount: fullShas.length,
        ...parseNumstat(numstat)
      };
    }

    if (!selection.branch) throw new Error("MANUAL_BRANCH_REQUIRED");
    const sourceRef = await this.resolveBranch(project.localRepositoryPath, selection.branch);
    const targetBranch = selection.targetBranch || project.defaultBranch;
    const targetRef = await this.resolveBranch(project.localRepositoryPath, targetBranch);
    const mergeBase = await this.command(project.localRepositoryPath, ["merge-base", targetRef, sourceRef]);
    const [commitCountText, numstat] = await Promise.all([
      this.command(project.localRepositoryPath, ["rev-list", "--count", `${mergeBase}..${sourceRef}`]),
      this.command(project.localRepositoryPath, ["diff", "--numstat", "--find-renames", `${mergeBase}..${sourceRef}`], 60_000)
    ]);
    return {
      selection: {
        mode: "branch",
        commitShas: [],
        branch: selection.branch,
        targetBranch
      },
      commitCount: Number(commitCountText) || 0,
      ...parseNumstat(numstat)
    };
  }
}
