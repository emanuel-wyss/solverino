import * as vscode from "vscode";
import { AgentRunner, buildAgentArgs, buildDefaultPrompt } from "./services/agentRunner";
import { GitHubService, isAuthOrMissingCliError } from "./services/githubService";
import { WorktreeService } from "./services/worktreeService";
import { SessionStore } from "./state";
import { OverviewProvider } from "./views/overviewProvider";
import { ChatPanel, ChatPanelAction } from "./views/chatPanel";
import { Logger } from "./util";
import { ChatSession, GitHubItem, sessionId } from "./types";
import { OverviewNode } from "./views/overviewProvider";

export class Controller {
  private readonly outputChannel: vscode.OutputChannel;
  private readonly logger: Logger;
  private readonly github: GitHubService;
  private readonly store: SessionStore;
  private readonly tree: OverviewProvider;
  private readonly runner: AgentRunner;
  private readonly worktrees: WorktreeService;
  private readonly panels = new Map<string, ChatPanel>();
  private pollTimer: NodeJS.Timeout | undefined;
  private repoPath: string;

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
    this.store = new SessionStore(context);
    this.tree = new OverviewProvider((kind, number) =>
      this.store.get(sessionId(kind, number))?.status
    );
    this.runner = new AgentRunner(
      this.config<number>("maxConcurrentAgents", 4),
      {
        onOutput: (sid, chunk) => this.onAgentOutput(sid, chunk),
        onExit: (sid, code) => this.onAgentExit(sid, code),
      },
      this.logger
    );
    this.worktrees = new WorktreeService(
      this.repoPath,
      this.config<string>("worktreeParentFolder", ""),
      this.config<string>("envSetupCommand", ""),
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
    const node = arg as OverviewNode;
    if (node.item) {
      return node.item;
    }
    const item = arg as GitHubItem;
    if (typeof item.kind === "string" && typeof item.number === "number") {
      return item;
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
    this.runner.stopAll();
  }

  activate(): void {
    this.registerCommands();
    this.tree.setLoading(true);
    void this.refresh();
    this.startPolling();
    this.context.subscriptions.push(
      this.outputChannel,
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration("solverino")) {
          return;
        }
        this.runner.setMaxConcurrent(
          this.config<number>("maxConcurrentAgents", 4)
        );
        this.startPolling();
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
      this.tree.setItems(issues, prs);
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
    reg("solverino.openChat", (arg) => {
      const item = this.requireItem(arg);
      if (item) {
        void this.openChat(item);
      }
    });
    reg("solverino.createWorktree", (arg) => {
      const item = this.requireItem(arg);
      if (item) {
        void this.createWorktree(item);
      }
    });
    reg("solverino.cleanupWorktree", (arg) => {
      const item = this.requireItem(arg);
      if (item) {
        void this.cleanupWorktree(item);
      }
    });
    reg("solverino.startAgent", (arg) => {
      const item = this.requireItem(arg);
      if (item) {
        void this.startAgent(
          item,
          buildDefaultPrompt(item.kind, item.number, item.title, item.body)
        );
      }
    });
    reg("solverino.stopAgent", (arg) => {
      const item = this.requireItem(arg);
      if (item) {
        this.stopAgent(sessionId(item.kind, item.number));
      }
    });
    reg("solverino.commit", (arg) => {
      const item = this.requireItem(arg);
      if (item) {
        void this.commit(sessionId(item.kind, item.number));
      }
    });
    reg("solverino.pushAndCreatePR", (arg) => {
      const item = this.requireItem(arg);
      if (item) {
        void this.pushAndCreatePR(sessionId(item.kind, item.number));
      }
    });
    reg("solverino.openWorktreeInNewWindow", (arg) => {
      const item = this.requireItem(arg);
      if (item) {
        this.openWorktreeInNewWindow(sessionId(item.kind, item.number));
      }
    });
    reg("solverino.openOnGitHub", (arg) => {
      const item = this.requireItem(arg);
      if (item) {
        void vscode.env.openExternal(vscode.Uri.parse(item.url));
      }
    });
  }

  async openChat(item: GitHubItem): Promise<void> {
    const session = this.store.getOrCreate(item);
    let panel = this.panels.get(session.id);
    if (!panel || panel.isDisposed()) {
      panel = ChatPanel.open(session, vscode.ViewColumn.Beside);
      this.panels.set(session.id, panel);
      panel.onDidDispose(() => this.panels.delete(session.id));
      panel.onAction((action) =>
        this.onChatAction(session.id, item, action)
      );
      panel.setMessages(session.history, this.panelState(session));
    } else {
      panel.reveal();
    }
    if (!session.worktreePath) {
      await this.createWorktree(item, panel);
    }
  }

  private async createWorktree(
    item: GitHubItem,
    panel?: ChatPanel
  ): Promise<void> {
    const session = this.store.get(sessionId(item.kind, item.number));
    if (!session) {
      return;
    }
    try {
      const info = await this.worktrees.ensure(item.kind, item.number);
      this.store.update(session.id, {
        branch: info.branch,
        branchOwned: session.branchOwned || info.branchCreated,
        worktreePath: info.path,
      });
      const updated = this.store.get(session.id)!;
      this.refreshPanel(updated, panel);
      this.tree.refresh();
    } catch (e) {
      this.handleError(session.id, e, panel);
    }
  }

  private async cleanupWorktree(item: GitHubItem): Promise<void> {
    const id = sessionId(item.kind, item.number);
    if (this.runner.isRunning(id)) {
      void vscode.window.showWarningMessage(
        "Solverino: stop the agent before cleaning up the worktree."
      );
      return;
    }
    const confirm = await vscode.window.showWarningMessage(
      `Remove the worktree and branch for ${item.kind} #${item.number}?`,
      { modal: true },
      "Remove"
    );
    if (confirm !== "Remove") {
      return;
    }
    try {
      const session = this.store.get(id);
      await this.worktrees.remove(
        item.kind,
        item.number,
        session?.branchOwned === true
      );
      const updated = this.store.update(id, {
        worktreePath: undefined,
        branch: undefined,
        branchOwned: false,
        status: "idle",
      });
      if (updated) {
        this.refreshPanel(updated);
      }
      this.tree.refresh();
    } catch (e) {
      this.handleError(id, e);
    }
  }

  async startAgent(item: GitHubItem, prompt: string): Promise<void> {
    const id = sessionId(item.kind, item.number);
    let session = this.store.get(id);
    if (!session) {
      session = this.store.getOrCreate(item);
    }
    if (this.runner.isActive(id)) {
      void vscode.window.showInformationMessage(
        `Solverino: agent for ${item.kind} #${item.number} is already running or queued.`
      );
      return;
    }
    if (!session.worktreePath) {
      await this.createWorktree(item);
      session = this.store.get(id);
      if (!session?.worktreePath) {
        return;
      }
    }
    this.store.update(id, { status: "working", errorMessage: undefined });
    this.tree.refresh();
    const updated = this.store.get(id)!;
    const panel = this.panels.get(id);
    if (!panel || panel.isDisposed()) {
      await this.openChat(item);
    } else {
      this.refreshPanel(updated, panel);
    }
    const command = this.config<string>("agentCommand", "copilot");
    const resumeArgs = this.config<string>("agentResumeArgs", "--continue")
      .split(/\s+/)
      .filter(Boolean);
    const hasPriorTurn = updated.history.some((m) => m.role === "agent");
    this.store.appendMessage(id, {
      role: "system",
      text: "Agent started.",
      timestamp: Date.now(),
    });
    this.runner
      .run({
        command,
        args: buildAgentArgs(prompt, hasPriorTurn, resumeArgs),
        cwd: updated.worktreePath!,
        sessionId: id,
      })
      .catch((e) => this.handleError(id, e, this.panels.get(id)));
  }

  private stopAgent(id: string): void {
    const result = this.runner.stop(id);
    if (result === "cancelled") {
      this.store.update(id, { status: "idle" });
      this.store.appendMessage(id, {
        role: "system",
        text: "Queued agent cancelled.",
        timestamp: Date.now(),
      });
      const session = this.store.get(id);
      if (session) {
        this.refreshPanel(session);
      }
      this.tree.refresh();
    } else if (result === "killed") {
      this.store.appendMessage(id, {
        role: "system",
        text: "Agent stopped by user.",
        timestamp: Date.now(),
      });
    }
  }

  private async commit(id: string): Promise<boolean> {
    const session = this.store.get(id);
    if (!session?.worktreePath) {
      return false;
    }
    if (this.runner.isActive(id)) {
      void vscode.window.showWarningMessage(
        "Solverino: stop the agent before committing — it is still writing to the worktree."
      );
      return false;
    }
    try {
      const dirty = await this.worktrees.hasUncommittedChanges(
        session.worktreePath
      );
      if (!dirty) {
        void vscode.window.showInformationMessage(
          "Solverino: no changes to commit."
        );
        return false;
      }
      const message = await vscode.window.showInputBox({
        prompt: "Commit message",
        value: `${session.kind === "issue" ? "Fix" : "Update"} ${session.kind} #${session.number}`,
      });
      if (!message) {
        return false;
      }
      const result = await this.worktrees.commitAll(
        session.worktreePath,
        message
      );
      this.store.update(id, { status: "needsReview" });
      this.store.appendMessage(id, {
        role: "system",
        text: `Committed: ${result.summary}`,
        timestamp: Date.now(),
      });
      const updated = this.store.get(id)!;
      this.refreshPanel(updated);
      this.tree.refresh();
      return true;
    } catch (e) {
      this.handleError(id, e);
      return false;
    }
  }

  private async pushAndCreatePR(id: string): Promise<void> {
    const session = this.store.get(id);
    if (!session?.worktreePath || !session.branch) {
      return;
    }
    if (this.runner.isActive(id)) {
      void vscode.window.showWarningMessage(
        "Solverino: stop the agent before pushing — it is still writing to the worktree."
      );
      return;
    }
    const hasChanges = await this.worktrees
      .hasUncommittedChanges(session.worktreePath)
      .catch(() => false);
    if (hasChanges) {
      const commit = await vscode.window.showWarningMessage(
        "Solverino: the worktree has uncommitted changes. Commit first?",
        "Commit & continue",
        "Cancel"
      );
      if (commit !== "Commit & continue") {
        return;
      }
      const committed = await this.commit(id);
      if (!committed) {
        return;
      }
      const stillDirty = await this.worktrees
        .hasUncommittedChanges(session.worktreePath)
        .catch(() => true);
      if (stillDirty) {
        void vscode.window.showWarningMessage(
          "Solverino: the worktree still has uncommitted changes — push aborted."
        );
        return;
      }
    }
    try {
      await this.worktrees.push(session.worktreePath, session.branch);
      const pr = await this.github.createPullRequest(
        session.branch,
        `Solverino: ${session.title}`,
        `Automated change for ${session.kind} #${session.number}: ${session.title}`
      );
      this.store.update(id, { status: "prOpened", prUrl: pr.url });
      this.store.appendMessage(id, {
        role: "system",
        text: `Pull request created: ${pr.url}`,
        timestamp: Date.now(),
      });
      const updated = this.store.get(id)!;
      this.refreshPanel(updated);
      this.tree.refresh();
      void vscode.env.openExternal(vscode.Uri.parse(pr.url));
    } catch (e) {
      this.handleError(id, e);
    }
  }

  private openWorktreeInNewWindow(id: string): void {
    const session = this.store.get(id);
    if (!session?.worktreePath) {
      void vscode.window.showWarningMessage(
        "Solverino: no worktree for this chat yet."
      );
      return;
    }
    void vscode.commands.executeCommand(
      "vscode.openFolder",
      vscode.Uri.file(session.worktreePath),
      { forceNewWindow: true }
    );
  }

  private async onChatAction(
    id: string,
    item: GitHubItem,
    action: ChatPanelAction
  ): Promise<void> {
    const session = this.store.get(id);
    if (!session) {
      return;
    }
    switch (action.type) {
      case "send":
        await this.startAgent(item, action.text);
        break;
      case "stop":
        this.stopAgent(id);
        break;
      case "commit":
        await this.commit(id);
        break;
      case "pushAndCreatePR":
        await this.pushAndCreatePR(id);
        break;
      case "openWorktree":
        this.openWorktreeInNewWindow(id);
        break;
    }
  }

  private onAgentOutput(id: string, chunk: string): void {
    const panel = this.panels.get(id);
    if (panel && !panel.isDisposed()) {
      panel.appendAgentChunk(chunk);
    }
    const session = this.store.get(id);
    if (session) {
      const last = session.history[session.history.length - 1];
      const merged =
        last && last.role === "agent" && last.streaming ? last.text + chunk : chunk;
      this.store.replaceLastAgentMessage(id, merged, true);
    }
  }

  private onAgentExit(id: string, code: number | null): void {
    const session = this.store.get(id);
    if (!session) {
      return;
    }
    const last = session.history[session.history.length - 1];
    if (last && last.role === "agent" && last.streaming) {
      this.store.replaceLastAgentMessage(id, last.text, false);
    }
    const panel = this.panels.get(id);
    if (panel && !panel.isDisposed()) {
      panel.closeAgentMessage();
    }
    if (this.runner.wasStopped(id)) {
      this.store.update(id, { status: "idle" });
      const stopped = this.store.get(id)!;
      this.refreshPanel(stopped);
      this.tree.refresh();
      return;
    }
    if (code === 0) {
      this.store.update(id, { status: "needsReview" });
      this.store.appendMessage(id, {
        role: "system",
        text: "Agent finished. Review the changes, then Commit or Push & Create PR.",
        timestamp: Date.now(),
      });
    } else {
      this.store.update(id, {
        status: "error",
        errorMessage: `Agent exited with code ${code ?? "unknown"}.`,
      });
      this.store.appendMessage(id, {
        role: "system",
        text: `Agent exited with code ${code ?? "unknown"}. Check the Solverino output channel for details.`,
        timestamp: Date.now(),
      });
    }
    const updated = this.store.get(id)!;
    this.refreshPanel(updated);
    this.tree.refresh();
  }

  private refreshPanel(session: ChatSession, panel?: ChatPanel): void {
    const target = panel ?? this.panels.get(session.id);
    if (target && !target.isDisposed()) {
      target.setMessages(session.history, this.panelState(session));
    }
  }

  private panelState(session: ChatSession) {
    return {
      status: session.status,
      worktreePath: session.worktreePath,
      branch: session.branch,
      hasWorktree: Boolean(session.worktreePath),
    };
  }

  private handleError(id: string, e: unknown, panel?: ChatPanel): void {
    const message = e instanceof Error ? e.message : String(e);
    this.logger.error(message);
    this.store.update(id, { status: "error", errorMessage: message });
    this.store.appendMessage(id, {
      role: "system",
      text: `Error: ${message}`,
      timestamp: Date.now(),
    });
    const session = this.store.get(id);
    if (session) {
      this.refreshPanel(session, panel);
    }
    this.tree.refresh();
    void vscode.window.showErrorMessage(`Solverino: ${message}`);
  }
}
