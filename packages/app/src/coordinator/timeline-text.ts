import type { StreamItem } from "@/types/stream";

/**
 * First human-readable line of a markdown-ish blob: skips images, rules,
 * fences, and headings, then flattens the inline markup that survives. Used for
 * the board's one-line reply and peek rows — same contract as the inbox
 * plugin's `firstLine`, against app `StreamItem`s.
 */
export function firstLine(text: string, max = 160): string {
  const line = text
    .split("\n")
    .map((part) => part.trim())
    .filter((part) => !/^!\[[^\]]*\]\([^)]*\)$/.test(part))
    .filter(
      (part) => !/^(?:([-*_])(?:\s*\1){2,}|[=~-]{2,}|`{3,}[^`]*|~{3,}[^~]*|#+\s*)$/.test(part),
    )
    .map((part) => part.replace(/^#{1,6}\s+/, "").replace(/^>\s*/, ""))
    .find((part) => part.length > 0);
  if (!line) return "";
  const plain = line
    .replace(/^[-*+]\s+/, "")
    .replace(/\[([^\]]+)\]\(https?:\/\/[^\s)]+\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}

/** The coordinator's latest reply, for the board's reply area. */
export function lastAssistantLine(items: readonly StreamItem[]): string | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.kind === "assistant_message") {
      const line = firstLine(item.text);
      if (line) return line;
    }
  }
  return null;
}
