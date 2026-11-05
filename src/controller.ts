import * as vscode from "vscode";
import * as path from "path";
import {
  GitHubService,
  isAuthOrMissingCliError,
  codespaceNewUrl,
} from "./services/githubService";
import { WorktreeService } from "./services/worktreeService";
import { OverviewProvider, OverviewNode } from "./views/overviewProvider";
import { Logger } from "./util";
import {
  GitHubItem,
  branchName,
  parseWorktreeFolderName,
  owningRepoName,
} from "./types";
import { ActivityItem } from "./services/githubService";

export class Controller {
  private readonly outputChannel: vscode.OutputChannel;
  private readonly logger: Logger;
  private readonly github: GitHubService;
  private readonly tree: OverviewProvider;
  private worktrees: WorktreeService;
  private worktreeParentFolder: string;
  private worktreesByPath = new Map<string, string>();
  private pollTimer: NodeJS.Timeout | undefined;
  private repoPath: string;
  private static readonly OPEN_AGENT_FLAG_KEY =
    "solverino.openCopilotAgentOnStart";
  private static readonly OPEN_AGENT_FLAG_TTL_MS = 5 * 60 * 1000;
  private static readonly URI_HANDLER_PATH = "/open-agent";
  private static readonly URI_HANDLER_BASE =
    "vscode://emanuel-wyss.solverino/open-agent";

  constructor(private readonly context: vscode.ExtensionContext) {
    this.outputChannel = vscode.window.createOutputChannel("Solverino");
    this.logger = {
      debug: (m) => this.outputChannel.appendLine(`[debug] ${m}`),
      info: (m) => this.outputChannel.appendLine(`[info] ${m}`),
      warn: (m) => this.outputChannel.appendLine(`[warn] ${m}`),
      error: (m) => this.outputChannel.appendLine(`[error] ${m}`),
    };
    this.repoPath = Controller.requireRepoPath();
    this.github = new GitHubService(this.repoPath, this.logger);
    this.worktreeParentFolder = this.config<string>("worktreeParentFolder", "");
    this.worktrees = this.buildWorktreeService();
    this.tree = new OverviewProvider((kind, number) =>
      this.lookupWorktree(kind, number)
    );
  }

  private buildWorktreeService(): WorktreeService {
    return new WorktreeService(
      this.repoPath,
      this.worktreeParentFolder,
      this.logger
    );
  }

  get overviewProvider(): OverviewProvider {
    return this.tree;
  }

  private static resolveItem(arg: unknown): GitHubItem | undefined {
    if (!arg) {
      return undefined;
    }
    const candidate = ((arg as OverviewNode).item ?? arg) as GitHubItem;
    if (
      (candidate.kind === "issue" || candidate.kind === "pr") &&
      Number.isInteger(candidate.number) &&
      candidate.number > 0
    ) {
      return candidate;
    }
    return undefined;
  }

  private requireItem(arg: unknown): GitHubItem | undefined {
    const item = Controller.resolveItem(arg);
    if (!item) {
      void vscode.window.showErrorMessage(
        "Solverino: could not resolve the selected issue or PR."
      );
    }
    return item;
  }

