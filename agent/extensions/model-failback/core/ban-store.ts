/**
 * 跨 Pi 进程的 failback 禁用表。
 *
 * agent-team 的每个 subagent 都是全新 `pi --no-session` 进程，内存态无法避免
 * 下一个 worker 再次请求已耗尽模型。因此仅将"终态 ban"持久化到 agent 目录；
 * chains 与 models.json 不被改写，充值/恢复后可由命令清除。
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface BanRecord {
  /** 原终态的 fallback 约束；仅影响该禁用模型的下游选择，不扩大 ban 范围。 */
  scope: "cross-provider" | "any";
  reason: string;
  note?: string;
  markedAt: number;
  resetsAt?: number;
}

export interface BanStore {
  refresh(): Promise<void>;
  mark(key: string, record: BanRecord): Promise<string>;
  setSessionId(sessionId: string): void;
  endSession(): Promise<void>;
  isBlocked(key: string): boolean;
  get(key: string): BanRecord | undefined;
  list(): Array<{ key: string; record: BanRecord }>;
  clear(key?: string): Promise<void>;
}

type StoredBans = { version: 1; bans: Record<string, BanRecord> };

export const BAN_FILE_PREFIX = "model-failback-bans-";
export const BAN_LOCK_STALE_MS = 30_000;

function isExpired(record: BanRecord): boolean {
  return record.resetsAt !== undefined && Date.now() >= record.resetsAt;
}

function activeEntries(bans: Record<string, BanRecord>): Record<string, BanRecord> {
  return Object.fromEntries(Object.entries(bans).filter(([, record]) => !isExpired(record)));
}

function normalize(raw: unknown): Record<string, BanRecord> {
  if (typeof raw !== "object" || raw === null) return {};
  const entries = (raw as { bans?: unknown }).bans;
  if (typeof entries !== "object" || entries === null) return {};
  const out: Record<string, BanRecord> = {};
  for (const [key, value] of Object.entries(entries as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const r = value as Partial<BanRecord>;
    if (
      (r.scope !== "cross-provider" && r.scope !== "any") ||
      typeof r.reason !== "string" ||
      typeof r.markedAt !== "number"
    ) continue;
    out[key] = {
      scope: r.scope,
      reason: r.reason,
      ...(typeof r.note === "string" ? { note: r.note } : {}),
      markedAt: r.markedAt,
      ...(typeof r.resetsAt === "number" ? { resetsAt: r.resetsAt } : {}),
    };
  }
  return activeEntries(out);
}

export class MemoryBanStore implements BanStore {
  protected bans: Record<string, BanRecord> = {};

  setSessionId(_sessionId: string): void {}

  async endSession(): Promise<void> {
    this.bans = {};
  }

  async refresh(): Promise<void> {}

  async mark(key: string, record: BanRecord): Promise<string> {
    this.bans[key] = record;
    return key;
  }

  isBlocked(key: string): boolean {
    return this.get(key) !== undefined;
  }

  get(key: string): BanRecord | undefined {
    this.bans = activeEntries(this.bans);
    return this.bans[key];
  }

  list(): Array<{ key: string; record: BanRecord }> {
    this.bans = activeEntries(this.bans);
    return Object.entries(this.bans).map(([key, record]) => ({ key, record }));
  }

  async clear(key?: string): Promise<void> {
    if (key) delete this.bans[key];
    else this.bans = {};
  }
}

export class PersistentBanStore extends MemoryBanStore {
  private path: string;
  private isChildProcess: boolean;

  constructor(path?: string) {
    super();
    this.isChildProcess = process.env.MODEL_FAILBACK_CHILD === "1";
    this.path = path ?? this.defaultPath();
  }

  private defaultPath(): string {
    const sessionId = process.env.MODEL_FAILBACK_SESSION_ID ?? `ephemeral-${process.pid}`;
    const safeSessionId = sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
    return join(getAgentDir(), `${BAN_FILE_PREFIX}${safeSessionId}.json`);
  }

  setSessionId(sessionId: string): void {
    if (this.isChildProcess) return;
    const safeSessionId = sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
    this.path = join(getAgentDir(), `${BAN_FILE_PREFIX}${safeSessionId}.json`);
  }

  async endSession(): Promise<void> {
    if (!this.isChildProcess) {
      rmSync(this.path, { force: true });
    }
    this.bans = {};
  }

  async refresh(): Promise<void> {
    if (!existsSync(this.path)) {
      this.bans = {};
      return;
    }
    try {
      this.bans = normalize(JSON.parse(readFileSync(this.path, "utf8")));
    } catch {
      // 状态文件损坏不应阻断会话；保守地按无 ban 处理，下一次写入会覆盖。
      this.bans = {};
    }
  }

  async pruneOrphans(ttlMs: number): Promise<string[]> {
    if (this.isChildProcess || !Number.isFinite(ttlMs) || ttlMs <= 0) return [];

    const directory = dirname(this.path);
    let names: string[];
    try {
      names = readdirSync(directory);
    } catch {
      return [];
    }

    const now = Date.now();
    const removed: string[] = [];
    for (const name of names) {
      if (!name.startsWith(BAN_FILE_PREFIX)) continue;
      const fullPath = join(directory, name);
      if (fullPath === this.path || fullPath === `${this.path}.lock`) continue;

      let info;
      try {
        info = lstatSync(fullPath);
      } catch {
        continue;
      }

      if (name.endsWith(".lock")) {
        if (info.isDirectory() && now - info.mtimeMs > BAN_LOCK_STALE_MS) {
          rmSync(fullPath, { recursive: true, force: true });
        }
        continue;
      }
      if (!info.isFile() || (!name.endsWith(".json") && !name.endsWith(".tmp"))) continue;
      if (existsSync(`${fullPath}.lock`) || now - info.mtimeMs <= ttlMs) continue;

      try {
        rmSync(fullPath, { force: true });
        removed.push(name);
      } catch {
        // 清理失败不应影响当前 session。
      }
    }
    return removed;
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const data: StoredBans = { version: 1, bans: activeEntries(this.bans) };
    const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
    renameSync(tmp, this.path);
  }

  private async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const lockPath = `${this.path}.lock`;
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        mkdirSync(lockPath);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          if (Date.now() - statSync(lockPath).mtimeMs > 30_000) rmSync(lockPath, { recursive: true, force: true });
        } catch {
          // Another writer may have released the lock between stat and cleanup.
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (attempt === 119) throw new Error(`ban store lock timeout: ${lockPath}`);
    }
    try {
      await this.refresh();
      return await operation();
    } finally {
      rmSync(lockPath, { recursive: true, force: true });
    }
  }

  async mark(key: string, record: BanRecord): Promise<string> {
    return this.withWriteLock(async () => {
      const storedKey = await super.mark(key, record);
      this.persist();
      return storedKey;
    });
  }

  async clear(key?: string): Promise<void> {
    await this.withWriteLock(async () => {
      await super.clear(key);
      this.persist();
    });
  }
}
