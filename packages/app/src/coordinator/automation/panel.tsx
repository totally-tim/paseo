import { automationLoadMessage } from "./model";
import { useCallback, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { Target, ShieldCheck } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import invariant from "tiny-invariant";
import type { CoordinatorGoal, CoordinatorPolicyRule } from "@getpaseo/protocol/coordinator-goals";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { usePaneContext } from "@/panels/pane-context";
import { definePanel } from "@/panels/panel-registry";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useAutomation } from "./use-model";
import type { AutomationView, AutomationState, openAutomation } from "./model";
const GoalIcon = withUnistyles(Target);
const PolicyIcon = withUnistyles(ShieldCheck);
type Operation = AutomationState["operations"][string];
function Status({ operation }: { operation?: Operation }) {
  if (operation?.error)
    return (
      <Text style={styles.error} accessibilityRole="alert">
        {operation.error}
      </Text>
    );
  if (operation?.success) return <Text style={styles.muted}>{operation.success}</Text>;
  return null;
}
function GoalRow({
  goal,
  model,
  operation,
  connected,
}: {
  goal: CoordinatorGoal;
  model: ReturnType<typeof openAutomation>;
  operation?: Operation;
  connected: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const toggleExpanded = useCallback(() => setExpanded((value) => !value), []);
  const toggleGoal = useCallback(
    (enabled: boolean) => void model.setGoalPaused(goal, !enabled),
    [model, goal],
  );
  return (
    <View style={styles.item} testID={`coordinator-goal-${goal.id}`}>
      <View style={styles.row}>
        <Text style={styles.title}>{goal.sentence}</Text>
        <Switch
          value={!goal.paused}
          disabled={!connected || operation?.pending}
          onValueChange={toggleGoal}
          accessibilityLabel={`Run goal: ${goal.sentence}`}
        />
      </View>
      <Text style={styles.muted}>
        {goal.paused ? "Paused" : "Active"} ·{" "}
        {goal.kind === "judgment" ? "Judgment" : "Deterministic"} · {goal.firedCount} runs ·{" "}
        {goal.lastRunAt ? `Last run ${new Date(goal.lastRunAt).toLocaleString()}` : "Not run yet"}
        {goal.lastOutcome === "unknown" ? " · Outcome unverified" : ""}
        {goal.emptyStreak ? ` · ${goal.emptyStreak} runs without output` : ""}
      </Text>
      {goal.lastError ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {goal.lastError} Resume the goal to retry.
        </Text>
      ) : null}
      {operation?.pending ? <Text style={styles.muted}>Saving…</Text> : null}
      <Button variant="ghost" size="sm" style={styles.ruleButton} onPress={toggleExpanded}>
        {expanded ? "Hide rule" : "View rule"}
      </Button>
      {expanded ? (
        <Text selectable style={styles.code}>
          {goal.ruleYaml}
        </Text>
      ) : null}
      <Status operation={operation} />
    </View>
  );
}
function PolicyRow({
  rule,
  model,
  operation,
  connected,
}: {
  rule: CoordinatorPolicyRule;
  model: ReturnType<typeof openAutomation>;
  operation?: Operation;
  connected: boolean;
}) {
  const togglePolicy = useCallback(
    (enabled: boolean) => void model.setPolicyEnabled(rule, enabled),
    [model, rule],
  );
  return (
    <View style={styles.item} testID={`coordinator-policy-${rule.id}`}>
      <View style={styles.row}>
        <Text style={styles.title}>
          {rule.scope === "daemon" ? "All projects" : `Project ${rule.scope}`}
        </Text>
        <Switch
          value={rule.enabled}
          disabled={!connected || operation?.pending}
          onValueChange={togglePolicy}
          accessibilityLabel={`Enable rule ${rule.id}`}
        />
      </View>
      <Text selectable style={styles.code}>
        {JSON.stringify(JSON.parse(rule.pattern), null, 2)}
      </Text>
      <Text style={styles.muted}>
        {rule.firedCount} approvals{operation?.pending ? " · Saving…" : ""}
      </Text>
      <Text style={styles.muted}>
        Exact provider, tool, and complete input must match, including worktree paths. Automatic
        answers require Ship or Autopilot.
      </Text>
      <Status operation={operation} />
    </View>
  );
}
function AutomationContent({
  serverId,
  projectId,
  view,
}: {
  serverId: string;
  projectId?: string;
  view: AutomationView;
}) {
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const { model, state } = useAutomation(view, projectId, connected ? client : null);
  if (state.load.status !== "loaded")
    return (
      <View style={styles.empty}>
        <Text style={state.load.status === "error" ? styles.error : styles.muted}>
          {automationLoadMessage(state.load)}
        </Text>
        {state.load.status === "error" ? (
          <Button variant="ghost" onPress={model.reload}>
            Retry
          </Button>
        ) : null}
      </View>
    );
  const data = state.load.data;
  const count = view === "goals" ? data.goals.length : data.policy.length;
  return (
    <View style={styles.root} testID={`coordinator-${view}-pane`}>
      <View style={styles.toolbar}>
        <Text style={styles.title}>
          {view === "goals" ? "Goals" : "Policy"} · {count}
        </Text>
        <Button
          size="sm"
          variant="ghost"
          loading={state.refreshing}
          disabled={!connected}
          onPress={model.reload}
        >
          Refresh
        </Button>
      </View>
      {!connected ? (
        <Text style={styles.error}>Host disconnected. Reconnect before making changes.</Text>
      ) : null}
      <ScrollView contentContainerStyle={styles.list}>
        {count === 0 ? (
          <Text style={styles.muted}>
            {view === "goals"
              ? "No approved goals yet. Describe a goal in the coordinator composer."
              : "No permission rules yet. Use Always allow this on a pending decision."}
          </Text>
        ) : null}
        {view === "goals"
          ? data.goals.map((goal) => (
              <GoalRow
                key={goal.id}
                goal={goal}
                model={model}
                connected={connected}
                operation={state.operations[goal.id]}
              />
            ))
          : data.policy.map((rule) => (
              <PolicyRow
                key={rule.id}
                rule={rule}
                model={model}
                connected={connected}
                operation={state.operations[rule.id]}
              />
            ))}
      </ScrollView>
    </View>
  );
}
function AutomationPanel() {
  const { serverId, target } = usePaneContext();
  invariant(
    target.kind === "coordinator_goals" || target.kind === "coordinator_policy",
    "Coordinator automation target required",
  );
  return (
    <AutomationContent
      key={`${serverId}:${target.kind}:${target.projectId ?? "daemon"}`}
      serverId={serverId}
      projectId={target.projectId}
      view={target.kind === "coordinator_goals" ? "goals" : "policy"}
    />
  );
}
export const coordinatorGoalsPanelRegistration = definePanel("coordinator_goals", {
  component: AutomationPanel,
  presentation: {
    label: () => "Goals",
    subtitle: () => "Coordinator",
    tooltip: () => "Goals",
    icon: GoalIcon,
  },
});
export const coordinatorPolicyPanelRegistration = definePanel("coordinator_policy", {
  component: AutomationPanel,
  presentation: {
    label: () => "Policy",
    subtitle: () => "Coordinator",
    tooltip: () => "Policy",
    icon: PolicyIcon,
  },
});
const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, padding: theme.spacing[4], gap: theme.spacing[3] },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: theme.spacing[3] },
  toolbar: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  row: { flexDirection: "row", alignItems: "center", gap: theme.spacing[3] },
  title: { flex: 1, color: theme.colors.foreground, fontSize: theme.fontSize.base },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
  ruleButton: { alignSelf: "flex-start" },
  code: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
  },
  list: { gap: theme.spacing[4] },
  item: { gap: theme.spacing[2] },
}));
