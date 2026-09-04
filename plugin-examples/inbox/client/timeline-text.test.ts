import { describe, expect, it } from "vitest";
import { firstLine, itemToPeekRow, lastAssistantLine } from "./timeline-text";
import type { TimelineItem } from "./types";

describe("timeline text", () => {
  it("takes the first non-empty line and truncates", () => {
    expect(firstLine("\n\n  Hello world  \nmore")).toBe("Hello world");
    expect(firstLine("x".repeat(200), 10)).toBe(`${"x".repeat(9)}…`);
  });

  it("skips Markdown dividers and fences before a meaningful preview", () => {
    expect(firstLine("\n---\n\nPERMISSION-DONE")).toBe("PERMISSION-DONE");
    expect(firstLine("* * *\n## Result")).toBe("Result");
    expect(firstLine("```sh\nprintf ok\n```")).toBe("printf ok");
    expect(firstLine("---\n___\n***")).toBe("");
  });

  it("maps rows to peek text and skips rows the peek does not show", () => {
    expect(itemToPeekRow({ type: "user_message", text: "hi" } as TimelineItem)).toEqual({
      role: "you",
      text: "hi",
    });
    expect(
      itemToPeekRow({
        type: "tool_call",
        name: "Bash",
        status: "running",
        callId: "c",
        detail: { type: "generic" },
      } as unknown as TimelineItem),
    ).toEqual({ role: "tool", text: "Bash…" });
    expect(itemToPeekRow({ type: "turn_started" } as unknown as TimelineItem)).toBeNull();
  });

  it("finds the last assistant line", () => {
    const items = [
      { type: "assistant_message", text: "first" },
      {
        type: "tool_call",
        name: "Read",
        status: "completed",
        callId: "c",
        detail: { type: "generic" },
      },
      { type: "assistant_message", text: "\nlast line\ndetail" },
    ] as unknown as TimelineItem[];
    expect(lastAssistantLine(items)).toBe("last line");
    expect(lastAssistantLine([])).toBeNull();
  });
});
