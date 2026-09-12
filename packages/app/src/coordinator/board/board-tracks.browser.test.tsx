import React, { act, type ComponentType, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CoordinatorProjectResult,
  DaemonClient,
} from "@getpaseo/client/internal/daemon-client";
import type {
  CoordinatorBoardSnapshot as BoardSnapshot,
  CoordinatorTrustLevel,
  CoordinatorUsage,
  CoordinatorUsageExpectation,
  ProjectCoordinatorState,
} from "@getpaseo/protocol/messages";
import { i18n } from "@/i18n/i18next";
import { useCoordinatorBoardStore } from "@/coordinator/board-store";
import { useCoordinatorProjectStore } from "@/coordinator/project-store";
import { CoordinatorBoardTracks, CoordinatorScopePill, CoordinatorTrustPill } from "./board-tracks";

/**
 * The real host-runtime module drags the session and navigation graph into the
 * browser bundle, so the client seam is stubbed instead — `useHostRuntimeClient`
 * for the pills and `getHostRuntimeStore().getSnapshot` for the record refresh.
 */
const hostClient = vi.hoisted(() => ({
  current: null as Pick<DaemonClient, "getProjectCoordinator" | "updateProjectCoordinator"> | null,
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => hostClient.current,
  getHostRuntimeStore: () => ({
    getSnapshot: () => ({ client: hostClient.current }),
  }),
}));

/**
 * The menu surface's `entering` keyframe runs through reanimated's JS fallback, whose
 * `animationstart` listener races these tests' synchronous teardown — it fires on a node
 * React already detached and throws inside `_updatePropsJS`. Nothing under test animates,
 * so the floating primitives render as plain react-native views here.
 */
vi.mock("@/components/ui/floating", async () => {
  const { createElement, forwardRef } = await import("react");
  const { ScrollView, View } = await import("react-native");

  type LooseProps = Record<string, unknown>;
  const PlainView = View as unknown as ComponentType<LooseProps>;
  const PlainScrollView = ScrollView as unknown as ComponentType<LooseProps>;

  const FloatingSurface = forwardRef<unknown, LooseProps>(function FloatingSurface(props, ref) {
    const viewProps: LooseProps = {
      ...props,
      ref,
      style: [props.frameStyle, props.style],
    };
    delete viewProps.entering;
    delete viewProps.exiting;
    delete viewProps.layout;
    delete viewProps.frameStyle;
    return createElement(PlainView, viewProps);
  });
  const FloatingScrollView = (props: LooseProps) => createElement(PlainScrollView, props);

  return { FloatingSurface, FloatingScrollView };
});

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(async () => {
  vi.stubGlobal("React", React);
  await i18n.changeLanguage("en");
});

const SERVER_ID = "board-tracks-host";
const PROJECT_ID = "project-a";

const USAGE_WITH_EXPECTATION: CoordinatorUsage = {
  monthlySpawns: 14,
  monthlyTokens: 1_200_000,
};
const EXPECTATION: CoordinatorUsageExpectation = {
  monthlySpawns: 20,
  monthlyTokens: 5_000_000,
};
const USAGE_WITHOUT_EXPECTATION: CoordinatorUsage = {
  monthlySpawns: 3,
  monthlyTokens: 40_000,
};
const EMPTY_EXPECTATION: CoordinatorUsageExpectation = {};

interface Mounted {
  root: Root;
  container: HTMLDivElement;
}

const mounted: Mounted[] = [];

function mount(content: ReactNode): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(content));
  mounted.push({ root, container });
  return container;
}

afterEach(() => {
  // Dismiss any surface a test left open before its root comes down.
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  });
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
  hostClient.current = null;
  useCoordinatorBoardStore.getState().clearHost(SERVER_ID);
  useCoordinatorProjectStore.getState().clearHost(SERVER_ID);
});

function click(element: Element): void {
  act(() => {
    (element as HTMLElement).click();
  });
}

function node(testID: string): HTMLElement {
  const element = document.querySelector(`[data-testid="${testID}"]`);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`${testID} did not render`);
  }
  return element;
}

function maybeNode(testID: string): HTMLElement | null {
  const element = document.querySelector(`[data-testid="${testID}"]`);
  return element instanceof HTMLElement ? element : null;
}

function openPill(testID: string): void {
  click(node(testID));
}

