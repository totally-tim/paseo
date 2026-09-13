import type {
  CoordinatorBoardSnapshot,
  CoordinatorDecisionBoardRow,
} from "@getpaseo/protocol/messages";
import type { ChangeRequestSnapshot } from "./change-request-poll.js";

const DAY = 24 * 60 * 60_000;
function short(text: string): string {
  return text.split("\n")[0]!.slice(0, 160);
}
function proposal(row: CoordinatorDecisionBoardRow): boolean {
  if (row.setupProjectId) return true;
  const labels = new Set(row.actions.map((action) => action.label.toLowerCase()));
  return labels.has("approve") && labels.has("edit") && labels.has("ignore");
}
function projectNote(
  board: CoordinatorBoardSnapshot,
  snapshot: ChangeRequestSnapshot | null,
  now: number,
): string {
  const lines = [`${board.projectName ?? board.projectId}:`];
  if (!snapshot) lines.push("Change-request watch has no snapshot yet.");
  else {
    const count = snapshot.entries.length;
    lines.push(
      `${snapshot.truncated ? "At least " : ""}${count} open change request${count === 1 ? "" : "s"}${snapshot.truncated ? " (listing capped)" : ""}.`,
    );
    const listed = snapshot.entries
      .slice()
      .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt))
      .slice(0, 4);
    for (const entry of listed) {
      const facts: string[] = [];
      if (entry.checksStatus && entry.checksStatus !== "none")
        facts.push(`checks ${entry.checksStatus}`);
      const days = Math.floor((now - Date.parse(entry.updatedAt)) / DAY);
      if (days >= 3) facts.push(`unchanged ${days}d`);
      lines.push(
        `#${entry.number} ${short(entry.title)}${facts.length ? ` — ${facts.join(", ")}` : ""}.`,
      );
    }
    if (count > listed.length) lines.push(`${count - listed.length} more in the watch.`);
    lines.push(
      `Last observed ${snapshot.fetchedAt}${now - Date.parse(snapshot.fetchedAt) > DAY ? "; cached data" : ""}.`,
    );
  }
  const recent = board.done.filter(
    (row) => Date.parse(row.at) >= now - DAY && Date.parse(row.at) <= now,
  );
  if (recent.length) {
    // Preserve the recorded wording: a vanished open request is not evidence of a merge.
    const outcomes = recent
      .slice()
      .sort((a, b) => Number(/opened|merged/i.test(b.text)) - Number(/opened|merged/i.test(a.text)))
      .slice(0, 3);
    lines.push(`Reported in the last 24h: ${outcomes.map((row) => short(row.text)).join("; ")}.`);
  }
  return lines.join(" ");
}

/** M6 will supply goal-run facts; absent goal history never becomes a fabricated zero. */
export function formatCoordinatorDigest(
  boards: CoordinatorBoardSnapshot[],
  snapshots: ReadonlyMap<string, ChangeRequestSnapshot | null>,
  now: number,
): string {
  const pending = boards.flatMap((board) => board.needsYou);
  const proposals = pending.filter(proposal).length;
  const working = boards.reduce((sum, board) => sum + board.working.length, 0);
  const lead = `${pending.length} item${pending.length === 1 ? " needs" : "s need"} you (${proposals} proposal${proposals === 1 ? "" : "s"}); ${working} session${working === 1 ? "" : "s"} working.`;
  const projects = boards.filter((board) => board.tier !== "global");
  return [
    lead,
    ...projects.map((board) => projectNote(board, snapshots.get(board.projectId) ?? null, now)),
  ].join("\n");
}
