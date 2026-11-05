export type ItemKind = "issue" | "pr";

export type CheckState = "failure" | "pending" | "success" | "unknown";

export interface GitHubItem {
  kind: ItemKind;
  number: number;
  title: string;
  body: string;
  url: string;
  state: string;
  author: string;
  updatedAt: string;
  assignees?: string[];
  reviewRequests?: string[];
  labels?: string[];
  isDraft?: boolean;
  reviewDecision?: string;
  checkState?: CheckState;
}

export function branchName(kind: ItemKind, number: number): string {
  return `${kind}-${number}`;
}

export interface ParsedWorktreeName {
  repoName: string;
  kind: ItemKind;
  number: number;
}

export function parseWorktreeFolderName(
  folderName: string
): ParsedWorktreeName | undefined {
  const match = /^solverino-(.+)-(issue|pr)-(\d+)$/.exec(folderName);
  if (!match) {
    return undefined;
  }
  return {
    repoName: match[1],
    kind: match[2] as ItemKind,
    number: parseInt(match[3], 10),
  };
}

export function owningRepoName(folderName: string): string | undefined {
  let parsed = parseWorktreeFolderName(folderName);
  if (!parsed) {
    return undefined;
  }
  let repoName = parsed.repoName;
  while (true) {
    const inner = parseWorktreeFolderName(repoName);
    if (!inner) {
      break;
    }
    repoName = inner.repoName;
  }
  return repoName;
}

export function worktreeFolderName(
  repoName: string,
  kind: ItemKind,
  number: number
): string {
  return `solverino-${repoName}-${kind}-${number}`;
}

export interface StatusContextEntry {
  state: string;
}

export interface CheckRunEntry {
  status: string;
  conclusion?: string | null;
}

export function isCheckRun(
  entry: StatusContextEntry | CheckRunEntry
): entry is CheckRunEntry {
  return "status" in entry;
}

export function normalizeCheckState(
  entry: StatusContextEntry | CheckRunEntry
): "FAILURE" | "PENDING" | "SUCCESS" | "UNKNOWN" {
  if (isCheckRun(entry)) {
    const status = entry.status.toUpperCase();
    if (status !== "COMPLETED") {
      return "PENDING";
    }
    const conclusion = (entry.conclusion ?? "").toUpperCase();
    if (
      [
        "FAILURE",
        "TIMED_OUT",
        "STARTUP_FAILURE",
        "CANCELLED",
        "ACTION_REQUIRED",
      ].includes(conclusion)
    ) {
      return "FAILURE";
    }
    if (conclusion === "SUCCESS" || conclusion === "NEUTRAL" || conclusion === "SKIPPED") {
      return "SUCCESS";
    }
    return "UNKNOWN";
  }
  const state = entry.state.toUpperCase();
  if (["FAILURE", "ERROR"].includes(state)) {
    return "FAILURE";
  }
  if (state === "PENDING") {
    return "PENDING";
  }
  if (state === "SUCCESS") {
    return "SUCCESS";
  }
  return "UNKNOWN";
}

export function deriveCheckState(
  rollup: (StatusContextEntry | CheckRunEntry)[] | null | undefined
): CheckState {
  if (!rollup || rollup.length === 0) {
    return "unknown";
  }
  const states = rollup.map(normalizeCheckState);
  if (states.includes("FAILURE")) {
    return "failure";
  }
  if (states.includes("PENDING")) {
    return "pending";
  }
  if (states.every((s) => s === "SUCCESS")) {
    return "success";
  }
  return "unknown";
}

export function checkStateSymbol(state: CheckState | undefined): string {
  switch (state) {
    case "success":
      return "$(check)";
    case "failure":
      return "$(error)";
    case "pending":
      return "$(clock)";
    default:
      return "$(circle-filled)";
  }
}

export function itemStatusText(item: GitHubItem): string {
  const parts: string[] = [];
  if (item.kind === "pr") {
    if (item.isDraft) {
      parts.push("draft");
    }
    if (item.checkState === "failure") {
      parts.push("checks failing");
    } else if (item.checkState === "pending") {
      parts.push("checks running");
    } else if (item.checkState === "success") {
      parts.push("checks passing");
    }
    if (item.reviewDecision === "CHANGES_REQUESTED") {
      parts.push("changes requested");
    } else if (item.reviewDecision === "APPROVED") {
      parts.push("approved");
    }
  }
  return parts.join(" \u00b7 ");
}

export function itemLabelText(item: GitHubItem): string {
  return (item.labels ?? []).slice(0, 3).join(", ");
}

export function relativeTime(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) {
    return "";
  }
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) {
    return "just now";
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.round(hours / 24);
  if (days < 30) {
    return `${days}d ago`;
  }
  const months = Math.round(days / 30);
  return `${months}mo ago`;
}

export function escapeMarkdown(text: string): string {
  return text.replace(/([\\`*_{}[\]()#+.!|>-])/g, "\\$1");
}

export function bodyExcerpt(body: string, maxLength = 200): string {
  const text = body.replace(/\r\n/g, "\n").trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength).trimEnd()}\u2026`;
}
