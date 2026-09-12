import type { ProviderUsage } from "./messages.js";
import { z } from "zod";

export const AccountProviderSchema = z.enum(["claude", "codex"]);
export type AccountProvider = z.infer<typeof AccountProviderSchema>;

export const AccountSelectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("default") }),
  z.object({ kind: z.literal("fixed"), accountId: z.string().min(1) }),
  z.object({ kind: z.literal("automatic"), accountIds: z.array(z.string().min(1)).optional() }),
]);
export type AccountSelection = z.infer<typeof AccountSelectionSchema>;

export const ProviderAccountIdentitySchema = z.object({
  key: z.string().min(1),
  email: z.string().optional(),
  organization: z.string().optional(),
  plan: z.string().optional(),
});
export type ProviderAccountIdentity = z.infer<typeof ProviderAccountIdentitySchema>;

export const ProviderAccountSchema = z.object({
  id: z.string().min(1),
  provider: AccountProviderSchema,
  label: z.string().min(1).max(120),
  ownership: z.enum(["managed", "external"]),
  enabled: z.boolean(),
  authState: z.enum(["unknown", "signed-out", "authenticating", "ready", "error"]),
  identity: ProviderAccountIdentitySchema.nullable(),
  error: z.string().nullable(),
  revision: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Unattended work cannot start below this remaining capacity in any known window. */
  reservePercent: z.number().min(0).max(100).optional(),
  interactiveOnly: z.boolean().optional(),
  removedAt: z.string().optional(),
  capacityLimit: z
    .object({
      observedAt: z.string(),
      resetsAt: z.string().optional(),
      model: z.string().optional(),
      /** Verified identity that reported the rejection; absent on records written before the binding existed. */
      identityKey: z.string().optional(),
    })
    .nullable()
    .optional(),
});
export type ProviderAccount = z.infer<typeof ProviderAccountSchema>;

export const AccountPolicySchema = z.object({
  unknownQuota: z.enum(["pause-unattended", "allow"]),
});
export type AccountPolicy = z.infer<typeof AccountPolicySchema>;

/** Transient login instructions. No credential, refresh token, or filesystem path. */
export const AccountLoginSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  expiresAt: z.string(),
  challenge: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("starting") }),
    z.object({ kind: z.literal("browser"), url: z.string(), acceptsCode: z.boolean() }),
    z.object({ kind: z.literal("device"), url: z.string(), userCode: z.string() }),
  ]),
});
export type AccountLogin = z.infer<typeof AccountLoginSchema>;

export const AccountOperationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("add"),
    provider: AccountProviderSchema,
    label: z.string().min(1).max(120),
  }),
  z.object({
    kind: z.literal("edit"),
    accountId: z.string(),
    changes: z.object({
      label: z.string().min(1).max(120).optional(),
      enabled: z.boolean().optional(),
      reservePercent: z.number().min(0).max(100).optional(),
      interactiveOnly: z.boolean().optional(),
    }),
  }),
  z.object({ kind: z.literal("inspect"), accountId: z.string() }),
  z.object({ kind: z.literal("login-start"), accountId: z.string() }),
  z.object({ kind: z.literal("login-status"), accountId: z.string(), loginId: z.string() }),
  z.object({ kind: z.literal("login-cancel"), accountId: z.string(), loginId: z.string() }),
  z.object({
    kind: z.literal("login-code"),
    accountId: z.string(),
    loginId: z.string(),
    code: z.string().min(1).max(2048),
  }),
  z.object({ kind: z.literal("logout"), accountId: z.string() }),
  z.object({
    kind: z.literal("remove"),
    accountId: z.string(),
    credentials: z.enum(["retain", "logout"]),
  }),
  z.object({ kind: z.literal("restore"), accountId: z.string() }),
  z.object({ kind: z.literal("policy"), policy: AccountPolicySchema }),
  z.object({ kind: z.literal("reorder"), accountIds: z.array(z.string()).max(34) }),
]);
export type AccountOperation = z.infer<typeof AccountOperationSchema>;

export const ProviderAccountsListRequestSchema = z.object({
  type: z.literal("provider.accounts.list.request"),
  requestId: z.string(),
});
export const ProviderAccountsManageRequestSchema = z.object({
  type: z.literal("provider.accounts.manage.request"),
  requestId: z.string(),
  operation: AccountOperationSchema,
});

export const ProviderAccountCatalogRequestSchema = z.object({
  type: z.literal("provider.accounts.catalog.request"),
  requestId: z.string(),
  provider: AccountProviderSchema,
  selection: AccountSelectionSchema.optional(),
  model: z.string().optional(),
  cwd: z.string().optional(),
});

/**
 * The account's remembered capacity rejection, or null when it cannot be attributed to the
 * account's current verified identity. Records written before the binding existed carry no
 * identityKey; on an external account the host login can change outside Paseo, so an
 * unattributable record is ignored there. A managed identity is directory-pinned, so a
 * legacy record still applies. Shared by daemon admission and the account display.
 */
export function effectiveCapacityLimit(
  account: ProviderAccount,
): NonNullable<ProviderAccount["capacityLimit"]> | null {
  const limit = account.capacityLimit;
  if (!limit) return null;
  if (limit.identityKey === undefined) return account.ownership === "managed" ? limit : null;
  return limit.identityKey === account.identity?.key ? limit : null;
}

/** Shared by admission and the running account tooltip; unidentified scopes stay conservative. */
export function getAccountUsageWindows(
  usage: ProviderUsage | null,
  model?: string,
): ProviderUsage["windows"] {
  if (usage?.status !== "available") return [];
  const key = (value: string) => value.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
  const selected = model ? key(model) : undefined;
  return usage.windows.filter((window) => {
    let scope: string | undefined;
    if (window.id === "seven_day_opus") scope = "opus";
    if (window.id === "seven_day_sonnet") scope = "sonnet";
    if (window.id.startsWith("model:")) scope = window.id.split(":").slice(2).join(":");
    if (usage.providerId === "codex") {
      const bucket = window.id.replace(/:(primary|secondary|account_limit)$/, "");
      if (/^gpt-\d/i.test(bucket)) scope = bucket;
      const label = window.label.split(" · ").at(-1);
      if (label && /^gpt-\d/i.test(label)) scope = label;
    }
    if (!scope) return true;
    return selected ? selected.includes(key(scope)) : false;
  });
}
