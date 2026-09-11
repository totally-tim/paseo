import type { PluginLifecycle } from "../../plugins/lifecycle/index.js";
import { describeHookWorkspace } from "../../plugins/lifecycle/index.js";
import { basename, resolve } from "node:path";
import type { Logger } from "pino";
import {
  generateWorkspaceId,
  initialWorkspacePlacement,
  reconcileWorkspacePlacement,
} from "../../workspace-registry-model.js";
import {
  createPersistedWorkspaceRecord,
  type PersistedProjectRecord,
  type PersistedWorkspaceRecord,
  type ProjectRegistry,
  type WorkspaceRegistry,
} from "../../workspace-registry.js";
import type { WorkspaceGitService } from "../../workspace-git-service.js";
import type { CreatePaseoWorktreeWorkflowResult } from "../../worktree-session.js";
import { deriveProjectKey } from "../../project-key.js";
import { areEquivalentPaths, createRealpathAwarePathMatcher } from "../../../utils/path.js";
import type { UntrustedWorkspaceSource } from "../../workspace-automation-gate.js";

export interface ResolveOrCreateWorkspaceIdInput {
  createdWorktree: CreatePaseoWorktreeWorkflowResult | null;
  requestedWorkspaceId?: string;
  cwd: string;
  initialTitle: string | null;
}

export interface CreateAgentWorkspacePlacement {
  workspaceId: string;
  // True only when this call minted the workspace; a reused record keeps its
  // own title and is not auto-named from the new agent's prompt.
  createdWorkspace: boolean;
}

export interface ImportWorkspaceInput {
  cwd: string;
  requestedWorkspaceId?: string;
}

export interface ImportWorkspaceResult<T> {
  value: T;
  createdWorkspace: PersistedWorkspaceRecord | null;
}

export interface CreateWorktreeWorkspaceInput {
  sourceCwd: string;
  projectId?: string;
  repoRoot: string;
  cwd: string;
  worktreeRoot: string;
  branch: string | null;
  baseBranch: string | null;
  title: string | null;
  expectsInitialAgent?: boolean;
  untrustedSource?: UntrustedWorkspaceSource;
}

export interface WorkspaceProvisioningService {
  runInImportWorkspace<T>(
    input: ImportWorkspaceInput,
    operation: (workspace: PersistedWorkspaceRecord) => Promise<T>,
  ): Promise<ImportWorkspaceResult<T>>;
  findOrCreateWorkspaceForDirectory(cwd: string): Promise<PersistedWorkspaceRecord>;
  resolveOrCreateWorkspaceIdForCreateAgent(
    input: ResolveOrCreateWorkspaceIdInput,
  ): Promise<CreateAgentWorkspacePlacement>;
  openWorkspaceForDirectory(
    cwd: string,
    title?: string | null,
    projectId?: string,
    context?: { expectsInitialAgent?: boolean },
  ): Promise<{ workspace: PersistedWorkspaceRecord; created: boolean }>;
  createWorkspaceForDirectory(
    cwd: string,
    title?: string | null,
    projectId?: string,
    context?: { expectsInitialAgent?: boolean },
  ): Promise<PersistedWorkspaceRecord>;
  createWorkspaceForWorktree(
    input: CreateWorktreeWorkspaceInput,
  ): Promise<PersistedWorkspaceRecord>;
  findOrCreateProjectForDirectory(cwd: string): Promise<PersistedProjectRecord>;
  ensureWorkspaceRecordUnarchived(
    workspace: PersistedWorkspaceRecord,
  ): Promise<PersistedWorkspaceRecord>;
}

type WorkspaceCheckout = Awaited<ReturnType<WorkspaceGitService["getCheckout"]>>;

export type WorkspaceProvisioningErrorCode = "unknown_project" | "archived_project";

export class WorkspaceProvisioningError extends Error {
  constructor(
    readonly code: WorkspaceProvisioningErrorCode,
    projectId: string,
  ) {
    super(
      code === "unknown_project"
        ? `Unknown project: ${projectId}`
        : `Archived project: ${projectId}`,
    );
    this.name = "WorkspaceProvisioningError";
  }
}

