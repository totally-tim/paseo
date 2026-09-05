import { createHash } from "node:crypto";
import type { AgentQueuedMessageInput, AgentQueueOperation } from "../messages.js";
import type { ContinuationRecord } from "./store.js";

export function messageDigest(message: AgentQueuedMessageInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        text: message.text,
        images: message.images ?? [],
        attachments: message.attachments ?? [],
      }),
    )
    .digest("hex");
}

function messageBytes(message: AgentQueuedMessageInput): number {
  return (
    Buffer.byteLength(JSON.stringify(message)) +
    (message.attachments ?? []).reduce(
      (sum, attachment) => sum + (attachment.type === "uploaded_file" ? attachment.size : 0),
      0,
    )
  );
}
function queueBytes(record: ContinuationRecord): number {
  return record.queue.reduce((sum, item) => sum + messageBytes(item), 0);
}

export function checkQueuedMessage(message: AgentQueuedMessageInput): void {
  if (!message.text.trim() && !message.images?.length && !message.attachments?.length)
    throw new Error("Enter a message or attach a file before queueing it.");
  if (messageBytes(message) > 32 * 1024 * 1024)
    throw new Error("This queued message exceeds the 32 MB attachment limit.");
}

/** Called inside the store transaction; no optimistic acknowledgement precedes it. */
export function updateQueuedMessages(
  record: ContinuationRecord,
  operation: AgentQueueOperation,
  now: string,
  enqueueDigest?: string,
): void {
  if (operation.kind === "enqueue") {
    checkQueuedMessage(operation.message);
    const digest = enqueueDigest ?? messageDigest(operation.message);
    const id = operation.message.id;
    if (Object.hasOwn(record.receipts, id)) {
      if (record.receipts[id].digest !== digest)
        throw new Error("This message ID was already used for different content.");
      return;
    }
    if (record.queue.length >= 100) throw new Error("This task already has 100 queued messages.");
    if (queueBytes(record) + messageBytes(operation.message) > 64 * 1024 * 1024)
      throw new Error(
        "This task's queued attachments exceed 64 MB. Send or remove a queued message first.",
      );
    record.queue.push({ ...operation.message, status: "queued", revision: 1, createdAt: now });
    record.receipts = { ...record.receipts, [id]: { digest, outcome: "queued" } };
    return;
  }
  const id = operation.kind === "edit" ? operation.message.id : operation.messageId;
  const item = record.queue.find((entry) => entry.id === id);
  if (!item) {
    if (
      operation.kind === "cancel" &&
      Object.hasOwn(record.receipts, id) &&
      record.receipts[id].outcome === "cancelled"
    )
      return;
    throw new Error("This message is no longer queued. Refresh the conversation.");
  }
  if (item.status === "dispatching")
    throw new Error("This message is being sent and cannot be changed.");
  if (operation.kind === "cancel") {
    record.queue = record.queue.filter((entry) => entry.id !== id);
    record.receipts[id].outcome = "cancelled";
    return;
  }
  if (item.status === "attention")
    throw new Error(
      "Delivery is uncertain. Inspect the conversation, then remove this queue item before sending it again.",
    );
  if (operation.kind === "edit") {
    if (item.revision !== operation.revision)
      throw new Error("This queued message changed on another client. Refresh it before editing.");
    checkQueuedMessage(operation.message);
    Object.assign(item, operation.message, { revision: item.revision + 1 });
    if (queueBytes(record) > 64 * 1024 * 1024)
      throw new Error("This task's queued attachments exceed 64 MB.");
  }
}
