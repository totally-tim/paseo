import type { ComponentType } from "react";
import type { PaseoApi } from "@getpaseo/client";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { ZodType, input as ZodInput, output as ZodOutput } from "zod";
import type { PluginRpcContract } from "../rpc.js";
import type {
  PluginButtonRegistration,
  PluginHeaderButtonContribution,
  PluginComposerPillContribution,
} from "./buttons.js";
import type {
  PluginTheme,
  PluginWorkspaceSnapshot,
  PluginAgentSnapshot,
  PluginThemeContribution,
  PluginAttachmentSourceContribution,
  PluginTimelineTransformResult,
  PluginCleanup,
} from "../contracts.js";

export interface PluginHostProps {
  theme: PluginTheme;
  host: {
    id: string;
    label: string;
  };
  layout: {
    compact: boolean;
    platform: "ios" | "android" | "web";
  };
}

interface PluginNavigableHostProps extends PluginHostProps {
  /** Whether this retained surface owns interaction. Undefined on older apps; do not bind shortcuts. */
  readonly isActive?: boolean;
  /** Client-owned navigation. Undefined on older hosts; hide dependent affordances when absent. */
  readonly navigation?: {
    readonly openAgent: (input: { readonly agentId: string }) => void;
    readonly openWorkspace: (input: { readonly workspaceId: string }) => void;
  };
}

export interface PluginSurfaceProps extends PluginNavigableHostProps {}

export interface PluginIconProps {
  name: string;
  size?: number;
  color?: string;
}

export type PluginPanelLocation = "workspace" | "explorer";

export interface PluginOpenPanelOptions {
  location?: PluginPanelLocation;
}

interface PluginWorkspacePanelBase {
  id: string;
  title: string;
  icon: string;
  locations?: readonly PluginPanelLocation[];
}

export interface PluginWorkspacePanelProps extends PluginNavigableHostProps {
  context: "workspace";
  workspaceId: string;
}

export interface PluginAgentPanelProps extends PluginNavigableHostProps {
  context: "agent";
  workspaceId: string;
  agentId: string;
}

export interface PluginClientOpenPanelOptions extends PluginOpenPanelOptions {
  workspaceId: string;
  agentId?: string;
}

/** Device-local preferences, isolated by host and plugin. Not a secret store. */
export interface PluginClientStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface PluginClientContext extends PluginCommandCapabilities {
  /** Undefined on older apps. Gate features that require persistence. */
  readonly storage?: PluginClientStorage;
  addSettingsScreen(contribution: PluginSettingsScreenContribution): PluginCleanup;
  addSurface(id: string, Component: ComponentType<PluginSurfaceProps>): PluginCleanup;
  addSidebarItem(contribution: PluginSidebarContribution): PluginCleanup;
  addWorkspacePanel(contribution: PluginWorkspacePanelContribution): PluginCleanup;
  addCommandCenterItem(contribution: PluginCommandCenterItemContribution): PluginCleanup;
  addSlashCommand(contribution: PluginClientSlashCommandContribution): PluginCleanup;
  addHeaderButton(contribution: PluginHeaderButtonContribution): PluginButtonRegistration;
  addComposerPill(contribution: PluginComposerPillContribution): PluginButtonRegistration;
  addAttachmentSource(contribution: PluginAttachmentSourceContribution): PluginCleanup;
  addTheme(contribution: PluginThemeContribution): PluginCleanup;
  addTimelineTransformer<ItemType extends AgentTimelineItem["type"]>(
    contribution: PluginTimelineTransformerContribution<ItemType>,
  ): PluginCleanup;
  addTimelineRenderer<Schema extends ZodType>(
    contribution: PluginTimelineRendererContribution<Schema>,
  ): PluginCleanup;
  openPanel(id: string, options: PluginClientOpenPanelOptions): void;
}

export type PluginClientContribution = (client: PluginClientContext) => PluginCleanup;

export type PluginWorkspacePanelContribution =
  | (PluginWorkspacePanelBase & {
      context: "workspace";
      Component: ComponentType<PluginWorkspacePanelProps>;
    })
  | (PluginWorkspacePanelBase & {
      context: "agent";
      Component: ComponentType<PluginAgentPanelProps>;
    });