export function createWorkspaceProvisioningService(deps: {
  serverId?: string;
  workspaceRegistry: WorkspaceRegistry;
  projectRegistry: ProjectRegistry;
  workspaceGitService: Pick<WorkspaceGitService, "getCheckout" | "getSnapshot" | "peekSnapshot">;
  logger: Logger;
  lifecycle?: PluginLifecycle;
}): WorkspaceProvisioningService {
  const { serverId, workspaceRegistry, projectRegistry, workspaceGitService, logger } = deps;

  async function runInImportWorkspace<T>(
    input: ImportWorkspaceInput,
    operation: (workspace: PersistedWorkspaceRecord) => Promise<T>,
  ): Promise<ImportWorkspaceResult<T>> {
    if (input.requestedWorkspaceId) {
      const workspace = await workspaceRegistry.get(input.requestedWorkspaceId);
      if (!workspace || workspace.archivedAt) {
        throw new Error(`Workspace not found: ${input.requestedWorkspaceId}`);
      }
      const project = await projectRegistry.get(workspace.projectId);
      if (!project || project.archivedAt) {
        throw new Error(`Project not found: ${workspace.projectId}`);
      }
      if (!createRealpathAwarePathMatcher(workspace.cwd)(input.cwd)) {
        throw new Error(`Import cwd does not match workspace: ${workspace.workspaceId}`);
      }
      return {
        value: await operation(workspace),
        createdWorkspace: null,
      };
    }

    const [projectsBeforeImport, workspacesBeforeImport] = await Promise.all([
      projectRegistry.list(),
      workspaceRegistry.list(),
    ]);
    const workspace = await findOrCreateWorkspaceForDirectory(input.cwd);
    const createdWorkspace = workspacesBeforeImport.some(
      (candidate) => candidate.workspaceId === workspace.workspaceId,
    )
      ? null
      : workspace;
    const previousProject =
      projectsBeforeImport.find((project) => project.projectId === workspace.projectId) ?? null;

    try {
      return {
        value: await operation(workspace),
        createdWorkspace,
      };
    } catch (error) {
      if (createdWorkspace) {
        await rollbackFailedImportWorkspace(createdWorkspace, previousProject);
      }
      throw error;
    }
  }

  async function rollbackFailedImportWorkspace(
    workspace: PersistedWorkspaceRecord,
    previousProject: PersistedProjectRecord | null,
  ): Promise<void> {
    try {
      await workspaceRegistry.remove(workspace.workspaceId);
      const projectHasActiveWorkspace = (await workspaceRegistry.list()).some(
        (candidate) => candidate.projectId === workspace.projectId && !candidate.archivedAt,
      );
      if (projectHasActiveWorkspace) {
        return;
      }
      if (previousProject?.archivedAt) {
        await projectRegistry.upsert(previousProject);
      } else if (!previousProject) {
        await projectRegistry.remove(workspace.projectId);
      }
    } catch (error) {
      logger.error(
        { err: error, workspaceId: workspace.workspaceId, projectId: workspace.projectId },
        "Failed to restore workspace state after provider import failure",
      );
    }
  }

  async function findOrCreateProjectForDirectory(cwd: string): Promise<PersistedProjectRecord> {
    const rootPath = resolve(cwd);
    const checkout = await workspaceGitService.getCheckout(rootPath);
    if (isPaseoWorktreeCheckout(checkout)) {
      return resolveProjectForPaseoWorktree(checkout);
    }
    const timestamp = new Date().toISOString();
    return projectRegistry.getOrCreateActiveByRoot({
      rootPath,
      kind: checkout.isGit ? "git" : "non_git",
      displayName: basename(rootPath) || rootPath,
      projectKey: deriveProjectKey({
        rootPath,
        remoteUrl: checkout.remoteUrl,
        worktreeRoot: checkout.worktreeRoot,
        mainRepoRoot: checkout.mainRepoRoot,
        serverId,
      }),
      timestamp,
    });
  }

  async function requireActiveProject(projectId: string): Promise<PersistedProjectRecord> {
    const project = await projectRegistry.get(projectId);
    if (!project) throw new WorkspaceProvisioningError("unknown_project", projectId);
    if (project.archivedAt) throw new WorkspaceProvisioningError("archived_project", projectId);
    return project;
  }

  // Always mints. Scheduled runs and Hub creates rely on owning the record they
  // get back, because they archive it when the run finishes.
  async function createWorkspaceForDirectory(
    cwd: string,
    title?: string | null,
    projectId?: string,
    context?: { expectsInitialAgent?: boolean },
  ): Promise<PersistedWorkspaceRecord> {
    const normalizedCwd = resolve(cwd);
    const checkout = await workspaceGitService.getCheckout(normalizedCwd);
    return mintWorkspaceForDirectory(normalizedCwd, checkout, title, projectId, context);
  }

  // A user-facing directory open (workspace.create with a directory source,
  // which is also what a bare `paseo run` sends first). A Paseo-owned worktree
  // reopens as the workspace that already has that exact cwd; an ordinary
  // directory always gets a fresh record so two workspaces may share one cwd.
  async function openWorkspaceForDirectory(
    cwd: string,
    title?: string | null,
    projectId?: string,
    context?: { expectsInitialAgent?: boolean },
  ): Promise<{ workspace: PersistedWorkspaceRecord; created: boolean }> {
    const normalizedCwd = resolve(cwd);
    if (projectId) await requireActiveProject(projectId);
    const checkout = await workspaceGitService.getCheckout(normalizedCwd);
    const owner = await findPaseoWorktreeOwner(normalizedCwd, checkout);
    // A request that names a different project is honored as a fresh record
    // rather than silently rehomed onto the owner.
    if (owner && (!projectId || owner.projectId === projectId)) {
      return { workspace: owner, created: false };
    }
    return {
      workspace: await mintWorkspaceForDirectory(
        normalizedCwd,
        checkout,
        title,
        projectId,
        context,
      ),
      created: true,
    };
  }

  // The workspace that already runs at this exact cwd, only inside a
  // Paseo-owned worktree. Ordinary directories never reuse: scheduled runs and
  // Hub creates mint throwaway records at arbitrary cwds and archive them, with
  // every agent inside, when the run ends, so a bare create must not join one.
  async function findPaseoWorktreeOwner(
    normalizedCwd: string,
    checkout: WorkspaceCheckout,
  ): Promise<PersistedWorkspaceRecord | null> {
    if (!isPaseoWorktreeCheckout(checkout)) return null;
    return findWorkspaceForDirectory(normalizedCwd);
  }

  async function mintWorkspaceForDirectory(
    normalizedCwd: string,
    checkout: WorkspaceCheckout,
    title: string | null | undefined,
    projectId: string | undefined,
    context: { expectsInitialAgent?: boolean } | undefined,
  ): Promise<PersistedWorkspaceRecord> {
    const project = projectId
      ? await refreshProjectKind(await requireActiveProject(projectId), normalizedCwd, checkout)
      : // COMPAT(workspaceCreateMissingProjectId): added in v0.1.107, remove after 2027-01-15.
        await findOrCreateProjectForDirectory(normalizedCwd);
    const timestamp = new Date().toISOString();
    const workspace = createPersistedWorkspaceRecord({
      workspaceId: generateWorkspaceId(),
      projectId: project.projectId,
      ...initialWorkspacePlacement({ source: "checkout", cwd: normalizedCwd, checkout }),
      title: title?.trim() || null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await workspaceRegistry.upsert(workspace, context);
    deps.lifecycle?.emit("workspace.created", { workspace: describeHookWorkspace(workspace) });
    return workspace;
  }

  async function createWorkspaceForWorktree(
    input: CreateWorktreeWorkspaceInput,
  ): Promise<PersistedWorkspaceRecord> {
    const sourceCwd = resolve(input.sourceCwd);
    const repoRoot = resolve(input.repoRoot);
    const cwd = resolve(input.cwd);
    const worktreeRoot = resolve(input.worktreeRoot);
    const project = await resolveSourceProjectForWorktree({
      sourceCwd,
      projectId: input.projectId,
      repoRoot,
    });
    const timestamp = new Date().toISOString();
    const workspace = createPersistedWorkspaceRecord({
      workspaceId: generateWorkspaceId(),
      projectId: project.projectId,
      ...initialWorkspacePlacement({
        source: "created_worktree",
        cwd,
        worktreeRoot,
        branch: input.branch,
        baseBranch: input.baseBranch,
        mainRepoRoot: repoRoot,
      }),
      title: input.title,
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(input.untrustedSource ? { untrustedSource: input.untrustedSource } : {}),
    });
    await workspaceRegistry.upsert(workspace, {
      expectsInitialAgent: input.expectsInitialAgent,
    });
    deps.lifecycle?.emit("workspace.created", { workspace: describeHookWorkspace(workspace) });
    return workspace;
  }

  async function resolveSourceProjectForWorktree(input: {
    sourceCwd: string;
    projectId?: string;
    repoRoot: string;
  }): Promise<PersistedProjectRecord> {
    if (input.projectId) {
      return refreshProjectKind(await requireActiveProject(input.projectId));
    }

    const workspaces = await workspaceRegistry.list();
    const sourceWorkspace =
      workspaces.find(
        (workspace) => !workspace.archivedAt && areEquivalentPaths(workspace.cwd, input.sourceCwd),
      ) ??
      workspaces.find(
        (workspace) => !workspace.archivedAt && areEquivalentPaths(workspace.cwd, input.repoRoot),
      );
    if (sourceWorkspace) {
      const project = await projectRegistry.get(sourceWorkspace.projectId);
      if (project) return refreshProjectKind(project);
      // COMPAT(worktreeMissingSourceProject): added in v0.1.107, remove after 2027-01-15.
      // Orphaned legacy workspace FKs fall through to exact-root allocation.
    }

    return allocateProjectForRepoRoot(input.repoRoot);
  }

  async function allocateProjectForRepoRoot(repoRoot: string): Promise<PersistedProjectRecord> {
    // Git reports the main checkout as a realpath while the selected project
    // root keeps the user's spelling; exact-root allocation is string-only, so
    // look for a filesystem-equivalent active project before minting one.
    const matchesRepoRoot = createRealpathAwarePathMatcher(repoRoot);
    const equivalent = (await projectRegistry.list())
      .filter((project) => !project.archivedAt && matchesRepoRoot(project.rootPath))
      .sort(
        (left, right) =>
          Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
          left.projectId.localeCompare(right.projectId),
      )[0];
    if (equivalent) return refreshProjectKind(equivalent);
    const checkout = await workspaceGitService.getCheckout(repoRoot);
    const project = await projectRegistry.getOrCreateActiveByRoot({
      rootPath: repoRoot,
      kind: "git",
      displayName: basename(repoRoot) || repoRoot,
      projectKey: deriveProjectKey({
        rootPath: repoRoot,
        remoteUrl: checkout.remoteUrl,
        worktreeRoot: checkout.worktreeRoot,
        mainRepoRoot: checkout.mainRepoRoot,
        serverId,
      }),
      timestamp: new Date().toISOString(),
    });
    return refreshProjectKind(project);
  }

  // A Paseo-owned worktree is never a project root. The daemon minted the
  // directory for one workspace of the main checkout's project, so a path under
  // the worktrees root resolves to that project instead of allocating a sidebar
  // project named after the worktree slug. Hand-made linked worktrees are not
  // covered: those can legitimately be their own project.
  function isPaseoWorktreeCheckout(
    checkout: WorkspaceCheckout,
  ): checkout is WorkspaceCheckout & { worktreeRoot: string; mainRepoRoot: string } {
    return (
      checkout.isGit &&
      checkout.isPaseoOwnedWorktree &&
      checkout.worktreeRoot !== null &&
      checkout.mainRepoRoot !== null
    );
  }

  async function resolveProjectForPaseoWorktree(checkout: {
    worktreeRoot: string;
    mainRepoRoot: string;
  }): Promise<PersistedProjectRecord> {
    const workspaces = await workspaceRegistry.list();
    const matchesWorktreeRoot = createRealpathAwarePathMatcher(checkout.worktreeRoot);
    const ownsWorktree = (workspace: PersistedWorkspaceRecord) =>
      workspace.worktreeRoot !== null && matchesWorktreeRoot(workspace.worktreeRoot);
    const owner =
      workspaces.find((workspace) => !workspace.archivedAt && ownsWorktree(workspace)) ??
      workspaces.find(ownsWorktree);
    if (owner) {
      const project = await projectRegistry.get(owner.projectId);
      if (project && !project.archivedAt) return refreshProjectKind(project);
    }
    return allocateProjectForRepoRoot(checkout.mainRepoRoot);
  }

  // Exact cwd only, never an enclosing directory: a workspace's cwd is its
  // execution directory, and a subdirectory is a different placement.
  async function findWorkspaceForDirectory(
    normalizedCwd: string,
  ): Promise<PersistedWorkspaceRecord | null> {
    const matchesCwd = createRealpathAwarePathMatcher(normalizedCwd);
    const workspaces = await workspaceRegistry.list();
    const active = workspaces
      .filter((workspace) => !workspace.archivedAt && matchesCwd(workspace.cwd))
      .sort(
        (left, right) =>
          Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
          left.workspaceId.localeCompare(right.workspaceId),
      )[0];
    if (active) return refreshWorkspaceRecord(active);
    const archived = workspaces
      .filter((workspace) => workspace.archivedAt && matchesCwd(workspace.cwd))
      .sort(
        (left, right) =>
          Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
          left.workspaceId.localeCompare(right.workspaceId),
      )[0];
    if (archived) {
      const project = await projectRegistry.get(archived.projectId);
      if (project && !project.archivedAt) return ensureWorkspaceRecordUnarchived(archived);
    }
    return null;
  }

  async function findOrCreateWorkspaceForDirectory(cwd: string): Promise<PersistedWorkspaceRecord> {
    const normalizedCwd = resolve(cwd);
    return (
      (await findWorkspaceForDirectory(normalizedCwd)) ?? createWorkspaceForDirectory(normalizedCwd)
    );
  }

  async function resolveOrCreateWorkspaceIdForCreateAgent(
    input: ResolveOrCreateWorkspaceIdInput,
  ): Promise<CreateAgentWorkspacePlacement> {
    if (input.createdWorktree) {
      return { workspaceId: input.createdWorktree.workspace.workspaceId, createdWorkspace: false };
    }
    if (input.requestedWorkspaceId) {
      return { workspaceId: input.requestedWorkspaceId, createdWorkspace: false };
    }
    // An unaddressed agent create inside a Paseo-owned worktree is a placement
    // question, not a create verb: it lands in the worktree's own workspace.
    const normalizedCwd = resolve(input.cwd);
    const checkout = await workspaceGitService.getCheckout(normalizedCwd);
    const owner = await findPaseoWorktreeOwner(normalizedCwd, checkout);
    if (owner) return { workspaceId: owner.workspaceId, createdWorkspace: false };
    const created = await mintWorkspaceForDirectory(
      normalizedCwd,
      checkout,
      input.initialTitle,
      undefined,
      { expectsInitialAgent: true },
    );
    return { workspaceId: created.workspaceId, createdWorkspace: true };
  }

  async function resolveRestoredAutoArchiveChangeRequestUrl(
    workspace: PersistedWorkspaceRecord,
  ): Promise<string | null> {
    if (!workspace.archivedAt) {
      return workspace.autoArchivedChangeRequestUrl;
    }
    const snapshot = await workspaceGitService.getSnapshot(workspace.cwd, {
      force: true,
      includeForge: true,
      reason: "workspace-restore-auto-archive-latch",
    });
    return snapshot.forge.pullRequest?.isMerged
      ? snapshot.forge.pullRequest.url
      : workspace.autoArchivedChangeRequestUrl;
  }

  async function ensureWorkspaceRecordUnarchived(
    workspace: PersistedWorkspaceRecord,
  ): Promise<PersistedWorkspaceRecord> {
    const project = await projectRegistry.get(workspace.projectId);
    if (!project) throw new Error(`Unknown project: ${workspace.projectId}`);
    const timestamp = new Date().toISOString();
    const checkout =
      workspace.archivedAt || project.archivedAt
        ? await workspaceGitService.getCheckout(workspace.cwd)
        : null;
    const autoArchivedChangeRequestUrl =
      await resolveRestoredAutoArchiveChangeRequestUrl(workspace);
    let next: PersistedWorkspaceRecord | null = null;
    if (workspace.archivedAt && checkout) {
      const placementUpdate = reconcileWorkspacePlacement({
        workspace,
        checkout,
        updatedAt: timestamp,
      });
      next = {
        ...(placementUpdate?.workspace ?? workspace),
        archivedAt: null,
        autoArchivedChangeRequestUrl,
        updatedAt: timestamp,
      };
    }
    if (checkout && (project.archivedAt || workspace.archivedAt)) {
      const projectCheckout = areEquivalentPaths(project.rootPath, workspace.cwd)
        ? checkout
        : await workspaceGitService.getCheckout(project.rootPath);
      const kind = projectCheckout.isGit ? "git" : "non_git";
      const projectKey = deriveProjectKey({
        rootPath: project.rootPath,
        remoteUrl: projectCheckout.remoteUrl,
        worktreeRoot: projectCheckout.worktreeRoot,
        mainRepoRoot: projectCheckout.mainRepoRoot,
        serverId,
      });
      if (project.archivedAt || project.kind !== kind || project.projectKey !== projectKey) {
        await projectRegistry.upsert({
          ...project,
          kind,
          projectKey,
          archivedAt: null,
          updatedAt: timestamp,
        });
      }
    }
    if (!next) return workspace;
    await workspaceRegistry.upsert(next);
    return next;
  }

  async function refreshWorkspaceRecord(
    workspace: PersistedWorkspaceRecord,
  ): Promise<PersistedWorkspaceRecord> {
    const checkout = await workspaceGitService.getCheckout(workspace.cwd);
    const project = await projectRegistry.get(workspace.projectId);
    if (project && !project.archivedAt) {
      await refreshProjectKind(project, workspace.cwd, checkout);
    }
    const update = reconcileWorkspacePlacement({
      workspace,
      checkout,
      updatedAt: new Date().toISOString(),
    });
    if (!update) return workspace;
    await workspaceRegistry.upsert(update.workspace);
    return update.workspace;
  }

  async function refreshProjectKind(
    project: PersistedProjectRecord,
    workspaceCwd?: string,
    workspaceCheckout?: WorkspaceCheckout,
  ): Promise<PersistedProjectRecord> {
    const projectCheckout =
      workspaceCwd && workspaceCheckout && areEquivalentPaths(project.rootPath, workspaceCwd)
        ? workspaceCheckout
        : await workspaceGitService.getCheckout(project.rootPath);
    const kind: PersistedProjectRecord["kind"] = projectCheckout.isGit ? "git" : "non_git";
    const projectKey = deriveProjectKey({
      rootPath: project.rootPath,
      remoteUrl: projectCheckout.remoteUrl,
      worktreeRoot: projectCheckout.worktreeRoot,
      mainRepoRoot: projectCheckout.mainRepoRoot,
      serverId,
    });
    if (project.kind === kind && project.projectKey === projectKey) return project;
    const refreshed = {
      ...project,
      kind,
      projectKey,
      updatedAt: new Date().toISOString(),
    };
    await projectRegistry.upsert(refreshed);
    return refreshed;
  }

  return {
    runInImportWorkspace,
    findOrCreateWorkspaceForDirectory,
    resolveOrCreateWorkspaceIdForCreateAgent,
    openWorkspaceForDirectory,
    createWorkspaceForDirectory,
    createWorkspaceForWorktree,
    findOrCreateProjectForDirectory,
    ensureWorkspaceRecordUnarchived,
  };
}
