import { describe, expect, it } from "vitest";

import { prChipModel } from "./pr-status";
import type { CheckoutPrStatusResult } from "./types";

type PrStatus = NonNullable<CheckoutPrStatusResult["status"]>;

function payload(status: Partial<PrStatus> | null): CheckoutPrStatusResult {
  return { status: status as PrStatus | null } as CheckoutPrStatusResult;
}

const OPEN = {
  url: "https://github.com/owner/repo/pull/42",
  number: 42,
  state: "open",
  isMerged: false,
  isDraft: false,
} satisfies Partial<PrStatus>;

describe("prChipModel", () => {
  it("renders nothing without a payload or a change request", () => {
    expect(prChipModel(null)).toBeNull();
    expect(prChipModel(undefined)).toBeNull();
    expect(prChipModel(payload(null))).toBeNull();
    expect(prChipModel(payload({ ...OPEN, url: "" }))).toBeNull();
  });

  it("reads the PR number from the URL when the field is missing", () => {
    const model = prChipModel(payload({ ...OPEN, number: undefined }));
    expect(model?.label).toBe("#42 open");
    expect(model?.tone).toBe("accent");
  });

  it("supports merge-request URLs", () => {
    const model = prChipModel(
      payload({
        ...OPEN,
        url: "https://gitlab.com/owner/repo/-/merge_requests/7",
        number: undefined,
      }),
    );
    expect(model?.label).toBe("#7 open");
  });

  it("falls back to a state-only chip when no number can be derived", () => {
    const model = prChipModel(payload({ ...OPEN, number: undefined, url: "https://x/pr" }));
    expect(model?.label).toBe("open");
    expect(model?.tone).toBe("accent");
  });

  it("marks merged pull requests as success", () => {
    const model = prChipModel(payload({ ...OPEN, isMerged: true, state: "closed" }));
    expect(model?.label).toBe("#42 merged");
    expect(model?.tone).toBe("success");
  });

  it("labels drafts and closed pull requests", () => {
    expect(prChipModel(payload({ ...OPEN, isDraft: true }))?.label).toBe("#42 draft");
    const closed = prChipModel(payload({ ...OPEN, state: "closed" }));
    expect(closed?.label).toBe("#42 closed");
    expect(closed?.tone).toBe("muted");
  });

  it("maps check states onto the tone", () => {
    const failed = prChipModel(payload({ ...OPEN, checksStatus: "failure" }));
    expect(failed?.label).toBe("#42 open · checks ✗");
    expect(failed?.tone).toBe("danger");
    const pending = prChipModel(payload({ ...OPEN, checksStatus: "pending" }));
    expect(pending?.label).toBe("#42 open · checks …");
    expect(pending?.tone).toBe("warning");
    const passed = prChipModel(payload({ ...OPEN, checksStatus: "success" }));
    expect(passed?.label).toBe("#42 open · checks ✓");
    expect(passed?.tone).toBe("accent");
  });

  it("appends the review decision", () => {
    expect(prChipModel(payload({ ...OPEN, reviewDecision: "approved" }))?.label).toBe(
      "#42 open · approved",
    );
    expect(prChipModel(payload({ ...OPEN, reviewDecision: "changes_requested" }))?.label).toBe(
      "#42 open · changes",
    );
  });
});