export interface PluginSettingsScreenContribution {
  id: string;
  title: string;
  icon: string;
  Component: ComponentType<PluginSurfaceProps>;
}

export interface PluginSurfaceContribution {
  id: string;
  Component: ComponentType<PluginSurfaceProps>;
}

/**
 * A count the sidebar row shows next to the item title. Same shape as a
 * `useSyncExternalStore` source: `getSnapshot` returns the current count or
 * `null` for no badge, and `subscribe` notifies when it changes.
 */
export interface PluginSidebarBadgeSource {
  getSnapshot(): number | null;
  subscribe(listener: () => void): () => void;
}

export interface PluginSidebarContribution {
  id: string;
  title: string;
  icon: string;
  surface: string;
  badge?: PluginSidebarBadgeSource;
}

export type PluginTimelineTransformerContribution<
  ItemType extends AgentTimelineItem["type"] = AgentTimelineItem["type"],
> = ItemType extends AgentTimelineItem["type"]
  ? {
      id: string;
      query: {
        itemType: ItemType;
      };
      transform(input: {
        item: Extract<AgentTimelineItem, { type: ItemType }>;
        phase: "streaming" | "complete";
      }): PluginTimelineTransformResult | undefined;
    }
  : never;

export interface PluginTimelineItemProps<Data = unknown> extends PluginHostProps {
  agentId: string;
  item: {
    type: "plugin";
    kind: string;
    version: number;
    data: Data;
  };
  timestamp: Date;
}

export interface PluginTimelineRendererContribution<Schema extends ZodType = ZodType> {
  kind: string;
  version: number;
  schema: Schema;
  Component: ComponentType<PluginTimelineItemProps<ZodOutput<Schema>>>;
}

export interface PluginCommandCapabilities {
  paseo: PaseoApi;
  rpc<InputSchema extends ZodType, OutputSchema extends ZodType>(
    contract: PluginRpcContract<InputSchema, OutputSchema>,
    input: ZodInput<InputSchema>,
  ): Promise<ZodOutput<OutputSchema>>;
  openSurface(id: string): void;
  openSettings(id: string): void;
}

export interface PluginGlobalCommandContext extends PluginCommandCapabilities {
  context: "global";
}

export interface PluginWorkspaceCommandContext extends PluginCommandCapabilities {
  context: "workspace";
  workspace: PluginWorkspaceSnapshot;
  openPanel(id: string, options?: PluginOpenPanelOptions): void;
}

export interface PluginAgentCommandContext extends PluginCommandCapabilities {
  context: "agent";
  workspace: PluginWorkspaceSnapshot;
  agent: PluginAgentSnapshot;
  openPanel(id: string, options?: PluginOpenPanelOptions): void;
}

interface PluginCommandCenterItemBase {
  id: string;
  title: string;
  icon: string;
  keywords?: readonly string[];
}

export type PluginCommandCenterItemContribution =
  | (PluginCommandCenterItemBase & {
      context: "global";
      onSelect(context: PluginGlobalCommandContext): void | Promise<void>;
    })
  | (PluginCommandCenterItemBase & {
      context: "workspace";
      onSelect(context: PluginWorkspaceCommandContext): void | Promise<void>;
    })
  | (PluginCommandCenterItemBase & {
      context: "agent";
      onSelect(context: PluginAgentCommandContext): void | Promise<void>;
    });

interface PluginClientSlashCommandBase {
  name: string;
  description: string;
  argumentHint: string;
}

export type PluginClientSlashCommandContribution =
  | (PluginClientSlashCommandBase & {
      context: "workspace";
      onSubmit(context: PluginWorkspaceCommandContext & { args: string }): void | Promise<void>;
    })
  | (PluginClientSlashCommandBase & {
      context: "agent";
      onSubmit(context: PluginAgentCommandContext & { args: string }): void | Promise<void>;
    });

export type SettingsState<Schema extends ZodType> = (
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "invalid"; error: string; revision: string }
  | { status: "ready"; values: ZodOutput<Schema>; revision: string }
) & {
  saving: boolean;
  saveError: string | null;
  /** Save an entire document against the revision currently displayed. Never throws. */
  save(values: ZodOutput<Schema>, revision: string): Promise<boolean>;
  reset(): Promise<boolean>;
  reload(): Promise<void>;
};
