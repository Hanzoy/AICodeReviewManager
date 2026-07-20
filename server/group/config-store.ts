import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GroupNodeConfig, GroupNodeConfigUpdate } from "../../shared/contracts.js";

interface StoredGroupConfig extends Omit<GroupNodeConfig, "gitlab" | "ai" | "feishu"> {
  gitlab: Omit<GroupNodeConfig["gitlab"], "tokenConfigured">;
  ai: Omit<GroupNodeConfig["ai"], "apiKeyConfigured">;
  feishu: Omit<GroupNodeConfig["feishu"], "webhookConfigured" | "signingSecretConfigured">;
}

interface GroupSecrets {
  gitlabToken?: string;
  aiApiKey?: string;
  feishuWebhookUrl?: string;
  feishuSigningSecret?: string;
}

interface EncryptedEnvelope {
  version: 1;
  algorithm: "aes-256-gcm";
  iv: string;
  authTag: string;
  ciphertext: string;
}

export class GroupConfigStore {
  private readonly configFile: string;
  private readonly keyFile: string;
  private readonly secretsFile: string;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly dataDir: string,
    private readonly groupName: string
  ) {
    this.configFile = path.join(dataDir, "config.json");
    this.keyFile = path.join(dataDir, "secret.key");
    this.secretsFile = path.join(dataDir, "secrets.enc.json");
  }

  async init() {
    await mkdir(this.dataDir, { recursive: true });
    try {
      await readFile(this.configFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.atomicWrite(this.configFile, this.defaultConfig());
    }
  }

  private defaultConfig(): StoredGroupConfig {
    const now = new Date().toISOString();
    return {
      schemaVersion: 1,
      revision: 1,
      updatedAt: now,
      general: {
        displayName: this.groupName,
        description: "",
        timezone: "Asia/Shanghai",
        reviewLanguage: "zh-CN"
      },
      repository: {
        rootPath: path.resolve(this.dataDir, "repositories"),
        cloneDepth: 0,
        maxDiskGigabytes: 100
      },
      gitlab: {
        baseUrl: "",
        apiUrl: "",
        sslVerification: true,
        requestTimeoutSeconds: 20
      },
      ai: {
        provider: "deepseek",
        baseUrl: "https://api.deepseek.com/anthropic",
        model: "deepseek-v4-pro[1m]",
        fastModel: "deepseek-v4-flash",
        subagentModel: "deepseek-v4-flash",
        reasoningEffort: "max",
        requestTimeoutSeconds: 600,
        maxConcurrency: 1,
        maxOutputTokens: 8000,
        reviewPrompt: [
          "你是一名严格但务实的高级代码审查工程师。",
          "只审查当前 Merge Request 相对于目标分支引入的变更，并结合必要的上下文判断。",
          "重点检查正确性、边界条件、并发、数据一致性、安全、性能和可维护性。",
          "只报告能够由代码变更直接证明、且开发者可以采取行动的问题；不要报告纯风格偏好。",
          "每个问题必须给出文件路径和尽可能准确的新代码行号，并说明触发条件、影响与修改建议。",
          "如果没有实质问题，findings 返回空数组，verdict 返回 approve。",
          "最终只输出符合指定 JSON Schema 的结果，不要使用 Markdown 代码块。"
        ].join("\n")
      },
      feishu: {
        enabled: false,
        name: "",
        notifyOnMergeRequestTriggered: true,
        notifyOnManualReviewCompleted: true,
        notifyOnReviewCompleted: true,
        notifyOnReviewFailed: true,
        notifyOnCriticalFinding: true
      }
    };
  }

  private async atomicWrite(filePath: string, value: unknown, mode?: number) {
    await mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode
    });
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

  private async readStoredConfig(): Promise<StoredGroupConfig> {
    const config = JSON.parse(await readFile(this.configFile, "utf8")) as StoredGroupConfig & {
      repository: StoredGroupConfig["repository"] & {
        worktreeRootPath?: string;
        cleanupPolicy?: string;
      };
      gitlab: StoredGroupConfig["gitlab"] & {
        name?: string;
      };
      ai: Partial<StoredGroupConfig["ai"]> & {
        provider?: string;
        baseUrl?: string;
        reviewCommand?: string;
        codexCommand?: string;
        codexProfile?: string;
      };
    };
    const {
      worktreeRootPath: _legacyWorktreeRootPath,
      cleanupPolicy: _legacyCleanupPolicy,
      ...repository
    } = config.repository;
    const { name: _legacyGitlabName, ...gitlab } = config.gitlab;
    const {
      reviewCommand: _legacyReviewCommand,
      codexCommand: _legacyCodexCommand,
      codexProfile: _legacyCodexProfile,
      ...ai
    } = config.ai;
    const defaults = this.defaultConfig();
    const isLegacyAiConfig = config.ai.provider !== "deepseek";
    return {
      ...defaults,
      ...config,
      general: { ...defaults.general, ...config.general },
      repository: { ...defaults.repository, ...repository },
      gitlab: { ...defaults.gitlab, ...gitlab },
      ai: {
        ...defaults.ai,
        ...ai,
        provider: "deepseek",
        baseUrl: config.ai.baseUrl || defaults.ai.baseUrl,
        model: config.ai.model || defaults.ai.model,
        fastModel: config.ai.fastModel || defaults.ai.fastModel,
        subagentModel: config.ai.subagentModel || defaults.ai.subagentModel,
        requestTimeoutSeconds: isLegacyAiConfig
          ? Math.max(config.ai.requestTimeoutSeconds ?? 0, defaults.ai.requestTimeoutSeconds)
          : config.ai.requestTimeoutSeconds ?? defaults.ai.requestTimeoutSeconds
      },
      feishu: { ...defaults.feishu, ...config.feishu }
    };
  }

  private async loadOrCreateKey() {
    try {
      return Buffer.from(await readFile(this.keyFile, "utf8"), "base64");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const key = randomBytes(32);
      await writeFile(this.keyFile, key.toString("base64"), { encoding: "utf8", mode: 0o600 });
      return key;
    }
  }

  private async readSecrets(): Promise<GroupSecrets> {
    try {
      const envelope = JSON.parse(await readFile(this.secretsFile, "utf8")) as EncryptedEnvelope;
      const key = await this.loadOrCreateKey();
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
      decipher.setAuthTag(Buffer.from(envelope.authTag, "base64"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64")),
        decipher.final()
      ]);
      return JSON.parse(plaintext.toString("utf8")) as GroupSecrets;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  private async writeSecrets(secrets: GroupSecrets) {
    const key = await this.loadOrCreateKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from(JSON.stringify(secrets), "utf8")),
      cipher.final()
    ]);
    const envelope: EncryptedEnvelope = {
      version: 1,
      algorithm: "aes-256-gcm",
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64")
    };
    await this.atomicWrite(this.secretsFile, envelope, 0o600);
  }

  private toPublicConfig(config: StoredGroupConfig, secrets: GroupSecrets): GroupNodeConfig {
    return {
      ...config,
      gitlab: { ...config.gitlab, tokenConfigured: Boolean(secrets.gitlabToken) },
      ai: { ...config.ai, apiKeyConfigured: Boolean(secrets.aiApiKey) },
      feishu: {
        ...config.feishu,
        webhookConfigured: Boolean(secrets.feishuWebhookUrl),
        signingSecretConfigured: Boolean(secrets.feishuSigningSecret)
      }
    };
  }

  async get() {
    return this.toPublicConfig(await this.readStoredConfig(), await this.readSecrets());
  }

  async getExecutionContext() {
    const config = await this.readStoredConfig();
    const secrets = await this.readSecrets();
    return {
      config: this.toPublicConfig(config, secrets),
      gitlabToken: secrets.gitlabToken,
      aiApiKey: secrets.aiApiKey
    };
  }

  async getFeishuContext() {
    const config = await this.readStoredConfig();
    const secrets = await this.readSecrets();
    return {
      config: this.toPublicConfig(config, secrets),
      webhookUrl: secrets.feishuWebhookUrl,
      signingSecret: secrets.feishuSigningSecret
    };
  }

  async update(input: GroupNodeConfigUpdate) {
    return this.withWrite(async () => {
      const current = await this.readStoredConfig();
      const secrets = await this.readSecrets();
      const { token: gitlabToken, ...gitlab } = input.gitlab ?? {};
      const { apiKey, ...ai } = input.ai ?? {};
      const { webhookUrl, signingSecret, ...feishu } = input.feishu ?? {};
      const next: StoredGroupConfig = {
        ...current,
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
        general: { ...current.general, ...input.general },
        repository: { ...current.repository, ...input.repository },
        gitlab: { ...current.gitlab, ...gitlab },
        ai: { ...current.ai, ...ai },
        feishu: { ...current.feishu, ...feishu }
      };

      if (gitlabToken?.trim()) secrets.gitlabToken = gitlabToken.trim();
      if (apiKey?.trim()) secrets.aiApiKey = apiKey.trim();
      if (webhookUrl?.trim()) secrets.feishuWebhookUrl = webhookUrl.trim();
      if (signingSecret?.trim()) secrets.feishuSigningSecret = signingSecret.trim();

      await this.atomicWrite(this.configFile, next);
      await this.writeSecrets(secrets);
      return this.toPublicConfig(next, secrets);
    });
  }
}
