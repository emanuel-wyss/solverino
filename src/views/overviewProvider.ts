import * as vscode from "vscode";
import { GitHubItem, ItemKind } from "../types";
import { WorktreeEntry } from "../services/worktreeService";

export class OverviewProvider implements vscode.TreeDataProvider<OverviewNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    OverviewNode | undefined
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private issues: GitHubItem[] = [];
  private prs: GitHubItem[] = [];
  private reviewPrs: GitHubItem[] = [];
  private orphans: WorktreeEntry[] = [];
  private loading = false;

  constructor(
    private readonly getWorktree: (
      kind: ItemKind,
      number: number
    ) => { branch: string; path: string } | undefined
  ) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  setLoading(loading: boolean): void {
    this.loading = loading;
    this.refresh();
  }

  setItems(
    issues: GitHubItem[],
    prs: GitHubItem[],
    reviewPrs: GitHubItem[] = []
  ): void {
    this.issues = issues;
    this.prs = prs;
    this.reviewPrs = reviewPrs;
  }

  setOrphans(orphans: WorktreeEntry[]): void {
    this.orphans = orphans;
  }

  currentOrphans(): WorktreeEntry[] {
    return this.orphans;
  }

  getTreeItem(element: OverviewNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: OverviewNode): OverviewNode[] {
    if (!element) {
      const nodes: OverviewNode[] = [];
      if (this.prs.length > 0) {
        nodes.push(
          new OverviewNode("My Pull Requests", "section-prs", {
            expand: vscode.TreeItemCollapsibleState.Expanded,
          })
        );
      }
      if (this.reviewPrs.length > 0) {
        nodes.push(
          new OverviewNode("Review Requested", "section-review-prs", {
            expand: vscode.TreeItemCollapsibleState.Collapsed,
          })
        );
      }
      if (this.issues.length > 0) {
        nodes.push(
          new OverviewNode("Assigned Issues", "section-issues", {
            expand: vscode.TreeItemCollapsibleState.Expanded,
          })
        );
      }
      if (nodes.length === 0) {
        return [
          new OverviewNode(
            this.loading ? "Loading…" : "No open issues or PRs found",
            "empty",
            {}
          ),
        ];
      }
      return nodes;
    }
    if (element.id === "section-prs") {
      return this.prs.map((i) => this.itemNode(i));
    }
    if (element.id === "section-review-prs") {
      return this.reviewPrs.map((i) => this.itemNode(i));
    }
    if (element.id === "section-issues") {
      return this.issues.map((i) => this.itemNode(i));
    }
    if (element.id === "section-orphans") {
      return this.orphans.map((w) => this.orphanNode(w));
    }
    return [];
  }

  private orphanNode(worktree: WorktreeEntry): OverviewNode {
    const folder = worktree.path.replace(/.*[\\/]/, "");
    const node = new OverviewNode(folder, `orphan:${worktree.path}`, {
      description: `no matching open item \u00b7 ${worktree.branch}`,
      tooltip: `Orphaned Solverino worktree\n\n${worktree.path}\nBranch: ${worktree.branch}\n\nThe issue or PR this worktree was created for is no longer open. You can safely remove it if you no longer need it.`,
      context: "orphan:worktree",
    });
    node.orphan = { path: worktree.path, branch: worktree.branch };
    node.iconPath = new vscode.ThemeIcon("folder");
    return node;
  }

  private itemNode(item: GitHubItem): OverviewNode {
    const worktree = this.getWorktree(item.kind, item.number);
    const label = `#${item.number} ${item.title}`;
    const node = new OverviewNode(label, `${item.kind}:${item.number}`, {
      description: worktree ? `worktree · ${worktree.branch}` : item.author,
      tooltip: `${item.kind === "issue" ? "Issue" : "Pull Request"} #${
        item.number
      }\n${item.title}\nby ${item.author}${
        worktree ? `\n\nWorktree: ${worktree.path}` : ""
      }\n\n${item.url}`,
      context: `${item.kind}${worktree ? ":worktree" : ""}`,
      command: {
        command: "solverino.openWorktree",
        title: "Open Worktree",
        arguments: [item],
      },
    });
    node.item = item;
    node.iconPath = new vscode.ThemeIcon(
      worktree ? "folder-library" : item.kind === "issue" ? "issues" : "git-pull-request"
    );
    return node;
  }
}

export class OverviewNode extends vscode.TreeItem {
  item?: GitHubItem;
  orphan?: { path: string; branch: string };

  constructor(
    label: string,
    id: string,
    options: {
      expand?: vscode.TreeItemCollapsibleState;
      description?: string;
      tooltip?: string | vscode.MarkdownString;
      context?: string;
      command?: vscode.Command;
    }
  ) {
    super(label, options.expand ?? vscode.TreeItemCollapsibleState.None);
    this.id = id;
    if (options.description) {
      this.description = options.description;
    }
    if (options.tooltip) {
      this.tooltip = options.tooltip;
    }
    if (options.context) {
      this.contextValue = options.context;
    }
    if (options.command) {
      this.command = options.command;
    }
  }
}
