import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import type {
  GitBranchSummary,
  GitCommitPage,
  GitCommitSummary,
  GitRepositoryStatus,
  ManualReviewPreview,
  ManualReviewSelection,
  ReviewProject
} from "../../shared/contracts.js";

const OUTPUT_LIMIT = 8 * 1024 * 1024;

function normalizeRemote(value: string) {
  return value
    .trim()
    .replace(/^git@([^:]+):/i, "ssh://git@$1/")
    .replace(/\.git\/?$/i, "")
    .replace(/\/$/, "")
    .toLowerCase();
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
  private async command(repositoryPath: string, args: string[], timeoutMs = 30_000) {
    return new Promise<string>((resolve, reject) => {
      const child = spawn("git", ["-C", repositoryPath, ...args], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
      });
      let stdout = "";
      let stderr = "";
      const append = (current: string, chunk: Buffer) => {
        const next = current + chunk.toString();
        return next.length <= OUTPUT_LIMIT ? next : next.slice(next.length - OUTPUT_LIMIT);
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
        if (code === 0) resolve(stdout.trim());
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
      const [currentBranch, headSha, originUrl, porcelain] = await Promise.all([
        this.command(repositoryPath, ["branch", "--show-current"]).catch(() => ""),
        this.command(repositoryPath, ["rev-parse", "HEAD"]).catch(() => ""),
        this.command(repositoryPath, ["remote", "get-url", "origin"]).catch(() => ""),
        this.command(repositoryPath, ["status", "--porcelain", "--untracked-files=no"]).catch(() => "")
      ]);
      return {
        exists: true,
        valid: inside === "true" && !bare,
        bare,
        locked,
        clean: porcelain.length === 0,
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
    const status = await this.status(project);
    if (!status.valid) throw new Error(status.error || "LOCAL_REPOSITORY_NOT_READY");
    if (status.locked) throw new Error("LOCAL_REPOSITORY_LOCKED");
    return status;
  }

  async branches(project: ReviewProject): Promise<GitBranchSummary[]> {
    const status = await this.assertRepository(project);
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
    return [...byName.values()].sort((a, b) => b.authoredAt.localeCompare(a.authoredAt));
  }

  async commits(project: ReviewProject, query: {
    branch?: string;
    search?: string;
    since?: string;
    until?: string;
    page: number;
    pageSize: number;
  }): Promise<GitCommitPage> {
    await this.assertRepository(project);
    const args = [
      "log",
      "--date-order",
      `--skip=${(query.page - 1) * query.pageSize}`,
      `--max-count=${query.pageSize + 1}`,
      "--format=%H%x00%h%x00%P%x00%s%x00%an%x00%ae%x00%aI%x00%D"
    ];
    if (query.search) args.push("--regexp-ignore-case", `--grep=${query.search}`);
    if (query.since) args.push(`--since=${query.since}`);
    if (query.until) {
      const inclusiveUntil = /^\d{4}-\d{2}-\d{2}$/.test(query.until)
        ? `${query.until} 23:59:59`
        : query.until;
      args.push(`--until=${inclusiveUntil}`);
    }
    if (query.branch) {
      const resolved = await this.resolveBranch(project.localRepositoryPath, query.branch);
      args.push(resolved);
    } else {
      args.push("--all");
    }
    const output = await this.command(project.localRepositoryPath, args);
    const rows = output.split(/\r?\n/).filter(Boolean);
    const hasMore = rows.length > query.pageSize;
    const items: GitCommitSummary[] = rows.slice(0, query.pageSize).map((line) => {
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
    return { items, page: query.page, pageSize: query.pageSize, hasMore };
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
