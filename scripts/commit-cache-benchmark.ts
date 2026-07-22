import path from "node:path";
import { performance } from "node:perf_hooks";
import { GitRepositoryService } from "../server/group/git-repository.js";

const [repositoryArgument, cacheRootArgument, projectId = "benchmark-project"] = process.argv.slice(2);
if (!repositoryArgument || !cacheRootArgument) {
  throw new Error("Usage: tsx scripts/commit-cache-benchmark.ts <repository-path> <cache-root> [project-id]");
}

const repositoryPath = path.resolve(repositoryArgument);
const service = new GitRepositoryService(path.resolve(cacheRootArgument));
const project = {
  id: projectId,
  localRepositoryPath: repositoryPath,
  repositoryUrl: repositoryPath,
  defaultBranch: "main"
};

const startedAt = performance.now();
const firstPage = await service.commits(project as never, { page: 1, pageSize: 50 });
const warmedAt = performance.now();
const warmPage = await service.commits(project as never, { page: 1, pageSize: 50 });
const completedAt = performance.now();

console.log(JSON.stringify({
  commitCount: firstPage.cache.commitCount,
  coldProcessMs: Math.round(warmedAt - startedAt),
  warmMemoryMs: Math.round(completedAt - warmedAt),
  cacheRefreshed: firstPage.cache.refreshed,
  returnedItems: warmPage.items.length
}, null, 2));
