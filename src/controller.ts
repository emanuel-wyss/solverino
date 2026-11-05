import * as vscode from "vscode";
import * as path from "path";
import {
  GitHubService,
  isAuthOrMissingCliError,
  codespaceNewUrl,
} from "./services/githubService";
import { WorktreeService } from "./services/worktreeService";
import { OverviewProvider, OverviewNode, WorktreeLookup } from "./views/overviewProvider";
import { Logger } from "./util";
import {
  GitHubItem,
  branchName,
  itemStatusText,
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
  private dirtyFilesByPath = new Map<string, number>();
  private itemWorktreeAssociations = new Map<string, string>();
  private statusBarItem: vscode.StatusBarItem | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private repoPath: string;
  private static readonly OPEN_AGENT_FLAG_KEY =
    "solverino.openCopilotAgentOnStart";
  private static readonly WT_ASSOC_KEY_PREFIX =
    "solverino.worktreeAssociations";

  private static worktreeAssociationsKey(
    repoPath: string
  ): string {
    return `${Controller.WT_ASSOC_KEY_PREFIX}.${repoPath}`;
  }
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
    this.itemWorktreeAssociations = new Map(
      Object.entries(
        this.context.globalState.get<Record<string, string>>(
          Controller.worktreeAssociationsKey(this.repoPath)
        ) ?? {}
      )
    );
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

  private lookupWorktree(
    kind: GitHubItem["kind"],
    number: number
  ): WorktreeLookup | undefined {
    const key = `${kind}:${number}`;
    const associated =
      this.itemWorktreeAssociations.get(key) ??
      this.worktrees.expectedPath(kind, number);
    const branch = this.worktreesByPath.get(associated);
    if (!branch) {
      return undefined;
    }
    return {
      branch,
      path: associated,
      dirtyFiles: this.dirtyFilesByPath.get(associated),
    };
  }

  private saveWorktreeAssociations(): void {
    void this.context.globalState.update(
      Controller.worktreeAssociationsKey(this.repoPath),
      Object.fromEntries(this.itemWorktreeAssociations)
    );
  }

  private removeAssociationsForPath(path: string): void {
    let changed = false;
    for (const [key, associated] of [...this.itemWorktreeAssociations]) {
      if (associated === path) {
        this.itemWorktreeAssociations.delete(key);
        changed = true;
      }
    }
    if (changed) {
      this.saveWorktreeAssociations();
    }
  }

  private async findReusableWorktree(
    branch: string,
    expectedHeadSha: string | undefined
  ): Promise<{ branch: string; path: string } | undefined> {
    if (!expectedHeadSha) {
      return undefined;
    }
    const repoName = await this.worktrees.mainRepoName();
    for (const [wtPath, wtBranch] of this.worktreesByPath) {
      if (wtBranch !== branch) {
        continue;
      }
      const folder = wtPath.replace(/.*[\\/]/, "");
      const parsed = parseWorktreeFolderName(folder);
      if (!parsed || owningRepoName(folder) !== repoName) {
        continue;
      }
      if ((await this.worktrees.headCommit(wtPath)) !== expectedHeadSha) {
        continue;
      }
      return { branch: wtBranch, path: wtPath };
    }
    return undefined;
  }

  private async scanWorktrees(): Promise<void> {
    const list = await this.worktrees.list();
    this.worktreesByPath = new Map(list.map((w) => [w.path, w.branch]));
    for (const [key, associated] of [...this.itemWorktreeAssociations]) {
      if (!this.worktreesByPath.has(associated)) {
        this.itemWorktreeAssociations.delete(key);
      }
    }
    if (this.itemWorktreeAssociations.size > 0) {
      this.saveWorktreeAssociations();
    }
    const overviewPaths = new Set(
      this.tree.allItems().map((item) => {
        const key = `${item.kind}:${item.number}`;
        return (
          this.itemWorktreeAssociations.get(key) ??
          this.worktrees.expectedPath(item.kind, item.number)
        );
      })
    );
    const dirtyFilesByPath = new Map<string, number>();
    await Promise.all(
      list
        .filter((w) => overviewPaths.has(w.path))
        .map(async (w) => {
          try {
            dirtyFilesByPath.set(
              w.path,
              await this.worktrees.dirtyFileCount(w.path)
            );
          } catch {
            dirtyFilesByPath.set(w.path, 0);
          }
        })
    );
    this.dirtyFilesByPath = dirtyFilesByPath;
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
      this.updateStatusBar();
    }
  }

  private updateStatusBar(): void {
    if (!this.statusBarItem) {
      this.statusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left,
        100
      );
      this.statusBarItem.name = "Solverino";
      this.statusBarItem.command = "solverino.goto";
      this.context.subscriptions.push(this.statusBarItem);
    }
    const { prs, issues, reviewPrs } = this.tree.counts();
    const total = prs + issues + reviewPrs;
    if (total === 0) {
      this.statusBarItem.text = "$(git-pull-request) Solverino";
      this.statusBarItem.tooltip = "Solverino: no open issues or PRs";
    } else {
      this.statusBarItem.text = `$(git-pull-request) ${prs}  $(comment-discussion) ${reviewPrs}  $(issues) ${issues}`;
      this.statusBarItem.tooltip = new vscode.MarkdownString(
        `Solverino: ${prs} PR(s), ${reviewPrs} review request(s), ${issues} issue(s) — click to jump to one`
      );
    }
    this.statusBarItem.show();
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
      const candidateKeys = new Set([
        `${parsed.kind}:${parsed.number}`,
        ...(() => {
          const keys: string[] = [];
          for (const [key, path] of this.itemWorktreeAssociations) {
            if (path === wtPath) {
              keys.push(key);
            }
          }
          return keys;
        })(),
      ]);
      let orphaned = true;
      for (const key of candidateKeys) {
        if (openKeys.has(key)) {
          orphaned = false;
          break;
        }
        const [kind, number] = key.split(":");
        const state = await this.github.getItemState(
          kind as GitHubItem["kind"],
          parseInt(number, 10)
        );
        if (state !== "CLOSED" && state !== "MERGED" && state !== "NOT_FOUND") {
          orphaned = false;
          break;
        }
      }
      if (orphaned) {
        orphans.push({ branch, path: wtPath });
      }
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
      const prNumber = /\/pull\/(\d+)/.exec(prUrl)?.[1];
      if (prNumber) {
        this.itemWorktreeAssociations.set(`pr:${prNumber}`, info.wt.path);
        this.saveWorktreeAssociations();
        this.tree.refresh();
      }
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
      this.removeAssociationsForPath(orphan.path);
      this.tree.setOrphans(
        this.tree.currentOrphans().filter((o) => o.path !== orphan.path)
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
    reg("solverino.goto", () => this.gotoItem());
    reg("solverino.showAllOpenIssues", async () => {
      const config = vscode.workspace.getConfiguration("solverino");
      const current = this.config<boolean>("showAllOpenIssues", false);
      const inspect = config.inspect<boolean>("showAllOpenIssues");
      const target =
        inspect?.workspaceValue !== undefined
          ? vscode.ConfigurationTarget.Workspace
          : vscode.ConfigurationTarget.Global;
      await config.update("showAllOpenIssues", !current, target);
      await this.refresh();
    });
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
      const existingByBranch = prHeadBranch
        ? await this.findReusableWorktree(
            prHeadBranch,
            await this.github.getPRHeadSha(item.number)
          )
        : undefined;
      if (existingByBranch) {
        this.itemWorktreeAssociations.set(
          `${item.kind}:${item.number}`,
          existingByBranch.path
        );
        this.saveWorktreeAssociations();
      }
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

  private async gotoItem(): Promise<void> {
    const items = this.tree.allItems();
    if (items.length === 0) {
      void vscode.window.showInformationMessage(
        "Solverino: no open issues or PRs to jump to. Run Solverino: Refresh Issues & PRs to load them."
      );
      return;
    }
    const picked = await vscode.window.showQuickPick(
      items.map((item) => ({
        label: `#${item.number} ${item.title}`,
        description: item.kind === "pr" ? "Pull Request" : "Issue",
        detail: itemStatusText(item) || undefined,
        item,
      })),
      { placeHolder: "Jump to an issue or PR…", matchOnDescription: true }
    );
    if (!picked) {
      return;
    }
    const item = picked.item;
    const hasWorktree = !!this.lookupWorktree(item.kind, item.number);
    const action = await vscode.window.showQuickPick(
      [
        {
          label: "$(folder-opened) Open Worktree",
          action: "worktree",
          alwaysAvailable: true,
        },
        {
          label: "$(globe) Open on GitHub",
          action: "github",
          alwaysAvailable: true,
        },
        {
          label: "$(cloud) Open in Codespace",
          action: "codespace",
          alwaysAvailable: true,
        },
        {
          label: "$(sparkle) Open Copilot Agent",
          action: "agent",
          alwaysAvailable: true,
        },
        {
          label: "$(trash) Cleanup Worktree",
          action: "cleanup",
          alwaysAvailable: hasWorktree,
        },
      ].filter((a) => a.alwaysAvailable),
      { placeHolder: `What do you want to do with ${item.kind} #${item.number}?` }
    );
    if (!action) {
      return;
    }
    switch (action.action) {
      case "worktree":
        await this.openWorktree(item);
        break;
      case "github":
        await vscode.env.openExternal(vscode.Uri.parse(item.url));
        break;
      case "codespace":
        await this.openInCodespace(item);
        break;
      case "agent":
        await this.openCopilotAgent(item);
        break;
      case "cleanup":
        await this.cleanupWorktree(item);
        break;
    }
  }

  async openWorktree(item: GitHubItem): Promise<void> {
    try {
      let prHeadBranch: string | undefined;
      if (item.kind === "pr") {
        prHeadBranch = await this.github.getPRHeadRef(item.number);
      }
      if (prHeadBranch) {
        const existing = await this.findReusableWorktree(
          prHeadBranch,
          await this.github.getPRHeadSha(item.number)
        );
        if (existing) {
          this.itemWorktreeAssociations.set(
            `${item.kind}:${item.number}`,
            existing.path
          );
          this.saveWorktreeAssociations();
          this.tree.refresh();
          this.openFolderWindow(existing.path);
          return;
        }
      }
      const info = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Solverino: preparing worktree for ${item.kind} #${item.number}…`,
          cancellable: false,
        },
        () => this.worktrees.ensure(item.kind, item.number, prHeadBranch)
      );
      this.worktreesByPath.set(info.path, info.branch);
      this.openFolderWindow(info.path);
      void this.scanWorktrees();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.error(message);
      void vscode.window.showErrorMessage(`Solverino: ${message}`);
    }
  }

  private async cleanupWorktree(item: GitHubItem): Promise<void> {
    const key = `${item.kind}:${item.number}`;
    const wtPath =
      this.itemWorktreeAssociations.get(key) ??
      this.worktrees.expectedPath(item.kind, item.number);
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
      await this.worktrees.removeEntry(wtPath, branch);
      this.worktreesByPath.delete(wtPath);
      this.itemWorktreeAssociations.delete(key);
      this.removeAssociationsForPath(wtPath);
      this.tree.refresh();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.error(message);
      void vscode.window.showErrorMessage(`Solverino: ${message}`);
    }
  }
}
