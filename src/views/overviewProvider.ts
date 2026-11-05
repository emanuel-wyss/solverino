import * as vscode from "vscode";
import {
  GitHubItem,
  ItemKind,
  bodyExcerpt,
  itemLabelText,
  itemStatusText,
  relativeTime,
} from "../types";

export interface WorktreeLookup {
  branch: string;
  path: string;
  dirtyFiles?: number;
}

export class OverviewProvider implements vscode.TreeDataProvider<OverviewNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    OverviewNode | undefined
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private issues: GitHubItem[] = [];
  private prs: GitHubItem[] = [];
  private reviewPrs: GitHubItem[] = [];
  private loading = false;

  constructor(
    private readonly getWorktree: (
      kind: ItemKind,
      number: number
    ) => WorktreeLookup | undefined
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

  allItems(): GitHubItem[] {
    return [...this.prs, ...this.reviewPrs, ...this.issues];
  }

  counts(): { prs: number; reviewPrs: number; issues: number } {
    return {
      prs: this.prs.length,
      reviewPrs: this.reviewPrs.length,
      issues: this.issues.length,
    };
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
            icon: "git-pull-request",
            description: String(this.prs.length),
          })
        );
      }
      if (this.reviewPrs.length > 0) {
        nodes.push(
          new OverviewNode("Review Requested", "section-review-prs", {
            expand: vscode.TreeItemCollapsibleState.Collapsed,
            icon: "comment-discussion",
            description: String(this.reviewPrs.length),
          })
        );
      }
      if (this.issues.length > 0) {
        nodes.push(
          new OverviewNode("Assigned Issues", "section-issues", {
            expand: vscode.TreeItemCollapsibleState.Expanded,
            icon: "issues",
            description: String(this.issues.length),
          })
        );
      }
      if (nodes.length === 0 && this.loading) {
        return [
          new OverviewNode("Loading…", "loading", {
            icon: "loading~spin",
          }),
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
    return [];
  }

  private itemNode(item: GitHubItem): OverviewNode {
    const worktree = this.getWorktree(item.kind, item.number);
    const status = itemStatusText(item);
    const descriptionParts: string[] = [];
    if (status) {
      descriptionParts.push(status);
    }
    if (worktree) {
      const dirty =
        worktree.dirtyFiles && worktree.dirtyFiles > 0
          ? ` \u00b7 ${worktree.dirtyFiles} changed`
          : "";
      descriptionParts.push(`${worktree.branch}${dirty}`);
    } else {
      const labels = itemLabelText(item);
      if (labels) {
        descriptionParts.push(labels);
      }
      descriptionParts.push(item.author);
    }
    const updated = relativeTime(item.updatedAt);
    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(
      `**${item.kind === "issue" ? "Issue" : "Pull Request"} #${item.number}** ${item.title}`
    );
    if (item.isDraft) {
      tooltip.appendMarkdown(" *(draft)*");
    }
    tooltip.appendMarkdown(
      `\n\nby @${item.author} \u00b7 updated ${updated || "recently"}`
    );
    if (status) {
      tooltip.appendMarkdown(` \u00b7 ${status}`);
    }
    const labels = itemLabelText(item);
    if (labels) {
      tooltip.appendMarkdown(`\n\n${labels}`);
    }
    const excerpt = bodyExcerpt(item.body);
    if (excerpt) {
      tooltip.appendMarkdown(`\n\n${excerpt}`);
    }
    if (worktree) {
      tooltip.appendMarkdown(
        `\n\nWorktree: \`${worktree.path}\`` +
          (worktree.dirtyFiles && worktree.dirtyFiles > 0
            ? ` (${worktree.dirtyFiles} uncommitted file(s))`
            : "")
      );
    }
    tooltip.appendMarkdown(
      `\n\n[${item.url}](${item.url})`
    );
    const node = new OverviewNode(`#${item.number} ${item.title}`, `${item.kind}:${item.number}`, {
      description: descriptionParts.join(" \u00b7 "),
      tooltip,
      context: `${item.kind}${worktree ? ":worktree" : ""}`,
      command: {
        command: "solverino.openWorktree",
        title: "Open Worktree",
        arguments: [item],
      },
    });
    node.item = item;
    node.iconPath = new vscode.ThemeIcon(
      worktree
        ? "folder-library"
        : item.kind === "issue"
          ? "issues"
          : "git-pull-request"
    );
    if (item.kind === "pr" && item.checkState === "failure") {
      node.iconPath = new vscode.ThemeIcon(
        "close",
        new vscode.ThemeColor("testing.iconFailed")
      );
    } else if (item.kind === "pr" && item.checkState === "pending") {
      node.iconPath = new vscode.ThemeIcon(
        "sync~spin",
        new vscode.ThemeColor("testing.iconQueued")
      );
    }
    return node;
  }
}

export class OverviewNode extends vscode.TreeItem {
  item?: GitHubItem;

  constructor(
    label: string,
    id: string,
    options: {
      expand?: vscode.TreeItemCollapsibleState;
      description?: string;
      tooltip?: string | vscode.MarkdownString;
      context?: string;
      command?: vscode.Command;
      icon?: string;
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
    if (options.icon) {
      this.iconPath = new vscode.ThemeIcon(options.icon);
    }
  }
}
