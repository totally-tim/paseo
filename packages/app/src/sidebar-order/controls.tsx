import { useCallback, useEffect } from "react";
import { View, Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { MenuItem, MenuSeparator } from "@/components/ui/menu";
import { Button } from "@/components/ui/button";
import { getHostRuntimeStore, useHosts } from "@/runtime/host-runtime";
import { sidebarOrderSync, useSidebarOrderSync, type HostOrderState } from "./index";

function HostOrderControls({
  serverId,
  label,
  notice = false,
}: {
  serverId: string;
  label: string;
  notice?: boolean;
}) {
  const { t } = useTranslation();
  const state = useSidebarOrderSync((store) => store.hosts[serverId]);
  useEffect(() => {
    if (notice) return;
    return getHostRuntimeStore().acquireDirectoryDemand(serverId);
  }, [notice, serverId]);
  const initialize = useCallback(() => {
    void sidebarOrderSync.initialize(serverId);
  }, [serverId]);
  const refresh = useCallback(() => {
    void sidebarOrderSync.refresh(serverId);
  }, [serverId]);
  const retry = useCallback(() => {
    void sidebarOrderSync.retry(serverId);
  }, [serverId]);
  const dismiss = useCallback(() => sidebarOrderSync.dismiss(serverId), [serverId]);
  const message = t(statusKey(state));
  if (notice && !state?.error && !state?.pending && !state?.failedWrite) return null;
  return (
    <View testID={notice ? "sidebar-order-notice" : `sidebar-order-host-${serverId}`}>
      <View style={styles.description}>
        <Text style={styles.name}>{label}</Text>
        <Text style={styles.detail}>{message}</Text>
        {state?.error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {state.error}
          </Text>
        ) : null}
      </View>
      {notice ? (
        <NoticeActions serverId={serverId} state={state} retry={retry} dismiss={dismiss} />
      ) : (
        <HostOrderActions
          serverId={serverId}
          state={state}
          initialize={initialize}
          refresh={refresh}
          retry={retry}
          dismiss={dismiss}
        />
      )}
    </View>
  );
}
function statusKey(state: HostOrderState | undefined): string {
  if (state?.pending) return "sidebarOrder.pending";
  if (state?.failedWrite) return "sidebarOrder.unsaved";
  if (state?.status === "online")
    return state.snapshot?.initialized ? "sidebarOrder.synced" : "sidebarOrder.uninitialized";
  return `sidebarOrder.${state?.status ?? "loading"}`;
}
function HostOrderActions({
  serverId,
  state,
  initialize,
  refresh,
  retry,
  dismiss,
}: {
  serverId: string;
  state: HostOrderState | undefined;
  initialize: () => void;
  refresh: () => void;
  retry: () => void;
  dismiss: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      {state?.status === "online" && !state.snapshot?.initialized ? (
        <MenuItem
          closeOnSelect={false}
          disabled={state.pending}
          onSelect={initialize}
          testID={`sidebar-order-import-${serverId}`}
        >
          {t("sidebarOrder.import")}
        </MenuItem>
      ) : null}
      {state?.status !== "unsupported" && state?.status !== "offline" ? (
        <MenuItem closeOnSelect={false} disabled={state?.pending} onSelect={refresh}>
          {t("sidebarOrder.reload")}
        </MenuItem>
      ) : null}
      {state?.failedWrite ? (
        <MenuItem
          closeOnSelect={false}
          disabled={state.pending || state.status === "offline" || state.status === "unsupported"}
          onSelect={retry}
          testID={`sidebar-order-retry-${serverId}`}
        >
          {t("sidebarOrder.retry")}
        </MenuItem>
      ) : null}
      {state?.error || state?.failedWrite ? (
        <MenuItem closeOnSelect={false} disabled={state.pending} onSelect={dismiss}>
          {t(state.failedWrite ? "sidebarOrder.discard" : "sidebarOrder.dismiss")}
        </MenuItem>
      ) : null}
      <MenuSeparator />
    </>
  );
}
function NoticeActions({
  serverId,
  state,
  retry,
  dismiss,
}: {
  serverId: string;
  state: HostOrderState | undefined;
  retry: () => void;
  dismiss: () => void;
}) {
  const { t } = useTranslation();
  return state?.error || state?.failedWrite ? (
    <View style={styles.actions}>
      {state.failedWrite ? (
        <Button
          variant="outline"
          size="sm"
          disabled={state.pending || state.status === "offline" || state.status === "unsupported"}
          onPress={retry}
          testID={`sidebar-order-notice-retry-${serverId}`}
        >
          {t("sidebarOrder.retry")}
        </Button>
      ) : null}
      <Button variant="ghost" size="sm" disabled={state.pending} onPress={dismiss}>
        {t(state.failedWrite ? "sidebarOrder.discard" : "sidebarOrder.dismiss")}
      </Button>
    </View>
  ) : null;
}

export function SidebarOrderControls() {
  const hosts = useHosts();
  return (
    <>
      {hosts.map((host) => (
        <HostOrderControls
          key={host.serverId}
          serverId={host.serverId}
          label={host.label?.trim() || host.serverId}
        />
      ))}
    </>
  );
}
/** A failed drag must be visible without reopening settings. */
export function SidebarOrderNotice() {
  const hosts = useHosts();
  return (
    <>
      {hosts.map((host) => (
        <HostOrderControls
          key={host.serverId}
          serverId={host.serverId}
          label={host.label?.trim() || host.serverId}
          notice
        />
      ))}
    </>
  );
}
const styles = StyleSheet.create((theme) => ({
  actions: { flexDirection: "row", gap: theme.spacing[2] },
  description: { padding: theme.spacing[2], gap: theme.spacing[1] },
  name: { color: theme.colors.foreground, fontSize: theme.fontSize.sm, fontWeight: "500" },
  detail: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
}));
