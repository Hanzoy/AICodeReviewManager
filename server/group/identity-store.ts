import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface GroupNodeIdentity {
  groupId: string;
  nodeId: string;
  nodeToken: string;
  managerUrl: string;
  registeredAt: string;
}

export class GroupIdentityStore {
  private readonly filePath: string;

  constructor(private readonly dataDir: string) {
    this.filePath = path.join(dataDir, "identity.json");
  }

  async load(): Promise<GroupNodeIdentity | undefined> {
    try {
      return JSON.parse(await readFile(this.filePath, "utf8")) as GroupNodeIdentity;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async save(identity: GroupNodeIdentity) {
    await mkdir(this.dataDir, { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(identity, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    try {
      await rename(tempPath, this.filePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "EPERM") throw error;
      await rm(this.filePath, { force: true });
      await rename(tempPath, this.filePath);
    }
  }

  async clear() {
    await rm(this.filePath, { force: true });
  }
}
