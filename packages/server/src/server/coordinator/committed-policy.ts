import { runGitCommand } from "../../utils/run-git-command.js";

/** Transport failure is not evidence that a readable committed policy is invalid. */
export class MergePolicyUnavailableError extends Error {}
const options = (cwd: string) => ({
  cwd,
  timeout: 15000,
  envOverlay: { GIT_TERMINAL_PROMPT: "0" },
});

export async function ensurePolicyCommit(cwd: string, sha: string): Promise<void> {
  if (!/^[a-f0-9]{40,64}$/i.test(sha)) throw new Error("An exact policy commit SHA is required");
  try {
    await runGitCommand(["cat-file", "-e", `${sha}^{commit}`], options(cwd));
    return;
  } catch {
    /* The advertised commit may have advanced beyond this checkout. */
  }
  try {
    // Fetch only the immutable object; leave checkout, branches and FETCH_HEAD alone.
    await runGitCommand(
      ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "origin", sha],
      options(cwd),
    );
    await runGitCommand(["cat-file", "-e", `${sha}^{commit}`], options(cwd));
  } catch (error) {
    throw new MergePolicyUnavailableError(`Cannot fetch committed policy ${sha}: ${String(error)}`);
  }
}

export async function resolveCommittedPolicyBase(
  cwd: string,
): Promise<{ cwd: string; baseSha: string }> {
  // A repository with no origin is a definitive configuration problem, not an outage.
  await runGitCommand(["remote", "get-url", "origin"], options(cwd));
  let stdout: string;
  try {
    ({ stdout } = await runGitCommand(["ls-remote", "--symref", "origin", "HEAD"], options(cwd)));
  } catch (error) {
    throw new MergePolicyUnavailableError(
      `Origin policy lookup is temporarily unavailable: ${String(error)}`,
    );
  }
  if (!/^ref: refs\/heads\/[^\s]+\s+HEAD$/m.test(stdout))
    throw new Error("Origin did not identify its default branch");
  const baseSha = /^([a-f0-9]{40,64})\s+HEAD$/im.exec(stdout)?.[1];
  if (!baseSha) throw new Error("Origin did not advertise its default branch commit");
  await ensurePolicyCommit(cwd, baseSha);
  return { cwd, baseSha };
}
