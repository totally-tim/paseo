import type { Logger } from "pino";
import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";

export type LifecycleEventName = keyof PluginLifecycleEvents;

export type LifecycleEventHandler<Name extends LifecycleEventName> = (
  event: PluginLifecycleEvents[Name],
) => void | Promise<void>;

/**
 * In-process fan-out for the lifecycle events the plugin runtime ships to
 * plugin subprocesses over IPC. Daemon modules (the coordinator service today)
 * subscribe here; AgentManager and workspace provisioning emit beside each
 * pluginLifecycle.emit call site so both sinks observe identical events.
 *
 * The bus is fire-and-forget on purpose: a slow or failing subscriber must
 * never stall agent lifecycle work, and emit stays synchronous so existing
 * call sites keep their shape.
 */
export class LifecycleBus {
  private readonly handlers = new Map<LifecycleEventName, Set<(event: unknown) => unknown>>();

  constructor(private readonly logger: Logger) {}

  /** Signature-compatible with PluginLifecycle["emit"] so sinks are interchangeable. */
  emit<Name extends LifecycleEventName>(name: Name, event: PluginLifecycleEvents[Name]): void {
    const handlers = this.handlers.get(name);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        const result = handler(event);
        if (result && typeof (result as Promise<void>).catch === "function") {
          void (result as Promise<void>).catch((error: unknown) => {
            this.logger.warn({ err: error, event: name }, "Lifecycle bus handler rejected");
          });
        }
      } catch (error) {
        this.logger.warn({ err: error, event: name }, "Lifecycle bus handler failed");
      }
    }
  }

  on<Name extends LifecycleEventName>(
    name: Name,
    handler: LifecycleEventHandler<Name>,
  ): () => void {
    let handlers = this.handlers.get(name);
    if (!handlers) {
      handlers = new Set();
      this.handlers.set(name, handlers);
    }
    const wrapped = (event: unknown) => handler(event as PluginLifecycleEvents[Name]);
    handlers.add(wrapped);
    return () => {
      handlers.delete(wrapped);
      if (handlers.size === 0) {
        this.handlers.delete(name);
      }
    };
  }
}
