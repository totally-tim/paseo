import type { ProviderAccount } from "@getpaseo/protocol/provider-accounts";
import type { ProviderUsage } from "@/provider-usage/types";
import { applicableAccountUsage } from "./account-view-model";
import type { AccountOptionDetail } from "./selection-option";

export interface AccountOption {
  id: string;
  value: string;
  label: string;
  disabled: boolean;
  detail: AccountOptionDetail;
}

export interface AccountCatalog {
  accounts: ProviderAccount[];
  usage: { accountId: string; usage: ProviderUsage; stale: boolean }[];
}

/** Translated once by the caller, so this stays a pure mapping. */
export interface AccountOptionLabels {
  automatic: string;
  automaticHelp: string;
  hostAccount: string;
  hostHelp: string;
}

/**
 * The rows of the account picker: automatic, the host CLI login, then every managed account for
 * this provider. Each row carries the identity and quota the reader needs to choose between two
 * logins, narrowed to the model the agent will start on.
 */
export function buildAccountOptions(
  data: AccountCatalog | null | undefined,
  provider: string,
  model: string | null | undefined,
  labels: AccountOptionLabels,
): AccountOption[] {
  const accounts = data?.accounts ?? [];
  const detailFor = (account: ProviderAccount, help?: string): AccountOptionDetail => {
    const entry = data?.usage.find((item) => item.accountId === account.id);
    return {
      help,
      account,
      model,
      usage: applicableAccountUsage(entry?.usage, model),
      stale: entry?.stale,
    };
  };
  const host = accounts.find((account) => account.id === `default:${provider}`);
  return [
    {
      id: "automatic",
      value: "automatic",
      label: labels.automatic,
      disabled: false,
      detail: { help: labels.automaticHelp },
    },
    {
      id: "default",
      value: "default",
      // The host row carries the account's own label once it has been renamed, so two logins on
      // the same email stay apart; its help line is what says which one is the host CLI.
      label: host?.label ?? labels.hostAccount,
      disabled: host?.enabled === false,
      detail: host ? detailFor(host, labels.hostHelp) : { help: labels.hostHelp },
    },
    ...accounts
      .filter(
        (account) =>
          account.provider === provider && account.ownership === "managed" && !account.removedAt,
      )
      .map((account) => ({
        id: account.id,
        value: account.id,
        label: account.label,
        disabled: !account.enabled || account.authState !== "ready",
        detail: detailFor(account),
      })),
  ];
}

export function defaultAccountSelection(
  accounts: ProviderAccount[],
  provider: string,
): "automatic" | "default" {
  return accounts.some(
    (account) =>
      account.provider === provider &&
      account.ownership === "managed" &&
      account.enabled &&
      !account.removedAt,
  )
    ? "automatic"
    : "default";
}
