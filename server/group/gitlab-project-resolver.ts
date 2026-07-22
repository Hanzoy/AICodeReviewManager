import { z } from "zod";
import type { GitLabProjectMetadata, GroupNodeConfig } from "../../shared/contracts.js";

const gitLabProjectSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  path: z.string().min(1),
  path_with_namespace: z.string().min(1),
  default_branch: z.string().nullable().optional(),
  ssh_url_to_repo: z.string().default(""),
  http_url_to_repo: z.string().default(""),
  web_url: z.string().default("")
});

export async function resolveGitLabProject(
  config: GroupNodeConfig["gitlab"],
  token: string | undefined,
  projectRef: string
): Promise<GitLabProjectMetadata> {
  const baseUrl = config.baseUrl.trim().replace(/\/$/, "");
  const apiUrl = (config.apiUrl.trim() || (baseUrl ? `${baseUrl}/api/v4` : "")).replace(/\/$/, "");
  if (!apiUrl || !token) throw new Error("GITLAB_CONNECTION_NOT_CONFIGURED");

  const response = await fetch(`${apiUrl}/projects/${encodeURIComponent(projectRef.trim())}`, {
    headers: { "PRIVATE-TOKEN": token },
    signal: AbortSignal.timeout(config.requestTimeoutSeconds * 1000)
  });
  if (response.status === 404) throw new Error("GITLAB_PROJECT_NOT_FOUND");
  if (!response.ok) throw new Error(`GITLAB_PROJECT_LOOKUP_FAILED_${response.status}`);

  const project = gitLabProjectSchema.parse(await response.json());
  // HTTPS is the default because Review workers authenticate with the
  // project-group Access Token instead of a machine-level SSH identity.
  const suggestedRepositoryUrl = project.http_url_to_repo || project.ssh_url_to_repo;
  if (!suggestedRepositoryUrl) throw new Error("GITLAB_PROJECT_CLONE_URL_MISSING");
  return {
    id: project.id,
    name: project.name,
    path: project.path,
    pathWithNamespace: project.path_with_namespace,
    defaultBranch: project.default_branch || "main",
    sshRepositoryUrl: project.ssh_url_to_repo,
    httpRepositoryUrl: project.http_url_to_repo,
    webUrl: project.web_url,
    suggestedRepositoryUrl
  };
}
