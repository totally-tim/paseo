import { promises as fs } from "node:fs";
import type { z } from "zod";
import { writeJsonFileAtomic } from "../atomic-file.js";

/** A transaction publishes its state only after the atomic file write succeeds. */
export class AutomationStore<T> {
  private state: T | null = null;
  private loading: Promise<void> | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly file: string,
    private readonly schema: z.ZodType<T>,
    private readonly empty: () => T,
  ) {}
  private load(): Promise<void> {
    if (this.state !== null) return Promise.resolve();
    this.loading ??= (async () => {
      try {
        this.state = this.schema.parse(JSON.parse(await fs.readFile(this.file, "utf8")));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        this.state = this.empty();
      }
    })().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }
  async read(): Promise<T> {
    await this.tail;
    await this.load();
    return structuredClone(this.state!);
  }
  change<R>(update: (state: T) => R): Promise<R> {
    const prior = this.tail;
    const job = prior.then(async () => {
      await this.load();
      const draft = structuredClone(this.state!);
      const result = update(draft);
      const parsed = this.schema.parse(draft);
      await writeJsonFileAtomic(this.file, parsed);
      this.state = parsed;
      return result;
    });
    this.tail = job.catch(() => undefined);
    return job;
  }
}
