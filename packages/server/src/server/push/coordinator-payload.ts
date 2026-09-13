import type { PushPayload } from "./push-service.js";

// Leave 1 KiB for the Expo token, sound/category/channel fields and platform envelope.
const COORDINATOR_PAYLOAD_LIMIT_BYTES = 3072;
const MORE_IN_COORDINATOR = "More in Coordinator";
const OPEN_CATEGORY = "paseo.coordinator.open";

function encodedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function fitText(text: string, fits: (candidate: string) => boolean, suffix: string): string {
  if (fits(text)) return text;
  const characters = Array.from(text);
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(characters.slice(0, middle).join("") + suffix)) low = middle;
    else high = middle - 1;
  }
  return characters.slice(0, low).join("") + suffix;
}

/** Bound only the push copy. Full decision responses and digest remain on the board. */
export function boundCoordinatorPushPayload(payload: PushPayload): PushPayload {
  if (encodedBytes(payload) <= COORDINATOR_PAYLOAD_LIMIT_BYTES) return payload;
  let omittedContent = false;
  let bounded: PushPayload = {
    ...payload,
    title: fitText(payload.title, (text) => encodedBytes(text) <= 256, "…"),
    body: MORE_IN_COORDINATOR,
  };
  omittedContent = bounded.title !== payload.title;
  if (encodedBytes(bounded) > COORDINATOR_PAYLOAD_LIMIT_BYTES) {
    // Never partially transmit a response: a truncated input could authorize a different action.
    omittedContent = true;
    const { actions: _actions, ...data } = bounded.data ?? {};
    bounded = {
      ...bounded,
      categoryId: OPEN_CATEGORY,
      data: { ...data, categoryIdentifier: OPEN_CATEGORY },
    };
  }
  if (encodedBytes(bounded) > COORDINATOR_PAYLOAD_LIMIT_BYTES) {
    // Routing IDs are opaque. If one is oversized, open the app without altering its identity.
    bounded = { title: "Coordinator", body: MORE_IN_COORDINATOR, categoryId: OPEN_CATEGORY };
  }
  const base = bounded;
  const bodyText = omittedContent ? `${payload.body}\n${MORE_IN_COORDINATOR}` : payload.body;
  const body = fitText(
    bodyText,
    (text) => encodedBytes({ ...base, body: text }) <= COORDINATOR_PAYLOAD_LIMIT_BYTES,
    `\n${MORE_IN_COORDINATOR}`,
  );
  return { ...bounded, body };
}