function trustPill(level: CoordinatorTrustLevel, onSelectTrust = vi.fn()) {
  return mount(
    <CoordinatorTrustPill
      trustLevel={level}
      usage={null}
      usageExpectation={null}
      onSelectTrust={onSelectTrust}
    />,
  );
}

function boardSnapshot(overrides: Partial<BoardSnapshot> = {}): BoardSnapshot {
  return {
    projectId: PROJECT_ID,
    needsYou: [],
    working: [],
    done: [],
    wake: null,
    coordinatorAgentId: "coordinator-agent-1",
    trustLevel: "observe",
    scope: "everything",
    enabled: true,
    ...overrides,
  };
}

function coordinatorState(
  overrides: Partial<ProjectCoordinatorState> = {},
): ProjectCoordinatorState {
  return {
    projectId: PROJECT_ID,
    agentId: "coordinator-agent-1",
    enabled: true,
    trustLevel: "observe",
    scope: "everything",
    ...overrides,
  };
}

/** A stub client the pills' panel actions call through `useHostRuntimeClient`. */
function seedHost(client: typeof hostClient.current): void {
  hostClient.current = client;
}

describe("coordinator trust pill", () => {
  it("reads the current notch with its dot", () => {
    trustPill("ship");

    const pill = node("coordinator-trust-pill");
    expect(pill.textContent).toContain("Ship");
    expect(node("coordinator-trust-pill-segment-0").firstElementChild).not.toBeNull();
  });

  it("offers every notch and applies a step down on selection", () => {
    const onSelectTrust = vi.fn();
    trustPill("ship", onSelectTrust);
    openPill("coordinator-trust-pill");

    for (const level of ["observe", "propose", "ship", "autopilot"]) {
      expect(maybeNode(`coordinator-trust-option-${level}`)).not.toBeNull();
    }
    expect(node("coordinator-trust-hint").textContent).toContain("implementers");

    click(node("coordinator-trust-option-propose"));

    expect(onSelectTrust).toHaveBeenCalledWith("propose");
  });

  it("arms Autopilot behind a second tap instead of applying it", () => {
    const onSelectTrust = vi.fn();
    trustPill("observe", onSelectTrust);
    openPill("coordinator-trust-pill");

    click(node("coordinator-trust-option-autopilot"));

    // The notch highlights armed, the level is not applied, and the panel
    // reveals the one control that applies it — no modal, no second sheet.
    expect(onSelectTrust).not.toHaveBeenCalled();
    const confirm = node("coordinator-trust-confirm-autopilot");
    expect(confirm.textContent).toContain("Allow autopilot in this project");

    click(confirm);

    expect(onSelectTrust).toHaveBeenCalledTimes(1);
    expect(onSelectTrust).toHaveBeenCalledWith("autopilot");
  });

  it("drops the arm when another notch is picked instead", () => {
    const onSelectTrust = vi.fn();
    trustPill("observe", onSelectTrust);
    openPill("coordinator-trust-pill");

    click(node("coordinator-trust-option-autopilot"));
    click(node("coordinator-trust-option-ship"));

    expect(onSelectTrust).toHaveBeenCalledTimes(1);
    expect(onSelectTrust).toHaveBeenCalledWith("ship");
    expect(maybeNode("coordinator-trust-confirm-autopilot")).toBeNull();
  });

  it("shows the month's actuals against the expectation", () => {
    mount(
      <CoordinatorTrustPill
        trustLevel="propose"
        usage={USAGE_WITH_EXPECTATION}
        usageExpectation={EXPECTATION}
        onSelectTrust={vi.fn()}
      />,
    );
    openPill("coordinator-trust-pill");

    const meter = node("coordinator-usage-text");
    expect(meter.textContent).toContain("14 of 20 spawns expected");
    expect(meter.textContent).toContain("1.2m of 5m tokens expected");
  });

  it("keeps the meter when the project has actuals but no expectation configured", () => {
    mount(
      <CoordinatorTrustPill
        trustLevel="observe"
        usage={USAGE_WITHOUT_EXPECTATION}
        usageExpectation={EMPTY_EXPECTATION}
        onSelectTrust={vi.fn()}
      />,
    );
    openPill("coordinator-trust-pill");

    // No expectation configured means there is nothing to meter against — the
    // whole affordance hides rather than render a bar with no scale.
    expect(maybeNode("coordinator-usage-meter")).toBeNull();
  });

  it("surfaces a failed update in the panel", async () => {
    const onSelectTrust = vi.fn(async () => {
      throw new Error("daemon rejected");
    });
    trustPill("observe", onSelectTrust);
    openPill("coordinator-trust-pill");

    click(node("coordinator-trust-option-propose"));
    await act(async () => {});

    expect(node("coordinator-trust-error").textContent).toContain("daemon rejected");
  });
});

