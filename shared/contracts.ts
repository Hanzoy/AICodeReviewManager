export type NodeConnectionState = "pending" | "online" | "offline" | "stopping";
export type GroupStatus = "active" | "disabled";

export interface GroupNodeSummary {
  id: string;
  instanceId: string;
  host: string;
  port: number;
  baseUrl: string;
  version: string;
  capabilities: string[];
  status: NodeConnectionState;
  registeredAt: string;
  lastHeartbeatAt: string;
  startedAt: string;
  activeReviewCount: number;
  repositoryStatus: "unknown" | "healthy" | "error";
}

export interface ProjectGroupSummary {
  id: string;
  key: string;
  name: string;
  description: string;
  status: GroupStatus;
  createdAt: string;
  updatedAt: string;
  enrollmentExpiresAt?: string;
  enrollmentUsedAt?: string;
  node?: GroupNodeSummary;
}

export interface ManagerRuntimeInfo {
  name: string;
  version: string;
  host: string;
  port: number;
  publicUrl: string;
  registrationUrl: string;
  heartbeatTimeoutSeconds: number;
  startedAt: string;
}

export interface CreateProjectGroupInput {
  name: string;
  key: string;
  description?: string;
}

export interface EnrollmentResult {
  group: ProjectGroupSummary;
  enrollmentToken: string;
  expiresAt: string;
  startCommand: string;
}

export interface NodeRegistrationInput {
  groupId: string;
  instanceId: string;
  name: string;
  host: string;
  port: number;
  baseUrl: string;
  version: string;
  capabilities: string[];
  startedAt: string;
}

export interface NodeRegistrationResult {
  nodeId: string;
  nodeToken: string;
  heartbeatIntervalSeconds: number;
}

export interface NodeHeartbeatInput {
  groupId: string;
  instanceId: string;
  activeReviewCount: number;
  repositoryStatus: "unknown" | "healthy" | "error";
  startedAt: string;
}

export interface GroupNodeRuntimeStatus {
  groupId: string;
  nodeId?: string;
  instanceId: string;
  name: string;
  status: "registering" | "online" | "offline" | "error";
  managerUrl: string;
  host: string;
  port: number;
  startedAt: string;
  lastHeartbeatAt?: string;
  integrations: {
    gitlab: "unconfigured" | "healthy" | "error";
    ai: "unconfigured" | "healthy" | "error";
    feishu: "unconfigured" | "healthy" | "error";
  };
}

export type IntegrationConfigState = "unconfigured" | "configured" | "disabled";

export interface GroupNodeConfig {
  schemaVersion: 1;
  revision: number;
  updatedAt: string;
  general: {
    displayName: string;
    description: string;
    timezone: string;
    reviewLanguage: "zh-CN" | "en-US";
  };
  repository: {
    rootPath: string;
    cloneDepth: number;
    maxDiskGigabytes: number;
  };
  gitlab: {
    baseUrl: string;
    apiUrl: string;
    sslVerification: boolean;
    requestTimeoutSeconds: number;
    tokenConfigured: boolean;
  };
  ai: {
    provider: "deepseek";
    baseUrl: string;
    model: string;
    fastModel: string;
    subagentModel: string;
    reasoningEffort: "low" | "medium" | "high" | "xhigh" | "max";
    requestTimeoutSeconds: number;
    maxConcurrency: number;
    maxOutputTokens: number;
    reviewPrompt: string;
    apiKeyConfigured: boolean;
  };
  feishu: {
    enabled: boolean;
    name: string;
    notifyOnMergeRequestTriggered: boolean;
    notifyOnManualReviewCompleted: boolean;
    notifyOnReviewCompleted: boolean;
    notifyOnReviewFailed: boolean;
    notifyOnCriticalFinding: boolean;
    webhookConfigured: boolean;
    signingSecretConfigured: boolean;
  };
}

export interface GroupNodeConfigUpdate {
  general?: Partial<GroupNodeConfig["general"]>;
  repository?: Partial<GroupNodeConfig["repository"]>;
  gitlab?: Partial<Omit<GroupNodeConfig["gitlab"], "tokenConfigured">> & {
    token?: string;
  };
  ai?: Partial<Omit<GroupNodeConfig["ai"], "apiKeyConfigured">> & {
    apiKey?: string;
  };
  feishu?: Partial<
    Omit<GroupNodeConfig["feishu"], "webhookConfigured" | "signingSecretConfigured">
  > & {
    webhookUrl?: string;
    signingSecret?: string;
  };
}

export type ProjectWebhookState = "waiting" | "active";
export type ReviewTaskStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "superseded";

export type ReviewFindingSeverity = "critical" | "high" | "medium" | "low";
export type ReviewVerdict = "approve" | "comment" | "request_changes";
export type ReviewRiskLevel = "critical" | "high" | "medium" | "low";
export type ReviewTriggerType = "merge_request" | "manual";

