import type {
  CreateReviewProjectInput,
  CreateProjectGroupInput,
  EnrollmentResult,
  GroupNodeConfig,
  GroupNodeConfigUpdate,
  GroupWorkspaceData,
  GitBranchSummary,
  GitCommitPage,
  GitRepositoryStatus,
  CreateManualReviewInput,
  ManualReviewPreview,
  ManagerRuntimeInfo,
  ProjectGroupSummary,
  ProjectWebhookCredentials,
  ReviewProject,
  ReviewTask,
  UpdateReviewProjectInput
} from "../shared/contracts";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && init.body !== null && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(url, {
    ...init,
    headers
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as { error?: string } | undefined;
    const code = body?.error;
    const friendlyMessages: Record<string, string> = {
      GROUP_NODE_UPGRADE_REQUIRED: "项目组节点版本过旧，请停止并重新启动该节点后再试",
      GROUP_NODE_OFFLINE: "项目组节点当前离线，请先启动节点",
      GROUP_NODE_UNAVAILABLE: "项目组节点暂时无法连接，请检查节点进程",
      "Not Found": "当前项目组节点尚未加载此功能，请停止并重新启动节点"
    };
    throw new Error((code && friendlyMessages[code]) ?? code ?? `请求失败：${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const managerApi = {
  runtime: () => request<ManagerRuntimeInfo>("/api/runtime"),
  groups: async () => (await request<{ items: ProjectGroupSummary[] }>("/api/groups")).items,
  createGroup: (input: CreateProjectGroupInput) =>
    request<EnrollmentResult>("/api/groups", {
      method: "POST",
      body: JSON.stringify(input)
    }),
  rotateEnrollment: (groupId: string) =>
    request<EnrollmentResult>(`/api/groups/${groupId}/enrollment`, { method: "POST" }),
  workspace: (groupId: string) =>
    request<GroupWorkspaceData>(`/api/groups/${groupId}/workspace`),
  updateGroupConfig: (groupId: string, input: GroupNodeConfigUpdate) =>
    request<GroupNodeConfig>(`/api/groups/${groupId}/config`, {
      method: "PUT",
      body: JSON.stringify(input)
    }),
  projects: async (groupId: string) =>
    (await request<{ items: ReviewProject[] }>(`/api/groups/${groupId}/projects`)).items,
  project: (groupId: string, projectId: string) =>
    request<ReviewProject>(`/api/groups/${groupId}/projects/${projectId}`),
  createProject: (groupId: string, input: CreateReviewProjectInput) =>
    request<ProjectWebhookCredentials>(`/api/groups/${groupId}/projects`, {
      method: "POST",
      body: JSON.stringify(input)
    }),
  updateProject: (groupId: string, projectId: string, input: UpdateReviewProjectInput) =>
    request<ReviewProject>(`/api/groups/${groupId}/projects/${projectId}`, {
      method: "PUT",
      body: JSON.stringify(input)
    }),
  deleteProject: (groupId: string, projectId: string) =>
    request<void>(`/api/groups/${groupId}/projects/${projectId}`, { method: "DELETE" }),
  rotateProjectWebhook: (groupId: string, projectId: string) =>
    request<ProjectWebhookCredentials>(
      `/api/groups/${groupId}/projects/${projectId}/webhook/rotate`,
      { method: "POST" }
    ),
  repositoryStatus: (groupId: string, projectId: string) =>
    request<GitRepositoryStatus>(`/api/groups/${groupId}/projects/${projectId}/repository/status`),
  repositoryBranches: async (groupId: string, projectId: string) =>
    (await request<{ items: GitBranchSummary[] }>(
      `/api/groups/${groupId}/projects/${projectId}/repository/branches`
    )).items,
  repositoryCommits: (
    groupId: string,
    projectId: string,
    query: { branch?: string; search?: string; since?: string; until?: string; page?: number; pageSize?: number }
  ) => {
    const search = new URLSearchParams();
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined && value !== "") search.set(key, String(value));
    });
    return request<GitCommitPage>(
      `/api/groups/${groupId}/projects/${projectId}/repository/commits?${search.toString()}`
    );
  },
  previewManualReview: (groupId: string, projectId: string, input: CreateManualReviewInput) =>
    request<ManualReviewPreview>(
      `/api/groups/${groupId}/projects/${projectId}/manual-reviews/preview`,
      { method: "POST", body: JSON.stringify(input) }
    ),
  createManualReview: (groupId: string, projectId: string, input: CreateManualReviewInput) =>
    request<ReviewTask>(`/api/groups/${groupId}/projects/${projectId}/manual-reviews`, {
      method: "POST",
      body: JSON.stringify(input)
    }),
  reviews: async (groupId: string) =>
    (await request<{ items: ReviewTask[] }>(`/api/groups/${groupId}/reviews`)).items,
  retryReview: (groupId: string, taskId: string) =>
    request<ReviewTask>(`/api/groups/${groupId}/reviews/${taskId}/retry`, { method: "POST" })
};
