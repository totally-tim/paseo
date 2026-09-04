import type { PluginTheme } from "@getpaseo/plugin";
import { Modal } from "@getpaseo/plugin/react-native";
import { useCallback, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { ALL_PROJECTS, type InboxFilters } from "./filters";
import { ActionButton } from "./question-card";
import type { InboxSnapshot, InboxStore } from "./store";

type Picker = "project" | "group";
interface Choice {
  id: string | null;
  label: string;
}

function FilterChoice({
  choice,
  selected,
  theme,
  onSelect,
}: {
  choice: Choice;
  selected: boolean;
  theme: PluginTheme;
  onSelect(id: string | null): void;
}) {
  const state = useMemo(() => ({ checked: selected }), [selected]);
  const style = useMemo(
    () => ({
      padding: 10,
      backgroundColor: selected ? theme.colors.surface2 : theme.colors.surface1,
      borderRadius: 8,
    }),
    [selected, theme],
  );
  const textStyle = useMemo(() => ({ color: theme.colors.foreground, fontSize: 13 }), [theme]);
  const select = useCallback(() => onSelect(choice.id), [choice.id, onSelect]);
  return (
    <Pressable accessibilityRole="radio" accessibilityState={state} style={style} onPress={select}>
      <Text style={textStyle}>{choice.label}</Text>
    </Pressable>
  );
}

export function FilterControls({
  snapshot,
  store,
  theme,
  onChange,
  onOpenChange,
  active,
}: {
  snapshot: InboxSnapshot;
  store: InboxStore;
  theme: PluginTheme;
  onChange(): void;
  onOpenChange(open: boolean): void;
  active: boolean;
}) {
  const [picker, setPicker] = useState<Picker | null>(null);
  const [search, setSearch] = useState("");
  const { filters } = snapshot;
  const choices = useMemo(() => {
    const projects = new Map<string, string>();
    const groups = new Set<string>();
    for (const workspace of snapshot.workspaces.values()) {
      const group = workspace.projectGroup ?? "";
      groups.add(group);
      if (filters.projectGroup === null || group === filters.projectGroup)
        projects.set(workspace.projectId, workspace.projectDisplayName);
    }
    const all =
      picker === "group"
        ? Array.from(groups, (id) => ({ id, label: id || "Ungrouped" }))
        : Array.from(projects, ([id, label]) => ({ id, label }));
    const matches = all
      .sort((a, b) => a.label.localeCompare(b.label))
      .filter((item) => item.label.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
    return [{ id: null, label: picker === "group" ? "All groups" : "All projects" }, ...matches];
  }, [snapshot.workspaces, filters.projectGroup, picker, search]);
  const projectLabel = Array.from(snapshot.workspaces.values()).find(
    (workspace) => workspace.projectId === filters.projectId,
  )?.projectDisplayName;
  const update = useCallback(
    (value: InboxFilters) => {
      onChange();
      store.setFilters(value);
      setPicker(null);
      onOpenChange(false);
    },
    [onChange, onOpenChange, store],
  );
  const reset = useCallback(() => update(ALL_PROJECTS), [update]);
  const select = useCallback(
    (id: string | null) =>
      update(
        picker === "group" ? { projectGroup: id, projectId: null } : { ...filters, projectId: id },
      ),
    [filters, picker, update],
  );
  const openGroup = useCallback(() => {
    setSearch("");
    setPicker("group");
    onOpenChange(true);
  }, [onOpenChange]);
  const openProject = useCallback(() => {
    setSearch("");
    setPicker("project");
    onOpenChange(true);
  }, [onOpenChange]);
  const changeOpen = useCallback(
    (value: boolean) => {
      if (!value) setPicker(null);
      onOpenChange(value);
    },
    [onOpenChange],
  );
  const styles = useMemo(
    () =>
      StyleSheet.create({
        stack: { gap: 8 },
        row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
        text: { color: theme.colors.foreground, fontSize: 13 },
        error: { color: theme.colors.statusDanger, fontSize: 13 },
        input: {
          color: theme.colors.foreground,
          fontSize: 13,
          padding: 10,
          borderWidth: 1,
          borderColor: theme.colors.border,
          borderRadius: 8,
        },
      }),
    [theme],
  );
  const selectedId = picker === "group" ? filters.projectGroup : filters.projectId;
  return (
    <View style={styles.stack}>
      <View style={styles.row}>
        <ActionButton
          theme={theme}
          label={`Group: ${filters.projectGroup === null ? "All" : filters.projectGroup || "Ungrouped"}`}
          onPress={openGroup}
          disabled={!snapshot.filtersReady}
        />
        <ActionButton
          theme={theme}
          label={`Project: ${filters.projectId ? projectLabel || "Unavailable project" : "All"}`}
          onPress={openProject}
          disabled={!snapshot.filtersReady}
        />
        {filters.projectId || filters.projectGroup !== null ? (
          <ActionButton theme={theme} label="Clear filters" onPress={reset} />
        ) : null}
        {snapshot.filtersSaving ? <Text style={styles.text}>Saving filters…</Text> : null}
      </View>
      {snapshot.filtersError ? (
        <View style={styles.row}>
          <Text style={styles.error}>
            Could not restore or save filters: {snapshot.filtersError}
          </Text>
          <ActionButton theme={theme} label="Retry filters" onPress={store.retryFilters} />
          <ActionButton theme={theme} label="Reset filters" onPress={reset} />
        </View>
      ) : null}
      <Modal
        title={picker === "group" ? "Filter by group" : "Filter by project"}
        open={active && picker !== null}
        onOpenChange={changeOpen}
      >
        <Modal.Content>
          <View style={styles.stack}>
            <TextInput
              value={search}
              onChangeText={setSearch}
              accessibilityLabel="Search filters"
              placeholder="Search…"
              placeholderTextColor={theme.colors.foregroundMuted}
              style={styles.input}
            />
            {choices.map((choice) => (
              <FilterChoice
                key={JSON.stringify(choice.id)}
                choice={choice}
                selected={choice.id === selectedId}
                theme={theme}
                onSelect={select}
              />
            ))}
            {choices.length === 1 ? (
              <Text style={styles.text}>No matching projects or groups.</Text>
            ) : null}
          </View>
        </Modal.Content>
      </Modal>
    </View>
  );
}
