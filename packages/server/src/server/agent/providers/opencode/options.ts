import type { ProviderOptions, ToolPolicy } from "@getpaseo/protocol/agent-types";
import { z } from "zod";

const PermissionActionSchema = z.enum(["ask", "allow", "deny"]);
const PermissionRuleSchema = z.union([
  PermissionActionSchema,
  z.record(z.string(), PermissionActionSchema),
]);

// OpenCode Config.permission, maintained against @opencode-ai/sdk 1.14.46.
export const OpenCodeProviderOptionsSchema = z
  .object({
    permission: z
      .union([
        PermissionActionSchema,
        z
          .object({
            read: PermissionRuleSchema.optional(),
            edit: PermissionRuleSchema.optional(),
            glob: PermissionRuleSchema.optional(),
            grep: PermissionRuleSchema.optional(),
            list: PermissionRuleSchema.optional(),
            bash: PermissionRuleSchema.optional(),
            task: PermissionRuleSchema.optional(),
            external_directory: PermissionRuleSchema.optional(),
            todowrite: PermissionActionSchema.optional(),
            question: PermissionActionSchema.optional(),
            webfetch: PermissionActionSchema.optional(),
            websearch: PermissionActionSchema.optional(),
            codesearch: PermissionActionSchema.optional(),
            repo_clone: PermissionRuleSchema.optional(),
            repo_overview: PermissionRuleSchema.optional(),
            lsp: PermissionRuleSchema.optional(),
            doom_loop: PermissionActionSchema.optional(),
            skill: PermissionRuleSchema.optional(),
          })
          .strict(),
      ])
      .optional(),
  })
  .strict() satisfies z.ZodType<ProviderOptions>;

export type OpenCodeProviderOptions = z.infer<typeof OpenCodeProviderOptionsSchema>;

export interface OpenCodePermissionRule {
  permission: string;
  pattern: string;
  action: "ask" | "allow" | "deny";
}

// Provider-native delegate-only restriction (docs/specs/coordinator.md).
export const OPENCODE_DELEGATE_ONLY_PERMISSION_RULES: OpenCodePermissionRule[] = [
  { permission: "edit", pattern: "*", action: "deny" },
  { permission: "bash", pattern: "*", action: "deny" },
];

export function buildOpenCodePermissionRules(
  options: OpenCodeProviderOptions | undefined,
  toolPolicy: ToolPolicy | undefined,
  delegateOnly = false,
): OpenCodePermissionRule[] | undefined {
  const grants =
    toolPolicy?.preapproved.map((grant) => ({
      permission: `${grant.server}_${grant.tool}`,
      pattern: "*",
      action: "allow" as const,
    })) ?? [];
  const permission = options?.permission;
  let rules: OpenCodePermissionRule[] | undefined;
  if (typeof permission === "string") {
    rules = [...grants, { permission: "*", pattern: "*", action: permission }];
  } else if (!permission || typeof permission !== "object" || Array.isArray(permission)) {
    rules = grants.length > 0 ? grants : undefined;
  } else {
    const authored = Object.entries(permission).flatMap(([name, rule]) => {
      if (typeof rule === "string") {
        return [{ permission: name, pattern: "*", action: rule }];
      }
      if (!rule || typeof rule !== "object" || Array.isArray(rule)) return [];
      return Object.entries(rule).flatMap(([pattern, action]) =>
        typeof action === "string" ? [{ permission: name, pattern, action }] : [],
      );
    });
    rules = [...grants, ...authored];
  }
  if (!delegateOnly) {
    return rules;
  }
  // Delegate-only sessions (coordinators) delegate through the Paseo MCP tools
  // and must not edit files or run shell commands themselves. OpenCode
  // permission rules evaluate last-match-wins, so appended denies override any
  // authored allow — including a wildcard string permission.
  return [...(rules ?? []), ...OPENCODE_DELEGATE_ONLY_PERMISSION_RULES];
}
