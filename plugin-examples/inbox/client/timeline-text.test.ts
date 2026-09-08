import { describe, expect, it } from "vitest";
import { firstLine, itemToPeekRow, lastAssistantLine, latestActivity } from "./timeline-text";
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

  it("makes linked, formatted results readable without changing code identifiers", () => {
    expect(
      firstLine("**PR [#544](https://example.com/pull/544)** is ready. `build_app` passed."),
    ).toBe("PR #544 is ready. build_app passed.");
    expect(firstLine("- **Done**: fixed `some_value`.")).toBe("Done: fixed some_value.");
  });

  it("skips image-only updates when choosing a readable activity preview", () => {
    expect(
      lastAssistantLine([
        { type: "assistant_message", text: "Checking the updated board." },
        { type: "assistant_message", text: "![Image](file:///tmp/capture.png)" },
      ] as TimelineItem[]),
    ).toBe("Checking the updated board.");
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

it("chooses readable activity in timeline order", () => {
  const assistant = { type: "assistant_message", text: "Checking files" } as TimelineItem;
  const tool = {
    type: "tool_call",
    name: "Bash",
    status: "running",
    callId: "call",
    detail: { type: "shell", command: "npm run lint" },
  } as TimelineItem;
  const image = {
    type: "assistant_message",
    text: "![Image](file:///tmp/image.png)",
  } as TimelineItem;
  expect(latestActivity([assistant, tool])).toBe("Bash: npm run lint");
  expect(latestActivity([tool, assistant])).toBe("Checking files");
  expect(latestActivity([assistant, tool, image])).toBe("Bash: npm run lint");
  expect(latestActivity([image])).toBeNull();
});
