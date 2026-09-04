import type { PluginClientContext } from "@getpaseo/plugin";
import { InboxSurface, InboxWorkspacePanel } from "./client/board";
import { createInboxStore, setInboxStore } from "./client/store";
import { boardLanes } from "./client/review";

export default function contribute(client: PluginClientContext) {
  const store = createInboxStore(client.paseo, client.storage);
  setInboxStore(store);
  client.addSurface("board", InboxSurface);
  client.addSidebarItem({
    id: "inbox",
    title: "Kanban",
    icon: "Kanban",
    surface: "board",
    badge: { getSnapshot: store.getBadge, subscribe: store.subscribe },
  });
  client.addWorkspacePanel({
    id: "inbox",
    title: "Kanban",
    icon: "Kanban",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: InboxWorkspacePanel,
  });
  client.addCommandCenterItem({
    id: "open-inbox",
    title: "Open Kanban",
    icon: "Kanban",
    keywords: ["inbox", "agents", "attention", "needs you", "triage"],
    context: "global",
    onSelect({ openSurface }) {
      openSurface("board");
    },
  });
  client.addCommandCenterItem({
    id: "next-needs-you",
    title: "Next agent needing you",
    icon: "Kanban",
    keywords: ["kanban", "inbox", "attention", "permission", "question"],
    context: "global",
    onSelect({ openSurface }) {
      const snapshot = store.getSnapshot();
      const oldest = boardLanes(snapshot).needsYou[0];
      if (oldest) store.requestOpen(oldest.agent.id);
      openSurface("board");
    },
  });
  return () => {
    setInboxStore(null);
    store.dispose();
  };
}
