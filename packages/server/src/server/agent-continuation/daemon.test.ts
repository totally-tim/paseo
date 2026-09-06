import { expect, test, vi } from "vitest";
import { createContinuationTestDaemon } from "../test-utils/continuation-daemon.js";

test("two RPC clients see one retained queue across capacity switching and daemon restart", async () => {
  const f = await createContinuationTestDaemon();
  try {
    const second = await f.connect();
    expect(f.client.getLastServerInfoMessage()?.features?.agentContinuation).toBe(true);
    const source = await f.start();
    await vi.waitFor(() => expect(f.starts).toHaveLength(1));
    const message = {
      id: "shared-instruction",
      text: "Then check the tests",
      images: [{ data: "aGVsbG8=", mimeType: "image/png" }],
    };
    const [ack, retry] = await Promise.all([
      f.client.manageAgentQueue(source.id, { kind: "enqueue", message }),
      second.manageAgentQueue(source.id, { kind: "enqueue", message }),
    ]);
    expect(ack.error).toBeNull();
    expect(retry.error).toBeNull();
    expect(ack.snapshot?.queuedMessages).toHaveLength(1);
    f.capacity(f.a);
    await vi.waitFor(
      async () => {
        const current = (await second.inspectAgentContinuation(source.id)).snapshot;
        expect(current?.agentId, JSON.stringify(current)).not.toBe(source.id);
        expect(f.starts).toHaveLength(2);
      },
      { timeout: 10_000 },
    );
    const successor = (await second.inspectAgentContinuation(source.id)).snapshot!.agentId;
    expect(f.starts[1].text).not.toContain(message.text);
    expect(f.starts[1].text).toContain("Investigate the project and report your findings.");
    f.capacity(f.b);
    await vi.waitFor(
      async () =>
        expect(
          (await second.inspectAgentContinuation(source.id)).snapshot?.continuation?.status,
        ).toBe("waiting"),
      { timeout: 10_000 },
    );
    const edited = await second.manageAgentQueue(successor, {
      kind: "edit",
      revision: 1,
      message: { ...message, text: "Edited from the second client" },
    });
    expect(edited.error).toBeNull();
    await f.restart();
    const reconnected = await f.connect();
    const restored = await reconnected.inspectAgentContinuation(source.id);
    expect(restored.snapshot).toMatchObject({
      agentId: successor,
      continuation: { status: "waiting" },
      queuedMessages: [
        { text: "Edited from the second client", revision: 2, images: message.images },
      ],
    });
    const staleEdit = await reconnected.manageAgentQueue(successor, {
      kind: "edit",
      revision: 1,
      message,
    });
    expect(staleEdit.error).toContain("another client");
    await reconnected.cancelAgentContinuation(successor);
    expect(
      (await reconnected.inspectAgentContinuation(source.id)).snapshot?.continuation?.status,
    ).toBe("cancelled");
    const removed = await reconnected.manageAgentQueue(successor, {
      kind: "cancel",
      messageId: message.id,
    });
    expect(removed.snapshot?.queuedMessages).toEqual([]);
    expect(f.starts).toHaveLength(2);
  } finally {
    await f.close();
  }
}, 40_000);
