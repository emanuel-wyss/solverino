import { runOk, Logger, RunError } from "../util";
import { ChatSession, GitHubItem, ItemKind } from "../types";

const ISSUE_FIELDS = "number,title,body,url,state,author,updatedAt";
const PR_FIELDS =
  "number,title,body,url,state,author,updatedAt,assignees,reviewRequests";
const MAX_ITEMS = 1000;

interface GhRawItem {
  number: number;
  title: string;
  body: string | null;
  url: string;
  state: string;
  author: { login: string } | null;
  updatedAt: string;
  assignees?: { login: string }[] | null;
  reviewRequests?: { login: string }[] | null;
}

function toItems(raw: GhRawItem[], kind: ItemKind): GitHubItem[] {
  return raw.map((i) => ({
    kind,
    number: i.number,
    title: i.title,
    body: i.body ?? "",
    url: i.url,
    state: i.state,
    author: i.author?.login ?? "unknown",
    updatedAt: i.updatedAt,
    ...(i.assignees !== undefined || i.reviewRequests !== undefined
      ? {
          assignees: (i.assignees ?? []).map((a) => a.login),
          reviewRequests: (i.reviewRequests ?? []).map((r) => r.login),
        }
      : {}),
  }));
}

export interface PullRequestSections {
  mine: GitHubItem[];
  reviewRequested: GitHubItem[];
}

export function classifyPullRequests(
  prs: GitHubItem[],
  currentUser?: string
): PullRequestSections {
  if (!currentUser) {
    return { mine: prs, reviewRequested: [] };
  }
  const mine: GitHubItem[] = [];
  const reviewRequested: GitHubItem[] = [];
  for (const pr of prs) {
    if (pr.author === currentUser || pr.assignees?.includes(currentUser)) {
      mine.push(pr);
    } else if (pr.reviewRequests?.includes(currentUser)) {
      reviewRequested.push(pr);
    }
  }
  return { mine, reviewRequested };
}

export class GitHubService {
  constructor(
    private readonly repoPath: string,
    private readonly logger: Logger
  ) {}

  private async gh(args: string[]): Promise<string> {
    const result = await runOk("gh", args, {
      cwd: this.repoPath,
      logger: this.logger,
    });
    return result.stdout;
  }

  async listIssues(assignedToMeOnly = true): Promise<GitHubItem[]> {
    const args = [
      "issue",
      "list",
      "--state",
      "open",
      "--limit",
      String(MAX_ITEMS),
      "--json",
      ISSUE_FIELDS,
    ];
    if (assignedToMeOnly) {
      args.push("--assignee", "@me");
    }
    const raw = JSON.parse(await this.gh(args)) as GhRawItem[];
    return toItems(raw, "issue");
  }

  private currentUser: string | undefined;

  async getCurrentUser(): Promise<string | undefined> {
    if (this.currentUser !== undefined) {
      return this.currentUser;
    }
    try {
      const login = (await this.gh(["api", "user", "--jq", ".login"])).trim();
      this.currentUser = login || undefined;
    } catch (e) {
      this.logger.warn(
        `Could not determine the current GitHub user: ${
          e instanceof Error ? e.message : e
        }`
      );
      this.currentUser = undefined;
    }
    return this.currentUser;
  }

  async listPullRequests(): Promise<PullRequestSections> {
    const raw = JSON.parse(
      await this.gh([
        "pr",
        "list",
        "--state",
        "open",
        "--limit",
        String(MAX_ITEMS),
        "--json",
        PR_FIELDS,
      ])
    ) as GhRawItem[];
    const items = toItems(raw, "pr");
    return classifyPullRequests(items, await this.getCurrentUser());
  }

  async getPRBaseRef(number: number): Promise<string> {
    const out = await this.gh([
      "pr",
      "view",
      String(number),
      "--json",
      "baseRefName",
    ]);
    const base = (JSON.parse(out) as { baseRefName?: string }).baseRefName;
    if (!base) {
      throw new Error(`Could not determine the base branch of PR #${number}.`);
    }
    return base;
  }

  async createPullRequest(
    branch: string,
    title: string,
    body: string,
    base?: string
  ): Promise<{ url: string }> {
    try {
      const args = [
        "pr",
        "create",
        "--head",
        branch,
        "--title",
        title,
        "--body",
        body,
      ];
      if (base) {
        args.push("--base", base);
      }
      const out = await this.gh(args);
      const url = out.trim().split("\n").pop() ?? "";
      return { url };
    } catch (e) {
      if (e instanceof RunError && /already exists/i.test(e.result.stderr)) {
        const out = await this.gh([
          "pr",
          "view",
          branch,
          "--json",
          "url",
        ]);
        return { url: (JSON.parse(out) as { url: string }).url };
      }
      throw e;
    }
  }

  async createIssue(
    title: string,
    body: string,
    assignee?: string
  ): Promise<{ url: string }> {
    const args = ["issue", "create", "--title", title, "--body", body];
    if (assignee) {
      args.push("--assignee", assignee);
    }
    const out = await this.gh(args);
    const url = out.trim().split("\n").pop() ?? "";
    return { url };
  }

  async comment(item: GitHubItem, body: string): Promise<void> {
    if (item.kind === "issue") {
      await this.gh(["issue", "comment", String(item.number), "--body", body]);
    } else {
      await this.gh(["pr", "comment", String(item.number), "--body", body]);
    }
  }
}

export function buildErrorIssueTitle(session: ChatSession): string {
  const kind = session.kind === "issue" ? "Issue" : "PR";
  const message = (session.errorMessage ?? "Agent error").replace(/\s+/g, " ").trim();
  const truncated =
    message.length > 80 ? `${message.slice(0, 77).trimEnd()}…` : message;
  return `Solverino: ${kind} #${session.number} agent error — ${truncated}`;
}

export function buildErrorIssueBody(session: ChatSession): string {
  const kind = session.kind === "issue" ? "Issue" : "Pull Request";
  const lastAgent = [...session.history]
    .reverse()
    .find((m) => m.role === "agent");
  const log = lastAgent ? lastAgent.text.trim().slice(-4000) : "";
  return [
    `The Solverino agent run for ${kind} #${session.number} (${session.title}) failed.`,
    "",
    "## Error",
    "```",
    session.errorMessage ?? "Agent exited with an unknown error.",
    "```",
    "",
    "## Context",
    `- ${kind}: #${session.number}`,
    session.branch ? `- Branch: \`${session.branch}\`` : "- Branch: none",
    session.worktreePath ? `- Worktree: \`${session.worktreePath}\`` : "- Worktree: none",
    "",
    log ? "## Agent output (tail)" : "## Agent output",
    "```",
    log || "(no agent output captured)",
    "```",
  ].join("\n");
}

export function isAuthOrMissingCliError(e: unknown): string | undefined {
  if (e instanceof Error) {
    const msg = e.message;
    if (/Failed to start "gh"/.test(msg)) {
      return "The GitHub CLI (gh) is not installed or not on PATH. Install it from https://cli.github.com and authenticate with `gh auth login`.";
    }
    if (/not authenticated|gh auth login|auth_status/i.test(msg)) {
      return "The GitHub CLI is not authenticated. Run `gh auth login`.";
    }
    return msg;
  }
  return String(e);
}
