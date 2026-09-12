import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Logger } from "pino";

import {
  CoordinatorDoneBoardRowSchema,
  CoordinatorProfilesSchema,
  CoordinatorProfileSelectionSchema,
  CoordinatorScopeSchema,
  CoordinatorTrustLevelSchema,
  CoordinatorUsageExpectationSchema,
  CoordinatorWakeBoardRowSchema,
} from "@getpaseo/protocol/messages";

import { writeJsonFileAtomic } from "../atomic-file.js";

const PersistedProjectCoordinatorSchema = z.object({
  version: z.literal(1),
  projectId: z.string(),
  /** Live coordinator agent record id; null while none has been created. */
  agentId: z.string().nullable(),
  enabled: z.boolean(),
  trustLevel: CoordinatorTrustLevelSchema,
  scope: CoordinatorScopeSchema,
  profile: CoordinatorProfileSelectionSchema.optional(),
  profiles: CoordinatorProfilesSchema.optional(),
  usageExpectation: CoordinatorUsageExpectationSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type PersistedProjectCoordinator = z.infer<typeof PersistedProjectCoordinatorSchema>;

const PersistedCoordinatorBoardSchema = z.object({
  version: z.literal(1),
  /** Verb-first outcome rows, newest first. Expired rows are pruned on write. */
  done: z.array(CoordinatorDoneBoardRowSchema).default([]),
  /** The latest wake line; only one is ever shown. */
  wake: CoordinatorWakeBoardRowSchema.nullable().default(null),
});

export type PersistedCoordinatorBoard = z.infer<typeof PersistedCoordinatorBoardSchema>;

export const EMPTY_COORDINATOR_BOARD: PersistedCoordinatorBoard = {
  version: 1,
  done: [],
  wake: null,
};

function coordinatorRoot(paseoHome: string): string {
  return path.join(paseoHome, "coordinator");
}

/**
 * File-backed coordinator state. Per-project config lives at
 * `coordinator/projects/{projectId}/coordinator.json`; derived board rows live
 * at `coordinator/board/{projectId}.json`. Writes are atomic and serialized
 * per file so event-driven appends cannot interleave a torn document.
 */
export class CoordinatorStore {
  private readonly root: string;
  private readonly logger: Logger;
  private readonly writeTails = new Map<string, Promise<void>>();

  constructor(paseoHome: string, logger: Logger) {
    this.root = coordinatorRoot(paseoHome);
    this.logger = logger.child({ module: "coordinator", component: "store" });
  }

  statePath(projectId: string): string {
    return path.join(this.root, "projects", projectId, "coordinator.json");
  }

  boardPath(projectId: string): string {
    return path.join(this.root, "board", `${projectId}.json`);
  }

  /** Projects with a coordinator record on disk, enabled or not. */
  async listProjectIds(): Promise<string[]> {
    const dir = path.join(this.root, "projects");
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  }

  async loadState(projectId: string): Promise<PersistedProjectCoordinator | null> {
    const parsed = await this.readJson(this.statePath(projectId));
    if (parsed === null) return null;
    return PersistedProjectCoordinatorSchema.parse(parsed);
  }

  async saveState(projectId: string, state: PersistedProjectCoordinator): Promise<void> {
    const filePath = this.statePath(projectId);
    await this.queueWrite(filePath, PersistedProjectCoordinatorSchema.parse(state));
  }

  async loadBoard(projectId: string): Promise<PersistedCoordinatorBoard> {
    const parsed = await this.readJson(this.boardPath(projectId));
    if (parsed === null) return { ...EMPTY_COORDINATOR_BOARD, done: [] };
    return PersistedCoordinatorBoardSchema.parse(parsed);
  }

  async saveBoard(projectId: string, board: PersistedCoordinatorBoard): Promise<void> {
    const filePath = this.boardPath(projectId);
    await this.queueWrite(filePath, PersistedCoordinatorBoardSchema.parse(board));
  }

  private async readJson(filePath: string): Promise<unknown | null> {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      return JSON.parse(raw);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      this.logger.warn({ err: error, filePath }, "Discarding unreadable coordinator file");
      return null;
    }
  }

  private queueWrite(filePath: string, value: unknown): Promise<void> {
    const prev = this.writeTails.get(filePath) ?? Promise.resolve();
    const next = prev.then(async () => {
      await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      return writeJsonFileAtomic(filePath, value);
    });
    const tracked = next.finally(() => {
      if (this.writeTails.get(filePath) === tracked) {
        this.writeTails.delete(filePath);
      }
    });
    this.writeTails.set(filePath, tracked);
    return tracked;
  }
}
