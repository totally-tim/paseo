import { MAX_CONTENT_WIDTH } from "@/constants/layout";
import { AgentRecoveryStatus } from "./recovery-status";
import { useCallback, useState, type ReactNode } from "react";
import { useShallow } from "zustand/shallow";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import {
  HANDOFF_FROM_AGENT_ID_LABEL,
  HANDOFF_TO_AGENT_ID_LABEL,
} from "@getpaseo/protocol/agent-labels";
import { useSessionStore } from "@/stores/session-store";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { Button } from "@/components/ui/button";
import { navigateToAgent } from "@/utils/navigate-to-agent";

function RetryContinuation({
  serverId,
  agentId,
  provider,
  accountId,
}: {
  serverId: string;
  agentId: string;
  provider: string;
  accountId?: string;
}) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const retry = useCallback(async () => {
    if (!client || pending) return;
    setPending(true);
    setError(null);
    try {
      const target = await client.handoffAgent({
        sourceAgentId: agentId,
        provider,
        ...(accountId ? { accountSelection: { kind: "fixed", accountId } } : {}),
      });
      navigateToAgent({ serverId, agentId: target.id });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setPending(false);
    }
  }, [client, pending, agentId, provider, serverId, accountId]);
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        disabled={!connected || pending}
        onPress={retry}
        testID="agent-handoff-retry"
      >
        {t("common.actions.retry")}
      </Button>
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </>
  );
}

export function AgentContinuationControls({
  serverId,
  agentId,
  children,
}: {
  serverId: string;
  agentId: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const supported = useHostFeature(serverId, "agentHandoff");
  const [from, to, archived] = useSessionStore(
    useShallow((state) => {
      const agent =
        state.sessions[serverId]?.agents.get(agentId) ??
        state.sessions[serverId]?.agentDetails.get(agentId);
      return [
        agent?.labels[HANDOFF_FROM_AGENT_ID_LABEL],
        agent?.labels[HANDOFF_TO_AGENT_ID_LABEL],
        Boolean(agent?.archivedAt),
      ] as const;
    }),
  );
  const [targetProvider, targetHasPrompt, targetAccountId] = useSessionStore(
    useShallow((state) => {
      const target = to
        ? (state.sessions[serverId]?.agents.get(to) ??
          state.sessions[serverId]?.agentDetails.get(to))
        : undefined;
      return [target?.provider, Boolean(target?.lastUserMessageAt), target?.accountId] as const;
    }),
  );
  const openSource = useCallback(() => {
    if (from) navigateToAgent({ serverId, agentId: from });
  }, [from, serverId]);
  const openSuccessor = useCallback(() => {
    if (to) navigateToAgent({ serverId, agentId: to });
  }, [to, serverId]);
  if (!supported) return children;
  return (
    <>
      <AgentRecoveryStatus serverId={serverId} agentId={agentId} />
      {from || to ? (
        <View style={styles.row}>
          {from ? (
            <Button
              variant="ghost"
              size="sm"
              onPress={openSource}
              testID="agent-handoff-predecessor"
            >
              {t("agentHandoff.source")}
            </Button>
          ) : null}
          {to ? (
            <>
              <Text style={styles.text}>{t("agentHandoff.stopped")}</Text>
              <Button
                variant="secondary"
                size="sm"
                onPress={openSuccessor}
                testID="agent-handoff-successor"
              >
                {t("agentHandoff.successor")}
              </Button>
            </>
          ) : null}
          {to && targetProvider && !targetHasPrompt && !archived ? (
            <RetryContinuation
              serverId={serverId}
              agentId={agentId}
              provider={targetProvider}
              accountId={targetAccountId}
            />
          ) : null}
        </View>
      ) : null}
      {to ? null : children}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    width: "100%",
    maxWidth: MAX_CONTENT_WIDTH,
    alignSelf: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "flex-end",
    paddingHorizontal: theme.spacing[4],
    gap: theme.spacing[2],
  },
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.statusDanger, fontSize: theme.fontSize.sm },
}));
