import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GroupNodeConfig } from "../../shared/contracts.js";
import { resolveGitLabProject } from "./gitlab-project-resolver.js";

export interface GitRepositoryAccess {
  repositoryUrl: string;
  environment: NodeJS.ProcessEnv;
  authentication: "gitlab-token" | "local";
}

export function withGitSafeDirectory(
  environment: NodeJS.ProcessEnv,
  repositoryPath: string
): NodeJS.ProcessEnv {
  const next = { ...environment };
  const configuredCount = Number.parseInt(next.GIT_CONFIG_COUNT ?? "0", 10);
  const count = Number.isSafeInteger(configuredCount) && configuredCount >= 0 ? configuredCount : 0;
  next.GIT_CONFIG_COUNT = String(count + 1);
  next[`GIT_CONFIG_KEY_${count}`] = "safe.directory";
  next[`GIT_CONFIG_VALUE_${count}`] = path.resolve(repositoryPath);
  return next;
}

export async function gitEnvironment(
  dataDir: string,
  repositoryUrl: string,
  gitlabToken: string
): Promise<NodeJS.ProcessEnv> {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never"
  };
  if (!/^https?:\/\//i.test(repositoryUrl)) return environment;

  const askPassPath = path.resolve(dataDir, process.platform === "win32" ? "git-askpass.cmd" : "git-askpass.sh");
  const script = process.platform === "win32"
    ? "@echo off\r\necho %~1 | findstr /I \"Username\" >nul\r\nif %errorlevel%==0 (echo oauth2) else (echo %CODE_REVIEW_GITLAB_TOKEN%)\r\n"
    : "#!/bin/sh\ncase \"$1\" in *Username*) printf '%s\\n' oauth2 ;; *) printf '%s\\n' \"$CODE_REVIEW_GITLAB_TOKEN\" ;; esac\n";
  await writeFile(askPassPath, script, { encoding: "utf8", mode: 0o700 });
  if (process.platform !== "win32") await chmod(askPassPath, 0o700);
  environment.GIT_ASKPASS = askPassPath;
  environment.CODE_REVIEW_GITLAB_TOKEN = gitlabToken;
  // Do not let a machine-level credential helper silently authenticate as the
  // interactive desktop user before Git asks our project-group AskPass helper.
  const configuredCount = Number.parseInt(environment.GIT_CONFIG_COUNT ?? "0", 10);
  const count = Number.isSafeInteger(configuredCount) && configuredCount >= 0 ? configuredCount : 0;
  environment.GIT_CONFIG_COUNT = String(count + 1);
  environment[`GIT_CONFIG_KEY_${count}`] = "credential.helper";
  environment[`GIT_CONFIG_VALUE_${count}`] = "";
  return environment;
}

export async function resolveGitRepositoryAccess(input: {
  dataDir: string;
  configuredRepositoryUrl: string;
  gitlabProjectRef: string;
  gitlabConfig: GroupNodeConfig["gitlab"];
  gitlabToken: string;
}): Promise<GitRepositoryAccess> {
  let repositoryUrl = input.configuredRepositoryUrl.trim();
  const usesSsh = /^(?:ssh:\/\/|git@)/i.test(repositoryUrl);
  if (usesSsh) {
    const metadata = await resolveGitLabProject(
      input.gitlabConfig,
      input.gitlabToken,
      input.gitlabProjectRef
    );
    if (!metadata.httpRepositoryUrl) {
      throw new Error("GITLAB_HTTP_CLONE_URL_MISSING");
    }
    repositoryUrl = metadata.httpRepositoryUrl;
  }

  const usesHttp = /^https?:\/\//i.test(repositoryUrl);
  return {
    repositoryUrl,
    environment: await gitEnvironment(input.dataDir, repositoryUrl, input.gitlabToken),
    authentication: usesHttp ? "gitlab-token" : "local"
  };
}
