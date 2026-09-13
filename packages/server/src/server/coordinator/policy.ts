import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import {
  CoordinatorAutomationIdSchema,
  CoordinatorPolicyRuleSchema,
  type CoordinatorPolicyRule,
} from "@getpaseo/protocol/coordinator-goals";
import type { AgentPermissionRequest } from "../agent/agent-sdk-types.js";
import { AutomationStore } from "./automation-store.js";

const PatternSchema = z
  .object({
    provider: z.string().min(1),
    tool: z.string().min(1),
    input: z.record(z.string(), z.json()),
  })
  .strict();
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, sorted(entry)]),
    );
  return value;
}
/** Literal tool and complete input equality; no glob, shell-prefix, or regex interpretation. */
export function validatePolicyPattern(pattern: string): string {
  if (Buffer.byteLength(pattern, "utf8") > 32000) throw new Error("Policy pattern exceeds 32 KB");
  return JSON.stringify(sorted(PatternSchema.parse(JSON.parse(pattern))));
}
export function permissionPolicyPattern(request: AgentPermissionRequest): string | null {
  if (request.kind !== "tool" || !request.input) return null;
  try {
    return validatePolicyPattern(
      JSON.stringify({ provider: request.provider, tool: request.name, input: request.input }),
    );
  } catch {
    return null;
  }
}
const StateSchema = z.object({
  rules: z.array(CoordinatorPolicyRuleSchema),
  receipts: z.record(z.string(), z.string()),
});
export class CoordinatorPolicy {
  private readonly store: AutomationStore<z.infer<typeof StateSchema>>;
  constructor(private readonly deps: { paseoHome: string; now: () => number }) {
    this.store = new AutomationStore(
      path.join(deps.paseoHome, "coordinator", "policy.json"),
      StateSchema,
      () => ({ rules: [], receipts: {} }),
    );
  }
  async initialize(): Promise<void> {
    await this.store.read();
  }
  async list(scope?: string): Promise<CoordinatorPolicyRule[]> {
    return (await this.store.read()).rules.filter((rule) => !scope || rule.scope === scope);
  }
  async addApproved(input: { scope: string; pattern: string }): Promise<CoordinatorPolicyRule> {
    const scope = CoordinatorAutomationIdSchema.parse(input.scope);
    const pattern = validatePolicyPattern(input.pattern);
    return this.store.change((state) => {
      const existing = state.rules.find((rule) => rule.scope === scope && rule.pattern === pattern);
      if (existing) {
        existing.enabled = true;
        return structuredClone(existing);
      }
      const rule = {
        id: createHash("sha256")
          .update(JSON.stringify([scope, pattern]))
          .digest("hex")
          .slice(0, 24),
        scope,
        pattern,
        enabled: true,
        firedCount: 0,
        createdAt: new Date(this.deps.now()).toISOString(),
      };
      state.rules.push(rule);
      return rule;
    });
  }
  async setEnabled(ruleId: string, enabled: boolean): Promise<void> {
    await this.store.change((state) => {
      const rule = state.rules.find((entry) => entry.id === ruleId);
      if (!rule) throw new Error("Policy rule not found");
      rule.enabled = enabled;
    });
  }
  async match(
    projectId: string,
    request: AgentPermissionRequest,
  ): Promise<CoordinatorPolicyRule | null> {
    const pattern = permissionPolicyPattern(request);
    if (!pattern) return null;
    const rules = (await this.store.read()).rules;
    const rule =
      rules.find((entry) => entry.scope === projectId && entry.pattern === pattern) ??
      rules.find((entry) => entry.scope === "daemon" && entry.pattern === pattern);
    return rule?.enabled ? rule : null;
  }
  /** Call only after the normal provider response succeeds; duplicate lifecycle events count once. */
  async recordFire(ruleId: string, requestKey: string): Promise<boolean> {
    if (!requestKey) throw new Error("A permission receipt key is required");
    return this.store.change((state) => {
      if (Object.hasOwn(state.receipts, requestKey)) return false;
      const rule = state.rules.find((entry) => entry.id === ruleId);
      if (!rule) throw new Error("Policy rule not found");
      rule.firedCount += 1;
      state.receipts = { ...state.receipts, [requestKey]: ruleId };
      return true;
    });
  }
}
