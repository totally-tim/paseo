import { useCallback } from "react";
import { Text, View, Linking } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { CoordinatorProposal } from "@getpaseo/protocol/coordinator-goals";
import { Button } from "@/components/ui/button";
import { useAutomation } from "./use-model";
import {
  proposalEditQuote,
  proposalRuleText,
  proposalNeedsReview,
  proposalScopeText,
  automationLoadMessage,
  type AutomationState,
  type openAutomation,
} from "./model";
function EvidenceLink({ title, url }: { title: string; url?: string }) {
  const open = useCallback(() => {
    if (url) void Linking.openURL(url);
  }, [url]);
  return (
    <View>
      <Text style={styles.muted}>{title}</Text>
      {url && /^https?:\/\//i.test(url) ? (
        <Button size="sm" variant="ghost" onPress={open}>
          Open evidence
        </Button>
      ) : null}
    </View>
  );
}
function ProposalRow({
  proposal,
  model,
  operation,
  connected,
  onEdit,
  projectNameForId,
}: {
  proposal: CoordinatorProposal;
  model: ReturnType<typeof openAutomation>;
  operation?: AutomationState["operations"][string];
  connected: boolean;
  onEdit: (quote: string) => void;
  projectNameForId?: (id: string) => string | undefined;
}) {
  const approve = useCallback(
    () => void model.resolveProposal(proposal, "approve"),
    [model, proposal],
  );
  const ignore = useCallback(
    () => void model.resolveProposal(proposal, "ignore"),
    [model, proposal],
  );
  const edit = useCallback(() => onEdit(proposalEditQuote(proposal)), [proposal, onEdit]);
  return (
    <View style={styles.proposal} testID={`coordinator-proposal-${proposal.id}`}>
      <Text style={styles.heading}>{proposal.sentence}</Text>
      <Text style={styles.heading}>{proposalScopeText(proposal, projectNameForId)}</Text>
      <Text selectable style={styles.rule}>
        {proposalRuleText(proposal)}
      </Text>
      {proposal.evidence.map((evidence) => (
        <EvidenceLink key={`${evidence.title}:${evidence.url ?? ""}`} {...evidence} />
      ))}
      <View style={styles.actions}>
        <Button
          size="sm"
          disabled={!connected || operation?.pending}
          loading={operation?.pending}
          onPress={approve}
        >
          {proposal.status === "approved" ? "Retry approval" : "Approve"}
        </Button>
        {proposal.status === "pending" ? (
          <>
            <Button
              size="sm"
              variant="ghost"
              disabled={!connected || operation?.pending}
              onPress={edit}
            >
              Edit
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!connected || operation?.pending}
              onPress={ignore}
            >
              Ignore
            </Button>
          </>
        ) : null}
      </View>
      {operation?.error || proposal.error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {operation?.error ?? proposal.error}
        </Text>
      ) : null}
      {operation?.success ? <Text style={styles.muted}>{operation.success}</Text> : null}
    </View>
  );
}
export function CoordinatorProposals({
  client,
  projectId,
  onEdit,
  projectNameForId,
}: {
  client: DaemonClient | null;
  projectId?: string;
  onEdit: (quote: string) => void;
  projectNameForId?: (id: string) => string | undefined;
}) {
  const { model, state } = useAutomation("proposals", projectId, client);
  if (state.load.status !== "loaded")
    return (
      <View style={styles.section}>
        <Text style={styles.muted}>{automationLoadMessage(state.load)}</Text>
        {state.load.status === "error" ? (
          <Button size="sm" variant="ghost" onPress={model.reload}>
            Retry proposals
          </Button>
        ) : null}
      </View>
    );
  const proposals = state.load.data.proposals.filter(proposalNeedsReview);
  if (!proposals.length) return null;
  return (
    <View style={styles.section} testID="coordinator-proposals">
      <Text style={styles.heading}>Proposals · {proposals.length}</Text>
      {proposals.map((proposal) => (
        <ProposalRow
          key={proposal.id}
          proposal={proposal}
          model={model}
          connected={state.connected}
          operation={state.operations[proposal.id]}
          onEdit={onEdit}
          projectNameForId={projectNameForId}
        />
      ))}
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  section: { gap: theme.spacing[3], padding: theme.spacing[3] },
  proposal: { gap: theme.spacing[2] },
  heading: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  rule: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
}));
