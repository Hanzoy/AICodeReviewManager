import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GroupNodeConfig } from "../../shared/contracts.js";
import { resolveGitLabProject } from "./gitlab-project-resolver.js";

export interface GitRepositoryAccess {
  repositoryUrl: string;
  environment: NodeJS.ProcessEnv;
  authentication: "gitlab-token" | "local";
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
  environment.GIT_CONFIG_COUNT = "1";
  environment.GIT_CONFIG_KEY_0 = "credential.helper";
  environment.GIT_CONFIG_VALUE_0 = "";
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
