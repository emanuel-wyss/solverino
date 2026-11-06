import { runOk, Logger } from "../util";
import {
  GitHubItem,
  ItemKind,
  deriveCheckState,
  StatusContextEntry,
  CheckRunEntry,
} from "../types";

const ISSUE_FIELDS = "number,title,body,url,state,author,updatedAt,labels";
const PR_FIELDS =
  "number,title,body,url,state,author,updatedAt,assignees,reviewRequests,labels,isDraft,reviewDecision,statusCheckRollup";
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
  labels?: { name: string }[] | null;
  isDraft?: boolean | null;
  reviewDecision?: string | null;
  statusCheckRollup?: (StatusContextEntry | CheckRunEntry)[] | null;
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
    labels: (i.labels ?? []).map((l) => l.name),
    ...(kind === "pr"
      ? {
          isDraft: i.isDraft ?? false,
          reviewDecision: i.reviewDecision ?? undefined,
          checkState: deriveCheckState(i.statusCheckRollup),
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

  async createDraftPR(
    branch: string,
    title: string,
    body: string
  ): Promise<string> {
    const url = await this.gh([
      "pr",
      "create",
      "--draft",
      "--head",
      branch,
      "--title",
      title,
      "--body",
      body,
    ]);
    return url.trim();
  }

  async getPRHeadSha(number: number): Promise<string | undefined> {
    try {
      const out = await this.gh([
        "pr",
        "view",
        String(number),
        "--json",
        "headRefOid",
      ]);
      return (JSON.parse(out) as { headRefOid?: string }).headRefOid;
    } catch {
      return undefined;
    }
  }

  private static readonly ITEM_STATE_TTL_MS = 60_000;
  private itemStateCache = new Map<
    string,
    { state: string | undefined; at: number }
  >();

  async getItemState(kind: ItemKind, number: number): Promise<string | undefined> {
    const cacheKey = `${kind}:${number}`;
    const cached = this.itemStateCache.get(cacheKey);
    if (
      cached &&
      cached.state !== undefined &&
      Date.now() - cached.at < GitHubService.ITEM_STATE_TTL_MS
    ) {
      return cached.state;
    }
    try {
      const out = await this.gh([
        kind === "pr" ? "pr" : "issue",
        "view",
        String(number),
        "--json",
        "state",
      ]);
      const state = (JSON.parse(out) as { state?: string }).state;
      const normalized = state?.toUpperCase();
      if (normalized) {
        this.itemStateCache.set(cacheKey, { state: normalized, at: Date.now() });
      }
      return normalized;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (/could not resolve|not found/i.test(message)) {
        this.itemStateCache.set(cacheKey, {
          state: "NOT_FOUND",
          at: Date.now(),
        });
        return "NOT_FOUND";
      }
      this.logger.warn(
        `Could not determine the state of ${kind} #${number}: ${message}`
      );
      return undefined;
    }
  }

  private static readonly SEARCH_PAGE_SIZE = 50;
  private static readonly SEARCH_MAX_PAGES = 5;

  private async ghGraphql<T>(selection: string): Promise<T> {
    const document = `query { ${selection} }`;
    const out = await this.gh([
      "api",
      "graphql",
      "-f",
      `query=${document}`,
    ]);
    return JSON.parse(out) as T;
  }

  private async searchAllPages<T>(
    buildSelection: (after?: string) => string,
    extract: (
      page: unknown,
      user: string
    ) => { items: T[]; hasNextPage: boolean; endCursor?: string }
  ): Promise<T[]> {
    const user = await this.getCurrentUser();
    if (!user) {
      return [];
    }
    const all: T[] = [];
    let after: string | undefined;
    for (
      let page = 0;
      page < GitHubService.SEARCH_MAX_PAGES && (page === 0 || after);
      page++
    ) {
      const parsed = await this.ghGraphql(buildSelection(after));
      const { items, hasNextPage, endCursor } = extract(parsed, user);
      all.push(...items);
      if (!hasNextPage || !endCursor) {
        break;
      }
      after = endCursor;
    }
    return all;
  }

  async listRecentlyMergedPRs(days = 7): Promise<ActivityItem[]> {
    const slug = await this.getRepoSlug();
    const qualifier = `repo:${slug} is:pr merged:>=${isoDateDaysAgo(days)}`;
    return this.searchAllPages(
      (after) =>
        `search(query: "${qualifier}", type: ISSUE, first: ${
          GitHubService.SEARCH_PAGE_SIZE
        }${after ? `, after: "${after}"` : ""}) ` +
        `{ nodes { ... on PullRequest { number title url closedAt mergedBy { login } } } ` +
        `pageInfo { hasNextPage endCursor } }`,
      (page, user) => {
        const parsed = page as {
          data?: {
            search?: {
              nodes?:
                | {
                    number: number;
                    title: string;
                    url: string;
                    closedAt: string;
                    mergedBy?: { login?: string } | null;
                  }[]
                | null;
              pageInfo?: { hasNextPage?: boolean; endCursor?: string };
            };
          };
        };
        const search = parsed.data?.search;
        const nodes = search?.nodes ?? [];
        return {
          items: nodes
            .filter((n) => isMergedBy(n.mergedBy?.login, user))
            .map((n) => ({
              kind: "pr" as const,
              number: n.number,
              title: n.title,
              url: n.url,
              closedAt: n.closedAt,
            })),
          hasNextPage: !!search?.pageInfo?.hasNextPage,
          endCursor: search?.pageInfo?.endCursor,
        };
      }
    );
  }

  async listRecentlyClosedIssues(days = 7): Promise<ActivityItem[]> {
    const slug = await this.getRepoSlug();
    const qualifier = `repo:${slug} is:issue closed:>=${isoDateDaysAgo(days)}`;
    return this.searchAllPages(
      (after) =>
        `search(query: "${qualifier}", type: ISSUE, first: ${
          GitHubService.SEARCH_PAGE_SIZE
        }${after ? `, after: "${after}"` : ""}) ` +
        `{ nodes { ... on Issue { number title url closedAt ` +
        `timelineItems(itemTypes: CLOSED_EVENT, last: 1) { nodes { ... on ClosedEvent { actor { login } } } } } } ` +
        `pageInfo { hasNextPage endCursor } }`,
      (page, user) => {
        const parsed = page as {
          data?: {
            search?: {
              nodes?:
                | {
                    number: number;
                    title: string;
                    url: string;
                    closedAt: string;
                    timelineItems?: {
                      nodes?: { actor?: { login?: string } | null }[] | null;
                    } | null;
                  }[]
                | null;
              pageInfo?: { hasNextPage?: boolean; endCursor?: string };
            };
          };
        };
        const search = parsed.data?.search;
        const nodes = search?.nodes ?? [];
        return {
          items: nodes
            .filter((n) =>
              isClosedBy(
                n.timelineItems?.nodes?.[n.timelineItems.nodes.length - 1]
                  ?.actor?.login,
                user
              )
            )
            .map((n) => ({
              kind: "issue" as const,
              number: n.number,
              title: n.title,
              url: n.url,
              closedAt: n.closedAt,
            })),
          hasNextPage: !!search?.pageInfo?.hasNextPage,
          endCursor: search?.pageInfo?.endCursor,
        };
      }
    );
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

export interface ActivityItem {
  kind: ItemKind;
  number: number;
  title: string;
  url: string;
  closedAt: string;
}

export function isoDateDaysAgo(days: number, now = new Date()): string {
  const d = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

export function isMergedBy(
  mergedBy: string | undefined,
  currentUser: string | undefined
): boolean {
  return !!currentUser && mergedBy === currentUser;
}

export function isClosedBy(
  closedBy: string | undefined,
  currentUser: string | undefined
): boolean {
  return !!currentUser && closedBy === currentUser;
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
