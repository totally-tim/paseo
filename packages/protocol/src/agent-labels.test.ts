import { describe, expect, test } from "vitest";
import {
  COORDINATOR_GLOBAL_ROLE,
  COORDINATOR_PROJECT_ID_LABEL,
  COORDINATOR_PROJECT_ROLE,
  getCoordinatorProjectIdFromLabels,
  getCoordinatorRole,
  getParentAgentIdFromLabels,
  getOpenAgentTabLabel,
  hasOpenAgentTab,
  isCoordinatorAgent,
  isDelegatedAgent,
  isOpenAgentTabLabel,
  PARENT_AGENT_ID_LABEL,
  PASEO_ROLE_LABEL,
} from "./agent-labels.js";

describe("agent label policy", () => {
  test("treats a non-empty parent agent label as delegation", () => {
    const labels = { [PARENT_AGENT_ID_LABEL]: " parent-agent \n" };

    expect(getParentAgentIdFromLabels(labels)).toBe("parent-agent");
    expect(isDelegatedAgent({ labels })).toBe(true);
  });

  test("ignores missing, empty, and non-string parent agent labels", () => {
    expect(isDelegatedAgent({ labels: {} })).toBe(false);
    expect(isDelegatedAgent({ labels: { [PARENT_AGENT_ID_LABEL]: "   " } })).toBe(false);
    expect(isDelegatedAgent({ labels: { [PARENT_AGENT_ID_LABEL]: 42 } })).toBe(false);
  });

  test("treats any true client-scoped open-tab label as open", () => {
    const desktopLabel = getOpenAgentTabLabel("desktop-client");
    const mobileLabel = getOpenAgentTabLabel("mobile-client");

    expect(hasOpenAgentTab({ [desktopLabel]: "false", [mobileLabel]: "true" })).toBe(true);
    expect(hasOpenAgentTab({ [desktopLabel]: "false", [mobileLabel]: "false" })).toBe(false);
    expect(hasOpenAgentTab({})).toBe(false);
  });

  test("recognizes only client-scoped open-tab labels", () => {
    expect(isOpenAgentTabLabel(getOpenAgentTabLabel("client-a"))).toBe(true);
    expect(isOpenAgentTabLabel("paseo.open-agent-tab")).toBe(false);
    expect(isOpenAgentTabLabel("custom.open-agent-tab.client-a")).toBe(false);
  });

  test("reads coordinator roles from the role label", () => {
    expect(getCoordinatorRole({ [PASEO_ROLE_LABEL]: COORDINATOR_GLOBAL_ROLE })).toBe(
      COORDINATOR_GLOBAL_ROLE,
    );
    expect(getCoordinatorRole({ [PASEO_ROLE_LABEL]: COORDINATOR_PROJECT_ROLE })).toBe(
      COORDINATOR_PROJECT_ROLE,
    );
    expect(isCoordinatorAgent({ labels: { [PASEO_ROLE_LABEL]: COORDINATOR_PROJECT_ROLE } })).toBe(
      true,
    );
  });

  test("rejects missing, unknown, and non-string role labels", () => {
    expect(getCoordinatorRole(undefined)).toBeNull();
    expect(getCoordinatorRole({})).toBeNull();
    expect(getCoordinatorRole({ [PASEO_ROLE_LABEL]: "coordinator" })).toBeNull();
    expect(getCoordinatorRole({ [PASEO_ROLE_LABEL]: 7 })).toBeNull();
    expect(isCoordinatorAgent({ labels: {} })).toBe(false);
  });

  test("reads the project id only from the coordinator project label", () => {
    expect(
      getCoordinatorProjectIdFromLabels({ [COORDINATOR_PROJECT_ID_LABEL]: " project-1 \n" }),
    ).toBe("project-1");
    expect(getCoordinatorProjectIdFromLabels({})).toBeNull();
    expect(getCoordinatorProjectIdFromLabels({ [COORDINATOR_PROJECT_ID_LABEL]: "   " })).toBeNull();
    expect(getCoordinatorProjectIdFromLabels({ [COORDINATOR_PROJECT_ID_LABEL]: 3 })).toBeNull();
  });
});