  dispose(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }
  }

  activate(): void {
    this.registerCommands();
    this.tree.setLoading(true);
    void this.refresh();
    this.startPolling();
    this.context.subscriptions.push(
      vscode.window.registerUriHandler({
        handleUri: (uri) => this.handleUri(uri),
      })
    );
    void this.maybeOpenAgentChatOnStart();
    this.context.subscriptions.push(
      this.outputChannel,
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration("solverino")) {
          return;
        }
        this.startPolling();
        const parentFolder = this.config<string>("worktreeParentFolder", "");
        if (parentFolder !== this.worktreeParentFolder) {
          this.worktreeParentFolder = parentFolder;
          this.worktrees = this.buildWorktreeService();
          void this.scanWorktrees();
          this.logger.info(
            "Worktree settings changed; using the updated configuration."
          );
        }
      })
    );
  }

  private static requireRepoPath(): string {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      throw new Error("Solverino requires a workspace folder to be open.");
    }
    return folder.uri.fsPath;
  }

  private config<T>(key: string, fallback: T): T {
    return vscode.workspace
      .getConfiguration("solverino")
      .get<T>(key, fallback) as T;
  }

  private lookupWorktreeByBranch(
    branch: string
  ): { branch: string; path: string } | undefined {
    for (const [wtPath, wtBranch] of this.worktreesByPath) {
      if (wtBranch === branch) {
        return { branch: wtBranch, path: wtPath };
      }
    }
    return undefined;
  }

  private lookupWorktree(
    kind: GitHubItem["kind"],
    number: number
  ): { branch: string; path: string } | undefined {
    const expected = this.worktrees.expectedPath(kind, number);
    const branch = this.worktreesByPath.get(expected);
    if (!branch) {
      return undefined;
    }
    return { branch, path: expected };
  }

  private async scanWorktrees(): Promise<void> {
    const list = await this.worktrees.list();
    this.worktreesByPath = new Map(list.map((w) => [w.path, w.branch]));
    this.tree.refresh();
  }

  private startPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    const seconds = this.config<number>("pollIntervalSeconds", 60);
    if (seconds > 0) {
      this.pollTimer = setInterval(() => void this.refresh(), seconds * 1000);
      this.pollTimer.unref();
    }
  }

  async refresh(): Promise<void> {
    this.tree.setLoading(true);
    try {
      const assignedOnly = !this.config<boolean>("showAllOpenIssues", false);
      const [issues, prs] = await Promise.all([
        this.github.listIssues(assignedOnly),
        this.github.listPullRequests(),
      ]);
      this.tree.setItems(issues, prs.mine, prs.reviewRequested);
      await this.scanWorktrees();
      await this.updateOrphans(issues, prs.mine, prs.reviewRequested);
    } catch (e) {
      const msg = isAuthOrMissingCliError(e) ?? String(e);
      this.logger.error(msg);
      void vscode.window.showErrorMessage(`Solverino: ${msg}`);
      this.tree.setItems([], []);
    } finally {
      this.tree.setLoading(false);
      this.tree.refresh();
    }
  }

  private async updateOrphans(
    issues: GitHubItem[],
    prs: GitHubItem[],
    reviewPrs: GitHubItem[]
  ): Promise<void> {
    const repoName = await this.worktrees.mainRepoName();
    const openKeys = new Set<string>();
    for (const item of [...issues, ...prs, ...reviewPrs]) {
      openKeys.add(`${item.kind}:${item.number}`);
    }
    const orphans: { branch: string; path: string }[] = [];
    for (const [wtPath] of this.worktreesByPath) {
      const folder = wtPath.replace(/.*[\\/]/, "");
      const parsed = parseWorktreeFolderName(folder);
      if (!parsed || owningRepoName(folder) !== repoName) {
        continue;
      }
      const branch = this.worktreesByPath.get(wtPath);
      if (!branch) {
        continue;
      }
      if (openKeys.has(`${parsed.kind}:${parsed.number}`)) {
        continue;
      }
      const state = await this.github.getItemState(parsed.kind, parsed.number);
      if (state !== "CLOSED" && state !== "MERGED" && state !== "NOT_FOUND") {
        continue;
      }
      orphans.push({ branch, path: wtPath });
    }
    this.tree.setOrphans(orphans);
  }

  private async myWeek(): Promise<void> {
    try {
      const [mergedPrs, closedIssues] = await Promise.all([
        this.github.listRecentlyMergedPRs(7),
        this.github.listRecentlyClosedIssues(7),
      ]);
      const entries: ActivityItem[] = [...mergedPrs, ...closedIssues];
      if (entries.length === 0) {
        void vscode.window.showInformationMessage(
          "Solverino: nothing merged or closed by you in the last 7 days."
        );
        return;
      }
      const picked = await vscode.window.showQuickPick(
        entries.map((entry) => ({
          label: `#${entry.number} ${entry.title}`,
          description:
            entry.kind === "pr"
              ? `PR merged ${new Date(entry.closedAt).toLocaleDateString()}`
              : `Issue closed ${new Date(entry.closedAt).toLocaleDateString()}`,
          entry,
        })),
        {
          placeHolder: `Last 7 days: ${mergedPrs.length} PR(s) merged, ${closedIssues.length} issue(s) closed. Pick one to open on GitHub…`,
        }
      );
      if (picked) {
        await vscode.env.openExternal(vscode.Uri.parse(picked.entry.url));
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.error(message);
      void vscode.window.showErrorMessage(`Solverino: ${message}`);
    }
  }

  private async createDraftPR(item: GitHubItem): Promise<void> {
    try {
      if (item.kind !== "issue") {
        void vscode.window.showErrorMessage(
          "Solverino: draft PRs can only be created for issues."
        );
        return;
      }
      const branch = branchName(item.kind, item.number);
      const currentFolder = this.currentWorkspaceFolder();
      let existingPath: string | undefined;
      if (currentFolder) {
        const currentBranch = await this.worktrees.currentBranch(currentFolder);
        if (currentBranch === branch) {
          existingPath = currentFolder;
        }
      }
      const info = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Solverino: preparing draft PR for issue #${item.number}…`,
          cancellable: false,
        },
        async () => {
          const wt = existingPath
            ? {
                path: existingPath,
                branch,
                created: false,
                branchCreated: false,
              }
            : await this.worktrees.ensure(item.kind, item.number);
          const committed = await this.worktrees.commitAll(
            wt.path,
            `#${item.number}: ${item.title}`
          );
          await this.worktrees.pushBranch(branch);
          return { wt, committed };
        }
      );
      this.worktreesByPath.set(info.wt.path, info.wt.branch);
      this.tree.refresh();
      const prUrl = await this.github.createDraftPR(
        branch,
        `#${item.number}: ${item.title}`,
        `Closes #${item.number}\n\n${item.body}`
      );
      await vscode.env.openExternal(vscode.Uri.parse(prUrl));
      void vscode.window.showInformationMessage(
        `Solverino: draft PR created${info.committed ? " (uncommitted changes were committed)" : ""} — ${prUrl}`
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.error(message);
      void vscode.window.showErrorMessage(`Solverino: ${message}`);
    }
  }

  private async cleanupOrphan(arg: unknown): Promise<void> {
    const orphan = (arg as { orphan?: { path: string; branch: string } })
      ?.orphan;
    if (!orphan?.path || !orphan?.branch) {
      return;
    }
    const warnings: string[] = [];
    try {
      const status = await this.worktrees.statusFiles(orphan.path);
      if (status.files.length > 0) {
        warnings.push(
          `${status.files.length} uncommitted file(s) will be permanently lost`
        );
      }
      const unpushed = await this.worktrees.unpushedCommitCount(
        orphan.path,
        orphan.branch
      );
      if (unpushed > 0) {
        warnings.push(
          `${unpushed} commit(s) on ${orphan.branch} exist only locally and will be deleted`
        );
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.error(message);
      void vscode.window.showErrorMessage(
        `Solverino: could not verify the worktree status on branch "${orphan.branch}"; cleanup aborted. ${message}`
      );
      return;
    }
    const confirm = await vscode.window.showWarningMessage(
      `Remove the orphaned worktree on branch "${orphan.branch}"?`,
      {
        modal: true,
        detail:
          warnings.length > 0
            ? `${orphan.path}\n\nWarning: ${warnings.join("; ")}.`
            : orphan.path,
      },
      "Remove"
    );
    if (confirm !== "Remove") {
      return;
    }
    try {
      await this.worktrees.removeEntry(orphan.path, orphan.branch);
      this.worktreesByPath.delete(orphan.path);
      this.tree.setOrphans(
        this.tree
          .currentOrphans()
          .filter((o) => o.path !== orphan.path)
      );
      this.tree.refresh();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.error(message);
      void vscode.window.showErrorMessage(`Solverino: ${message}`);
    }
  }

  private registerCommands(): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reg = (id: string, cb: (...args: any[]) => unknown) =>
      this.context.subscriptions.push(
        vscode.commands.registerCommand(id, cb)
      );

    reg("solverino.refresh", () => this.refresh());
    reg("solverino.openWorktree", (arg) => {
      const item = this.requireItem(arg);
      if (item) {
        void this.openWorktree(item);
      }
    });
    reg("solverino.cleanupWorktree", (arg) => {
      const item = this.requireItem(arg);
      if (item) {
        void this.cleanupWorktree(item);
      }
    });
    reg("solverino.openOnGitHub", (arg) => {
      const item = this.requireItem(arg);
      if (item) {
        void vscode.env.openExternal(vscode.Uri.parse(item.url));
      }
    });
    reg("solverino.openInCodespace", (arg) => {
      const item = this.requireItem(arg);
      if (item) {
        void this.openInCodespace(item);
      }
    });
    reg("solverino.openCopilotAgent", (arg) => {
      const item = this.requireItem(arg);
      if (item) {
        void this.openCopilotAgent(item);
      }
    });
    reg("solverino.createDraftPR", (arg) => {
      const item = this.requireItem(arg);
      if (item) {
        void this.createDraftPR(item);
      }
    });
    reg("solverino.cleanupOrphan", (arg) => {
      void this.cleanupOrphan(arg);
    });
    reg("solverino.myWeek", () => this.myWeek());
  }

  private static toVscodeFileUri(fsPath: string): vscode.Uri {
    const sep = fsPath.includes("\\") ? "\\" : "/";
    const encoded = fsPath
      .split(sep)
      .filter(Boolean)
      .map(encodeURIComponent)
      .join("/");
    return vscode.Uri.parse(`vscode://file/${encoded}`);
  }

  private openFolderWindow(fsPath: string): void {
    const opened = vscode.env.openExternal(
      Controller.toVscodeFileUri(fsPath)
    );
    if (!opened) {
      void vscode.commands.executeCommand(
        "vscode.openFolder",
        vscode.Uri.file(fsPath),
        { forceNewWindow: true }
      );
    }
  }

  private async openInCodespace(item: GitHubItem): Promise<void> {
    try {
      const baseSlug = await this.github.getRepoSlug();
      let slug = baseSlug;
      let branch: string | undefined;
      if (item.kind === "pr") {
        const head = await this.github.getPRHead(item.number);
        slug = head.repoSlug;
        branch = head.ref;
      } else {
        branch = this.lookupWorktree(item.kind, item.number)?.branch;
      }
      if (branch && slug === baseSlug) {
        if (!(await this.worktrees.hasRemoteBranch(branch))) {
          const choice = await vscode.window.showWarningMessage(
            `Branch "${branch}" exists only locally. Push it to GitHub before opening a codespace?`,
            { modal: true },
            "Push branch",
            "Use default branch"
          );
          if (choice === "Push branch") {
            await this.worktrees.pushBranch(branch);
          } else if (choice === "Use default branch") {
            branch = await this.github.getDefaultBranch();
          } else {
            return;
          }
        }
      }
      let usedFallback = false;
      if (!branch) {
        branch = await this.github.getDefaultBranch();
        usedFallback = true;
      }
      if (usedFallback) {
        void vscode.window.showInformationMessage(
          `Solverino: no worktree exists for this ${item.kind} yet, opening a codespace on the default branch (${branch}).`
        );
      }
      await vscode.env.openExternal(
        vscode.Uri.parse(codespaceNewUrl(slug, branch))
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.error(message);
      void vscode.window.showErrorMessage(`Solverino: ${message}`);
    }
  }

  private async openAgentChat(): Promise<void> {
    try {
      await vscode.commands.executeCommand("workbench.action.chat.openInEditor");
    } catch {
      try {
        await vscode.commands.executeCommand("workbench.action.chat.open");
      } catch {
        this.logger.warn(
          "Could not open a Copilot Chat editor tab; open it manually with the Chat view."
        );
        return;
      }
    }
    try {
      await vscode.commands.executeCommand(
        "workbench.action.chat.toggleAgentMode",
        { modeId: "agent" }
      );
    } catch {
      try {
        await vscode.commands.executeCommand("chat.setMode", "agent");
      } catch {
        this.logger.warn(
          "Could not switch the chat to agent mode; select it manually in the chat editor."
        );
      }
    }
  }

  private currentWorkspaceFolder(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private isSameFolder(a: string, b: string): boolean {
    return path.resolve(a) === path.resolve(b);
  }

  private async handleUri(uri: vscode.Uri): Promise<void> {
    if (uri.path !== Controller.URI_HANDLER_PATH) {
      return;
    }
    const target = new URLSearchParams(uri.query).get("path");
    const currentFolder = this.currentWorkspaceFolder();
    if (!target || !currentFolder || !this.isSameFolder(target, currentFolder)) {
      return;
    }
    await this.context.globalState.update(
      Controller.OPEN_AGENT_FLAG_KEY,
      undefined
    );
    await this.openAgentChat();
  }

  private async maybeOpenAgentChatOnStart(): Promise<void> {
    const pending = this.context.globalState.get<{
      path: string;
      at: number;
    }>(Controller.OPEN_AGENT_FLAG_KEY);
    const currentFolder = this.currentWorkspaceFolder();
    if (!pending || !currentFolder) {
      return;
    }
    if (!this.isSameFolder(pending.path, currentFolder)) {
      return;
    }
    await this.context.globalState.update(
      Controller.OPEN_AGENT_FLAG_KEY,
      undefined
    );
    if (Date.now() - pending.at > Controller.OPEN_AGENT_FLAG_TTL_MS) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await this.openAgentChat();
  }

  private async openCopilotAgent(item: GitHubItem): Promise<void> {
    try {
      let prHeadBranch: string | undefined;
      if (item.kind === "pr") {
        prHeadBranch = await this.github.getPRHeadRef(item.number);
      }
      const expectedBranch =
        item.kind === "pr" && prHeadBranch
          ? prHeadBranch
          : branchName(item.kind, item.number);
      const currentFolder = this.currentWorkspaceFolder();
      if (currentFolder) {
        const branch = await this.worktrees.currentBranch(currentFolder);
        if (branch === expectedBranch) {
          await this.openAgentChat();
          return;
        }
      }
      const existingByBranch =
        prHeadBranch && this.lookupWorktreeByBranch(prHeadBranch);
      const info = existingByBranch
        ? { branch: existingByBranch.branch, path: existingByBranch.path }
        : await this.worktrees.ensure(item.kind, item.number, prHeadBranch);
      this.worktreesByPath.set(info.path, info.branch);
      this.tree.refresh();
      if (
        currentFolder &&
        this.isSameFolder(currentFolder, info.path)
      ) {
        await this.openAgentChat();
        return;
      }
      await this.context.globalState.update(Controller.OPEN_AGENT_FLAG_KEY, {
        path: info.path,
        at: Date.now(),
      });
      await vscode.env.openExternal(
        vscode.Uri.parse(
          `${Controller.URI_HANDLER_BASE}?path=${encodeURIComponent(info.path)}`
        )
      );
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const pending = this.context.globalState.get<{
        path: string;
        at: number;
      }>(Controller.OPEN_AGENT_FLAG_KEY);
      if (!pending || !this.isSameFolder(pending.path, info.path)) {
        return;
      }
      this.openFolderWindow(info.path);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.error(message);
      void vscode.window.showErrorMessage(`Solverino: ${message}`);
    }
  }

  async openWorktree(item: GitHubItem): Promise<void> {
    try {
      let prHeadBranch: string | undefined;
      if (item.kind === "pr") {
        prHeadBranch = await this.github.getPRHeadRef(item.number);
      }
      if (prHeadBranch) {
        const existing = this.lookupWorktreeByBranch(prHeadBranch);
        if (existing) {
          this.openFolderWindow(existing.path);
          return;
        }
      }
      const info = await this.worktrees.ensure(
        item.kind,
        item.number,
        prHeadBranch
      );
      this.worktreesByPath.set(info.path, info.branch);
      this.tree.refresh();
      this.openFolderWindow(info.path);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.error(message);
      void vscode.window.showErrorMessage(`Solverino: ${message}`);
    }
  }

  private async cleanupWorktree(item: GitHubItem): Promise<void> {
    const wtPath = this.worktrees.expectedPath(item.kind, item.number);
    const branch = this.worktreesByPath.get(wtPath);
    if (!branch) {
      void vscode.window.showInformationMessage(
        `Solverino: no worktree exists for ${item.kind} #${item.number}.`
      );
      return;
    }
    const warnings: string[] = [];
    try {
      const status = await this.worktrees.statusFiles(wtPath);
      if (status.files.length > 0) {
        warnings.push(
          `${status.files.length} uncommitted file(s) will be permanently lost`
        );
      }
      const unpushed = await this.worktrees.unpushedCommitCount(
        wtPath,
        branch
      );
      if (unpushed > 0) {
        warnings.push(
          `${unpushed} commit(s) on ${branch} exist only locally and will be deleted`
        );
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.error(message);
      void vscode.window.showErrorMessage(
        `Solverino: could not verify the worktree status for ${item.kind} #${item.number}; cleanup aborted. ${message}`
      );
      return;
    }
    if (item.kind === "pr" && item.state.toUpperCase() === "OPEN") {
      warnings.push(
        "PR #" +
          item.number +
          " is still open on GitHub — this removes only the local worktree and branch, not the PR"
      );
    }
    const confirm = await vscode.window.showWarningMessage(
      `Remove the worktree and branch for ${item.kind} #${item.number}?`,
      {
        modal: true,
        detail:
          warnings.length > 0
            ? `${wtPath}\n\nWarning: ${warnings.join("; ")}.`
            : wtPath,
      },
      "Remove"
    );
    if (confirm !== "Remove") {
      return;
    }
    try {
      await this.worktrees.remove(item.kind, item.number);
      this.worktreesByPath.delete(wtPath);
      this.tree.refresh();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.error(message);
      void vscode.window.showErrorMessage(`Solverino: ${message}`);
    }
  }
}
