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
import { GitHubItem } from "./types";

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

  private async resolveItemBranch(
    item: GitHubItem
  ): Promise<string | undefined> {
    const existing = this.lookupWorktree(item.kind, item.number);
    if (existing) {
      return existing.branch;
    }
    if (item.kind === "pr") {
      return this.github.getPRHeadRef(item.number);
    }
    return undefined;
  }

  private async openInCodespace(item: GitHubItem): Promise<void> {
    try {
      const slug = await this.github.getRepoSlug();
      let branch = await this.resolveItemBranch(item);
      if (!branch) {
        branch = await this.github.getDefaultBranch();
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
      await vscode.commands.executeCommand("chat.setMode", "agent");
    } catch {
      this.logger.warn(
        "Could not switch the chat to agent mode; select it manually in the chat editor."
      );
    }
  }

  private async maybeOpenAgentChatOnStart(): Promise<void> {
    const flaggedAt = this.context.globalState.get<number>(
      Controller.OPEN_AGENT_FLAG_KEY
    );
    if (
      flaggedAt === undefined ||
      Date.now() - flaggedAt > Controller.OPEN_AGENT_FLAG_TTL_MS
    ) {
      return;
    }
    await this.context.globalState.update(
      Controller.OPEN_AGENT_FLAG_KEY,
      undefined
    );
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await this.openAgentChat();
  }

  private async openCopilotAgent(item: GitHubItem): Promise<void> {
    try {
      let prHeadBranch: string | undefined;
      if (item.kind === "pr") {
        prHeadBranch = await this.github.getPRHeadRef(item.number);
      }
      const info = await this.worktrees.ensure(
        item.kind,
        item.number,
        prHeadBranch
      );
      this.worktreesByPath.set(info.path, info.branch);
      this.tree.refresh();
      const currentFolder = vscode.workspace.workspaceFolders?.[0]?.uri
        .fsPath;
      if (
        currentFolder &&
        path.resolve(currentFolder) === path.resolve(info.path)
      ) {
        await this.openAgentChat();
        return;
      }
      await this.context.globalState.update(
        Controller.OPEN_AGENT_FLAG_KEY,
        Date.now()
      );
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
    } catch {
      // worktree may already be gone; cleanup proceeds
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
