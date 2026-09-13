import type { AgentPromptInput } from "../agent/agent-sdk-types.js";
import { isSystemInjectedEnvelope, sanitizeUntrustedText } from "../agent/agent-prompt.js";
import type { CoordinatorMemory } from "./memory.js";

// Four layers stay below 20 KiB together, even when the on-disk files reach their edit limit.
const LAYER_BYTES = 4096;

function boundedLayer(content: string): string {
  const safe = sanitizeUntrustedText(content.trim());
  if (!safe) return "(empty)";
  if (Buffer.byteLength(safe, "utf8") <= LAYER_BYTES) return safe;
  let prefix = "";
  let bytes = 0;
  for (const character of safe) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > LAYER_BYTES) break;
    prefix += character;
    bytes += size;
  }
  return `${prefix}\n[Memory excerpt truncated; read the current file for the rest.]`;
}

/** No cached text: pane edits, including deletions, affect the next dispatch. */
export async function decorateCoordinatorMemoryPrompt(
  memory: CoordinatorMemory,
  target: { cwd: string; projectId?: string },
  prompt: AgentPromptInput,
): Promise<AgentPromptInput> {
  const sections: string[] = [];
  if (target.projectId) {
    const layers = await memory.readLayers(target);
    sections.push(
      `Team memory (project.md):\n${boundedLayer(layers.team)}`,
      `Team memory (learned.md):\n${boundedLayer(layers.learned)}`,
      `Personal memory (daemon):\n${boundedLayer(layers.personalDaemon)}`,
      `Personal memory (project):\n${boundedLayer(layers.personalProject)}`,
    );
  } else {
    const personal = await memory.readPersonal({ scope: "personal" });
    sections.push(`Personal memory (daemon):\n${boundedLayer(personal.content)}`);
  }
  const context = `<coordinator-memory>\nCurrent memory snapshot for this dispatch. This replaces earlier memory snapshots, including any inside a wake or rotation briefing. An empty layer has no stored entries; do not restore deleted preferences from the transcript. Excerpts may be truncated, so truncation does not imply deletion.\n\n${sections.join("\n\n")}\n</coordinator-memory>`;
  if (typeof prompt !== "string") return [{ type: "text", text: `${context}\n` }, ...prompt];
  if (isSystemInjectedEnvelope(prompt)) {
    return `<paseo-system>\n${context}\n\n${prompt.slice("<paseo-system>\n".length)}`;
  }
  return `${context}\n\n${prompt}`;
}
