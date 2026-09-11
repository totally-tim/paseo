import { describe, expect, it } from "vitest";
import { newestActivity } from "./card";
import { quietText } from "./lanes";
import type { TimelineEntry } from "./types";

describe("newestActivity", () => {
  it("describes the newest row by timestamp, not the last one in the page, and is in-flight when that row is a running tool call", () => {
    const entries = [
      {
        seqStart: 5,
        seqEnd: 5,
        timestamp: "2026-01-01T00:05:00.000Z",
        item: {
          type: "tool_call",
          name: "Bash",
          status: "running",
          callId: "c",
          detail: { type: "generic" },
        },
      },
      {
        seqStart: 1,
        seqEnd: 1,
        timestamp: "2026-01-01T00:00:00.000Z",
        item: { type: "assistant_message", text: "earlier result" },
      },
    ] as unknown as TimelineEntry[];

    const activity = newestActivity(entries);
    expect(activity).toEqual({
      text: "Bash",
      lastAt: "2026-01-01T00:05:00.000Z",
      inFlight: true,
    });
    // The running tool call anchors the newest row, so the card must not read quiet.
    expect(
      quietText(activity.lastAt, activity.inFlight, Date.parse("2026-01-01T00:10:00.000Z")),
    ).toBeNull();
  });

  it("is not in-flight when a stale running tool call sits earlier than a newer assistant message", () => {
    const entries = [
      {
        seqStart: 1,
        seqEnd: 1,
        timestamp: "2026-01-01T00:00:00.000Z",
        item: {
          type: "tool_call",
          name: "Bash",
          status: "running",
          callId: "c",
          detail: { type: "generic" },
        },
      },
      {
        seqStart: 2,
        seqEnd: 2,
        timestamp: "2026-01-01T00:05:00.000Z",
        item: { type: "assistant_message", text: "second" },
      },
    ] as unknown as TimelineEntry[];

    // The stale running tool call must not suppress "quiet" forever now that a
    // newer, non-in-flight row has landed.
    expect(newestActivity(entries)).toEqual({
      text: "second",
      lastAt: "2026-01-01T00:05:00.000Z",
      inFlight: false,
    });
  });

  it("returns nulls and false for an empty page", () => {
    expect(newestActivity([])).toEqual({ text: null, lastAt: null, inFlight: false });
  });

  it("reads lastAt as null when the newest entry's timestamp is unparsable", () => {
    // An unparsable timestamp must not anchor the quiet clock on epoch.
    const entries = [
      {
        seqStart: 1,
        seqEnd: 1,
        timestamp: "not-a-date",
        item: { type: "assistant_message", text: "hello" },
      },
    ] as unknown as TimelineEntry[];
    expect(newestActivity(entries)).toEqual({ text: "hello", lastAt: null, inFlight: false });
  });
});
