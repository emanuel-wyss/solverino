import * as vscode from "vscode";
import { GitHubItem, ItemKind, SessionStatus } from "../types";

const STATUS_LABEL: Record<SessionStatus, string> = {
  idle: "",
  working: "working",
  needsReview: "needs review",
  prOpened: "PR opened",
  error: "error",
};

export class OverviewProvider implements vscode.TreeDataProvider<OverviewNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    OverviewNode | undefined
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private issues: GitHubItem[] = [];
  private prs: GitHubItem[] = [];
  private loading = false;

  constructor(
    private readonly getStatus: (
      kind: ItemKind,
      number: number
    ) => SessionStatus | undefined
  ) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  setLoading(loading: boolean): void {
    this.loading = loading;
    this.refresh();
  }

  setItems(issues: GitHubItem[], prs: GitHubItem[]): void {
    this.issues = issues;
    this.prs = prs;
  }

  getTreeItem(element: OverviewNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: OverviewNode): OverviewNode[] {
    if (!element) {
      const nodes: OverviewNode[] = [];
      if (this.prs.length > 0) {
        nodes.push(
          new OverviewNode("Open Pull Requests", "section-prs", {
            expand: vscode.TreeItemCollapsibleState.Expanded,
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
    if (element.id === "section-issues") {
      return this.issues.map((i) => this.itemNode(i));
    }
    return [];
  }

  private itemNode(item: GitHubItem): OverviewNode {
    const status = this.getStatus(item.kind, item.number) ?? "idle";
    const label = `#${item.number} ${item.title}`;
    const node = new OverviewNode(label, `${item.kind}:${item.number}`, {
      description: STATUS_LABEL[status] || item.author,
      tooltip: `${item.kind === "issue" ? "Issue" : "Pull Request"} #${
        item.number
      }\n${item.title}\nby ${item.author}\n\n${item.url}`,
      context: `${item.kind}:${status}`,
      command: {
        command: "swarmforge.openChat",
        title: "Start Chat",
        arguments: [item],
      },
    });
    node.iconPath = new vscode.ThemeIcon(
      status === "working"
        ? "loading~spin"
        : status === "needsReview"
        ? "eye"
        : status === "prOpened"
        ? "git-pull-request"
        : status === "error"
        ? "error"
        : item.kind === "issue"
        ? "issues"
        : "git-pull-request"
    );
    return node;
  }
}

export class OverviewNode extends vscode.TreeItem {
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
