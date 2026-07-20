import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  CreateProjectGroupInput,
  EnrollmentResult,
  GroupNodeSummary,
  NodeHeartbeatInput,
  NodeRegistrationInput,
  NodeRegistrationResult,
  ProjectGroupSummary
} from "../../shared/contracts.js";

interface StoredNode extends Omit<GroupNodeSummary, "status"> {
  tokenHash: string;
  status: "online" | "offline" | "stopping";
}

interface StoredProjectGroup {
  id: string;
  key: string;
  name: string;
  description: string;
  status: "active" | "disabled";
  revision: number;
  createdAt: string;
  updatedAt: string;
  enrollment?: {
    tokenHash: string;
    expiresAt: string;
    usedAt?: string;
  };
  node?: StoredNode;
}

const HEARTBEAT_TIMEOUT_MS = 45_000;
const ENROLLMENT_TTL_MS = 30 * 60_000;

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function secureHashEquals(token: string, expectedHash: string) {
  const actual = Buffer.from(hashToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function issueToken(prefix: string) {
  return `${prefix}_${randomBytes(24).toString("base64url")}`;
}

export class ManagerFileStore {
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly rootDir: string,
    private readonly managerPublicUrl: string
  ) {}

  async init() {
    await mkdir(this.groupsDir, { recursive: true });
  }

  private get groupsDir() {
    return path.join(this.rootDir, "groups");
  }

  private groupDir(groupId: string) {
    return path.join(this.groupsDir, groupId);
  }

  private groupFile(groupId: string) {
    return path.join(this.groupDir(groupId), "group.json");
  }

  private async atomicWrite(filePath: string, value: unknown) {
    await mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    try {
      await rename(tempPath, filePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "EPERM") throw error;
      await rm(filePath, { force: true });
      await rename(tempPath, filePath);
    }
  }

  private withWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.catch(() => undefined);
    return result;
  }

  private async readGroup(groupId: string): Promise<StoredProjectGroup> {
    try {
      return JSON.parse(await readFile(this.groupFile(groupId), "utf8")) as StoredProjectGroup;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("PROJECT_GROUP_NOT_FOUND");
      }
      throw error;
    }
  }

  private toSummary(group: StoredProjectGroup): ProjectGroupSummary {
    const now = Date.now();
    const node = group.node
      ? {
          ...group.node,
          tokenHash: undefined,
          status:
            now - new Date(group.node.lastHeartbeatAt).getTime() > HEARTBEAT_TIMEOUT_MS
              ? "offline"
              : group.node.status
        }
      : undefined;

    if (node) delete (node as Partial<StoredNode>).tokenHash;

    return {
      id: group.id,
      key: group.key,
      name: group.name,
      description: group.description,
      status: group.status,
      createdAt: group.createdAt,
      updatedAt: group.updatedAt,
      enrollmentExpiresAt: group.enrollment?.expiresAt,
      enrollmentUsedAt: group.enrollment?.usedAt,
      node: node as GroupNodeSummary | undefined
    };
  }

  async listGroups() {
    const entries = await readdir(this.groupsDir, { withFileTypes: true });
    const groups = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => this.readGroup(entry.name))
    );
    return groups
      .map((group) => this.toSummary(group))
      .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  }

  async getGroup(groupId: string) {
    return this.toSummary(await this.readGroup(groupId));
  }

  async deleteGroup(groupId: string) {
    return this.withWrite(async () => {
      const group = await this.readGroup(groupId);
      const nodeIsOnline =
        group.node &&
        group.node.status === "online" &&
        Date.now() - new Date(group.node.lastHeartbeatAt).getTime() <= HEARTBEAT_TIMEOUT_MS;
      if (nodeIsOnline) throw new Error("PROJECT_GROUP_NODE_ONLINE");
      await rm(this.groupDir(groupId), { recursive: true, force: true });
    });
  }

  async createGroup(input: CreateProjectGroupInput): Promise<EnrollmentResult> {
    return this.withWrite(async () => {
      const groups = await this.listGroups();
      if (groups.some((group) => group.key.toLowerCase() === input.key.toLowerCase())) {
        throw new Error("PROJECT_GROUP_KEY_EXISTS");
      }

      const now = new Date().toISOString();
      const groupId = randomUUID();
      const token = issueToken("enroll");
      const expiresAt = new Date(Date.now() + ENROLLMENT_TTL_MS).toISOString();
      const group: StoredProjectGroup = {
        id: groupId,
        key: input.key,
        name: input.name,
        description: input.description ?? "",
        status: "active",
        revision: 1,
        createdAt: now,
        updatedAt: now,
        enrollment: {
          tokenHash: hashToken(token),
          expiresAt
        }
      };
      await this.atomicWrite(this.groupFile(groupId), group);
      return this.enrollmentResult(group, token, expiresAt);
    });
  }

  async rotateEnrollment(groupId: string): Promise<EnrollmentResult> {
    return this.withWrite(async () => {
      const group = await this.readGroup(groupId);
      const token = issueToken("enroll");
      const expiresAt = new Date(Date.now() + ENROLLMENT_TTL_MS).toISOString();
      group.enrollment = { tokenHash: hashToken(token), expiresAt };
      group.revision += 1;
      group.updatedAt = new Date().toISOString();
      await this.atomicWrite(this.groupFile(groupId), group);
      return this.enrollmentResult(group, token, expiresAt);
    });
  }

  private enrollmentResult(
    group: StoredProjectGroup,
    token: string,
    expiresAt: string
  ): EnrollmentResult {
    const safeName = group.name.replaceAll('"', "");
    return {
      group: this.toSummary(group),
      enrollmentToken: token,
      expiresAt,
      startCommand:
        `npm run start:group -- --manager-url=${this.managerPublicUrl}` +
        ` --group-id=${group.id} --enroll-token=${token}` +
        ` --name=\"${safeName}\" --data-dir=./data/group-nodes/${group.id}`
    };
  }

  async registerNode(
    enrollmentToken: string,
    input: NodeRegistrationInput
  ): Promise<NodeRegistrationResult> {
    return this.withWrite(async () => {
      const group = await this.readGroup(input.groupId);
      if (group.status !== "active") throw new Error("PROJECT_GROUP_DISABLED");
      if (!group.enrollment) throw new Error("ENROLLMENT_NOT_AVAILABLE");
      if (group.enrollment.usedAt) throw new Error("ENROLLMENT_ALREADY_USED");
      if (Date.now() > new Date(group.enrollment.expiresAt).getTime()) {
        throw new Error("ENROLLMENT_EXPIRED");
      }
      if (!secureHashEquals(enrollmentToken, group.enrollment.tokenHash)) {
        throw new Error("INVALID_ENROLLMENT_TOKEN");
      }

      const now = new Date().toISOString();
      const nodeToken = issueToken("node");
      group.enrollment.usedAt = now;
      group.node = {
        id: randomUUID(),
        instanceId: input.instanceId,
        host: input.host,
        port: input.port,
        baseUrl: input.baseUrl,
        version: input.version,
        capabilities: input.capabilities,
        status: "online",
        registeredAt: now,
        lastHeartbeatAt: now,
        startedAt: input.startedAt,
        activeReviewCount: 0,
        repositoryStatus: "unknown",
        tokenHash: hashToken(nodeToken)
      };
      group.revision += 1;
      group.updatedAt = now;
      await this.atomicWrite(this.groupFile(group.id), group);
      return {
        nodeId: group.node.id,
        nodeToken,
        heartbeatIntervalSeconds: 15
      };
    });
  }

  async reconnectNode(nodeToken: string, input: NodeRegistrationInput) {
    return this.withWrite(async () => {
      const group = await this.readGroup(input.groupId);
      if (!group.node || !secureHashEquals(nodeToken, group.node.tokenHash)) {
        throw new Error("INVALID_NODE_TOKEN");
      }
      const now = new Date().toISOString();
      group.node = {
        ...group.node,
        instanceId: input.instanceId,
        host: input.host,
        port: input.port,
        baseUrl: input.baseUrl,
        version: input.version,
        capabilities: input.capabilities,
        status: "online",
        lastHeartbeatAt: now,
        startedAt: input.startedAt
      };
      group.updatedAt = now;
      await this.atomicWrite(this.groupFile(group.id), group);
      return { heartbeatIntervalSeconds: 15 };
    });
  }

  async heartbeat(nodeId: string, nodeToken: string, input: NodeHeartbeatInput) {
    return this.withWrite(async () => {
      const group = await this.readGroup(input.groupId);
      if (
        !group.node ||
        group.node.id !== nodeId ||
        !secureHashEquals(nodeToken, group.node.tokenHash)
      ) {
        throw new Error("INVALID_NODE_TOKEN");
      }
      const now = new Date().toISOString();
      group.node.status = "online";
      group.node.instanceId = input.instanceId;
      group.node.activeReviewCount = input.activeReviewCount;
      group.node.repositoryStatus = input.repositoryStatus;
      group.node.startedAt = input.startedAt;
      group.node.lastHeartbeatAt = now;
      group.updatedAt = now;
      await this.atomicWrite(this.groupFile(group.id), group);
      return { acceptedAt: now };
    });
  }

  async deregister(nodeId: string, nodeToken: string, groupId: string) {
    return this.withWrite(async () => {
      const group = await this.readGroup(groupId);
      if (
        !group.node ||
        group.node.id !== nodeId ||
        !secureHashEquals(nodeToken, group.node.tokenHash)
      ) {
        throw new Error("INVALID_NODE_TOKEN");
      }
      group.node.status = "offline";
      group.node.lastHeartbeatAt = new Date().toISOString();
      group.updatedAt = group.node.lastHeartbeatAt;
      await this.atomicWrite(this.groupFile(group.id), group);
    });
  }
}

export { HEARTBEAT_TIMEOUT_MS };
