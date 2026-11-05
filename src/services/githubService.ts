import { runOk, Logger, RunError } from "../util";
import { GitHubItem, ItemKind } from "../types";

const ISSUE_FIELDS = "number,title,body,url,state,author,updatedAt";
const PR_FIELDS = "number,title,body,url,state,author,updatedAt";

interface GhRawItem {
  number: number;
  title: string;
  body: string | null;
  url: string;
  state: string;
  author: { login: string } | null;
  updatedAt: string;
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
  }));
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
      "100",
      "--json",
      ISSUE_FIELDS,
    ];
    if (assignedToMeOnly) {
      args.push("--assignee", "@me");
    }
    const raw = JSON.parse(await this.gh(args)) as GhRawItem[];
    return toItems(raw, "issue");
  }

  async listPullRequests(): Promise<GitHubItem[]> {
    const raw = JSON.parse(
      await this.gh([
        "pr",
        "list",
        "--state",
        "open",
        "--limit",
        "100",
        "--json",
        PR_FIELDS,
      ])
    ) as GhRawItem[];
    return toItems(raw, "pr");
  }

  async createPullRequest(
    branch: string,
    title: string,
    body: string
  ): Promise<{ url: string }> {
    try {
      const out = await this.gh([
        "pr",
        "create",
        "--head",
        branch,
        "--title",
        title,
        "--body",
        body,
      ]);
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

  async comment(item: GitHubItem, body: string): Promise<void> {
    if (item.kind === "issue") {
      await this.gh(["issue", "comment", String(item.number), "--body", body]);
    } else {
      await this.gh(["pr", "comment", String(item.number), "--body", body]);
    }
  }
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