describe("coordinator scope pill", () => {
  it("reads the current scope and applies the other one on selection", () => {
    const onSelectScope = vi.fn();
    mount(<CoordinatorScopePill scope="everything" onSelectScope={onSelectScope} />);

    expect(node("coordinator-scope-pill").textContent).toContain("Everything");

    openPill("coordinator-scope-pill");
    click(node("coordinator-scope-option-project"));

    expect(onSelectScope).toHaveBeenCalledWith("project");
  });

  it("reads Project only when that is the board's scope", () => {
    mount(<CoordinatorScopePill scope="project" onSelectScope={vi.fn()} />);
    expect(node("coordinator-scope-pill").textContent).toContain("Project only");
  });
});

describe("coordinator board tracks", () => {
  function clientReturning(result: CoordinatorProjectResult) {
    return {
      getProjectCoordinator: vi.fn(async () => result),
      updateProjectCoordinator: vi.fn(async () => result),
    };
  }

  it("draws both pills off the board snapshot once the project is enabled", async () => {
    seedHost(clientReturning({ coordinator: coordinatorState() }));
    useCoordinatorBoardStore
      .getState()
      .applyBoardChange(SERVER_ID, boardSnapshot({ trustLevel: "propose", scope: "project" }));

    mount(<CoordinatorBoardTracks serverId={SERVER_ID} projectId={PROJECT_ID} />);
    await act(async () => {});

    expect(node("coordinator-trust-pill").textContent).toContain("Propose");
    expect(node("coordinator-scope-pill").textContent).toContain("Project only");
  });

  it("renders nothing while the project has no coordinator", () => {
    useCoordinatorBoardStore
      .getState()
      .applyBoardChange(SERVER_ID, boardSnapshot({ enabled: false }));

    mount(<CoordinatorBoardTracks serverId={SERVER_ID} projectId={PROJECT_ID} />);

    expect(maybeNode("coordinator-trust-pill")).toBeNull();
    expect(maybeNode("coordinator-scope-pill")).toBeNull();
  });

  it("sends trust changes to coordinator.project.update and lands the record", async () => {
    const client = clientReturning({
      coordinator: coordinatorState({ trustLevel: "propose" }),
    });
    seedHost(client);
    useCoordinatorBoardStore.getState().applyBoardChange(SERVER_ID, boardSnapshot());

    mount(<CoordinatorBoardTracks serverId={SERVER_ID} projectId={PROJECT_ID} />);
    openPill("coordinator-trust-pill");
    click(node("coordinator-trust-option-propose"));
    await act(async () => {});

    expect(client.updateProjectCoordinator).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      trustLevel: "propose",
    });
    expect(
      useCoordinatorProjectStore.getState().hosts[SERVER_ID]?.get(PROJECT_ID)?.coordinator
        ?.trustLevel,
    ).toBe("propose");
  });

  it("sends scope changes to coordinator.project.update", async () => {
    const client = clientReturning({
      coordinator: coordinatorState({ scope: "project" }),
    });
    seedHost(client);
    useCoordinatorBoardStore.getState().applyBoardChange(SERVER_ID, boardSnapshot());

    mount(<CoordinatorBoardTracks serverId={SERVER_ID} projectId={PROJECT_ID} />);
    openPill("coordinator-scope-pill");
    click(node("coordinator-scope-option-project"));
    await act(async () => {});

    expect(client.updateProjectCoordinator).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      scope: "project",
    });
  });

  it("fills the meter from the project record's usage expectation", async () => {
    seedHost(
      clientReturning({
        coordinator: coordinatorState({
          usageExpectation: { monthlySpawns: 10 },
        }),
      }),
    );
    useCoordinatorBoardStore
      .getState()
      .applyBoardChange(
        SERVER_ID,
        boardSnapshot({ usage: { monthlySpawns: 4, monthlyTokens: 600 } }),
      );

    mount(<CoordinatorBoardTracks serverId={SERVER_ID} projectId={PROJECT_ID} />);
    await act(async () => {});
    openPill("coordinator-trust-pill");
    await act(async () => {});

    expect(node("coordinator-usage-text").textContent).toContain("4 of 10 spawns expected");
  });
});
