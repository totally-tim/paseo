/** @vitest-environment jsdom */
import React from "react";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "@/i18n/i18next";
import type { HostOrderState } from "./index";
import { SidebarOrderControls, SidebarOrderNotice } from "./controls";

const mock = vi.hoisted(() => ({
  hosts: {} as Record<string, HostOrderState>,
  acquireDirectoryDemand: vi.fn(),
  retry: vi.fn(),
}));
vi.mock("@/runtime/host-runtime", () => ({
  useHosts: () => [{ serverId: "visible" }, { serverId: "filtered-out" }],
  getHostRuntimeStore: () => ({ acquireDirectoryDemand: mock.acquireDirectoryDemand }),
}));
vi.mock("./index", () => ({
  useSidebarOrderSync: (selector: (store: { hosts: typeof mock.hosts }) => unknown) =>
    selector({ hosts: mock.hosts }),
  sidebarOrderSync: { retry: mock.retry },
}));
vi.mock("@/components/ui/menu", () => ({
  MenuItem: ({ children }: { children: React.ReactNode }) => children,
  MenuSeparator: () => null,
}));
beforeEach(async () => {
  vi.stubGlobal("React", React);
  mock.hosts = {};
  mock.acquireDirectoryDemand.mockReset();
  mock.retry.mockReset();
  await i18n.changeLanguage("en");
});
afterEach(cleanup);

it("connects every settings host and releases demand when settings close", () => {
  const releaseVisible = vi.fn();
  const releaseFiltered = vi.fn();
  mock.acquireDirectoryDemand
    .mockReturnValueOnce(releaseVisible)
    .mockReturnValueOnce(releaseFiltered);
  const view = render(<SidebarOrderControls />);
  expect(mock.acquireDirectoryDemand.mock.calls).toEqual([["visible"], ["filtered-out"]]);
  view.unmount();
  expect(releaseVisible).toHaveBeenCalledOnce();
  expect(releaseFiltered).toHaveBeenCalledOnce();
});

it("keeps notice retry available after a connected host reload fails", () => {
  mock.hosts.visible = {
    status: "loading",
    snapshot: null,
    pending: false,
    error: "Reload timeout",
    failedWrite: { change: { kind: "groups", keys: ["new"] }, baseKeys: ["old"] },
  };
  const view = render(<SidebarOrderNotice />);
  fireEvent.click(view.getByRole("button", { name: i18n.t("sidebarOrder.retry") }));
  expect(mock.retry).toHaveBeenCalledWith("visible");
  expect(mock.acquireDirectoryDemand).not.toHaveBeenCalled();
});
