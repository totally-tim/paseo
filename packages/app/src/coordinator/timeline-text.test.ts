import { describe, expect, it } from "vitest";
import type { AssistantMessageItem, StreamItem, ThoughtItem } from "@/types/stream";
import { firstLine, lastAssistantLine } from "./timeline-text";

function assistant(
  text: string,
  id = `msg-${Math.random().toString(36).slice(2)}`,
): AssistantMessageItem {
  return { kind: "assistant_message", id, text, timestamp: new Date() };
}

function thought(text: string): ThoughtItem {
  return { kind: "thought", id: "thought-1", text, timestamp: new Date(), status: "ready" };
}

describe("firstLine", () => {
  it("returns the first non-empty line", () => {
    expect(firstLine("hello\nworld")).toBe("hello");
  });

  it("skips blank lines, rules, and heading markers", () => {
    expect(firstLine("\n\n---\n# Heading\nactual answer")).toBe("Heading");
  });

  it("skips fence markers but keeps their contents", () => {
    expect(firstLine("```ts\nconst a = 1\n```")).toBe("const a = 1");
  });

  it("flattens inline markdown", () => {
    expect(firstLine("**bold** `code` [link](https://example.com)")).toBe("bold code link");
  });

  it("strips list and quote markers", () => {
    expect(firstLine("- item")).toBe("item");
    expect(firstLine("> quoted")).toBe("quoted");
  });

  it("skips image-only lines", () => {
    expect(firstLine("![shot](https://example.com/x.png)\nnext")).toBe("next");
  });

  it("truncates beyond the cap with an ellipsis", () => {
    const long = "x".repeat(200);
    expect(firstLine(long, 160)).toBe(`${"x".repeat(159)}…`);
  });

  it("returns an empty string for structural-only content", () => {
    expect(firstLine("```\n```\n---")).toBe("");
    expect(firstLine("")).toBe("");
  });
});

describe("lastAssistantLine", () => {
  it("returns the newest assistant message's first line", () => {
    const items: StreamItem[] = [assistant("older reply"), assistant("newest reply\nwith detail")];
    expect(lastAssistantLine(items)).toBe("newest reply");
  });

  it("skips non-assistant items", () => {
    const items: StreamItem[] = [assistant("the reply"), thought("thinking")];
    expect(lastAssistantLine(items)).toBe("the reply");
  });

  it("walks past assistant messages whose first line is empty", () => {
    const items: StreamItem[] = [assistant("usable"), assistant("```\n```")];
    expect(lastAssistantLine(items)).toBe("usable");
  });

  it("returns null when no assistant message has content", () => {
    expect(lastAssistantLine([])).toBeNull();
    expect(lastAssistantLine([thought("only thinking")])).toBeNull();
  });
});
