import { useCallback } from "react";
import { View, Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { MenuItem, MenuSeparator } from "@/components/ui/menu";
import { Button } from "@/components/ui/button";
import { useHosts } from "@/runtime/host-runtime";
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
  const initialize = useCallback(() => {
    void sidebarOrderSync.initialize(serverId);
  }, [serverId]);
  const refresh = useCallback(() => {
    void sidebarOrderSync.refresh(serverId);
  }, [serverId]);
  const dismiss = useCallback(() => sidebarOrderSync.dismiss(serverId), [serverId]);
  const message = t(statusKey(state));
  if (notice && !state?.error && !state?.pending) return null;
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
        <NoticeActions error={state?.error ?? null} dismiss={dismiss} />
      ) : (
        <HostOrderActions
          serverId={serverId}
          state={state}
          initialize={initialize}
          refresh={refresh}
          dismiss={dismiss}
        />
      )}
    </View>
  );
}
function statusKey(state: HostOrderState | undefined): string {
  if (state?.pending) return "sidebarOrder.pending";
  if (state?.status === "online")
    return state.snapshot?.initialized ? "sidebarOrder.synced" : "sidebarOrder.uninitialized";
  return `sidebarOrder.${state?.status ?? "loading"}`;
}
function HostOrderActions({
  serverId,
  state,
  initialize,
  refresh,
  dismiss,
}: {
  serverId: string;
  state: HostOrderState | undefined;
  initialize: () => void;
  refresh: () => void;
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
      {state?.error ? (
        <MenuItem closeOnSelect={false} onSelect={dismiss}>
          {t("sidebarOrder.dismiss")}
        </MenuItem>
      ) : null}
      <MenuSeparator />
    </>
  );
}
function NoticeActions({ error, dismiss }: { error: string | null; dismiss: () => void }) {
  const { t } = useTranslation();
  return error ? (
    <Button variant="ghost" size="sm" onPress={dismiss}>
      {t("sidebarOrder.dismiss")}
    </Button>
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
  description: { padding: theme.spacing[2], gap: theme.spacing[1] },
  name: { color: theme.colors.foreground, fontSize: theme.fontSize.sm, fontWeight: "500" },
  detail: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
}));
