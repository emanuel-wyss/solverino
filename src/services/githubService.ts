import { runOk, Logger } from "../util";
import { GitHubItem, ItemKind } from "../types";

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

export function codespaceNewUrl(repoSlug: string, ref: string): string {
  return `https://codespaces.new/${repoSlug}/tree/${ref}`;
}

export interface PRHead {
  ref: string;
  repoSlug: string;
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
  private currentUser: string | undefined;
  private repoSlug: string | undefined;
  private defaultBranch: string | undefined;

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

  async getRepoSlug(): Promise<string> {
    if (this.repoSlug === undefined) {
      const slug = (
        await this.gh([
          "repo",
          "view",
          "--json",
          "nameWithOwner",
          "--jq",
          ".nameWithOwner",
        ])
      ).trim();
      this.repoSlug = slug || undefined;
    }
    if (!this.repoSlug) {
      throw new Error("Could not determine the GitHub repository.");
    }
    return this.repoSlug;
  }

  async getDefaultBranch(): Promise<string> {
    if (this.defaultBranch === undefined) {
      const branch = (
        await this.gh([
          "repo",
          "view",
          "--json",
          "defaultBranchRef",
          "--jq",
          ".defaultBranchRef.name",
        ])
      ).trim();
      this.defaultBranch = branch || undefined;
    }
    if (!this.defaultBranch) {
      throw new Error("Could not determine the default branch of the repository.");
    }
    return this.defaultBranch;
  }

  async getPRHead(number: number): Promise<PRHead> {
    const out = await this.gh([
      "pr",
      "view",
      String(number),
      "--json",
      "headRefName,headRepositoryOwner,headRepository",
    ]);
    const parsed = JSON.parse(out) as {
      headRefName?: string;
      headRepositoryOwner?: { login?: string };
      headRepository?: { name?: string };
    };
    if (!parsed.headRefName) {
      throw new Error(`Could not determine the head branch of PR #${number}.`);
    }
    const headSlug =
      parsed.headRepositoryOwner?.login && parsed.headRepository?.name
        ? `${parsed.headRepositoryOwner.login}/${parsed.headRepository.name}`
        : undefined;
    return {
      ref: parsed.headRefName,
      repoSlug: headSlug ?? (await this.getRepoSlug()),
    };
  }

  async getPRHeadRef(number: number): Promise<string> {
    return (await this.getPRHead(number)).ref;
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