export interface ManualReviewSelection {
  mode: "commits" | "branch";
  commitShas: string[];
  branch?: string;
  targetBranch: string;
}

export interface CreateManualReviewInput {
  selection: ManualReviewSelection;
  requestedBy?: string;
}

export interface GitRepositoryStatus {
  exists: boolean;
  valid: boolean;
  bare: boolean;
  locked: boolean;
  clean?: boolean;
  currentBranch?: string;
  headSha?: string;
  originUrl?: string;
  remoteMatches: boolean;
  checkedAt: string;
  error?: string;
}

export interface GitBranchSummary {
  name: string;
  headSha: string;
  authoredAt: string;
  subject: string;
  current: boolean;
  remote: boolean;
}

export interface GitCommitSummary {
  sha: string;
  shortSha: string;
  parentShas: string[];
  subject: string;
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  refs: string[];
  graph: GitCommitGraph;
}

export interface GitCommitGraphSegment {
  fromLane: number;
  fromPosition: "top" | "node";
  toLane: number;
  toPosition: "node" | "bottom";
  colorIndex: number;
}

export interface GitCommitGraph {
  lane: number;
  laneCount: number;
  colorIndex: number;
  segments: GitCommitGraphSegment[];
}

export interface GitCommitAuthor {
  name: string;
  email: string;
  commitCount: number;
}

export interface GitCommitPage {
  items: GitCommitSummary[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
  authors: GitCommitAuthor[];
  cache: {
    generatedAt: string;
    syncedAt?: string;
    commitCount: number;
    refreshed: boolean;
  };
}

export interface GitRepositorySyncResult {
  startedAt: string;
  completedAt: string;
  changed: boolean;
  commitCount: number;
  cacheGeneratedAt: string;
}

export interface ManualReviewPreview {
  selection: ManualReviewSelection;
  commitCount: number;
  fileCount: number;
  additions: number;
  deletions: number;
}

export interface ReviewFinding {
  severity: ReviewFindingSeverity;
  title: string;
  file: string;
  line: number | null;
  description: string;
  suggestion: string;
}

export interface ReviewResult {
  verdict: ReviewVerdict;
  riskLevel: ReviewRiskLevel;
  summary: string;
  findings: ReviewFinding[];
  positives: string[];
}

export interface ReviewProject {
  id: string;
  key: string;
  name: string;
  description: string;
  enabled: boolean;
  gitlabProjectRef: string;
  repositoryUrl: string;
  defaultBranch: string;
  localRepositoryPath: string;
  webhook: {
    url: string;
    secretConfigured: boolean;
    state: ProjectWebhookState;
    lastEventAt?: string;
    lastEventName?: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface CreateReviewProjectInput {
  key: string;
  name: string;
  description?: string;
  enabled?: boolean;
  gitlabProjectRef: string;
  repositoryUrl: string;
  defaultBranch: string;
}

export interface UpdateReviewProjectInput {
  name?: string;
  description?: string;
  enabled?: boolean;
  gitlabProjectRef?: string;
  repositoryUrl?: string;
  defaultBranch?: string;
}

export interface GitLabProjectMetadata {
  id: number;
  name: string;
  path: string;
  pathWithNamespace: string;
  defaultBranch: string;
  sshRepositoryUrl: string;
  httpRepositoryUrl: string;
  webUrl: string;
  suggestedRepositoryUrl: string;
}

export interface ProjectWebhookCredentials {
  project: ReviewProject;
  secret: string;
}

export interface ReviewTask {
  id: string;
  triggerType: ReviewTriggerType;
  projectId: string;
  projectName: string;
  mergeRequestIid: number;
  mergeRequestTitle: string;
  mergeRequestUrl?: string;
  sourceBranch: string;
  targetBranch: string;
  headSha: string;
  authorName: string;
  action: string;
  status: ReviewTaskStatus;
  deliveryId?: string;
  manualSelection?: ManualReviewSelection;
  manualPreview?: ManualReviewPreview;
  requestedBy?: string;
  retryCount: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  result?: ReviewResult;
  gitlabNoteId?: number;
  gitlabNoteUrl?: string;
}

export interface GitLabWebhookResult {
  accepted: boolean;
  queued: boolean;
  deduplicated: boolean;
  reason?: string;
  taskId?: string;
}

export interface GroupWorkspaceData {
  runtime: GroupNodeRuntimeStatus;
  config: GroupNodeConfig;
  stats: {
    projectCount: number;
    queuedReviewCount: number;
    completedReviewCount: number;
    findingCount: number;
  };
  recentReviews: Array<{
    id: string;
    projectName: string;
    mergeRequest: string;
    status: string;
    completedAt?: string;
  }>;
}
